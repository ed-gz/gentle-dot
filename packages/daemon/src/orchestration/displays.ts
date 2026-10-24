import { execFile, spawn } from "node:child_process";
import { accessSync, chmodSync, constants, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { OrchestrationError, record } from "./herdr.ts";
import type { DisplayProvider } from "./registry.ts";

export interface ProviderStatus {
	id: DisplayProvider;
	available: boolean;
	canCreate: boolean;
	error?: string;
}
export interface DisplayListing {
	status: ProviderStatus;
	panes: Record<string, unknown>[];
}
export type RunCli = (
	program: string,
	args: string[],
	authorize?: () => boolean,
) => Promise<Record<string, unknown>>;

function executable(name: string): string | undefined {
	for (const directory of [...(process.env.PATH || "").split(delimiter), join(homedir(), ".local", "bin")]) {
		const candidate = join(directory, name);
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {
			/* Try next executable. */
		}
	}
	return undefined;
}

const authorizeNow = (authorize: () => boolean) => {
	if (!authorize())
		throw new OrchestrationError("UNAUTHORIZED", "El acceso del dispositivo fue revocado.", 401);
};

export const runOrcaCli: RunCli = (program, args, authorize = () => true) =>
	new Promise((resolve, reject) => {
		try {
			authorizeNow(authorize);
		} catch (error) {
			reject(error);
			return;
		}
		const env = { ...process.env };
		// Always target this computer; an inherited Orca caller context must not select another machine.
		for (const key of [
			"ORCA_PAIRING_CODE",
			"ORCA_REMOTE_PAIRING",
			"ORCA_ENVIRONMENT",
			"ORCA_CLI_CWD",
			"ORCA_PANE_KEY",
			"ORCA_WORKTREE_ID",
			"ORCA_TAB_ID",
		])
			delete env[key];
		execFile(
			program,
			[...args, "--json"],
			{ cwd: homedir(), env, timeout: 12_000, maxBuffer: 4 * 1024 * 1024 },
			(error, stdout) => {
				try {
					authorizeNow(authorize);
					const response: unknown = JSON.parse(stdout);
					if (!record(response) || response.ok !== true || !record(response.result)) {
						const detail =
							record(response) && record(response.error) && typeof response.error.message === "string"
								? response.error.message
								: "Orca no devolvió una respuesta válida.";
						throw new OrchestrationError("ORCA_UNAVAILABLE", detail, 503);
					}
					if (error)
						throw new OrchestrationError(
							"ORCA_FAILED",
							"Orca no confirmó la operación. Revisa sus terminales antes de reintentar.",
							503,
						);
					resolve(response.result);
				} catch (failure) {
					reject(
						failure instanceof OrchestrationError
							? failure
							: new OrchestrationError(
									"ORCA_UNAVAILABLE",
									"Orca no está disponible. Abre Orca en este equipo y vuelve a intentar.",
									503,
								),
					);
				}
			},
		);
	});

/** Public Orca CLI contract, verified from installed 1.4.223. No internal daemon token is read. */
export class OrcaDisplay {
	private readonly command: string | undefined;
	private readonly run: RunCli;
	private cached?: { until: number; result: DisplayListing };
	constructor(command?: string | false, run: RunCli = runOrcaCli) {
		this.command =
			command === false ? undefined : command || process.env.GENTLE_DOT_ORCA_BIN || executable("orca-ide");
		this.run = run;
	}
	async list(): Promise<DisplayListing> {
		if (this.cached && this.cached.until > Date.now()) return this.cached.result;
		if (!this.command)
			return {
				status: { id: "orca", available: false, canCreate: false, error: "No se encontró Orca CLI." },
				panes: [],
			};
		try {
			const result = await this.run(this.command, ["terminal", "list", "--limit", "100"]);
			if (!Array.isArray(result.terminals)) throw new Error("Invalid terminal list");
			const panes = result.terminals
				.filter(record)
				.filter((terminal) => typeof terminal.handle === "string" && terminal.executionHostId === "local")
				.map((terminal) => ({
					pane_id: `orca:${terminal.handle}`,
					terminal_id: terminal.handle,
					workspace_id: typeof terminal.worktreePath === "string" ? terminal.worktreePath : "orca",
					label: typeof terminal.title === "string" ? terminal.title : terminal.handle,
					cwd: terminal.worktreePath,
					agent_status: "unknown",
					provider: "orca",
				}));
			const listing: DisplayListing = { status: { id: "orca", available: true, canCreate: true }, panes };
			this.cached = { until: Date.now() + 5000, result: listing };
			return listing;
		} catch (error) {
			const listing: DisplayListing = {
				status: {
					id: "orca",
					available: false,
					canCreate: false,
					error: error instanceof Error ? error.message : "Orca no está disponible.",
				},
				panes: [],
			};
			this.cached = { until: Date.now() + 15_000, result: listing };
			return listing;
		}
	}
	async create(cwd: string, label: string, command: string, authorize: () => boolean) {
		if (!this.command) throw new OrchestrationError("ORCA_UNAVAILABLE", "Instala o configura Orca CLI.", 503);
		const resolved = await this.run(
			this.command,
			["worktree", "show", "--worktree", `path:${cwd}`],
			authorize,
		);
		if (
			!record(resolved.worktree) ||
			resolved.worktree.hostId !== "local" ||
			typeof resolved.worktree.id !== "string"
		)
			throw new OrchestrationError(
				"ORCA_HOST",
				"Elige una carpeta de trabajo local ya abierta en Orca.",
				400,
			);
		authorizeNow(authorize);
		const result = await this.run(
			this.command,
			[
				"terminal",
				"create",
				"--worktree",
				`id:${resolved.worktree.id}`,
				"--title",
				label,
				"--command",
				command,
			],
			authorize,
		);
		if (!record(result.terminal) || typeof result.terminal.handle !== "string")
			throw new OrchestrationError(
				"ORCA_PROTOCOL",
				"Orca no identificó la terminal creada. Revísala antes de reintentar.",
				502,
			);
		this.cached = undefined;
		return {
			created: true,
			provider: "orca",
			paneId: `orca:${result.terminal.handle}`,
			terminalId: result.terminal.handle,
			starting: true,
		};
	}
}

export function defaultTerminalLauncher(): string[] | undefined {
	const configured = process.env.GENTLE_DOT_TERMINAL_ARGV;
	if (configured) {
		try {
			const value: unknown = JSON.parse(configured);
			if (
				Array.isArray(value) &&
				value.length > 0 &&
				value.length <= 32 &&
				value.every((part) => typeof part === "string" && part.length > 0 && !part.includes("\0"))
			)
				return value;
		} catch {
			/* Invalid configuration disables automatic launching. */
		}
		return undefined;
	}
	const kitty = executable("kitty");
	return kitty && (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) ? [kitty, "--"] : undefined;
}

/** A configurable argv prefix launches Pi in a new window, without injecting into an existing shell. */
export function privateKittyLauncher(launcher: string[]) {
	const [program] = launcher;
	// Respect custom launchers. Only the ordinary fresh Kitty invocation is prepared;
	// never add a socket to --single-instance or an existing remote-control target.
	let kittyAt = program && basename(program) === "kitty" ? 0 : -1;
	if (program && basename(program) === "systemd-run") {
		const candidate = launcher.findIndex((part, index) => index > 0 && basename(part) === "kitty");
		const options = launcher.slice(1, candidate);
		// The installed launcher puts Kitty in its own scope so restarting Dot does
		// not stop the terminal. Preserve this wrapper and forbid early-return flags.
		if (
			candidate > 1 &&
			options.includes("--user") &&
			options.includes("--scope") &&
			options.every((option) => ["--user", "--scope", "--collect", "--quiet"].includes(option))
		)
			kittyAt = candidate;
	}
	const prefix = launcher.slice(kittyAt + 1);
	if (kittyAt < 0 || (prefix.length > 0 && !(prefix.length === 1 && prefix[0] === "--"))) return { launcher };
	const socketDir = mkdtempSync(join(tmpdir(), "gentle-dot-kitty-"));
	chmodSync(socketDir, 0o700);
	return {
		socketDir,
		launcher: [
			...launcher.slice(0, kittyAt + 1),
			"--listen-on",
			`unix:${join(socketDir, "control.sock")}`,
			"-o",
			"allow_remote_control=socket-only",
			"--",
		],
	};
}

export async function launchTerminal(
	launcher: string[],
	command: string[],
	cwd: string,
	directory: string,
	authorize: () => boolean,
): Promise<void> {
	authorizeNow(authorize);
	const prepared = privateKittyLauncher(launcher);
	const [program, ...prefix] = prepared.launcher;
	if (!program) throw new OrchestrationError("NO_TERMINAL", "No hay un lanzador de terminal configurado.");
	const env: NodeJS.ProcessEnv = { ...process.env, GENTLE_DOT_SESSION_DIR: directory };
	for (const key of [
		"HERDR_ENV",
		"HERDR_SOCKET_PATH",
		"HERDR_PANE_ID",
		"HERDR_SESSION",
		"ORCA_PANE_KEY",
		"ORCA_TAB_ID",
		"ORCA_WORKTREE_ID",
		"KITTY_PID",
		"KITTY_WINDOW_ID",
		"KITTY_LISTEN_ON",
		"KITTY_PUBLIC_KEY",
		"KITTY_RC_PASSWORD",
	])
		delete env[key];
	try {
		authorizeNow(authorize);
		const child = spawn(program, [...prefix, ...command], { cwd, env, detached: true, stdio: "ignore" });
		if (prepared.socketDir)
			child.once("exit", () => rmSync(prepared.socketDir!, { recursive: true, force: true }));
		await new Promise<void>((resolve, reject) => {
			child.once("error", reject);
			child.once("spawn", () => {
				child.unref();
				resolve();
			});
		});
	} catch (error) {
		if (prepared.socketDir) rmSync(prepared.socketDir, { recursive: true, force: true });
		throw error;
	}
}
