import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { reviewConsentPatchFiles } from "../src/runtime-build.ts";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { tempDir } from "./helpers.ts";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const BUILD = join(PACKAGE, "scripts", "build-runtime.ts");
const ENGINE_CLI = join("@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");

let out: string;

beforeAll(() => {
	out = tempDir();
	const build = spawnSync(process.execPath, [BUILD, "--out", out], { encoding: "utf8" });
	expect(build.stderr).toBe("");
	expect(build.status).toBe(0);
}, 60_000);

function listFiles(dir: string, prefix = ""): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
		entry.isDirectory()
			? listFiles(join(dir, entry.name), `${prefix}${entry.name}/`)
			: [`${prefix}${entry.name}`],
	);
}

describe("build:runtime", () => {
	it("emits the daemon part of the runtime layout, without node_modules", () => {
		expect(listFiles(out).sort()).toEqual([
			"bin/pi",
			"daemon/apply-review-consent-patch.mjs",
			"daemon/cli.mjs",
			"daemon/extensions/approval-guard.ts",
			"daemon/extensions/background-turn.ts",
			"daemon/extensions/dot-browser.ts",
			"daemon/extensions/dot-companion.ts",
			"daemon/extensions/dot-completions.ts",
			"daemon/extensions/dot-history.ts",
			"daemon/extensions/dot-live-input.ts",
			"daemon/extensions/dot-orchestrator.ts",
			"daemon/extensions/dot-session.ts",
			"daemon/extensions/dot-share-file.ts",
			"daemon/extensions/dot-watch.ts",
			"daemon/extensions/dot-workflows.ts",
			"daemon/extensions/screenshot-context.ts",
			"daemon/gentle-pi@4.0.0.patch",
			"daemon/history-recall.ts",
			"daemon/identity.md",
			"daemon/orchestration/activity-files.ts",
			"daemon/orchestration/activity.ts",
			"daemon/orchestration/companion-activity.ts",
			"daemon/orchestration/delivery.ts",
            "daemon/orchestration/editor-geometry.ts",
			"daemon/orchestration/herdr.ts",
			"daemon/orchestration/process-identity.ts",
			"daemon/orchestration/questions.ts",
			"daemon/orchestration/review-consent-presentation.ts",
			"daemon/orchestration/review-consent.ts",
			"daemon/orchestration/session-attachments.ts",
			"daemon/orchestration/session-copy.ts",
			"daemon/orchestration/session-info.ts",
			"daemon/orchestration/transcript.ts",
			"daemon/package.json",
			"daemon/review-consent-patch.json",
			"daemon/terminal-mood.py",
			"daemon/workflow-authorization.ts",
		]);
		expect(readFileSync(join(out, "daemon", "identity.md"), "utf8")).toBe(
			readFileSync(join(PACKAGE, "src", "identity.md"), "utf8"),
		);
		expect(readFileSync(join(out, "daemon", "extensions", "approval-guard.ts"), "utf8")).toBe(
			readFileSync(join(PACKAGE, "src", "extensions", "approval-guard.ts"), "utf8"),
		);
	});

	it("loads the optional persona extension without workspace packages or artwork", () => {
		const source = readFileSync(join(out, "daemon/extensions/dot-companion.ts"), "utf8");
		expect(source).not.toContain('from "@gentle-dot/theme-capri');
		expect(source).toContain("Active companion: Capri");
		const loaded = spawnSync(process.execPath, ["--input-type=module", "-e",
			`const extension = await import(${JSON.stringify(join(out, "daemon/extensions/dot-companion.ts"))});
			if (typeof extension.default !== "function") process.exit(1);`
		], { encoding: "utf8" });
		expect(loaded.stderr).toBe("");
		expect(loaded.status).toBe(0);
	});

	it("ships an npm postinstall that applies the pinned patch to pristine provider bytes and is idempotent", () => {
		const root = resolve(".cache/rdd-consent-bridge/packaging");
		mkdirSync(root, { recursive: true });
		const directory = mkdtempSync(join(root, "runtime-"));
		const provider = join(directory, "node_modules/gentle-pi");
		mkdirSync(provider, { recursive: true });
		writeFileSync(join(provider, "package.json"), JSON.stringify({ name: "gentle-pi", version: "4.0.0", type: "module" }));
		const manifest = JSON.parse(readFileSync(join(out, "daemon/package.json"), "utf8"));
		expect(manifest.scripts.postinstall).toBe("node apply-review-consent-patch.mjs");
		for (const file of ["gentle-pi@4.0.0.patch", "review-consent-patch.json", "apply-review-consent-patch.mjs"])
			copyFileSync(join(out, "daemon", file), join(directory, file));
		const installed = join(createRequire(import.meta.url).resolve("gentle-pi/package.json"), "..");
		const patch = readFileSync(join(directory, "gentle-pi@4.0.0.patch"), "utf8");
		const files = reviewConsentPatchFiles(patch, path => readFileSync(join(installed, path), "utf8"));
		for (const file of files) {
			mkdirSync(join(provider, file.path, ".."), { recursive: true });
			writeFileSync(join(provider, file.path), file.original);
		}
		const run = () => spawnSync(process.execPath, [join(directory, "apply-review-consent-patch.mjs")], { cwd: directory, encoding: "utf8" });
		for (let attempt = 0; attempt < 2; attempt++) {
			const result = run();
			expect({ code: result.status, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
			expect(result.stdout).toContain(createHash("sha256").update(patch).digest("hex"));
			for (const file of files) expect(readFileSync(join(provider, file.path), "utf8")).toBe(file.content);
		}
		const source = files[0]!;
		writeFileSync(join(provider, source.path), source.content + "\n// unsupported local modification\n");
		const rejected = run();
		expect(rejected.status).toBe(1);
		expect(rejected.stderr).toContain("Unsupported Gentle Pi consent source");
		expect(readFileSync(join(provider, source.path), "utf8")).toContain("unsupported local modification");
		writeFileSync(join(provider, "package.json"), JSON.stringify({ version: "4.0.1" }));
		expect(run().stderr).toContain("Unsupported Gentle Pi consent version");
	});

	it("loads the packaged session approval adapter without relying on the source checkout", () => {
		const extension = join(out, "daemon", "extensions", "dot-session.ts");
		symlinkSync(join(PACKAGE, "node_modules"), join(out, "daemon", "node_modules"));
		const check = spawnSync(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				`const {createDotSession}=await import(${JSON.stringify(extension)}); if(typeof createDotSession!=='function') process.exit(1);`,
			],
			{ encoding: "utf8", cwd: out },
		);
		rmSync(join(out, "daemon", "node_modules"));
		expect(check.stderr).toBe("");
		expect(check.status).toBe(0);
	});

	it("loads all packaged background extensions with their shared turn coordinator", () => {
		const extensions = join(out, "daemon", "extensions");
		const check = spawnSync(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				`
			const folder=${JSON.stringify(extensions)};
			for (const [file, name] of [['dot-completions.ts', 'registerCompletionReports'], ['dot-watch.ts', 'registerWatchers'], ['dot-workflows.ts', 'registerWorkflows']]) {
				const extension=await import(folder+'/'+file);
				if(typeof extension[name]!=='function') throw new Error(file+' failed to load');
			}
		`,
			],
			{ encoding: "utf8", cwd: out },
		);
		expect(check.stderr).toBe("");
		expect(check.status).toBe(0);
	});

	it("loads and executes the packaged history tool without source checkout imports or a model", () => {
		const sessions = join(tempDir(), "sessions");
		mkdirSync(sessions);
		const session = join(sessions, "chat.jsonl");
		writeFileSync(
			session,
			`${JSON.stringify({ type: "session", id: "chat" })}\n${JSON.stringify({ type: "message", message: { role: "user", content: "Fiestas en Monterrey" } })}\n`,
		);
		const extension = join(out, "daemon", "extensions", "dot-history.ts");
		const check = spawnSync(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				`
			process.env.GENTLE_DOT_HISTORY_DIR=${JSON.stringify(sessions)};
			const {default:register}=await import(${JSON.stringify(extension)});
			let tool; register({registerTool(value){tool=value;}});
			if(tool?.name!=='dot_history') throw new Error('history tool missing');
			const result=await tool.execute('test',{query:'Monterrey'},undefined,undefined,{sessionManager:{getSessionFile(){return ${JSON.stringify(session)};}}});
			const found=JSON.parse(result.content[0].text);
			if(found.matches[0]?.text!=='Fiestas en Monterrey') throw new Error('packaged recall failed');
		`,
			],
			{ encoding: "utf8", cwd: out },
		);
		expect(check.stderr).toBe("");
		expect(check.status).toBe(0);
	});

	it("ships the runtime dependency used to verify workflow instruction origins", () => {
		const helper = join(out, "daemon", "workflow-authorization.ts");
		const check = spawnSync(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				`const {WorkflowAuthorization,workflowSourceHash}=await import(${JSON.stringify(helper)}); const ledger=new WorkflowAuthorization(); ledger.record('human instruction','composed message'); if(ledger.resolve(workflowSourceHash('composed message'))!=='human instruction') process.exit(1);`,
			],
			{ encoding: "utf8" },
		);
		expect(check.stderr).toBe("");
		expect(check.status).toBe(0);
	});

	it("bundles the protocol and leaves the engine and ws external", () => {
		const bundle = readFileSync(join(out, "daemon", "cli.mjs"), "utf8");
		expect(bundle.startsWith("#!/usr/bin/env node\n")).toBe(true);
		expect(bundle).not.toContain("@gentle-dot/protocol");
		expect(bundle).toMatch(/from "ws"/);
		expect(bundle).toContain('import("@earendil-works/pi-coding-agent")');
	});

	it("lists the external dependencies with the lockfile's exact versions", () => {
		const manifest = JSON.parse(readFileSync(join(out, "daemon", "package.json"), "utf8"));
		expect(manifest).toMatchObject({ private: true, type: "module" });
		expect(manifest.dependencies).toEqual({
			"@earendil-works/pi-ai": "1.0.4",
			"@earendil-works/pi-codemode": "1.0.4",
			"@earendil-works/pi-coding-agent": "1.0.4",
			"@earendil-works/pi-mcp": "1.0.4",
			"@earendil-works/pi-tui": "1.0.4",
			"gentle-pi": "4.0.0",
			jiti: "2.7.0",
			"playwright-core": "1.63.0",
			ws: "8.22.0",
		});
	});

	it("keeps the codemode compatibility export required by the pinned engine", () => {
		const check = spawnSync(
			process.execPath,
			[
				"--input-type=module",
				"--eval",
				'import { MCP_TYPESCRIPT_PREAMBLE } from "@earendil-works/pi-codemode"; ' +
					'if (typeof MCP_TYPESCRIPT_PREAMBLE !== "string" || !MCP_TYPESCRIPT_PREAMBLE.length) process.exit(1);',
			],
			{ cwd: PACKAGE, encoding: "utf8" },
		);
		expect(check.stderr).toBe("");
		expect(check.status).toBe(0);
	});

	it("runs its self-check from the output with the engine resolved inside it", () => {
		symlinkSync(join(PACKAGE, "node_modules"), join(out, "daemon", "node_modules"));
		const check = spawnSync(process.execPath, [join(out, "daemon", "cli.mjs"), "--self-check"], {
			encoding: "utf8",
			env: {
				PATH: "/usr/bin:/bin",
				HOME: tempDir(),
				GENTLE_DOT_DATA_DIR: tempDir(),
				GENTLE_DOT_RUNTIME: out,
				ENGRAM_BIN: "/x/engram",
			},
		});
		expect(check.stderr).toBe("");
		expect(check.status).toBe(0);
		const report = JSON.parse(check.stdout);
		const real = realpathSync(out);
		expect(report).toMatchObject({
			ok: true,
			runtime: out,
			uiDir: join(out, "ui"),
			gentleShell: join(out, "daemon", "node_modules", "gentle-pi", "bin", "gentle-shell.mjs"),
			engineCli: join(out, "daemon", "node_modules", ENGINE_CLI),
			engramBin: "/x/engram",
		});
		expect(realpathSync(report.approvalGuard)).toBe(join(real, "daemon", "extensions", "approval-guard.ts"));
		expect(realpathSync(report.identity)).toBe(join(real, "daemon", "identity.md"));
	});

	it("emits a `pi` wrapper that runs the runtime's node and engine wherever the runtime is", () => {
		expect(statSync(join(out, "bin", "pi")).mode & 0o111).toBe(0o111);
		const moved = tempDir();
		mkdirSync(join(moved, "bin"));
		mkdirSync(join(moved, "node", "bin"), { recursive: true });
		copyFileSync(join(out, "bin", "pi"), join(moved, "bin", "pi"));
		writeFileSync(join(moved, "node", "bin", "node"), '#!/bin/sh\nprintf "%s\\n" "$0" "$@"\n', {
			mode: 0o755,
		});
		const linked = join(tempDir(), "pi");
		symlinkSync(join(moved, "bin", "pi"), linked);
		const real = realpathSync(moved);
		for (const entry of [join(moved, "bin", "pi"), linked]) {
			const run = spawnSync(entry, ["--version", "a b"], { encoding: "utf8" });
			expect(run.status).toBe(0);
			expect(run.stdout.split("\n")).toEqual([
				join(real, "node", "bin", "node"),
				join(real, "daemon", "node_modules", ENGINE_CLI),
				"--version",
				"a b",
				"",
			]);
		}
		expect(existsSync(join(PACKAGE, "node_modules", ENGINE_CLI))).toBe(true);
	});
});
