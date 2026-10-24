import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CompletionEvent, CompletionSession } from "./completion-reports.ts";
import { writePrivateFile } from "./private-file.ts";
import { runtimeDir } from "./runtime.ts";

const runtime = runtimeDir();
export const WATCH_EXTENSION_PATH = runtime
	? join(runtime, "daemon", "extensions", "dot-watch.ts")
	: fileURLToPath(new URL("./extensions/dot-watch.ts", import.meta.url));

export type WatchCursor = null | boolean | number | string | WatchCursor[] | { [key: string]: WatchCursor };
export interface WatchSession {
	paneId: string;
	sessionId: string;
}
export type WatchSource =
	| { kind: "agents"; sessions?: WatchSession[] }
	| { kind: "email"; connectorId: string };
export interface WatchEvent {
	id: string;
	at: string;
	kind: string;
	title: string;
	summary?: string;
	paneId?: string;
	sessionId?: string;
	messageId?: string;
	url?: string;
}
export interface WatchStatus {
	id: string;
	source: WatchSource;
	instruction: string;
	state: "active" | "paused";
	createdAt: string;
	updatedAt: string;
	pending: number;
	lastEventAt?: string;
	lastCheckedAt?: string;
	lastError?: string;
	nextPollAt?: string;
	intervalMs?: number;
}
export interface WatchWake {
	watchId: string;
	leaseId: string;
	deliveryId: string;
	instruction: string;
	authorizedInstruction: string;
	events: WatchEvent[];
}
export interface WatchBatch {
	watches: WatchStatus[];
	pending: number;
	pollAfterMs: number;
	wake?: WatchWake;
	error?: string;
}
export interface WatcherOptions {
	dataDir: string;
	snapshot: () => Promise<{ sessions: Array<CompletionSession & { assistantMessageId?: string }> }>;
	inspect?: (paneId: string, sessionId: string) => Promise<unknown>;
	email?: (
		connectorId: string,
		cursor: WatchCursor | undefined,
		signal: AbortSignal,
	) => Promise<{ cursor: WatchCursor; events: WatchEvent[] }>;
	now?: () => number;
	pollMs?: number;
	debounceMs?: number;
	isFollowed?: (paneId: string, sessionId: string) => boolean;
}
interface Lease {
	id: string;
	deliveryId: string;
	eventIds: string[];
	expiresAt: number;
	startedAt: number;
}
interface PreparedWatch {
	revision: number;
	events: WatchEvent[];
	enriched: WatchEvent[];
}
interface StoredWatch extends Omit<WatchStatus, "pending" | "nextPollAt"> {
	authorization: string;
	cursor?: WatchCursor;
	baseline: Record<string, string>;
	since: string;
	outbox: WatchEvent[];
	seen: string[];
	readyAt: number;
	nextPoll: number;
	sourceFailures: number;
	deliveryFailures: number;
	claimOrder: number;
	revision: number;
	batch?: string[];
	lease?: Lease;
}
const MAX_STATE_BYTES = 4 * 1024 * 1024;
const MAX_CURSOR_BYTES = 128 * 1024;
const MAX_OUTBOX = 128;
const MAX_BATCH = 20;
const record = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);
const stamp = (now: number) => new Date(now).toISOString();
const sessionKey = (value: WatchSession) => JSON.stringify([value.paneId, value.sessionId]);
const scoped = (source: WatchSource, value: WatchSession) =>
	source.kind === "agents" &&
	(!source.sessions || source.sessions.some((session) => sessionKey(session) === sessionKey(value)));
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function interval(value: unknown): number {
	if (!Number.isSafeInteger(value) || Number(value) < 60_000 || Number(value) > 3_600_000)
		throw new WatcherError("El intervalo debe estar entre un minuto y una hora.");
	return Number(value);
}
function text(value: unknown, field: string, limit = 512): string {
	if (typeof value !== "string" || !value.trim() || value.length > limit || value.includes("\0"))
		throw new WatcherError(`El campo ${field} no es válido.`);
	return value.trim();
}
export class WatcherError extends Error {
	readonly status: number;
	constructor(message: string, status = 400) {
		super(message);
		this.status = status;
	}
}

/** Only construct this with mapped, user-safe text; never pass through a remote server's raw error. */
export class WatchSourceError extends Error {
	readonly code: string;
	readonly retryable: boolean;
	constructor(code: string, userSafeMessage: string, retryable = false) {
		super(text(userSafeMessage, "sourceError", 1000));
		this.code = text(code, "sourceErrorCode", 64);
		this.retryable = retryable;
	}
}

/** Durable event outbox. Source probes and status reads never invoke the language model. */
export class Watchers {
	private readonly options: WatcherOptions;
	private readonly path: string;
	private readonly now: () => number;
	private readonly pollMs: number;
	private readonly debounceMs: number;
	private readonly watches = new Map<string, StoredWatch>();
	private readonly probes = new Map<string, AbortController>();
	private readonly recent: Array<{ sequence: number; event: CompletionEvent; handled: boolean }> = [];
	private closed = false;
	private creating = false;
	private claiming = false;
	private readonly preparing = new Map<string, Promise<void>>();
	private readonly prepared = new Map<string, PreparedWatch>();
	private sequence = 0;
	private eventSequence = 0;
	private agentRecoveryAt = Number.POSITIVE_INFINITY;
	private probingAgents = false;
	private engine?: { id: string; startedAt: number };
	private storageError?: string;
	constructor(options: WatcherOptions) {
		this.options = options;
		this.now = options.now ?? Date.now;
		this.pollMs = Math.max(60_000, options.pollMs ?? 120_000);
		this.debounceMs = Math.max(0, options.debounceMs ?? 2000);
		this.path = join(options.dataDir, "watchers.json");
		try {
			const stat = lstatSync(this.path);
			if (
				!stat.isFile() ||
				stat.isSymbolicLink() ||
				stat.nlink !== 1 ||
				stat.size > MAX_STATE_BYTES ||
				stat.mode & 0o077 ||
				(process.getuid && stat.uid !== process.getuid())
			)
				throw new Error("Unsafe watcher state");
			const saved: unknown = JSON.parse(readFileSync(this.path, "utf8"));
			if (!record(saved) || saved.version !== 1 || !Array.isArray(saved.watches) || saved.watches.length > 16)
				throw new Error("Invalid watcher state");
			if (
				record(saved.engine) &&
				typeof saved.engine.id === "string" &&
				Number.isSafeInteger(saved.engine.startedAt)
			)
				this.engine = { id: saved.engine.id, startedAt: Number(saved.engine.startedAt) };
			for (const candidate of saved.watches) {
				if (
					!record(candidate) ||
					typeof candidate.id !== "string" ||
					!["active", "paused"].includes(String(candidate.state)) ||
					!Array.isArray(candidate.outbox) ||
					candidate.outbox.length > MAX_OUTBOX ||
					!Array.isArray(candidate.seen) ||
					candidate.seen.length > 512 ||
					!record(candidate.baseline) ||
					!Number.isFinite(candidate.readyAt) ||
					!Number.isFinite(candidate.nextPoll) ||
					!Number.isSafeInteger(candidate.claimOrder) ||
					!Number.isSafeInteger(candidate.revision) ||
					(candidate.batch !== undefined &&
						(!Array.isArray(candidate.batch) ||
							candidate.batch.length > MAX_BATCH ||
							!candidate.batch.every((id) => typeof id === "string" && id.length <= 256)))
				)
					throw new Error("Invalid watcher record");
				this.source(candidate.source);
				if (candidate.intervalMs !== undefined) interval(candidate.intervalMs);
				text(candidate.instruction, "instruction", 4000);
				text(candidate.authorization, "authorization", 100_000);
				if (!Number.isFinite(Date.parse(String(candidate.since))))
					throw new Error("Invalid watcher baseline");
				for (const event of candidate.outbox) this.event(event);
				if (candidate.cursor !== undefined) this.cursor(candidate.cursor);
				const watch = candidate as unknown as StoredWatch;
				this.sequence = Math.max(this.sequence, watch.claimOrder);
				if (watch.lease) {
					watch.batch ??= watch.lease.eventIds;
					delete watch.lease;
					watch.readyAt = this.now() + 15_000;
				}
				if (
					watch.batch !== undefined &&
					(!Array.isArray(watch.batch) ||
						watch.batch.length > MAX_BATCH ||
						new Set(watch.batch).size !== watch.batch.length ||
						!watch.batch.every((id) => watch.outbox.some((event) => event.id === id)))
				)
					throw new Error("Saved delivery does not match the pending outbox");
				this.watches.set(watch.id, watch);
				if (watch.state === "active" && watch.source.kind === "agents") this.agentRecoveryAt = this.now();
			}
			this.save();
		} catch (error) {
			if (!record(error) || error.code !== "ENOENT") {
				this.watches.clear();
				this.storageError = "No se pudo recuperar la vigilancia guardada; está detenida.";
			}
		}
	}
	private ensure(authorize: () => boolean = () => true) {
		if (this.closed || this.storageError)
			throw new WatcherError(this.storageError ?? "La vigilancia está cerrada.", 503);
		if (!authorize()) throw new WatcherError("La autorización ya no está vigente.", 401);
	}
	private save() {
		try {
			const data = `${JSON.stringify({ version: 1, engine: this.engine, watches: [...this.watches.values()] })}\n`;
			if (Buffer.byteLength(data) > MAX_STATE_BYTES) throw new Error("Watcher quota exceeded");
			mkdirSync(this.options.dataDir, { recursive: true, mode: 0o700 });
			writePrivateFile(this.path, data);
		} catch {
			this.storageError =
				"No se pudo guardar la vigilancia. Está detenida para conservar los eventos pendientes.";
			throw new WatcherError(this.storageError, 503);
		}
	}
	private source(value: unknown): WatchSource {
		if (!record(value)) throw new WatcherError("Selecciona una fuente de eventos.");
		if (value.kind === "email")
			return { kind: "email", connectorId: text(value.connectorId, "connectorId", 256) };
		if (value.kind !== "agents") throw new WatcherError("Fuente de vigilancia no admitida.");
		if (value.sessions === undefined) return { kind: "agents" };
		if (!Array.isArray(value.sessions) || !value.sessions.length || value.sessions.length > 32)
			throw new WatcherError("Selecciona de una a 32 sesiones.");
		const sessions = value.sessions.map((item) => {
			if (!record(item)) throw new WatcherError("Sesión inválida.");
			return { paneId: text(item.paneId, "paneId"), sessionId: text(item.sessionId, "sessionId") };
		});
		if (new Set(sessions.map(sessionKey)).size !== sessions.length)
			throw new WatcherError("Hay sesiones repetidas.");
		return { kind: "agents", sessions: sessions.sort((a, b) => sessionKey(a).localeCompare(sessionKey(b))) };
	}
	private cursor(value: unknown): WatchCursor {
		const encoded = JSON.stringify(value);
		if (!encoded || Buffer.byteLength(encoded) > MAX_CURSOR_BYTES)
			throw new WatcherError("El cursor de correo excede el tamaño permitido.");
		return JSON.parse(encoded) as WatchCursor;
	}
	private event(value: unknown): WatchEvent {
		if (!record(value) || !Number.isFinite(Date.parse(String(value.at))))
			throw new WatcherError("Evento inválido.");
		return {
			id: text(value.id, "id", 256),
			at: String(value.at),
			kind: text(value.kind, "kind", 64),
			title: text(value.title, "title", 512),
			...(typeof value.summary === "string" && value.summary
				? { summary: value.summary.slice(0, 2000) }
				: {}),
			...(value.paneId !== undefined ? { paneId: text(value.paneId, "paneId") } : {}),
			...(value.sessionId !== undefined ? { sessionId: text(value.sessionId, "sessionId") } : {}),
			...(value.messageId !== undefined ? { messageId: text(value.messageId, "messageId", 256) } : {}),
			...(typeof value.url === "string" && /^https?:\/\//.test(value.url) && value.url.length <= 2048
				? { url: value.url }
				: {}),
		};
	}
	private public(watch: StoredWatch): WatchStatus {
		return {
			id: watch.id,
			source: structuredClone(watch.source),
			instruction: watch.instruction,
			state: watch.state,
			createdAt: watch.createdAt,
			updatedAt: watch.updatedAt,
			pending: watch.outbox.length,
			...(watch.source.kind === "email" ? { intervalMs: watch.intervalMs ?? this.pollMs } : {}),
			...(watch.lastEventAt ? { lastEventAt: watch.lastEventAt } : {}),
			...(watch.lastCheckedAt ? { lastCheckedAt: watch.lastCheckedAt } : {}),
			...(watch.lastError ? { lastError: watch.lastError } : {}),
			...(watch.source.kind === "email" && watch.state === "active"
				? { nextPollAt: stamp(watch.nextPoll) }
				: {}),
		};
	}
	status(): WatchBatch {
		const watches = [...this.watches.values()].map((watch) => this.public(watch));
		const readyAt = [...this.watches.values()]
			.filter((watch) => watch.state === "active" && watch.outbox.length && !watch.lease)
			.map((watch) => watch.readyAt);
		return {
			watches,
			pending: watches.reduce((sum, watch) => sum + watch.pending, 0),
			pollAfterMs: readyAt.length
				? Math.max(1000, Math.min(15_000, Math.min(...readyAt) - this.now()))
				: watches.some((watch) => watch.state === "active")
					? 15_000
					: 60_000,
			...(this.storageError ? { error: this.storageError } : {}),
		};
	}
	/** In-memory admission check for the shared engine's mutually exclusive claim routes. */
	hasDelivery(): boolean {
		return [...this.watches.values()].some(
			(watch) => watch.state === "active" && watch.lease && watch.lease.expiresAt > this.now(),
		);
	}
	private enqueue(watch: StoredWatch, event: WatchEvent): boolean {
		if (watch.seen.includes(event.id) || watch.outbox.some((item) => item.id === event.id)) return false;
		if (watch.outbox.length >= MAX_OUTBOX)
			throw new WatcherError(
				"Hay demasiados eventos pendientes; se conserva el cursor hasta que Dot los revise.",
				429,
			);
		if (!watch.outbox.length) watch.readyAt = this.now() + this.debounceMs;
		watch.outbox.push(event);
		watch.lastEventAt = event.at;
		watch.updatedAt = stamp(this.now());
		return true;
	}
	private agentEvent(watch: StoredWatch, event: CompletionEvent, handled = false): boolean {
		if (
			!event.paneId ||
			!event.sessionId ||
			!scoped(watch.source, { paneId: event.paneId, sessionId: event.sessionId }) ||
			Date.parse(event.at) < Date.parse(watch.since)
		)
			return false;
		const key = digest([event.paneId, event.sessionId, event.type]);
		const identity = event.type === "completed" ? event.assistantMessageId : event.requestId;
		if (identity && watch.baseline[key] === identity) return false;
		const added =
			handled || this.options.isFollowed?.(event.paneId, event.sessionId)
				? false
				: this.enqueue(
						watch,
						this.event({
							id: event.id,
							at: event.at,
							kind: event.type,
							title:
								event.type === "completed"
									? "El agente terminó una respuesta"
									: event.type === "attention"
										? "El agente necesita una decisión"
										: "El agente se desconectó",
							paneId: event.paneId,
							sessionId: event.sessionId,
							messageId: event.assistantMessageId,
						}),
					);
		if (identity) {
			watch.baseline[key] = identity;
			const keys = Object.keys(watch.baseline);
			for (const key of keys.slice(0, Math.max(0, keys.length - 512))) delete watch.baseline[key];
		}
		return added;
	}
	/** Workflow-owned events are deliberately not duplicated as another notification turn. */
	onEvent(event: CompletionEvent, handledByWorkflow = false): boolean {
		if (
			this.closed ||
			this.storageError ||
			!["completed", "attention", "disconnected"].includes(event.type) ||
			!event.id ||
			event.id.length > 256 ||
			!Number.isFinite(Date.parse(event.at)) ||
			Date.parse(event.at) > this.now() + 60_000
		)
			return false;
		this.recent.push({ sequence: ++this.eventSequence, event: { ...event }, handled: handledByWorkflow });
		if (this.recent.length > 256) this.recent.shift();
		let changed = false;
		let handled = false;
		try {
			for (const watch of this.watches.values()) {
				if (
					watch.state !== "active" ||
					!event.paneId ||
					!event.sessionId ||
					!scoped(watch.source, { paneId: event.paneId, sessionId: event.sessionId })
				)
					continue;
				handled = true;
				const before = JSON.stringify(watch.baseline);
				changed =
					this.agentEvent(watch, event, handledByWorkflow) ||
					before !== JSON.stringify(watch.baseline) ||
					changed;
			}
			if (changed) this.save();
		} catch (error) {
			if (error instanceof WatcherError && !this.storageError) {
				for (const watch of this.watches.values())
					if (watch.state === "active" && watch.source.kind === "agents") watch.lastError = error.message;
				try {
					this.save();
				} catch {
					/* A storage error disables future deliveries. */
				}
			}
		}
		return handled;
	}
	private async baseline(source: WatchSource): Promise<Record<string, string>> {
		if (source.kind !== "agents") return {};
		const snapshot = await this.options.snapshot();
		if (
			source.sessions?.some(
				(target) =>
					!snapshot.sessions.some(
						(session) =>
							session.connected && session.sessionId === target.sessionId && session.paneId === target.paneId,
					),
			)
		)
			throw new WatcherError("Una sesión seleccionada ya no está conectada.", 409);
		const baseline: Record<string, string> = {};
		for (const session of snapshot.sessions.slice(-512))
			if (session.sessionId && scoped(source, { paneId: session.paneId, sessionId: session.sessionId }))
				baseline[digest([session.paneId, session.sessionId, "completed"])] = session.assistantMessageId ?? "";
		return baseline;
	}
	private async recoverAgents(authorize: () => boolean) {
		if (
			this.probingAgents ||
			this.agentRecoveryAt > this.now() ||
			![...this.watches.values()].some((watch) => watch.state === "active" && watch.source.kind === "agents")
		)
			return;
		this.probingAgents = true;
		const revision = this.eventSequence;
		const watches = [...this.watches.values()]
			.filter((watch) => watch.state === "active" && watch.source.kind === "agents")
			.map((watch) => ({ watch, revision: watch.revision }));
		try {
			const snapshot = await this.options.snapshot();
			this.ensure(authorize);
			if (revision !== this.eventSequence) {
				this.agentRecoveryAt = this.now() + 15_000;
				return;
			}
			for (const { watch, revision } of watches) {
				if (watch.revision !== revision || watch.state !== "active" || !this.watches.has(watch.id)) continue;
				for (const session of snapshot.sessions.slice(-512)) {
					if (
						!session.sessionId ||
						!scoped(watch.source, { paneId: session.paneId, sessionId: session.sessionId })
					)
						continue;
					const key = digest([session.paneId, session.sessionId, "completed"]);
					if (
						session.assistantMessageId &&
						Object.hasOwn(watch.baseline, key) &&
						watch.baseline[key] !== session.assistantMessageId &&
						session.connected &&
						["idle", "done"].includes(session.state)
					)
						this.agentEvent(watch, {
							id: `recovered:${digest([session.paneId, session.sessionId, session.assistantMessageId])}`,
							at: stamp(this.now()),
							type: "completed",
							paneId: session.paneId,
							sessionId: session.sessionId,
							assistantMessageId: session.assistantMessageId,
						});
					else if (!Object.hasOwn(watch.baseline, key))
						watch.baseline[key] = session.assistantMessageId ?? "";
				}
				watch.lastCheckedAt = stamp(this.now());
				delete watch.lastError;
			}
			this.agentRecoveryAt = this.now() + 5 * 60_000;
			this.save();
		} catch {
			this.agentRecoveryAt = this.now() + 60_000;
			if (!this.closed && !this.storageError && authorize()) {
				for (const { watch, revision } of watches)
					if (watch.revision === revision && watch.state === "active" && this.watches.has(watch.id))
						watch.lastError = "No se pudo revisar el estado de los agentes. Se reintentará automáticamente.";
				this.save();
			}
		} finally {
			this.probingAgents = false;
		}
	}
	/** Independent sources never serialize on a mailbox; at most two email probes run at once. */
	async tick(authorize: () => boolean = () => true): Promise<void> {
		this.ensure(authorize);
		const recovery = this.recoverAgents(authorize);
		const watch = [...this.watches.values()]
			.filter(
				(item) =>
					item.state === "active" &&
					item.source.kind === "email" &&
					item.nextPoll <= this.now() &&
					!this.probes.has(item.id),
			)
			.sort((a, b) => a.nextPoll - b.nextPoll)[0];
		await Promise.all([
			recovery,
			watch && this.probes.size < 2 ? this.probeEmail(watch, authorize) : Promise.resolve(),
		]);
	}
	private async probeEmail(watch: StoredWatch, authorize: () => boolean): Promise<void> {
		if (watch.source.kind !== "email") return;
		const revision = watch.revision;
		const controller = new AbortController();
		this.probes.set(watch.id, controller);
		let timer: ReturnType<typeof setTimeout> | undefined;
		let timedOut = false;
		try {
			if (!this.options.email) throw new WatcherError("La conexión de correo no está disponible.");
			const result = await Promise.race([
				this.options.email(
					watch.source.connectorId,
					watch.cursor === undefined ? undefined : structuredClone(watch.cursor),
					controller.signal,
				),
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(() => {
						timedOut = true;
						controller.abort();
						reject(new Error("Source timed out"));
					}, 20_000);
					timer.unref?.();
				}),
			]);
			this.ensure(authorize);
			if (
				controller.signal.aborted ||
				watch.revision !== revision ||
				watch.state !== "active" ||
				!this.watches.has(watch.id)
			)
				return;
			const cursor = this.cursor(result.cursor);
			if (!Array.isArray(result.events) || result.events.length > MAX_BATCH)
				throw new WatcherError("La conexión devolvió demasiados eventos.");
			const events = result.events.map((event) => this.event(event));
			if (watch.cursor !== undefined) {
				const fresh = events.filter(
					(event) => !watch.seen.includes(event.id) && !watch.outbox.some((item) => item.id === event.id),
				);
				if (watch.outbox.length + fresh.length > MAX_OUTBOX)
					throw new WatcherError(
						"Hay demasiados eventos pendientes; se conserva el cursor hasta que Dot los revise.",
					);
				for (const event of events) this.enqueue(watch, event);
			}
			watch.cursor = cursor;
			watch.lastCheckedAt = stamp(this.now());
			watch.nextPoll = this.now() + (watch.intervalMs ?? this.pollMs);
			watch.sourceFailures = 0;
			delete watch.lastError;
			this.save();
		} catch (error) {
			if (
				this.closed ||
				this.storageError ||
				(controller.signal.aborted && !timedOut) ||
				watch.revision !== revision ||
				!authorize() ||
				!this.watches.has(watch.id)
			)
				return;
			watch.sourceFailures = Math.min(8, watch.sourceFailures + 1);
			watch.lastError =
				error instanceof WatchSourceError
					? error.message
					: "No se pudo revisar la fuente. Se reintentará automáticamente sin generar avisos repetidos.";
			if (error instanceof WatchSourceError && !error.retryable) {
				watch.state = "paused";
				watch.revision++;
				delete watch.lease;
			}
			watch.lastCheckedAt = stamp(this.now());
			watch.nextPoll =
				this.now() +
				Math.min(
					Math.max(30 * 60_000, watch.intervalMs ?? this.pollMs),
					(watch.intervalMs ?? this.pollMs) * 2 ** (watch.sourceFailures - 1),
				);
			this.save();
		} finally {
			if (timer) clearTimeout(timer);
			this.probes.delete(watch.id);
		}
	}
	private expire() {
		let changed = false;
		for (const watch of this.watches.values())
			if (watch.lease && watch.lease.expiresAt <= this.now()) {
				this.release(watch, false);
				changed = true;
			}
		if (changed) this.save();
	}
	private release(watch: StoredWatch, settled: boolean) {
		const lease = watch.lease;
		if (!lease) return;
		delete watch.lease;
		if (settled) {
			delete watch.batch;
			watch.outbox = watch.outbox.filter((event) => !lease.eventIds.includes(event.id));
			watch.seen = [...new Set([...watch.seen, ...lease.eventIds])].slice(-512);
			watch.deliveryFailures = 0;
			watch.readyAt = this.now() + this.debounceMs;
		} else {
			watch.deliveryFailures++;
			watch.readyAt = this.now() + 15_000 * 2 ** Math.min(5, watch.deliveryFailures - 1);
			if (watch.deliveryFailures >= 3) {
				watch.state = "paused";
				watch.lastError = "Dot no pudo entregar los avisos tras tres intentos; los eventos siguen guardados.";
			}
		}
		watch.updatedAt = stamp(this.now());
	}
	private async enrich(event: WatchEvent): Promise<WatchEvent> {
		if (event.kind !== "completed" || !event.paneId || !event.sessionId || !this.options.inspect)
			return event;
		try {
			const value = await this.options.inspect(event.paneId, event.sessionId);
			if (
				!record(value) ||
				value.sessionId !== event.sessionId ||
				value.status !== "idle" ||
				value.question ||
				!Array.isArray(value.messages)
			)
				return event;
			const messages = value.messages.filter(record);
			const index = messages.findLastIndex((message) => message.role === "assistant");
			if (index < 0 || index < messages.findLastIndex((message) => message.role === "user")) return event;
			const last = messages[index];
			if (!last || (event.messageId && last.id !== event.messageId)) return event;
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
			return content ? { ...event, summary: content.slice(-4000) } : event;
		} catch {
			return event;
		}
	}
	private batchEvents(watch: StoredWatch): WatchEvent[] {
		return watch.batch?.length
			? watch.outbox.filter((event) => watch.batch?.includes(event.id))
			: watch.outbox.slice(0, MAX_BATCH);
	}
	private preparedCurrent(watch: StoredWatch, prepared: PreparedWatch): boolean {
		const current = this.batchEvents(watch);
		return (
			!this.closed &&
			!this.storageError &&
			this.watches.get(watch.id) === watch &&
			watch.state === "active" &&
			!watch.lease &&
			watch.revision === prepared.revision &&
			prepared.events.length > 0 &&
			current.length === prepared.events.length &&
			current.every((event, index) => event === prepared.events[index])
		);
	}
	/** Read reports without reserving the model; transcripts remain only in bounded memory. */
	prepare(): Promise<void> {
		if (this.closed || this.storageError) return Promise.resolve();
		for (const [id, prepared] of this.prepared) {
			const watch = this.watches.get(id);
			if (!watch || !this.preparedCurrent(watch, prepared)) this.prepared.delete(id);
		}
		for (const watch of [...this.watches.values()].sort((a, b) => a.claimOrder - b.claimOrder)) {
			if (this.preparing.size >= 2 || this.prepared.size + this.preparing.size >= 4) break;
			if (
				watch.state !== "active" ||
				watch.lease ||
				!watch.outbox.length ||
				watch.readyAt > this.now() + this.debounceMs ||
				this.preparing.has(watch.id) ||
				this.prepared.has(watch.id)
			)
				continue;
			const events = this.batchEvents(watch);
			if (!events.length) continue;
			const prepared: PreparedWatch = { revision: watch.revision, events, enriched: [] };
			let failed = false;
			const reading = (async () => {
				for (let start = 0; start < events.length; start += 4) {
					if (!this.preparedCurrent(watch, prepared)) return;
					prepared.enriched.push(
						...(await Promise.all(events.slice(start, start + 4).map((event) => this.enrich(event)))),
					);
				}
				if (this.preparedCurrent(watch, prepared)) this.prepared.set(watch.id, prepared);
			})()
				.catch(() => {
					// Leave the durable outbox intact for the next preparation attempt.
					failed = true;
				})
				.finally(() => {
					this.preparing.delete(watch.id);
					// Events may arrive during the read; refresh the batch without holding a lease.
					if (!failed) void this.prepare();
				});
			this.preparing.set(watch.id, reading);
		}
		return Promise.all(this.preparing.values()).then(() => {});
	}
	async poll(take: boolean, authorize: () => boolean = () => true): Promise<WatchBatch> {
		this.ensure(authorize);
		if (!take) return this.status();
		this.expire();
		// Sources and report reads run independently. Claiming a shared model turn
		// only consumes a prepared batch and persists its lease, with no adapter IO.
		void this.prepare();
		if (this.claiming || [...this.watches.values()].some((watch) => watch.lease)) return this.status();
		const watch = [...this.watches.values()]
			.filter((item) => {
				const prepared = this.prepared.get(item.id);
				return prepared && item.readyAt <= this.now() && this.preparedCurrent(item, prepared);
			})
			.sort((a, b) => a.claimOrder - b.claimOrder)[0];
		const prepared = watch && this.prepared.get(watch.id);
		if (!watch || !prepared) return this.status();
		this.claiming = true;
		try {
			const eventIds = prepared.events.map((event) => event.id);
			watch.batch = eventIds;
			const lease: Lease = {
				id: randomUUID(),
				deliveryId: digest([watch.id, eventIds]),
				eventIds,
				expiresAt: this.now() + 10 * 60_000,
				startedAt: this.now(),
			};
			watch.lease = lease;
			watch.claimOrder = ++this.sequence;
			this.prepared.delete(watch.id);
			this.save();
			return {
				...this.status(),
				wake: {
					watchId: watch.id,
					leaseId: lease.id,
					deliveryId: lease.deliveryId,
					instruction: watch.instruction,
					authorizedInstruction: watch.authorization,
					events: prepared.enriched,
				},
			};
		} finally {
			this.claiming = false;
		}
	}
	async dispatch(
		value: unknown,
		actor: "human" | "agent",
		authorize: () => boolean = () => true,
	): Promise<unknown> {
		this.ensure(authorize);
		if (!record(value)) throw new WatcherError("Solicitud de vigilancia inválida.");
		if (value.action === "list") return this.status();
		if (value.action === "recoverEngine") {
			if (actor !== "agent") throw new WatcherError("Acción interna del motor.", 403);
			const id = text(value.engineId, "engineId", 128);
			if (
				typeof value.startedAt !== "number" ||
				!Number.isSafeInteger(value.startedAt) ||
				value.startedAt < 0 ||
				value.startedAt > this.now() + 60_000
			)
				throw new WatcherError("Identidad temporal inválida.");
			if (this.engine?.id === id) return { recovered: true };
			if (this.engine && value.startedAt < this.engine.startedAt)
				throw new WatcherError("El motor pertenece a una sesión anterior.", 409);
			this.engine = { id, startedAt: value.startedAt };
			for (const watch of this.watches.values())
				if (watch.lease) {
					delete watch.lease;
					watch.readyAt = this.now() + 15_000;
				}
			this.save();
			return { recovered: true };
		}
		if (value.action === "acknowledge" || value.action === "heartbeat") {
			if (actor !== "agent") throw new WatcherError("Acción interna del motor.", 403);
			this.expire();
			const watch = [...this.watches.values()].find((item) => item.lease?.id === value.leaseId);
			if (value.action === "heartbeat") {
				if (!watch?.lease || watch.state !== "active")
					throw new WatcherError("El aviso ya no está autorizado.", 409);
				const expiry = Math.min(this.now() + 10 * 60_000, watch.lease.startedAt + 30 * 60_000);
				if (expiry - watch.lease.expiresAt >= 60_000) {
					watch.lease.expiresAt = expiry;
					this.save();
				}
				return { active: true };
			}
			if (!["settled", "error", "delivery_failed", "interrupted"].includes(String(value.outcome)))
				throw new WatcherError("Confirmación inválida.");
			if (watch) {
				// An explicit human interruption dismisses this report; future events remain subscribed.
				this.release(watch, value.outcome === "settled" || value.outcome === "interrupted");
				this.save();
			}
			return { acknowledged: true };
		}
		if (value.action === "start") {
			if (this.creating) throw new WatcherError("Hay otra vigilancia registrándose.", 429);
			this.creating = true;
			try {
				const source = this.source(value.source);
				const instruction = text(value.instruction, "instruction", 4000);
				const authorization =
					actor === "human" ? instruction : text(value.authorization, "authorization", 100_000);
				const intervalMs = value.intervalMs === undefined ? undefined : interval(value.intervalMs);
				if (source.kind !== "email" && intervalMs !== undefined)
					throw new WatcherError("Las sesiones se observan por eventos, sin un intervalo de correo.");
				if (this.watches.size >= 16) throw new WatcherError("Se alcanzó el límite de 16 vigilancias.", 409);
				if (source.kind === "email" && !this.options.email)
					throw new WatcherError("La vigilancia de correo no está disponible.", 409);
				if (
					[...this.watches.values()].some((watch) => {
						if (watch.source.kind !== source.kind) return false;
						if (source.kind === "email")
							return watch.source.kind === "email" && watch.source.connectorId === source.connectorId;
						return (
							watch.source.kind === "agents" &&
							(!source.sessions ||
								!watch.source.sessions ||
								source.sessions.some((session) => scoped(watch.source, session)))
						);
					})
				)
					throw new WatcherError(
						"Esta cuenta o alguna sesión ya está incluida en otra tarea. Reanúdala o elimínala antes de crear otra.",
						409,
					);
				const startedAt = stamp(this.now());
				const eventSequence = this.eventSequence;
				const baseline = await this.baseline(source);
				this.ensure(authorize);
				const watch: StoredWatch = {
					id: randomUUID(),
					source,
					instruction,
					authorization,
					...(intervalMs !== undefined ? { intervalMs } : {}),
					state: "active",
					createdAt: startedAt,
					updatedAt: startedAt,
					since: startedAt,
					baseline,
					outbox: [],
					seen: [],
					readyAt: 0,
					nextPoll: this.now(),
					sourceFailures: 0,
					deliveryFailures: 0,
					claimOrder: 0,
					revision: 0,
				};
				// Events arriving during the baseline read are real changes, even if the snapshot already includes them.
				for (const { event, handled } of this.recent.filter((entry) => entry.sequence > eventSequence)) {
					if (event.paneId && event.sessionId)
						delete watch.baseline[digest([event.paneId, event.sessionId, event.type])];
					this.agentEvent(watch, event, handled);
				}
				if (source.kind === "agents")
					this.agentRecoveryAt = Math.min(this.agentRecoveryAt, this.now() + 5 * 60_000);
				this.watches.set(watch.id, watch);
				this.save();
				return this.public(watch);
			} finally {
				this.creating = false;
			}
		}
		const watch = this.watches.get(text(value.watchId, "watchId"));
		if (!watch) throw new WatcherError("No existe esa vigilancia.", 404);
		if (value.action === "pause" || value.action === "delete") {
			watch.revision++;
			watch.state = "paused";
			this.prepared.delete(watch.id);
			delete watch.lease;
			this.probes.get(watch.id)?.abort();
			if (value.action === "delete") this.watches.delete(watch.id);
		} else if (value.action === "resume") {
			if (actor === "agent" && (value.authorization === undefined || value.leaseId || watch.lease))
				throw new WatcherError("Sólo una instrucción humana verificada permite reanudar.", 403);
			if (actor === "agent") text(value.authorization, "authorization", 100_000);
			if (watch.state !== "paused") throw new WatcherError("La vigilancia ya está activa.", 409);
			const revision = watch.revision;
			const since = stamp(this.now());
			const eventSequence = this.eventSequence;
			const baseline = await this.baseline(watch.source);
			this.ensure(authorize);
			if (!this.watches.has(watch.id) || revision !== watch.revision)
				throw new WatcherError("La vigilancia cambió durante la reanudación.", 409);
			watch.baseline = baseline;
			watch.since = since;
			watch.state = "active";
			watch.revision++;
			delete watch.cursor;
			delete watch.lastError;
			watch.nextPoll = this.now();
			watch.readyAt = this.now() + this.debounceMs;
			watch.deliveryFailures = 0;
			for (const { event, handled } of this.recent.filter((entry) => entry.sequence > eventSequence)) {
				if (event.paneId && event.sessionId)
					delete watch.baseline[digest([event.paneId, event.sessionId, event.type])];
				this.agentEvent(watch, event, handled);
			}
			if (watch.source.kind === "agents")
				this.agentRecoveryAt = Math.min(this.agentRecoveryAt, this.now() + 5 * 60_000);
		} else throw new WatcherError("Acción de vigilancia no admitida.");
		watch.updatedAt = stamp(this.now());
		this.save();
		return this.status();
	}
	close() {
		this.closed = true;
		this.prepared.clear();
		for (const controller of this.probes.values()) controller.abort();
	}
}
