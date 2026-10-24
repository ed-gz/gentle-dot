import { spawn } from "node:child_process";
import type { AppApproval } from "./app-channel.ts";
import { approvalRequest } from "./extensions/approval-guard.ts";

export const ISSUE_LABELS = ["bug", "enhancement", "documentation", "question"] as const;
interface Result {
	code: number;
	stdout?: string;
	missing?: boolean;
}
interface Options {
	approve(request: AppApproval, signal?: AbortSignal): Promise<boolean>;
	run?: (args: string[], capture: boolean, signal?: AbortSignal) => Promise<Result>;
}

/** Never capture auth output or stderr: gh can include credential diagnostics there. */
export function runGh(args: string[], capture: boolean, signal?: AbortSignal): Promise<Result> {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve({ code: 1 });
		const child = spawn("gh", args, {
			shell: false,
			stdio: ["ignore", capture ? "pipe" : "ignore", "ignore"],
			env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_HOST: "github.com" },
		});
		let stdout = "";
		let done = false;
		const finish = (result: Result) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", cancel);
			resolve(result);
		};
		const cancel = () => {
			child.kill();
			finish({ code: 1 });
		};
		const timer = setTimeout(cancel, 30_000);
		timer.unref();
		signal?.addEventListener("abort", cancel, { once: true });
		child.stdout?.on("data", (chunk: Buffer) => {
			if (stdout.length + chunk.length > 4096) cancel();
			else stdout += chunk.toString("utf8");
		});
		child.on("error", (error: NodeJS.ErrnoException) =>
			finish({ code: 1, missing: error.code === "ENOENT" }),
		);
		child.on("close", (code) => finish({ code: code ?? 1, ...(capture ? { stdout } : {}) }));
	});
}

export class GitHubIssues {
	private readonly run: NonNullable<Options["run"]>;
	private readonly options: Options;
	constructor(options: Options) {
		this.options = options;
		this.run = options.run ?? runGh;
	}

	async dispatch(input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
		if (input.action === "status") {
			const result = await this.run(
				["auth", "status", "--active", "--hostname", "github.com"], false, signal,
			);
			return { available: !result.missing, authenticated: result.code === 0 };
		}
		if (input.action !== "create") throw new Error("Acción de GitHub no válida.");
		const { repo, title, body } = input;
		if (
			typeof repo !== "string" ||
			!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]{1,100}$/.test(repo) ||
			repo.endsWith("/.") || repo.endsWith("/..")
		) throw new Error("Usa un repositorio OWNER/REPO de github.com.");
		if (
			typeof title !== "string" || !title.trim() || title.length > 256 || /[\p{Cc}]/u.test(title)
		) throw new Error("El título debe tener entre 1 y 256 caracteres.");
		if (
			typeof body !== "string" || !body.trim() || body.length > 16000 ||
			/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(body)
		) throw new Error("El cuerpo debe tener entre 1 y 16000 caracteres.");
		const labels = input.labels ?? [];
		if (
			!Array.isArray(labels) || labels.length > 4 ||
			labels.some((label) => !ISSUE_LABELS.includes(label)) ||
			new Set(labels).size !== labels.length
		) throw new Error("Etiqueta no admitida.");

		// Freeze precisely the reviewed values before awaiting a human. Ignore any confirmed flag.
		const args = [
			"issue", "create", "--repo", repo, "--title", title, "--body", body,
			...labels.flatMap((label) => ["--label", String(label)]),
		];
		const request = approvalRequest("GitHub", "github", "create_issue", {
			repo, title, body, labels: [...labels],
		});
		const approved = await this.options.approve(request, signal).catch(() => false);
		if (!approved || signal?.aborted) return { created: false };
		const result = await this.run(args, true, signal);
		if (result.code !== 0) throw new Error(
			"GitHub no confirmó la creación. Comprueba gh, la conexión y los permisos del repositorio; no reintentes sin verificar duplicados.",
		);
		const url = result.stdout?.trim();
		if (
			!url || !/^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+\/issues\/[0-9]+$/.test(url) ||
			!url.toLowerCase().startsWith(`https://github.com/${repo.toLowerCase()}/issues/`)
		) throw new Error(
			"GitHub no devolvió una URL de issue verificable. Comprueba el repositorio antes de reintentar.",
		);
		return { created: true, url };
	}
}
