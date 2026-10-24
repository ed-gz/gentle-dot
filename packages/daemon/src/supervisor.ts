import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { encodeRecord, JsonlDecoder } from "./jsonl.ts";
import { writePrivateFile } from "./private-file.ts";
import type { OsUser } from "./vps.ts";

/** A record the agent wrote to stdout that is not a command response. */
export type AgentRecord = { type: string; [key: string]: unknown };

export type RpcResponse = {
	type: "response";
	id?: string;
	command: string;
	success: boolean;
	data?: unknown;
	error?: string;
};

export type SupervisorState = "stopped" | "starting" | "ready" | "restarting";

export type SupervisorEvent =
	| AgentRecord
	| { type: "supervisor_state"; state: SupervisorState }
	| { type: "interrupted" };

export interface SupervisorOptions {
	/** Executable to run, for example `gentle-shell`. */
	command: string;
	/** Arguments placed before the RPC arguments (used to run a script with node). */
	args?: string[];
	/** Arguments placed after the RPC arguments. */
	extraArgs?: string[];
	cwd: string;
	/** Directory for `sessions/` and `state.json` (the open session and the chains of rotated ones). */
	dataDir: string;
	env?: NodeJS.ProcessEnv;
	/** The user the agent runs as (server mode, S25.8); by default the daemon's own. */
	user?: OsUser;
	/** Runs before every spawn (first start, restart, respawn); returns variables added to `env`. */
	prepareSpawn?: () => NodeJS.ProcessEnv;
	/** Respawn delays; the last value repeats. Default 1s, 2s, 4s, 8s, 16s, 30s. */
	backoffMs?: number[];
	/** Uptime after which the backoff starts over. Default 30s. */
	stableMs?: number;
	/** Deadline for one command response. Default 5 minutes. */
	requestTimeoutMs?: number;
	/** Deadline for the agent to answer its first `get_state`. Default 60s. */
	startTimeoutMs?: number;
	/** Grace period after closing stdin before SIGTERM. Default 5s. */
	stopTimeoutMs?: number;
	/** Consume every new human instruction at the next checkpoint instead of one per model turn. */
	steeringMode?: "all" | "one-at-a-time";
	/** The bundled live-input extension can yield inference without aborting a tool. */
	liveInput?: boolean;
	log?: (line: string) => void;
}

type Pending = {
	resolve: (response: RpcResponse) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
};

const DEFAULT_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];

/**
 * Runs the agent (`gentle-shell --mode rpc`) as a child process, correlates
 * commands with responses, forwards session events, and respawns the agent
 * after an unexpected exit, reopening the same conversation.
 */
export class AgentSupervisor {
	state: SupervisorState = "stopped";
	busy = false;
	sessionFile: string | undefined;
	sessionId: string | undefined;
	model: string | undefined;
	/** Whether the current model accepts images (its `input` lists `image`); undefined when not reported. */
	modelImages: boolean | undefined;

	private child: ChildProcess | undefined;
	/** One initialization owns the child and its RPC handshake at a time. */
	private initialization: Promise<void> | undefined;
	/** Concurrent intentional restarts share one close/spawn operation. */
	private restartOperation: Promise<void> | undefined;
	private readonly pending = new Map<string, Pending>();
	private readonly listeners = new Set<(event: SupervisorEvent) => void>();
	private nextId = 0;
	private liveInputReady = false;
	private inputHandoff = false;
	private inputEpoch = 0;
	private steeringPending = 0;
	/** Count of `agent_settled` records seen, to order them against prompt responses. */
	private settledRuns = 0;
	private attempts = 0;
	private spawnedAt = 0;
	private stopping = false;
	private restarting = false;
	private interrupted = false;
	private restartTimer: NodeJS.Timeout | undefined;
	private closeWaiters: (() => void)[] = [];
	/** For a session started by rotation, the session files it continues, oldest first. */
	private chains: Record<string, string[]> = {};
	private readonly sessionDir: string;
	private readonly stateFile: string;
	private readonly options: SupervisorOptions;

	constructor(options: SupervisorOptions) {
		this.options = options;
		this.sessionDir = join(options.dataDir, "sessions");
		this.stateFile = join(options.dataDir, "state.json");
		this.sessionFile = this.readPersistedSession();
	}

	get pid(): number | undefined {
		return this.child?.pid;
	}

	/** The earlier session files of the open chat, oldest first. */
	get previousSessions(): string[] {
		return (this.sessionFile && this.chains[this.sessionFile]) || [];
	}

	/** Records that `sessionFile` continues the chat held in `previous` (oldest first). */
	linkSessions(sessionFile: string, previous: string[]): void {
		this.chains[sessionFile] = previous;
		if (this.sessionFile) this.persistSession(this.sessionFile);
	}

	onEvent(listener: (event: SupervisorEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Spawns the agent and resolves once it answered `get_state`. */
	async start(): Promise<void> {
		if (this.restartOperation) return this.restartOperation;
		if (this.initialization) return this.initialization;
		if (this.child && this.state === "ready") return;
		this.stopping = false;
		clearTimeout(this.restartTimer);
		this.restartTimer = undefined;
		mkdirSync(this.sessionDir, { recursive: true });
		this.setState("starting");
		await this.initialize();
	}

	/** Sends a command and resolves with its successful response. */
	async request(command: AgentRecord): Promise<RpcResponse> {
		if (this.state !== "ready") throw new Error("Agent is not ready");
		if (["abort", "new_session", "switch_session"].includes(command.type)) this.inputEpoch++;
		const inputEpoch = this.inputEpoch;
		// Cancel any automatic inference handoff before an explicit Stop or session
		// switch. Both commands travel down the same private engine stdin, in order.
		if (command.type === "abort" && this.liveInputReady) {
			await this.rawRequest({ type: "prompt", message: "/dot-live-input cancel" }, 30_000);
		}
		const settledBefore = this.settledRuns;
		// Pi defers `prompt` during settlement, potentially putting a later human
		// message ahead of the one already in steering. Use its native steer RPC
		// throughout the handoff so text and images keep their arrival order.
		const delivered =
			this.liveInputReady &&
			this.inputHandoff &&
			command.type === "prompt" &&
			command.streamingBehavior === "steer"
				? { ...command, type: "steer" }
				: command;
		const response = await this.rawRequest(delivered, this.options.requestTimeoutMs ?? 300_000);
		if (
			this.liveInputReady &&
			inputEpoch === this.inputEpoch &&
			this.steeringPending > 0 &&
			((command.type === "prompt" && command.streamingBehavior === "steer") || command.type === "steer") &&
			(response.data as { disposition?: string } | undefined)?.disposition === "queued"
		) {
			// Only after the engine acknowledges the real message. The extension checks
			// its own phase atomically, so a tool that started since our last event is safe.
			void this.rawRequest({ type: "prompt", message: "/dot-live-input interrupt" }, 300_000).catch(
				(error: Error) => this.log(`live input handoff failed: ${error.message}`),
			);
		}
		// The run may already have settled before this response was handled.
		if (
			command.type === "prompt" &&
			(response.data as { disposition?: string } | undefined)?.disposition === "started" &&
			this.settledRuns === settledBefore
		) {
			this.busy = true;
		}
		if (command.type === "new_session" || command.type === "switch_session") await this.refreshSession();
		// A switch answers with the new model.
		if (command.type === "set_model") this.applyModel(response.data);
		if (command.type === "cycle_model") this.applyModel((response.data as { model?: unknown } | null)?.model);
		return response;
	}

	/** Writes a record that has no response, such as `extension_ui_response`. */
	send(record: AgentRecord): void {
		if (this.state !== "ready" || !this.child?.stdin?.writable) throw new Error("Agent is not ready");
		this.child.stdin.write(encodeRecord(record));
	}

	/**
	 * Replaces the agent process on purpose (for example after new credentials),
	 * reopening the same conversation. Not reported as an interruption.
	 */
	restart(): Promise<void> {
		if (this.restartOperation) return this.restartOperation;
		this.inputEpoch++;
		const operation = this.restartOnce().finally(() => {
			if (this.restartOperation === operation) this.restartOperation = undefined;
		});
		this.restartOperation = operation;
		return operation;
	}

	private async restartOnce(): Promise<void> {
		// Registering the native computer helper can change the tools while the first
		// RPC handshake is still starting. Let that handshake settle before replacing
		// its child; otherwise both startup paths can spawn and overwrite each other.
		if (this.initialization) await this.initialization.catch(() => {});
		const child = this.child;
		if (!child || this.stopping) return;
		clearTimeout(this.restartTimer);
		this.restartTimer = undefined;
		this.restarting = true;
		this.setState("restarting");
		const closed = new Promise<void>((resolve) => this.closeWaiters.push(resolve));
		child.stdin?.end();
		const term = setTimeout(() => child.kill("SIGTERM"), this.options.stopTimeoutMs ?? 5000);
		const kill = setTimeout(() => child.kill("SIGKILL"), (this.options.stopTimeoutMs ?? 5000) + 2000);
		try {
			await closed;
		} finally {
			clearTimeout(term);
			clearTimeout(kill);
		}
		// Stopped while the old process was closing: nothing is started again.
		if (this.stopping) {
			this.setState("stopped");
			return;
		}
		this.setState("restarting");
		await this.initialize();
	}

	async stop(): Promise<void> {
		this.inputEpoch++;
		this.stopping = true;
		clearTimeout(this.restartTimer);
		this.restartTimer = undefined;
		const child = this.child;
		if (!child) {
			this.setState("stopped");
			return;
		}
		const closed = new Promise<void>((resolve) => this.closeWaiters.push(resolve));
		child.stdin?.end();
		const term = setTimeout(() => child.kill("SIGTERM"), this.options.stopTimeoutMs ?? 5000);
		const kill = setTimeout(() => child.kill("SIGKILL"), (this.options.stopTimeoutMs ?? 5000) + 2000);
		await closed;
		clearTimeout(term);
		clearTimeout(kill);
	}

	private initialize(): Promise<void> {
		if (this.initialization) return this.initialization;
		const operation = this.spawnAndInitialize().finally(() => {
			if (this.initialization === operation) this.initialization = undefined;
		});
		this.initialization = operation;
		return operation;
	}

	private async spawnAndInitialize(): Promise<void> {
		this.inputEpoch++;
		this.liveInputReady = false;
		this.inputHandoff = false;
		this.steeringPending = 0;
		const wanted = this.sessionFile;
		let child: ChildProcess | undefined;
		try {
			child = this.spawnChild();
			const state = await this.rawRequest({ type: "get_state" }, this.options.startTimeoutMs ?? 60_000);
			const current = (state.data as { sessionFile?: string } | undefined)?.sessionFile;
			if (wanted && wanted !== current && existsSync(wanted)) {
				await this.rawRequest({ type: "switch_session", sessionPath: wanted }, 30_000);
			}
			if (this.options.steeringMode) {
				await this.rawRequest({ type: "set_steering_mode", mode: this.options.steeringMode }, 30_000);
			}
			if (this.options.liveInput) {
				const commands = await this.rawRequest({ type: "get_commands" }, 30_000);
				const list = (commands.data as { commands?: { name?: string }[] } | undefined)?.commands;
				this.liveInputReady = Array.isArray(list) && list.some((entry) => entry.name === "dot-live-input");
				if (!this.liveInputReady)
					this.log("live input extension unavailable; using native steering checkpoints");
			}
			await this.refreshSession();
		} catch (error) {
			if (child && this.child === child) child.kill("SIGKILL");
			// Preparation/spawn can fail before any child exists to emit close and retry.
			else if (!child && !this.child && !this.stopping) this.scheduleRestart();
			throw error;
		}
		if (this.child !== child) throw new Error("Agent exited during startup");
		this.spawnedAt = Date.now();
		this.setState("ready");
		if (this.interrupted) {
			this.interrupted = false;
			this.emit({ type: "interrupted" });
		}
	}

	private spawnChild(): ChildProcess {
		const { command, args = [], extraArgs = [], cwd, env, prepareSpawn, user } = this.options;
		const child = spawn(command, [...args, "--mode", "rpc", "--session-dir", this.sessionDir, ...extraArgs], {
			cwd,
			env: { ...(env ?? process.env), ...prepareSpawn?.() },
			stdio: ["pipe", "pipe", "pipe"],
			...(user ? { uid: user.uid, gid: user.gid } : {}),
		});
		this.child = child;
		const decoder = new JsonlDecoder(
			(record) => this.handleRecord(record as AgentRecord),
			(line) => this.log(`agent wrote a malformed record: ${line.slice(0, 200)}`),
		);
		child.stdout?.on("data", (chunk: Buffer) => decoder.push(chunk));
		child.stderr?.on("data", (chunk: Buffer) => this.log(chunk.toString("utf8").trimEnd()));
		child.stdin?.on("error", () => {});
		child.on("error", (error) => this.log(`agent process error: ${error.message}`));
		child.on("close", (code, signal) => this.handleClose(child, code, signal));
		return child;
	}

	private rawRequest(command: AgentRecord, timeoutMs: number): Promise<RpcResponse> {
		const child = this.child;
		if (!child?.stdin?.writable) return Promise.reject(new Error("Agent is not ready"));
		const id = `d${++this.nextId}`;
		return new Promise<RpcResponse>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Agent did not answer ${command.type} within ${timeoutMs} ms`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			child.stdin?.write(encodeRecord({ ...command, id }));
		});
	}

	private handleRecord(record: AgentRecord): void {
		if (record.type === "queue_update" && Array.isArray(record.steering)) {
			this.steeringPending = record.steering.length;
		}
		if (
			record.type === "extension_ui_request" &&
			record.method === "setStatus" &&
			record.statusKey === "gentle-dot-live-input"
		) {
			this.inputHandoff = record.statusText === "interrupting";
		}
		if (record.type === "response") {
			const response = record as unknown as RpcResponse;
			const pending = response.id === undefined ? undefined : this.pending.get(response.id);
			if (!pending || response.id === undefined) return;
			this.pending.delete(response.id);
			clearTimeout(pending.timer);
			if (response.success) pending.resolve(response);
			else pending.reject(new Error(response.error ?? `${response.command} failed`));
			return;
		}
		if (record.type === "agent_start") this.busy = true;
		if (record.type === "agent_settled") {
			this.settledRuns += 1;
			this.busy = false;
			void this.refreshSession().catch(() => {});
		}
		this.emit(record);
	}

	private handleClose(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
		if (child !== this.child) return;
		this.child = undefined;
		const reason = new Error(`Agent exited (${signal ?? `code ${code}`})`);
		for (const [id, pending] of this.pending) {
			clearTimeout(pending.timer);
			pending.reject(reason);
			this.pending.delete(id);
		}
		const wasBusy = this.busy;
		this.busy = false;
		if (this.restarting) {
			this.restarting = false;
			for (const resolve of this.closeWaiters.splice(0)) resolve();
			return;
		}
		for (const resolve of this.closeWaiters.splice(0)) resolve();
		if (this.stopping) {
			this.setState("stopped");
			return;
		}
		this.log(`agent exited unexpectedly (${signal ?? `code ${code}`})`);
		if (wasBusy) this.interrupted = true;
		this.scheduleRestart();
	}

	private scheduleRestart(): void {
		// close and a rejected initialization can both request a retry for the same child.
		if (this.stopping || this.restartTimer) return;
		const backoff = this.options.backoffMs ?? DEFAULT_BACKOFF_MS;
		if (this.spawnedAt && Date.now() - this.spawnedAt > (this.options.stableMs ?? 30_000)) this.attempts = 0;
		// A healthy run earns one reset. Failed starts cannot keep reusing its old uptime.
		this.spawnedAt = 0;
		const delay = backoff[Math.min(this.attempts, backoff.length - 1)] ?? 1000;
		this.attempts += 1;
		this.setState("restarting");
		this.restartTimer = setTimeout(() => {
			this.restartTimer = undefined;
			if (this.stopping) return;
			this.initialize().catch((error: Error) => {
				this.log(`agent restart failed: ${error.message}`);
				// A child that is still alive will close and schedule the next attempt.
				if (!this.child && !this.stopping) this.scheduleRestart();
			});
		}, delay);
	}

	private async refreshSession(): Promise<void> {
		const response = await this.rawRequest({ type: "get_state" }, 30_000);
		this.applyState(response.data);
	}

	private applyState(data: unknown): void {
		const state = (data ?? {}) as {
			sessionFile?: string;
			sessionId?: string;
			model?: unknown;
		};
		if (state.model) this.applyModel(state.model);
		if (state.sessionId) this.sessionId = state.sessionId;
		if (state.sessionFile && state.sessionFile !== this.sessionFile) {
			this.sessionFile = state.sessionFile;
		}
		if (this.sessionFile) this.persistSession(this.sessionFile);
	}

	private applyModel(data: unknown): void {
		if (typeof data !== "object" || data === null) return;
		const model = data as { name?: string; id?: string; input?: unknown };
		this.model = model.name ?? model.id;
		this.modelImages = Array.isArray(model.input) ? model.input.includes("image") : undefined;
	}

	private readPersistedSession(): string | undefined {
		try {
			const saved = JSON.parse(readFileSync(this.stateFile, "utf8")) as {
				sessionFile?: string;
				chains?: unknown;
			};
			if (typeof saved.chains === "object" && saved.chains !== null) {
				for (const [file, previous] of Object.entries(saved.chains)) {
					if (Array.isArray(previous) && previous.every((p) => typeof p === "string"))
						this.chains[file] = previous;
				}
			}
			return typeof saved.sessionFile === "string" ? saved.sessionFile : undefined;
		} catch {
			return undefined;
		}
	}

	private persistSession(sessionFile: string): void {
		mkdirSync(this.options.dataDir, { recursive: true });
		writePrivateFile(this.stateFile, `${JSON.stringify({ sessionFile, chains: this.chains })}\n`);
	}

	private setState(state: SupervisorState): void {
		if (this.state === state) return;
		this.state = state;
		this.emit({ type: "supervisor_state", state });
	}

	private emit(event: SupervisorEvent): void {
		for (const listener of this.listeners) listener(event);
	}

	private log(line: string): void {
		if (line) this.options.log?.(line);
	}
}
