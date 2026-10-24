import { mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writePrivateFile } from "./private-file.ts";
import { runtimeDir } from "./runtime.ts";

const runtime = runtimeDir();
export const COMPLETIONS_EXTENSION_PATH = runtime
	? join(runtime, "daemon", "extensions", "dot-completions.ts")
	: fileURLToPath(new URL("./extensions/dot-completions.ts", import.meta.url));

export interface CompletionEvent {
	requestId?: string;
	id: string;
	at: string;
	type: string;
	paneId?: string;
	sessionId?: string;
	assistantMessageId?: string;
}
export interface CompletionSession {
	paneId: string;
	sessionId?: string;
	label: string;
	state: string;
	connected: boolean;
	capabilities?: { inspect: boolean };
}
export interface CompletionReport {
	id: string;
	paneId: string;
	sessionId: string;
	label: string;
	at: string;
	/** Idle only means the agent stopped answering. It does not certify task success. */
	outcome: "idle" | "error" | "aborted" | "unavailable";
	lastAssistant: string;
	truncated: boolean;
	unavailableReason?: string;
}
export interface CompletionBatch {
	enabled: boolean;
	revision: number;
	reports: CompletionReport[];
}
export interface CompletionReportsOptions {
	dataDir: string;
	snapshot: () => Promise<{ sessions: CompletionSession[] }>;
	inspect: (paneId: string, sessionId: string) => Promise<unknown>;
	now?: () => number;
}
export class CompletionReportsError extends Error {
	readonly status: number;
	constructor(message: string, status = 400) {
		super(message);
		this.status = status;
	}
}
const record = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);
const sessionKey = (event: { paneId: string; sessionId: string }) =>
	JSON.stringify([event.paneId, event.sessionId]);

/** Opt-in, memory-only completion queue. No past snapshots or report contents are persisted. */
export class CompletionReports {
	private readonly options: CompletionReportsOptions;
	private readonly path: string;
	private readonly now: () => number;
	private enabled = false;
	private since: number;
	private generation = 0;
	private closed = false;
	private draining = false;
	private preparing?: Promise<void>;
	private readonly prepared: CompletionReport[] = [];
	private readonly queue: Array<CompletionEvent & { paneId: string; sessionId: string }> = [];
	private readonly seen = new Set<string>();
	private readonly latest = new Map<string, CompletionEvent>();
	private lastError?: string;
	private dropped = 0;

	constructor(options: CompletionReportsOptions) {
		this.options = options;
		this.path = join(options.dataDir, "completion-reports.json");
		this.now = options.now ?? Date.now;
		this.since = this.now();
		try {
			if (statSync(this.path).size > 1024) return;
			const stored: unknown = JSON.parse(readFileSync(this.path, "utf8"));
			this.enabled = record(stored) && stored.version === 1 && stored.enabled === true;
		} catch {
			// A missing or corrupt preference never opts the user in.
		}
	}

	status() {
		return {
			enabled: this.enabled && !this.closed,
			revision: this.generation,
			pending: this.queue.length + this.prepared.length,
			ready: this.prepared.length,
			dropped: this.dropped,
			...(this.lastError ? { error: this.lastError } : {}),
		};
	}

	configure(enabled: unknown) {
		if (typeof enabled !== "boolean")
			throw new CompletionReportsError("Indica si quieres recibir resúmenes.");
		if (this.closed) throw new CompletionReportsError("El servicio de resúmenes está cerrado.", 503);
		// Turning off is immediate even if the disk can no longer persist the preference.
		if (!enabled) this.applyEnabled(false);
		try {
			mkdirSync(this.options.dataDir, { recursive: true, mode: 0o700 });
			writePrivateFile(this.path, `${JSON.stringify({ version: 1, enabled })}\n`);
		} catch {
			throw new CompletionReportsError("No se pudo guardar la preferencia de resúmenes.", 500);
		}
		if (enabled !== this.enabled) this.applyEnabled(enabled);
		return this.status();
	}

	private applyEnabled(enabled: boolean): void {
		this.generation++;
		this.since = this.now();
		this.queue.length = 0;
		this.prepared.length = 0;
		this.seen.clear();
		this.latest.clear();
		this.lastError = undefined;
		this.enabled = enabled;
	}

	/** Called directly by onEvent, including during an in-flight snapshot; never awaits it. */
	onEvent(event: CompletionEvent): void {
		const at = Date.parse(event.at);
		if (
			!this.enabled ||
			this.closed ||
			event.type !== "completed" ||
			!event.paneId ||
			!event.sessionId ||
			!event.id ||
			event.id.length > 256 ||
			event.paneId.length > 512 ||
			event.sessionId.length > 512 ||
			!Number.isFinite(at) ||
			at < this.since ||
			at > this.now() + 60_000 ||
			this.seen.has(event.id)
		)
			return;
		const entry = { ...event, paneId: event.paneId, sessionId: event.sessionId };
		const key = sessionKey(entry);
		const previous = this.latest.get(key);
		if (previous && Date.parse(previous.at) > at) return;
		this.seen.add(event.id);
		if (this.seen.size > 512) {
			const oldest = this.seen.values().next().value;
			if (oldest) this.seen.delete(oldest);
		}
		this.latest.set(key, entry);
		for (let i = this.prepared.length - 1; i >= 0; i--)
			if (sessionKey(this.prepared[i] as CompletionReport) === key) this.prepared.splice(i, 1);
		const queued = this.queue.findIndex((item) => sessionKey(item) === key);
		if (queued !== -1) this.queue.splice(queued, 1);
		this.queue.push(entry);
		if (this.queue.length > 32) {
			const dropped = this.queue.shift();
			if (dropped) this.latest.delete(sessionKey(dropped));
			this.dropped++;
		}
	}

	async take(authorize: () => boolean = () => true): Promise<CompletionBatch> {
		if (this.draining || !this.enabled || this.closed || !authorize())
			return { enabled: this.enabled && !this.closed, revision: this.generation, reports: [] };
		this.draining = true;
		const generation = this.generation;
		const current = () => this.enabled && !this.closed && generation === this.generation && authorize();
		const reports: CompletionReport[] = [];
		try {
			// One inspection keeps provider discovery + inspection within the caller's bounded HTTP wait.
			for (let count = 0; count < 1 && this.queue.length && current(); count++) {
				const event = this.queue.shift();
				if (!event) break;
				const key = sessionKey(event);
				const latest = () => this.latest.get(key)?.id === event.id;
				let label = "Sesión de agente";
				try {
					const snapshot = await this.options.snapshot();
					if (!current()) break;
					if (!latest()) continue;
					const session = snapshot.sessions.find(
						(item) => item.paneId === event.paneId && item.sessionId === event.sessionId,
					);
					if (
						!session?.connected ||
						session.capabilities?.inspect === false ||
						!["idle", "done"].includes(session.state)
					)
						continue;
					label = session.label.slice(0, 256);
					const result = await this.options.inspect(event.paneId, event.sessionId);
					if (!current()) break;
					if (!latest()) continue;
					const report = completionReport(event, session, result);
					if (report) reports.push(report);
					this.lastError = undefined;
				} catch (error) {
					if (
						record(error) &&
						["SESSION_CHANGED", "INSTANCE_CHANGED", "UNBOUND", "NOT_FOUND"].includes(String(error.code))
					)
						continue;
					if (current() && latest()) {
						this.lastError = "No se pudo leer el resultado de una sesión; no se pudo verificar su resultado.";
						reports.push({
							id: event.id,
							paneId: event.paneId,
							sessionId: event.sessionId,
							at: event.at,
							label,
							outcome: "unavailable",
							lastAssistant: "",
							truncated: false,
							unavailableReason: this.lastError,
						});
					}
				} finally {
					if (latest()) this.latest.delete(key);
				}
			}
			return {
				enabled: this.enabled && !this.closed,
				revision: this.generation,
				reports: current() ? reports : [],
			};
		} finally {
			this.draining = false;
		}
	}

	/** Prepare source reads without reserving the one shared model turn. */
	prepare(): void {
		if (this.preparing || this.prepared.length >= 3 || !this.queue.length || !this.enabled || this.closed)
			return;
		const generation = this.generation;
		this.preparing = this.take()
			.then((batch) => {
				if (this.closed || !this.enabled || generation !== this.generation) return;
				for (const report of batch.reports) {
					// A newer event may have arrived between the source read and this continuation.
					if (this.queue.some((event) => sessionKey(event) === sessionKey(report))) continue;
					this.prepared.push(report);
				}
			})
			.catch(() => {
				// Source failures are reported through the existing take() result path.
			})
			.finally(() => {
				this.preparing = undefined;
			});
	}

	/** No network or session IPC while the daemon arbitrates the next model turn. */
	takeReady(authorize: () => boolean = () => true): CompletionBatch {
		const reports = this.enabled && !this.closed && authorize() ? this.prepared.splice(0, 1) : [];
		if (authorize()) this.prepare();
		return { enabled: this.enabled && !this.closed, revision: this.generation, reports };
	}

	close(): void {
		this.closed = true;
		this.generation++;
		this.queue.length = 0;
		this.prepared.length = 0;
		this.seen.clear();
		this.latest.clear();
	}
}

function completionReport(
	event: CompletionEvent & { paneId: string; sessionId: string },
	session: CompletionSession,
	value: unknown,
): CompletionReport | undefined {
	if (
		!record(value) ||
		value.sessionId !== event.sessionId ||
		value.status !== "idle" ||
		value.question ||
		!Array.isArray(value.messages)
	)
		return;
	const messages = value.messages.filter(record);
	const index = messages.findLastIndex((message) => message.role === "assistant");
	const fresh = index >= 0 && index >= messages.findLastIndex((message) => message.role === "user");
	if (!fresh && value.stopReason !== "error" && value.stopReason !== "aborted") return;
	const last = (fresh ? messages[index] : undefined) ?? {};
	if (event.assistantMessageId && last.id !== event.assistantMessageId) return;
	const stopReason = value.stopReason ?? last.stopReason;
	const outcome =
		stopReason === "error" || last.isError === true ? "error" : stopReason === "aborted" ? "aborted" : "idle";
	const content =
		typeof last.content === "string"
			? last.content
			: Array.isArray(last.content)
				? last.content
						.filter(record)
						.filter((part) => part.type === "text" && typeof part.text === "string")
						.map((part) => part.text)
						.join("\n")
				: "";
	const text = content || (typeof last.errorMessage === "string" ? last.errorMessage : "");
	if (!text.trim() && outcome === "idle") return;
	return {
		id: event.id,
		paneId: event.paneId,
		sessionId: event.sessionId,
		label: session.label.slice(0, 256),
		at: event.at,
		outcome,
		lastAssistant:
			text.slice(-16_000) ||
			(outcome === "error"
				? "El agente informó un error sin texto final."
				: "La ejecución fue cancelada sin texto final."),
		truncated: text.length > 16_000,
	};
}
