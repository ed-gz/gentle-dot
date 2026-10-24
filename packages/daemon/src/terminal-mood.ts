import { execFile } from "node:child_process";
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OrchestrationError, record } from "./orchestration/herdr.ts";
import type { HerdrLayout } from "./orchestration/herdr-layout.ts";
import type { Orchestrator } from "./orchestration/index.ts";
import { processIdentity } from "./orchestration/process-identity.ts";
import { runtimeDir } from "./runtime.ts";

export const TERMINAL_MOODS = ["hacker", "afterlife", "sunset", "restore"] as const;
export type TerminalMood = (typeof TERMINAL_MOODS)[number];
type Target = Awaited<ReturnType<Orchestrator["terminalTarget"]>>;
export type TerminalMoodSource = Pick<Orchestrator, "terminalTarget">;
export interface TerminalMoodState {
	available: boolean;
	paneId: string;
	scope: "window";
	mood: Exclude<TerminalMood, "restore"> | null;
	canRestore: boolean;
	windowId?: number;
	affectedPaneIds: string[];
	sharedWindow: boolean;
	requiresSharedConfirmation: boolean;
	verified?: boolean;
	reason?: string;
}
interface ProcessTree {
	pids: number[];
	names: string[];
	kittyPid?: number;
	windowId?: number;
	address?: string;
}
interface KittyWindow {
	id: number;
	pid: number;
}
export interface TerminalMoodHost {
	tree(pid: number): ProcessTree;
	identity(pid: number): Promise<string | undefined>;
	socket(address: string, kittyPid: number): string;
	run(address: string, args: string[], authorize: () => boolean): Promise<unknown>;
}

function authorized(authorize: () => boolean) {
	if (!authorize())
		throw new OrchestrationError("UNAUTHORIZED", "El acceso de este dispositivo fue revocado.", 401);
}
function inputPane(value: unknown): string {
	if (typeof value !== "string" || !value.trim() || value.length > 256 || value.includes("\0"))
		throw new OrchestrationError("INVALID_INPUT", "Elige una sesión válida.", 400);
	return value;
}
export function terminalMoodInput(value: unknown) {
	if (
		!record(value) ||
		Object.keys(value).some((key) => !["paneId", "mood", "allowSharedWindow"].includes(key)) ||
		!TERMINAL_MOODS.includes(value.mood as TerminalMood) ||
		(value.allowSharedWindow !== undefined && typeof value.allowSharedWindow !== "boolean")
	)
		throw new OrchestrationError("INVALID_INPUT", "Elige Hacker, Afterlife, Atardecer o Restaurar.", 400);
	return {
		paneId: inputPane(value.paneId),
		mood: value.mood as TerminalMood,
		allowSharedWindow: value.allowSharedWindow === true,
	};
}

/** Read only routing metadata. Never return environment secrets, terminal contents or stdin. */
export function terminalProcessTree(start: number): ProcessTree {
	if (process.platform !== "linux") throw new Error("Los ambientes de terminal requieren Kitty en Linux.");
	const pids: number[] = [],
		names: string[] = [];
	const env: Record<string, string> = {};
	for (let pid = start; pid > 1 && pids.length < 96 && !pids.includes(pid); ) {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const end = stat.lastIndexOf(")");
		const fields = stat.slice(end + 2).split(/\s+/);
		pids.push(pid);
		names.push(stat.slice(stat.indexOf("(") + 1, end));
		try {
			for (const item of readFileSync(`/proc/${pid}/environ`, "utf8").split("\0")) {
				const at = item.indexOf("=");
				const key = item.slice(0, at);
				if (["KITTY_PID", "KITTY_WINDOW_ID", "KITTY_LISTEN_ON"].includes(key) && env[key] === undefined)
					env[key] = item.slice(at + 1);
			}
		} catch {
			/* Some ancestors need elevated access; do not request it. */
		}
		pid = Number(fields[1]);
	}
	const positive = (value?: string) =>
		value && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : undefined;
	return {
		pids,
		names,
		kittyPid: positive(env.KITTY_PID),
		windowId: positive(env.KITTY_WINDOW_ID),
		address: env.KITTY_LISTEN_ON,
	};
}

/** A real local socket owned by the verified Kitty, protected by its mode or private parent. */
export function terminalSocket(address: string, kittyPid: number): string {
	if (!address.startsWith("unix:") || !isAbsolute(address.slice(5)) || address.includes("\0"))
		throw new Error("Esta ventana necesita un canal local privado; no se admite control por red.");
	const path = address.slice(5);
	const stat = lstatSync(path),
		parent = lstatSync(dirname(path));
	const uid = process.getuid?.();
	if (
		!stat.isSocket() ||
		stat.isSymbolicLink() ||
		stat.uid !== uid ||
		((stat.mode & 0o077) !== 0 &&
			!(parent.isDirectory() && parent.uid === uid && (parent.mode & 0o077) === 0))
	)
		throw new Error("El canal de la terminal no tiene permisos privados.");
	const canonical = realpathSync(path);
	const sockets = readFileSync(`/proc/${kittyPid}/net/unix`, "utf8")
		.split("\n")
		.map((line) => line.trim().split(/\s+/))
		.filter((parts) => parts.slice(7).join(" ") === path || parts.slice(7).join(" ") === canonical)
		.map((parts) => `socket:[${parts[6]}]`);
	const owned = readdirSync(`/proc/${kittyPid}/fd`).some((fd) => {
		try {
			return sockets.includes(readlinkSync(`/proc/${kittyPid}/fd/${fd}`));
		} catch {
			return false;
		}
	});
	if (!owned) throw new Error("El canal ya no pertenece a esta instancia de Kitty.");
	return `unix:${canonical}`;
}

export function kittyWindows(value: unknown): KittyWindow[] {
	if (!Array.isArray(value)) throw new Error("Kitty no confirmó sus ventanas.");
	const windows: KittyWindow[] = [];
	for (const os of value.filter(record))
		for (const tab of (Array.isArray(os.tabs) ? os.tabs : []).filter(record))
			for (const window of (Array.isArray(tab.windows) ? tab.windows : []).filter(record)) {
				if (
					Number.isSafeInteger(window.id) &&
					(window.id as number) > 0 &&
					Number.isSafeInteger(window.pid) &&
					(window.pid as number) > 0
				)
					windows.push({ id: window.id as number, pid: window.pid as number });
			}
	return windows;
}

const runKitty: TerminalMoodHost["run"] = (address, args, authorize) =>
	new Promise((resolve, reject) => {
		try {
			authorized(authorize);
		} catch (error) {
			reject(error);
			return;
		}
		// Explicit socket and disabled password lookup prevent TTY fallback and interactive prompts.
		execFile(
			"kitty",
			["@", "--to", address, "--use-password", "never", ...args],
			{ timeout: 5000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, KITTY_RC_PASSWORD: "" } },
			(error, stdout) => {
				try {
					authorized(authorize);
					if (error)
						throw new Error("Kitty no confirmó la operación. Verifica la ventana antes de reintentar.");
					resolve(JSON.parse(stdout));
				} catch (failure) {
					reject(failure);
				}
			},
		);
	});
const runtime = runtimeDir();
const bridgePath = runtime
	? join(runtime, "daemon", "terminal-mood.py")
	: fileURLToPath(new URL("./terminal-mood.py", import.meta.url));

export class TerminalMoodController {
	private readonly host: TerminalMoodHost;
	private readonly source?: TerminalMoodSource;
	constructor(source?: TerminalMoodSource, host: Partial<TerminalMoodHost> = {}) {
		this.source = source;
		this.host = {
			tree: terminalProcessTree,
			identity: processIdentity,
			socket: terminalSocket,
			run: runKitty,
			...host,
		};
	}
	private async resolve(paneId: string, authorize: () => boolean, route?: HerdrLayout) {
		authorized(authorize);
		if (!this.source) throw new Error("El control de terminal está disponible en el equipo local.");
		const target = await this.source.terminalTarget(paneId, authorize);
		if ((await this.host.identity(target.pid)) !== target.processIdentity)
			throw new Error("La sesión cambió de proceso.");
		if (
			route &&
			(!target.herdrSocketPath ||
				realpathSync(route.herdrSocketPath) !== realpathSync(target.herdrSocketPath) ||
				(await this.host.identity(route.clientPid)) !== route.processIdentity)
		)
			throw new Error("El cliente Herdr cambió.");
		const tree = this.host.tree(route?.clientPid ?? target.pid);
		if (
			!tree.kittyPid ||
			!tree.pids.includes(tree.kittyPid) ||
			tree.names[tree.pids.indexOf(tree.kittyPid)] !== "kitty"
		)
			throw new Error("Esta sesión no está dentro de una ventana Kitty compatible.");
		if (!tree.address)
			throw new Error(
				"Esta ventana no tiene control de ambientes. En Gentle Dot elige Nueva sesión → Abrir en: Terminal → Crear sesión. Tus sesiones actuales siguen funcionando.",
			);
		const kittyIdentity = await this.host.identity(tree.kittyPid);
		if (!kittyIdentity) throw new Error("La instancia de Kitty ya se cerró.");
		const address = this.host.socket(tree.address, tree.kittyPid);
		const matches = kittyWindows(await this.host.run(address, ["ls"], authorize)).filter((window) =>
			tree.pids.includes(window.pid),
		);
		if (
			matches.length !== 1 ||
			!matches[0] ||
			(tree.windowId && tree.windowId !== matches[0].id) ||
			(route && route.kittyWindowId !== matches[0]?.id)
		)
			throw new Error("No se pudo identificar una sola ventana para esta sesión.");
		const window = matches[0];
		const affectedPaneIds = new Set([paneId]);
		for (const peer of target.peers) {
			if (!peer.paneId || peer.pid === target.pid) continue;
			try {
				if (
					(await this.host.identity(peer.pid)) === peer.processIdentity &&
					this.host.tree(peer.pid).pids.includes(window.pid)
				)
					affectedPaneIds.add(peer.paneId);
			} catch {
				/* A closed peer does not change the target. */
			}
		}
		const sharedWindow =
			affectedPaneIds.size > 1 ||
			tree.names.some((name) => /^(herdr|tmux(?::.*)?|zellij|screen)$/.test(name));
		return {
			target,
			address,
			window,
			kittyPid: tree.kittyPid,
			kittyIdentity,
			affectedPaneIds: [...affectedPaneIds].sort(),
			sharedWindow,
		};
	}
	private async invoke(
		binding: Awaited<ReturnType<TerminalMoodController["resolve"]>>,
		mood: TerminalMood | "inspect",
		authorize: () => boolean,
	): Promise<TerminalMoodState> {
		const { target, window, kittyPid, kittyIdentity, address } = binding;
		// Rebind immediately before the fixed bridge; it also checks process ancestry atomically inside Kitty.
		const current = await this.source!.terminalTarget(target.paneId, authorize);
		if (
			["pid", "processIdentity", "sessionId", "instanceId"].some(
				(key) => current[key as keyof Target] !== target[key as keyof Target],
			)
		)
			throw new OrchestrationError("SESSION_CHANGED", "La sesión cambió. Vuelve a seleccionarla.");
		authorized(authorize);
		const result = await this.host.run(
			address,
			[
				"kitten",
				"--match",
				`id:${window.id}`,
				bridgePath,
				JSON.stringify({
					mood,
					windowId: window.id,
					childPid: window.pid,
					kittyPid,
					kittyIdentity,
					pid: target.pid,
					processIdentity: target.processIdentity,
				}),
			],
			authorize,
		);
		if (
			!record(result) ||
			result.ok !== true ||
			result.verified !== true ||
			result.windowId !== window.id ||
			typeof result.canRestore !== "boolean" ||
			!(result.mood === null || ["hacker", "afterlife", "sunset"].includes(result.mood as string))
		)
			throw new OrchestrationError(
				"MOOD_UNCONFIRMED",
				record(result) && typeof result.error === "string"
					? result.error
					: "Kitty no confirmó los colores; revisa la ventana antes de reintentar.",
			);
		if (
			mood !== "inspect" &&
			(result.mood !== (mood === "restore" ? null : mood) || result.canRestore !== (mood !== "restore"))
		)
			throw new OrchestrationError(
				"MOOD_UNCONFIRMED",
				"Los colores devueltos no coinciden con el ambiente solicitado.",
			);
		return {
			available: true,
			paneId: target.paneId,
			scope: "window",
			mood: result.mood as TerminalMoodState["mood"],
			canRestore: result.canRestore,
			windowId: window.id,
			affectedPaneIds: binding.affectedPaneIds,
			sharedWindow: binding.sharedWindow,
			requiresSharedConfirmation: binding.sharedWindow,
			verified: true,
		};
	}
	/** Same exact process/window binding as moods; the fixed bridge reads numeric geometry only. */
	async geometry(pane: string, sessionId: string, authorize: () => boolean, route?: HerdrLayout) {
		const binding = await this.resolve(inputPane(pane), authorize, route);
		const { target, window, kittyPid, kittyIdentity, address } = binding;
		if (target.sessionId !== sessionId) throw new Error("La sesión cambió.");
		const current = await this.source!.terminalTarget(pane, authorize);
		if (
			["pid", "processIdentity", "sessionId", "instanceId"].some(
				(key) => current[key as keyof Target] !== target[key as keyof Target],
			)
		)
			throw new Error("La sesión cambió.");
		const result = await this.host.run(
			address,
			[
				"kitten",
				"--match",
				`id:${window.id}`,
				bridgePath,
				JSON.stringify({
					mood: "geometry",
					windowId: window.id,
					childPid: window.pid,
					kittyPid,
					kittyIdentity,
					pid: route?.clientPid ?? target.pid,
					processIdentity: route?.processIdentity ?? target.processIdentity,
				}),
			],
			authorize,
		);
		if (!record(result) || result.ok !== true || result.verified !== true || result.windowId !== window.id)
			throw new Error("La terminal no confirmó su geometría.");
		return { kittyPid, kittyIdentity, sharedWindow: binding.sharedWindow, geometry: result.geometry };
	}
	async read(pane: unknown, authorize: () => boolean): Promise<TerminalMoodState> {
		const paneId = inputPane(pane);
		try {
			return await this.invoke(await this.resolve(paneId, authorize), "inspect", authorize);
		} catch (error) {
			authorized(authorize);
			if (error instanceof OrchestrationError && error.status === 401) throw error;
			return {
				available: false,
				paneId,
				scope: "window",
				mood: null,
				canRestore: false,
				affectedPaneIds: [paneId],
				sharedWindow: false,
				requiresSharedConfirmation: false,
				reason: error instanceof Error ? error.message : "La terminal no está disponible.",
			};
		}
	}
	async apply(value: unknown, authorize: () => boolean): Promise<TerminalMoodState> {
		const input = terminalMoodInput(value);
		try {
			const binding = await this.resolve(input.paneId, authorize);
			if (binding.sharedWindow && !input.allowSharedWindow)
				throw new OrchestrationError(
					"SHARED_WINDOW",
					"Esta ventana contiene otras sesiones. Confirma el cambio para toda la ventana.",
				);
			return await this.invoke(binding, input.mood, authorize);
		} catch (error) {
			if (error instanceof OrchestrationError) throw error;
			throw new OrchestrationError(
				"MOOD_UNAVAILABLE",
				error instanceof Error ? error.message : "La terminal no está disponible.",
			);
		}
	}
}
