import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CompletionEvent, CompletionSession } from "./completion-reports.ts";
import { humanOnlyQuestion } from "./orchestration/questions.ts";
import { defaultHerdrSocket } from "./orchestration/herdr.ts";
import { readManifests } from "./orchestration/registry.ts";
import { writePrivateFile } from "./private-file.ts";
import { runtimeDir } from "./runtime.ts";
import { type SessionApprovalPolicy, sessionApprovalPolicy } from "./workflow-authorization.ts";

const runtime = runtimeDir();
export const WORKFLOWS_EXTENSION_PATH = runtime
	? join(runtime, "daemon", "extensions", "dot-workflows.ts")
	: fileURLToPath(new URL("./extensions/dot-workflows.ts", import.meta.url));
export interface WorkflowSession {
	paneId: string;
	sessionId: string;
	label?: string;
}
export type WorkflowState =
	| "waiting"
	| "running"
	| "paused"
	| "completed"
	| "cancelled"
	| "expired"
	| "failed";
export interface WorkflowStatus {
	id: string;
	/** Session delegation remains active independently of any finite objective. */
	mode?: "objective" | "session";
	objective: string;
	sessions: WorkflowSession[];
	state: WorkflowState;
	createdAt: string;
	updatedAt: string;
	expiresAt?: string;
	runs: number;
	maxRuns?: number;
	pending: number;
	lastMessage?: string;
	/** Only exact, verified blanket confirmation grants can use the model-free path. */
	approvalMode?: "automatic-confirmations";
	automaticApprovals?: number;
	lastAutomaticApprovalAt?: string;
}
export interface WorkflowWake {
	workflowId: string;
	mode?: "objective" | "session";
	leaseId: string;
	objective: string;
	authorizedInstruction?: string;
	sessions: WorkflowSession[];
	reasons: string[];
	runs: number;
	maxRuns?: number;
	expiresAt?: string;
}
export interface WorkflowApprovalRequest {
	workflowId: string;
	objective: string;
	authorizedInstruction: string;
	paneId: string;
	sessionId: string;
	requestId: string;
	questionHash: string;
	answer: Record<string, unknown>;
	/** Explains why this concrete response is within the already authorized objective. */
	reason: string;
}
export interface WorkflowActivityEvidence {
	version: number;
	at: string | null;
	instanceId?: string;
}
// Capability travels with the existing authorize callback, never with model-authored input.
const activityAuthorities = new WeakMap<() => boolean, (target: WorkflowSession, evidence: WorkflowActivityEvidence) => boolean>();
export function verifyWorkflowActivity(authorize: () => boolean, target: WorkflowSession, evidence: WorkflowActivityEvidence): boolean {
	// Non-workflow foreground actions retain their own authorization path.
	return activityAuthorities.get(authorize)?.(target, evidence) ?? true;
}

export interface WorkflowPendingApproval {
	/** Adapter metadata supplied directly by discovery, not dialog text. */
	activity?: { version: number; at: string | null; instanceId?: string };
	paneId: string;
	sessionId: string;
	/** The original adapter dialog, not the UI projection of it. */
	question: Record<string, unknown>;
}
export interface WorkflowBatch {
	workflows: WorkflowStatus[];
	pending: number;
	wake?: WorkflowWake;
	error?: string;
	archived?: number;
}
export interface WorkflowOptions {
	dataDir: string;
	/** Trusted adapter registries, matching the orchestrator's configured directories. */
	registryDirs?: string[];
	snapshot: () => Promise<{
		sessions: Array<
			CompletionSession & {
				assistantMessageId?: string;
				humanActivityAt?: string;
				activityInstanceId?: string;
				capabilities?: { inspect: boolean; prompt?: boolean; approvals?: boolean; activityFence?: number };
			}
		>;
		approvals?: Array<{ id: string; paneId: string; sessionId: string }>;
	}>;
	inspect: (paneId: string, sessionId: string) => Promise<unknown>;
	prompt: (paneId: string, sessionId: string, text: string, authorize: () => boolean) => Promise<unknown>;
	/** The adapter must recheck session, question hash and authority immediately before answering. */
	approve?: (request: WorkflowApprovalRequest, authorize: () => boolean) => Promise<unknown>;
	/** A trusted UI question; no answer leaves the durable workflow paused. */
	askContinuation?: (work: WorkflowStatus, answer: (choice: "continue" | "stop") => Promise<void>) => void;
	now?: () => number;
}
interface Observation {
	activityInstanceId?: string;
	/** null means the versioned adapter positively reported no personal interaction yet. */
	humanActivityAt?: string | null;
	state: string;
	assistantMessageId?: string;
	awaiting?: boolean;
	connected?: boolean;
	requestId?: string;
	delegated?: boolean;
}
interface Operation {
	id: string;
	hash: string;
	state: "dispatching" | "sent";
	at: string;
	kind?: "prompt" | "approve";
	leaseId?: string;
	requestId?: string;
	reason?: string;
	automatic?: true;
}
interface Lease {
	id: string;
	/** Idempotent foreground claim, bound to a gateway-verified human instruction. */
	foregroundClaim?: string;
	expiresAt: number;
	startedAt: number;
	reasons: string[];
	inspected: Record<string, number>;
	questions: Record<string, { id: string; hash: string; at: number; humanOnly?: boolean }>;
	prompts: number;
}
interface StoredWorkflow extends Omit<WorkflowStatus, "pending"> {
	/** Durable question identity prevents repeated prompts and stale answers after a pause/resume. */
	yieldQuestion?: string;
	renewalHours?: number;
	/** Durable turn ordering: continuously busy objectives cannot starve another pending objective. */
	claimOrder?: number;
	/** Verified human instruction supplied only by the trusted gateway, never by a tool schema. */
	authorization?: string;
	approvalPolicy?: SessionApprovalPolicy;
	pending: string[];
	seen: string[];
	observed: Record<string, Observation>;
	operations: Operation[];
	lease?: Lease;
	attempts: number;
	nextAttemptAt: number;
}
const record = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);
const pair = (session: {paneId:string; sessionId?:string}) => JSON.stringify([session.paneId, session.sessionId]);
const active = (work: StoredWorkflow) => work.state === "waiting" || work.state === "running";
const terminal = (work: StoredWorkflow) => ["completed", "cancelled", "expired"].includes(work.state);
const MAX_STATE_BYTES = 4 * 1024 * 1024;
const MAX_AUTHORIZATION_CHARS = 100_000;
const deadline = (work: StoredWorkflow) =>
	work.expiresAt ? Date.parse(work.expiresAt) : Number.POSITIVE_INFINITY;
const runLimitReached = (work: StoredWorkflow) => work.maxRuns !== undefined && work.runs >= work.maxRuns;
const stamp = (now: number) => new Date(now).toISOString();
const text = (value: unknown, name: string, max = 512): string => {
	if (
		typeof value !== "string" ||
		!value.trim() ||
		value.length > max ||
		Array.from(value).some(
			(character) => character.charCodeAt(0) < 32 && ![9, 10, 13].includes(character.charCodeAt(0)),
		)
	)
		throw new WorkflowError(`El campo ${name} no es válido.`);
	return value.trim();
};
export class WorkflowError extends Error {
	readonly status: number;
	constructor(message: string, status = 400) {
		super(message);
		this.status = status;
	}
}

/** Only adapters that guarantee no answer was sent may use this recoverable preflight error. */
export class WorkflowApprovalRejected extends WorkflowError {}

/** Stable digest of the exact dialog, including choices and expiry, without storing its contents. */
export function workflowQuestionHash(question: unknown): string {
	if (
		!record(question) ||
		typeof question.id !== "string" ||
		!question.id ||
		Buffer.byteLength(JSON.stringify(question)) > 65_536
	)
		throw new WorkflowError("La solicitud concreta no es válida.");
	const canonical = (value: unknown): unknown =>
		Array.isArray(value)
			? value.map(canonical)
			: record(value)
				? Object.fromEntries(
						Object.keys(value)
							.sort()
							.filter((key) => value[key] !== undefined)
							.map((key) => [key, canonical(value[key])]),
					)
				: value;
	return createHash("sha256")
		.update(JSON.stringify(canonical(question)))
		.digest("hex");
}

/** Durable, explicitly scoped continuations. Files contain task metadata, never session transcripts. */
export class WorkflowContinuations {
	private readonly options: WorkflowOptions;
	private enrollmentSync: Promise<void> = Promise.resolve();
	private readonly enrollments = new Map<string, { socket: Socket; signature: string; renewal: ReturnType<typeof setInterval> }>();
	private readonly unconfirmedRevocations = new Set<string>();

	/** Publish live grants over the existing private adapter socket, never model/tool input. */
	private syncEnrollments(): Promise<void> {
		this.enrollmentSync = this.enrollmentSync.then(async () => {
			const desired = new Map<string, { sessionId: string; expiresAt: number; humanActivityAt: string | null }>();
			if (!this.closed && !this.storageError) for (const work of this.works.values()) {
				if (work.mode !== "session" || !work.authorization || !active(work) || deadline(work) <= this.now() ||
					(runLimitReached(work) && !work.lease && !work.operations.some(op => op.state === "dispatching"))) continue;
				for (const target of work.sessions) {
					const observed = work.observed[pair(target)];
					if (observed?.connected !== true || !observed.activityInstanceId || observed.humanActivityAt === undefined) continue;
					desired.set(observed.activityInstanceId, { sessionId: target.sessionId, expiresAt: deadline(work), humanActivityAt: observed.humanActivityAt });
				}
			}
			for (const [id, peer] of this.enrollments) {
				if (!peer.socket.destroyed && JSON.stringify(desired.get(id)) === peer.signature) continue;
				this.enrollments.delete(id);
				clearInterval(peer.renewal);
				this.unconfirmedRevocations.add(id);
				if (!peer.socket.destroyed) await new Promise<void>(resolve => {
					const timer = setTimeout(() => peer.socket.destroy(), 1000);
					// Only a remote FIN acknowledges that the adapter processed revocation.
					// A local destroy/close is not evidence that the peer relinquished authority.
					peer.socket.once("end", () => this.unconfirmedRevocations.delete(id));
					peer.socket.once("close", () => { clearTimeout(timer); resolve(); });
					peer.socket.end();
				});
			}
			if (!desired.size || this.closed) return;
			const directories = this.options.registryDirs ?? [join(this.options.dataDir, "pi-sessions"),
				process.env.HERDR_MOBILE_PI_DIR || join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "herdr-mobile", "pi-connect")];
			const manifests = await readManifests(directories, defaultHerdrSocket());
			for (const manifest of manifests) {
				const id = manifest.instanceId;
				const grant = id ? desired.get(id) : undefined;
				if (!id || !grant || manifest.sessionId !== grant.sessionId || this.enrollments.has(id) || this.closed) continue;
				await new Promise<void>(resolve => {
					const socket = connect(manifest.socketPath);
					const timer = setTimeout(() => socket.destroy(), 1000);
					let response = "";
					const finish = () => { clearTimeout(timer); resolve(); };
					socket.once("error", () => socket.destroy());
					socket.once("close", () => { if (this.enrollments.get(id)?.socket === socket) this.enrollments.delete(id); finish(); });
					socket.once("connect", () => socket.write(`${JSON.stringify({ id: randomUUID(), method: "workflow.enroll", params: {
						expectedSessionId: grant.sessionId, expectedInstanceId: id, expiresAt: grant.expiresAt, humanActivityAt: grant.humanActivityAt,
					} })}\n`));
					socket.on("data", chunk => {
						response += String(chunk);
						if (response.length > 4096) { socket.destroy(); return; }
						if (!response.includes("\n")) return;
						try {
							const value = JSON.parse(response.split("\n")[0]!);
							if (value.result?.accepted !== true || this.closed) { socket.destroy(); return; }
							const renewal = setInterval(() => {
								// Recompute desired grants before renewing, never renew cached authority.
								void this.syncEnrollments().then(() => {
									if (this.enrollments.get(id)?.socket === socket && !socket.destroyed) socket.write("workflow.renew\n");
								});
							}, 1000);
							renewal.unref();
							socket.once("close", () => clearInterval(renewal));
							this.unconfirmedRevocations.delete(id);
							this.enrollments.set(id, { socket, signature: JSON.stringify(grant), renewal });
							socket.removeAllListeners("data");
							socket.unref();
							finish();
						} catch { socket.destroy(); }
					});
				});
			}
		}).catch(() => {
			// A missing/stale adapter grants nothing. Never leave a cached grant on failure.
			for (const peer of this.enrollments.values()) peer.socket.destroy();
			this.enrollments.clear();
		});
		return this.enrollmentSync;
	}
	private readonly path: string;
	private readonly now: () => number;
	private readonly works = new Map<string, StoredWorkflow>();
	private closed = false;
	private busy = false;
	private storageError?: string;
	private recoveredAt = Number.NEGATIVE_INFINITY;
	private recovering?: Promise<void>;
	private recoveryRetryAt = Number.NEGATIVE_INFINITY;
	private eventRevision = 0;
	private controlRevision = 0;
	private archived = 0;
	private claimSequence = 0;
	private engine?: { id: string; startedAt: number };
	private readonly automaticInFlight = new Set<string>();
	private readonly sendingSessions = new Map<string, number>();
	private readonly approvalRevisions = new Map<string, number>();
	private sending(target: WorkflowSession): () => void {
		const key = pair(target);
		this.sendingSessions.set(key, (this.sendingSessions.get(key) ?? 0) + 1);
		return () => {
			const remaining = (this.sendingSessions.get(key) ?? 1) - 1;
			if (remaining) this.sendingSessions.set(key, remaining);
			else this.sendingSessions.delete(key);
		};
	}

	constructor(options: WorkflowOptions) {
		this.options = options;
		this.path = join(options.dataDir, "workflows.json");
		this.now = options.now ?? Date.now;
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
				throw new Error("Unsafe workflow state");
			const stored: unknown = JSON.parse(readFileSync(this.path, "utf8"));
			if (
				!record(stored) ||
				stored.version !== 1 ||
				!Array.isArray(stored.workflows) ||
				stored.workflows.length > 64
			)
				throw new Error("Invalid workflow state");
			this.archived =
				Number.isSafeInteger(stored.archived) && Number(stored.archived) >= 0 ? Number(stored.archived) : 0;
			if (
				record(stored.engine) &&
				typeof stored.engine.id === "string" &&
				typeof stored.engine.startedAt === "number"
			)
				this.engine = { id: stored.engine.id, startedAt: stored.engine.startedAt };
			for (const candidate of stored.workflows) {
				if (
					!record(candidate) ||
					typeof candidate.id !== "string" ||
					typeof candidate.objective !== "string" ||
					!Array.isArray(candidate.sessions) ||
					(candidate.mode !== undefined && !["objective", "session"].includes(String(candidate.mode))) ||
					(candidate.mode === "session" && (candidate.sessions.length !== 1 || !candidate.authorization)) ||
					candidate.sessions.length < 1 ||
					candidate.sessions.length > 8 ||
					!candidate.sessions.every(
						(item) => record(item) && typeof item.paneId === "string" && typeof item.sessionId === "string",
					) ||
					!["waiting", "running", "paused", "completed", "cancelled", "expired", "failed"].includes(
						String(candidate.state),
					) ||
					!Array.isArray(candidate.pending) ||
					candidate.pending.length > 16 ||
					!candidate.pending.every((item) => typeof item === "string") ||
					!Array.isArray(candidate.seen) ||
					candidate.seen.length > 128 ||
					!record(candidate.observed) ||
					!Array.isArray(candidate.operations) ||
					candidate.operations.length > 128 ||
					!Number.isSafeInteger(candidate.runs) ||
					(candidate.claimOrder !== undefined &&
						(!Number.isSafeInteger(candidate.claimOrder) || Number(candidate.claimOrder) < 1)) ||
					(candidate.authorization !== undefined &&
						(typeof candidate.authorization !== "string" ||
							candidate.authorization.length > MAX_AUTHORIZATION_CHARS ||
							!candidate.authorization.trim())) ||
					(candidate.maxRuns !== undefined &&
						(!Number.isSafeInteger(candidate.maxRuns) || Number(candidate.maxRuns) < 1)) ||
					(candidate.expiresAt !== undefined && !Number.isFinite(Date.parse(String(candidate.expiresAt))))
				)
					throw new Error("Invalid workflow record");
				const work = candidate as unknown as StoredWorkflow;
				if (!Number.isFinite(work.renewalHours) || Number(work.renewalHours) < 0.25 || Number(work.renewalHours) > 168) work.renewalHours = 24;
				if (!work.expiresAt) work.expiresAt = stamp(Date.parse(work.createdAt) + 24 * 3600_000);
				// Reconstruct only from trusted human provenance. A stored/model-supplied
				// policy flag cannot widen the original instruction, including after upgrade.
				work.approvalPolicy = work.mode === "session" ? sessionApprovalPolicy(work.authorization) : undefined;
				if (!Number.isSafeInteger(work.automaticApprovals) || Number(work.automaticApprovals) < 0)
					delete work.automaticApprovals;
				this.claimSequence = Math.max(this.claimSequence, work.claimOrder ?? 0);
				// The previous engine cannot acknowledge a lease after daemon restart. Never replay an uncertain send.
				if (work.lease) this.release(work, "error", true);
				if (active(work) && work.operations.some((operation) => operation.state === "dispatching")) {
					work.state = "paused";
					work.lastMessage =
						"No se pudo confirmar una respuesta anterior. Revisa la sesión antes de reanudar.";
				}
				this.works.set(work.id, work);
			}
			this.expire();
			this.save();
		} catch (error) {
			if (!record(error) || error.code !== "ENOENT") {
				this.works.clear();
				this.storageError =
					"No se pudo recuperar el seguimiento guardado. No se continuará ningún trabajo automáticamente.";
			}
		}
	}
	private ensure(authorize: () => boolean = () => true): void {
		if (this.closed || this.storageError)
			throw new WorkflowError(this.storageError ?? "El seguimiento está cerrado.", 503);
		if (!authorize()) throw new WorkflowError("La autorización ya no está vigente.", 401);
	}
	private save(): void {
		try {
			mkdirSync(this.options.dataDir, { recursive: true, mode: 0o700 });
			const encode = () =>
				`${JSON.stringify({ version: 1, archived: this.archived, engine: this.engine, workflows: [...this.works.values()] })}\n`;
			let state = encode();
			while (this.works.size > 64 || Buffer.byteLength(state) > MAX_STATE_BYTES) {
				const oldest = [...this.works.values()]
					.filter(terminal)
					.sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt))[0];
				if (!oldest) throw new Error("Workflow metadata quota exceeded");
				this.works.delete(oldest.id);
				this.archived++;
				state = encode();
			}
			writePrivateFile(this.path, state);
			void this.syncEnrollments();
		} catch {
			this.storageError = "No se pudo guardar el seguimiento. Las continuaciones están detenidas.";
			void this.syncEnrollments();
			throw new WorkflowError(this.storageError, 503);
		}
	}
	private public(work: StoredWorkflow): WorkflowStatus {
		return {
			id: work.id,
			...(work.mode ? { mode: work.mode } : {}),
			objective: work.objective,
			sessions: work.sessions.map((session) => ({ ...session })),
			state: work.state,
			createdAt: work.createdAt,
			updatedAt: work.updatedAt,
			...(work.expiresAt ? { expiresAt: work.expiresAt } : {}),
			runs: work.runs,
			...(work.maxRuns !== undefined ? { maxRuns: work.maxRuns } : {}),
			pending: work.pending.length,
			...(work.lastMessage ? { lastMessage: work.lastMessage } : {}),
			...(work.approvalPolicy ? { approvalMode: "automatic-confirmations" as const } : {}),
			...(work.automaticApprovals ? { automaticApprovals: work.automaticApprovals } : {}),
			...(work.lastAutomaticApprovalAt ? { lastAutomaticApprovalAt: work.lastAutomaticApprovalAt } : {}),
		};
	}
	status(): WorkflowBatch {
		this.expire();
		return {
			workflows: [...this.works.values()].map((work) => this.public(work)),
			pending: [...this.works.values()].reduce((total, work) => total + work.pending.length, 0),
			archived: this.archived,
			...(this.storageError ? { error: this.storageError } : {}),
		};
	}
	private async verifyActivity(work: StoredWorkflow, authorize: () => boolean = () => true, activity?: {version:number;at:string|null;instanceId?:string}): Promise<boolean> {
		const snapshot = activity ? {sessions:work.sessions.map(target => ({...target, label:target.label ?? "", state:"unknown", connected:true, humanActivityAt:activity.at ?? undefined, activityInstanceId:activity.instanceId, capabilities:{inspect:true,activityFence:activity.version}}))} : await this.options.snapshot();
		this.ensure(authorize);
		for (const target of work.sessions) {
			const session = snapshot.sessions.find(s => pair(s) === pair(target));
			if (!session?.connected || !this.matchesActivity(work, target, {
				version: session.capabilities?.activityFence ?? 0,
				at: session.humanActivityAt ?? null,
				instanceId: session.activityInstanceId,
			})) {
				this.yieldToHuman(work, "La actividad o el adaptador de la sesión cambió o no pudo comprobarse.");
				return false;
			}
		}
		return active(work);
	}

	private matchesActivity(work: StoredWorkflow, target: WorkflowSession, evidence: WorkflowActivityEvidence): boolean {
		const previous = work.observed[pair(target)];
		return evidence.version === 1 && typeof evidence.instanceId === "string" && !!evidence.instanceId &&
			(evidence.at === null || Number.isFinite(Date.parse(evidence.at))) &&
			previous?.humanActivityAt !== undefined && previous.humanActivityAt === evidence.at &&
			previous.activityInstanceId === evidence.instanceId;
	}
	private bindActivity(work: StoredWorkflow, authorize: () => boolean): void {
		activityAuthorities.set(authorize, (target, evidence) => {
			if (!work.sessions.some(session => pair(session) === pair(target)) || !this.matchesActivity(work, target, evidence)) {
				this.yieldToHuman(work, "La actividad o el adaptador de la sesión cambió o no pudo comprobarse.");
				return false;
			}
			return authorize();
		});
	}

	/** Called only by trusted interaction metadata, never session/mail content. */
	onInteraction(target: WorkflowSession, origin: "human" | "workflow"): void {
		if (origin !== "human" || this.closed || this.storageError) return;
		for (const work of this.works.values()) {
			if (active(work) && work.sessions.some(session => pair(session) === pair(target)))
				this.yieldToHuman(work, "La persona volvió a trabajar en esta sesión.");
		}
	}
	private yieldToHuman(work: StoredWorkflow, reason: string): void {
		if (!active(work)) return;
		work.state = "paused";
		delete work.lease;
		work.lastMessage = reason;
		work.updatedAt = stamp(this.now());
		const question = randomUUID();
		work.yieldQuestion = question;
		this.approvalRevisions.set(work.id, (this.approvalRevisions.get(work.id) ?? 0) + 1);
		this.save(); // Revoke action authority before presenting the question.
		this.options.askContinuation?.(this.public(work), async choice => {
			if (this.closed || this.storageError || work.state !== "paused" || work.yieldQuestion !== question) return;
			if (choice !== "continue" && choice !== "stop") return;
			if (choice === "continue") {
				// A new human decision renews the bounded delegation, never replays a dispatch.
				await this.dispatch({action:"resume", workflowId:work.id}, "human");
			} else await this.dispatch({action:"stop", workflowId:work.id}, "human");
		});
	}
	private expire(): void {
		let changed = false;
		for (const work of this.works.values()) {
			if (active(work) && deadline(work) <= this.now()) {
				this.yieldToHuman(work, "Venció el plazo autorizado; espera tu decisión para continuar.");
				changed = true;
			} else if (work.lease && work.lease.expiresAt <= this.now()) {
				this.release(work, "error", true);
				changed = true;
			}
		}
		if (changed && !this.closed && !this.storageError) this.save();
	}
	private enqueue(work: StoredWorkflow, reason: string): void {
		if (!work.pending.includes(reason)) work.pending = [...work.pending, reason].slice(-16);
		work.updatedAt = stamp(this.now());
	}
	/** A dedicated session delegation owns permission events; finite objectives still own task results. */
	private delegated(session: WorkflowSession): boolean {
		return [...this.works.values()].some(
			(work) =>
				work.mode === "session" &&
				active(work) &&
				work.sessions.some((target) => pair(target) === pair(session)),
		);
	}
	/**
	 * Runs directly on adapter discovery, independently of Dot's inference/turn queue.
	 * The grant is already explicit; this path checks data and sends one boolean only.
	 * Returning false leaves the exact dialog available to normal review and the person.
	 */
	async tryApprove(input: WorkflowPendingApproval): Promise<boolean> {
		if (this.closed || this.storageError || !this.options.approve) return false;
		this.expire();
		const work = [...this.works.values()].find(
			(candidate) =>
				candidate.mode === "session" &&
				active(candidate) &&
				candidate.sessions.some((target) => pair(target) === pair(input)),
		);
		if (
			!work?.approvalPolicy ||
			!work.authorization ||
			work.lease ||
			this.automaticInFlight.has(work.id) ||
			runLimitReached(work)
		)
			return false;
		if (!(await this.verifyActivity(work, () => true, input.activity).catch(() => false)) || !active(work) || this.closed || work.lease || this.automaticInFlight.has(work.id)) return false;
		const policy = work.approvalPolicy;
		const revision = this.approvalRevisions.get(work.id);
		const question = input.question;
		if (humanOnlyQuestion(question)) return false;
		// Non-local operations require the coordinator to compare the full dialog
		// with authorizedInstruction; blanket confirmations never skip that judgment.
		if (record(question.workflowPermission) && question.workflowPermission.decision === "instruction") return false;
		if (
			question.kind !== "confirm" ||
			question.answerable !== true ||
			typeof question.id !== "string" ||
			!question.id ||
			question.id.length > 256 ||
			(typeof question.expiresAt === "string" &&
				question.expiresAt &&
				(!Number.isFinite(Date.parse(question.expiresAt)) || Date.parse(question.expiresAt) <= this.now()))
		)
			return false;
		const questionHash = workflowQuestionHash(question);
		const operationId = `automatic:${question.id}`;
		const previous = work.operations.find((operation) => operation.id === operationId);
		if (previous) return previous.state === "sent" && previous.hash === questionHash;
		if (
			work.operations.some(
				(operation) =>
					operation.state === "dispatching" ||
					(operation.kind === "approve" && operation.requestId === question.id),
			)
		)
			return false;
		const current = () =>
			!this.closed &&
			!this.storageError &&
			active(work) &&
			!work.lease &&
			work.approvalPolicy === policy &&
			!humanOnlyQuestion(question) && workflowQuestionHash(question) === questionHash &&
			this.approvalRevisions.get(work.id) === revision &&
			deadline(work) > this.now();
		this.bindActivity(work, current);
		const operation: Operation = {
			id: operationId,
			hash: questionHash,
			state: "dispatching",
			at: stamp(this.now()),
			kind: "approve",
			automatic: true,
			requestId: question.id,
			reason: "Confirmación incluida en la delegación explícita de esta sesión.",
		};
		this.automaticInFlight.add(work.id);
		const sent = this.sending(input);
		const observedBefore = work.observed[pair(input)];
		try {
			work.operations = work.operations
				.filter((item) => item.state === "dispatching")
				.concat(work.operations.filter((item) => item.state === "sent").slice(-64), operation);
			work.runs++;
			this.save(); // Persist the attempt before dispatch; ambiguous outcomes are never replayed.
			try {
				const result = await this.options.approve(
					{
						workflowId: work.id,
						objective: work.objective,
						authorizedInstruction: work.authorization,
						paneId: input.paneId,
						sessionId: input.sessionId,
						requestId: question.id,
						questionHash,
						answer: { confirmed: true },
						reason: operation.reason as string,
					},
					current,
				);
				if (!record(result) || result.accepted !== true)
					throw new Error("The adapter did not acknowledge the answer");
			} catch (error) {
				if (error instanceof WorkflowApprovalRejected) {
					work.operations = work.operations.filter((item) => item !== operation);
					work.runs--; // The adapter guarantees that no answer was dispatched.
				} else if (active(work)) {
					work.state = "paused";
					work.lastMessage =
						"No se pudo confirmar una aprobación. Revisa la sesión antes de reanudar; no se repetirá automáticamente.";
				}
				this.save();
				return false;
			}
			operation.state = "sent";
			work.automaticApprovals = (work.automaticApprovals ?? 0) + 1;
			work.lastAutomaticApprovalAt = stamp(this.now());
			work.updatedAt = stamp(this.now());
			work.pending = work.pending.filter((reason) => reason !== `Permiso pendiente: ${input.paneId}`);
			if (work.observed[pair(input)] === observedBefore)
				work.observed[pair(input)] = {
					...observedBefore,
					state: "working",
					connected: true,
					requestId: question.id,
					awaiting: true,
				};
			this.save();
			return true;
		} finally {
			this.automaticInFlight.delete(work.id);
			sent();
		}
	}
	/** Track concrete changes only, so background polling never wakes every historical session. */
	onEvent(event: CompletionEvent): boolean {
		if (
			this.closed ||
			this.storageError ||
			!["completed", "attention", "disconnected"].includes(event.type) ||
			(event.type !== "disconnected" && (!event.paneId || !event.sessionId)) ||
			!event.id ||
			event.id.length > 256 ||
			(event.requestId && event.requestId.length > 256) ||
			(event.assistantMessageId && event.assistantMessageId.length > 256)
		)
			return false;
		try {
			this.expire();
		} catch {
			return false;
		}
		let handled = false;
		let changed = false;
		for (const work of this.works.values()) {
			if (!active(work)) continue;
			if (event.type === "disconnected" && !event.paneId && !event.sessionId) {
				for (const target of work.sessions) {
					const key = pair(target);
					work.observed[key] = { ...work.observed[key], state: "unknown", connected: false };
				}
				if (work.mode === "session") {
					work.state = "paused";
					delete work.lease;
					this.approvalRevisions.set(work.id, (this.approvalRevisions.get(work.id) ?? 0) + 1);
				}
				this.enqueue(work, "Descubrimiento desconectado; autonomía revocada.");
				changed = handled = true;
				continue;
			}
			const session = work.sessions.find(
				(item) => item.paneId === event.paneId && item.sessionId === event.sessionId,
			);
			if (!session) continue;
			if (work.mode === "session" && event.type === "completed") continue;
			if (work.mode !== "session" && event.type === "attention" && this.delegated(session)) continue;
			handled = true;
			if (
				work.seen.includes(event.id) ||
				Date.parse(event.at) < Date.parse(work.createdAt) ||
				Date.parse(event.at) > this.now() + 60_000 ||
				!Number.isFinite(Date.parse(event.at))
			)
				continue;
			const key = pair(session);
			const previous = work.observed[key];
			work.seen = [...work.seen, event.id].slice(-128);
			if (event.type !== "completed") {
				if (
					(event.type === "attention" &&
						event.requestId &&
						previous?.state === "blocked" &&
						previous.requestId === event.requestId) ||
					(event.type === "disconnected" && previous?.connected === false)
				) {
					changed = true;
					continue;
				}
				if (event.type === "disconnected" && work.mode === "session") {
					work.state = "paused";
					delete work.lease;
					this.approvalRevisions.set(work.id, (this.approvalRevisions.get(work.id) ?? 0) + 1);
				}
				work.observed[key] = {
					...previous,
					state: event.type === "attention" ? "blocked" : "unknown",
					connected: event.type === "attention",
					...(event.requestId ? { requestId: event.requestId } : {}),
				};
				this.enqueue(
					work,
					`${event.type === "attention" ? "Permiso pendiente" : "Sesión desconectada"}: ${session.paneId}`,
				);
				changed = true;
				continue;
			}
			if (
				event.assistantMessageId &&
				previous?.assistantMessageId === event.assistantMessageId &&
				!previous.awaiting
			) {
				changed = true;
				continue;
			}
			work.observed[key] = {
				...previous,
				state: "idle",
				connected: true,
				...(event.assistantMessageId ? { assistantMessageId: event.assistantMessageId } : {}),
				awaiting: false,
			};
			this.enqueue(work, `Resultado disponible: ${session.paneId}`);
			changed = true;
		}
		if (changed) {
			this.eventRevision++;
			try {
				this.save();
			} catch {
				/* Storage failure disables continuations, not session discovery. */
			}
		}
		return handled;
	}
	private async recover(authorize: () => boolean): Promise<void> {
		if (this.now() - this.recoveredAt < 30_000 || ![...this.works.values()].some(active)) return;
		const revision = this.eventRevision;
		const grants = new Map([...this.works.keys()].map((id) => [id, this.approvalRevisions.get(id)]));
		// A command may start or finish while this read is pending. Reconcile only
		// observations that still describe the same pre-read session state.
		const observations = new Map<string, Observation | undefined>(
			[...this.works.values()].flatMap((work) =>
				work.sessions
					.filter((target) => !this.sendingSessions.has(pair(target)))
					.map((target) => [`${work.id}:${pair(target)}`, work.observed[pair(target)]] as const),
			),
		);
		const snapshot = await this.options.snapshot();
		this.ensure(authorize);
		if (revision !== this.eventRevision) return;
		this.recoveredAt = this.now();
		let changed = false;
		for (const work of this.works.values()) {
			if (!active(work) || grants.get(work.id) !== this.approvalRevisions.get(work.id)) continue;
			for (const target of work.sessions) {
				const session = snapshot.sessions.find(
					(item) => item.paneId === target.paneId && item.sessionId === target.sessionId,
				);
				const key = pair(target);
				const previous = work.observed[key];
				const observationKey = `${work.id}:${key}`;
				if (
					this.sendingSessions.has(key) ||
					!observations.has(observationKey) ||
					observations.get(observationKey) !== previous
				)
					continue;
				if (!session?.connected) {
					if (previous?.connected !== false) {
						work.observed[key] = { ...previous, state: "unknown", connected: false };
						if (work.mode === "session") {
							work.state = "paused";
							delete work.lease;
							this.approvalRevisions.set(work.id, (this.approvalRevisions.get(work.id) ?? 0) + 1);
						}
						this.enqueue(work, `Sesión desconectada: ${target.paneId}`);
						changed = true;
					}
					continue;
				}
				const approval = snapshot.approvals?.find(
					(item) => item.paneId === target.paneId && item.sessionId === target.sessionId,
				);
				const answered =
					work.mode === "session" &&
					approval &&
					work.operations.some(
						(operation) =>
							operation.state === "sent" &&
							operation.kind === "approve" &&
							operation.requestId === approval.id,
					);
				// Older versions consumed a wake on ordinary model text even when the exact request remained open.
				const stranded =
					work.mode === "session" &&
					work.state === "waiting" &&
					!work.lease &&
					work.pending.length === 0 &&
					approval &&
					!answered;
				if (
					!answered &&
					(work.mode === "session" || !this.delegated(target)) &&
					(stranded ||
						(approval && (approval.id !== previous?.requestId || previous?.delegated)) ||
						(session.state === "blocked" && previous?.state !== "blocked"))
				) {
					this.enqueue(work, `Permiso pendiente: ${target.paneId}`);
					changed = true;
				}
				if (previous?.connected === false) this.enqueue(work, `Sesión reconectada: ${target.paneId}`);
				if (
					work.mode !== "session" &&
					["idle", "done"].includes(session.state) &&
					previous &&
					((session.assistantMessageId && session.assistantMessageId !== previous.assistantMessageId) ||
						previous.state === "working")
				) {
					this.enqueue(work, `Resultado recuperado: ${target.paneId}`);
				}
				const observed = {
					humanActivityAt: previous?.humanActivityAt,
					activityInstanceId: previous?.activityInstanceId,
					state: session.state,
					connected: true,
					...(work.mode !== "session" && this.delegated(target) ? { delegated: true } : {}),
					...(approval ? { requestId: approval.id } : {}),
					...(session.assistantMessageId ? { assistantMessageId: session.assistantMessageId } : {}),
					awaiting: previous?.awaiting && !["idle", "done"].includes(session.state),
				};
				if (JSON.stringify(previous) !== JSON.stringify(observed)) {
					work.observed[key] = observed;
					changed = true;
				}
			}
		}
		if (changed) this.save();
	}
	/** Reconcile missed adapter events outside the single-model-turn arbitration. */
	prepare(): Promise<void> {
		if (this.closed || this.storageError) return Promise.resolve();
		this.expire();
		if (this.recovering) return this.recovering.then(() => this.prepare());
		if (
			this.now() < this.recoveryRetryAt ||
			this.now() - this.recoveredAt < 30_000 ||
			![...this.works.values()].some(active)
		)
			return Promise.resolve();
		this.recoveryRetryAt = this.now() + 1000;
		this.recovering = this.recover(() => true)
			.catch(() => {
				// Discovery retries without taking a lease or failing an authorized objective.
			})
			.finally(() => {
				this.recovering = undefined;
			});
		return this.recovering;
	}
	async poll(take: boolean, authorize: () => boolean = () => true): Promise<WorkflowBatch> {
		try { return await this.pollWork(take, authorize); }
		finally { await this.syncEnrollments(); }
	}
	private async pollWork(take: boolean, authorize: () => boolean): Promise<WorkflowBatch> {
		this.ensure(authorize);
		this.expire();
		if (!take || this.busy) return this.status();
		this.busy = true;
		try {
			void this.prepare();
			this.ensure(authorize);
			if ([...this.works.values()].some((work) => work.lease)) return this.status();
			const work = [...this.works.values()]
				.filter(
					(candidate) =>
						active(candidate) &&
						!this.automaticInFlight.has(candidate.id) &&
						candidate.pending.length &&
						candidate.nextAttemptAt <= this.now(),
				)
				.sort((left, right) => (left.claimOrder ?? 0) - (right.claimOrder ?? 0))[0];
			if (!work) return this.status();
			if (runLimitReached(work)) {
				work.state = "paused";
				work.lastMessage = "Se alcanzó el límite de continuaciones autorizado.";
				this.save();
				return this.status();
			}
			if (!(await this.verifyActivity(work, authorize))) return this.status();
			const wake = this.leaseWork(work, work.pending.splice(0));
			return {
				...this.status(),
				wake,
			};
		} finally {
			this.busy = false;
		}
	}
	private wake(work: StoredWorkflow): WorkflowWake {
		if (!work.lease) throw new WorkflowError("La continuación ya no está autorizada.", 409);
		return {
			workflowId: work.id,
			...(work.mode ? { mode: work.mode } : {}),
			leaseId: work.lease.id,
			objective: work.objective,
			...(work.authorization ? { authorizedInstruction: work.authorization } : {}),
			sessions: work.sessions.map((item) => ({ ...item })),
			reasons: [...work.lease.reasons],
			runs: work.runs,
			...(work.maxRuns !== undefined ? { maxRuns: work.maxRuns } : {}),
			...(work.expiresAt ? { expiresAt: work.expiresAt } : {}),
		};
	}
	private leaseWork(work: StoredWorkflow, reasons: string[], foregroundClaim?: string): WorkflowWake {
		// Old lease IDs cannot act again. Keep a bounded audit without imposing a lifetime action quota.
		work.operations = work.operations
			.filter((operation) => operation.state === "dispatching")
			.concat(work.operations.filter((operation) => operation.state === "sent").slice(-64));
		work.lease = {
			id: randomUUID(),
			...(foregroundClaim ? { foregroundClaim } : {}),
			startedAt: this.now(),
			expiresAt: this.now() + 10 * 60_000,
			reasons,
			inspected: {},
			questions: {},
			prompts: 0,
		};
		work.state = "running";
		work.claimOrder = ++this.claimSequence;
		work.runs++;
		work.updatedAt = stamp(this.now());
		this.save();
		return this.wake(work);
	}
	private find(input: Record<string, unknown>): StoredWorkflow {
		const work = this.works.get(text(input.workflowId, "workflowId"));
		if (!work) throw new WorkflowError("No existe ese seguimiento.", 404);
		return work;
	}
	private scoped(work: StoredWorkflow, input: Record<string, unknown>, authorize: () => boolean): Lease {
		this.ensure(authorize);
		this.expire();
		if (!active(work) || !work.lease || work.lease.id !== input.leaseId)
			throw new WorkflowError("La continuación ya no está autorizada.", 409);
		return work.lease;
	}
	private release(work: StoredWorkflow, outcome: string, recovered = false): void {
		const lease = work.lease;
		if (!lease) return;
		delete work.lease;
		if (!active(work)) return;
		work.state = "waiting";
		work.updatedAt = stamp(this.now());
		if (work.operations.some((operation) => operation.state === "dispatching")) {
			work.state = "paused";
			work.lastMessage =
				"No se pudo confirmar si una instrucción llegó al agente. Revisa la sesión antes de reanudar para evitar duplicarla.";
		} else if (outcome === "settled") {
			work.attempts = 0;
			work.lastMessage = "Dot revisó el avance; espera un nuevo resultado de las sesiones.";
		} else if (lease.prompts > 0) {
			work.attempts = 0;
			work.lastMessage = "Hay una instrucción enviada; espera su resultado antes de continuar.";
		} else if (outcome === "interrupted") {
			// A human changing the subject is not a failed provider/continuation attempt.
			// Keep the objective queued without eventually failing it after several chat messages.
			work.pending = [...new Set([...lease.reasons, ...work.pending])].slice(-16);
			work.nextAttemptAt = this.now() + 15_000;
			work.lastMessage = "Dot retomará este seguimiento después de atender tu mensaje.";
		} else {
			work.attempts++;
			if (work.attempts >= 3) {
				work.state = "failed";
				work.lastMessage =
					outcome === "unresolved"
						? "La solicitud sigue pendiente después de tres revisiones sin respuesta. Revisa la sesión o pide a Dot que retome la delegación."
						: "La continuación no pudo completarse tras tres intentos. Requiere revisión humana.";
			} else {
				work.pending = [...new Set([...lease.reasons, ...work.pending])].slice(-16);
				work.nextAttemptAt = this.now() + 15_000 * 2 ** (work.attempts - 1);
				work.lastMessage = recovered
					? "Recuperando una continuación interrumpida; primero se volverá a inspeccionar."
					: outcome === "unresolved"
						? "La solicitud sigue pendiente; Dot volverá a inspeccionarla antes de responder."
						: "La continuación se reintentará tras una espera breve.";
			}
		}
	}
	async dispatch(
		value: unknown,
		actor: "human" | "agent",
		authorize: () => boolean = () => true,
	): Promise<unknown> {
		let result: unknown;
		try { result = await this.dispatchWork(value, actor, authorize); }
		finally { await this.syncEnrollments(); }
		return record(result) && this.unconfirmedRevocations.size
			? { ...result, revocation: "unconfirmed" }
			: result;
	}
	private async dispatchWork(value: unknown, actor: "human" | "agent", authorize: () => boolean): Promise<unknown> {
		if (!record(value)) throw new WorkflowError("La solicitud de seguimiento no es válida.");
		if (value.action === "pauseAll") {
			if (actor !== "human" || !authorize())
				throw new WorkflowError("Sólo la persona puede detener todos los seguimientos.", 403);
			this.controlRevision++;
			for (const work of this.works.values())
				if (active(work)) {
					this.approvalRevisions.set(work.id, (this.approvalRevisions.get(work.id) ?? 0) + 1);
					work.state = "paused";
					delete work.lease;
					work.lastMessage = "La persona detuvo el seguimiento.";
					work.updatedAt = stamp(this.now());
				}
			this.save();
			return this.status();
		}
		this.ensure(authorize);
		this.expire();
		const input = value;
		const action = input.action;
		if (action === "list") return this.status();
		if (action === "recoverEngine") {
			if (actor !== "agent") throw new WorkflowError("Operación interna del motor.", 403);
			const id = text(input.engineId, "engineId", 128);
			const startedAt = input.startedAt;
			if (
				typeof startedAt !== "number" ||
				!Number.isSafeInteger(startedAt) ||
				startedAt < 0 ||
				startedAt > this.now() + 60_000
			)
				throw new WorkflowError("Identidad temporal del motor inválida.");
			if (this.engine?.id === id) return { recovered: true };
			if (this.engine && startedAt < this.engine.startedAt)
				throw new WorkflowError("Esta recuperación pertenece a un motor anterior.", 409);
			this.engine = { id, startedAt };
			for (const work of this.works.values()) if (work.lease) this.release(work, "error", true);
			this.save();
			return { recovered: true };
		}
		if (action === "heartbeat") {
			if (actor !== "agent") throw new WorkflowError("Operación interna.", 403);
			const work = [...this.works.values()].find((candidate) => candidate.lease?.id === input.leaseId);
			if (!work?.lease || !active(work))
				throw new WorkflowError("La continuación ya no está autorizada.", 409);
			const expiresAt = Math.min(
				this.now() + 10 * 60_000,
				work.lease.startedAt + 30 * 60_000,
				deadline(work),
			);
			if (expiresAt - work.lease.expiresAt >= 60_000) {
				work.lease.expiresAt = expiresAt;
				this.save();
			}
			return { active: true };
		}
		if (action === "acknowledge") {
			if (
				actor !== "agent" ||
				!["settled", "error", "interrupted", "delivery_failed"].includes(String(input.outcome))
			)
				throw new WorkflowError("Confirmación interna inválida.", 403);
			const work = [...this.works.values()].find((candidate) => candidate.lease?.id === input.leaseId);
			if (work) {
				let outcome = String(input.outcome);
				const lease = work.lease;
				if (outcome === "settled" && work.mode === "session" && lease?.prompts === 0) {
					if (this.busy) throw new WorkflowError("Otra operación está en curso.", 429);
					this.busy = true;
					try {
						// A successful model turn is not proof that the enrolled session's request was answered.
						const snapshot = await this.options.snapshot();
						this.ensure(authorize);
						if (work.lease !== lease) return { acknowledged: true };
						const unresolved = work.sessions.some((target) => {
							const session = snapshot.sessions.find(
								(candidate) => candidate.paneId === target.paneId && candidate.sessionId === target.sessionId,
							);
							return (
								session?.connected &&
								(session.state === "blocked" ||
									snapshot.approvals?.some((approval) => pair(approval) === pair(target)))
							);
						});
						if (unresolved) outcome = "unresolved";
					} catch {
						this.ensure(authorize);
						if (work.lease !== lease) return { acknowledged: true };
						// A failed status read must release the lease into bounded retry, not hold all workflows.
						outcome = "error";
					} finally {
						this.busy = false;
					}
				}
				this.release(work, outcome);
				this.save();
			}
			return { acknowledged: true };
		}
		if (action === "start") {
			if (this.busy) throw new WorkflowError("Otra operación está en curso.", 429);
			this.busy = true;
			try {
				return await this.start(input, authorize);
			} finally {
				this.busy = false;
			}
		}
		const work = this.find(input);
		if (action === "claim") {
			if (this.automaticInFlight.has(work.id))
				throw new WorkflowError("Esta solicitud ya se está resolviendo con la delegación de la sesión.", 409);
			if (actor !== "agent" || input.leaseId !== undefined || !input.authorization)
				throw new WorkflowError("Esta revisión inmediata requiere una instrucción humana verificada.", 403);
			const authorization = text(input.authorization, "authorization", MAX_AUTHORIZATION_CHARS);
			const claimId = text(input.claimId, "claimId", 256);
			if (work.mode !== "session" || !work.authorization || !active(work))
				throw new WorkflowError(
					"Sólo una delegación de sesión vigente permite revisar solicitudes ahora.",
					409,
				);
			if (this.busy) throw new WorkflowError("Otra operación está en curso.", 429);
			const foregroundClaim = createHash("sha256")
				.update(JSON.stringify([claimId, authorization]))
				.digest("hex");
			if (!(await this.verifyActivity(work, authorize))) throw new WorkflowError("La sesión requiere revisión humana antes de continuar.", 403);
			if (work.lease?.foregroundClaim === foregroundClaim) return this.wake(work);
			if ([...this.works.values()].some((candidate) => candidate.lease))
				throw new WorkflowError(
					"Hay otra continuación en curso; termina esa revisión antes de reclamar ésta.",
					409,
				);
			if (runLimitReached(work))
				throw new WorkflowError("Se alcanzó el límite de continuaciones autorizado.", 409);
			work.attempts = 0;
			work.nextAttemptAt = this.now();
			const reasons = work.pending.splice(0);
			if (!reasons.length) reasons.push("La persona pidió revisar ahora las solicitudes de esta sesión.");
			if (!(await this.verifyActivity(work, authorize))) throw new WorkflowError("La sesión requiere revisión humana antes de continuar.", 403);
			return this.leaseWork(work, reasons, foregroundClaim);
		}
		if (["pause", "stop", "complete", "resume", "update"].includes(String(action))) {
			if (work.mode === "session" && action === "complete")
				throw new WorkflowError(
					"La delegación de esta sesión sigue vigente hasta que la persona la pause o revoque; no termina al completar una tarea.",
					409,
				);
			if (input.leaseId) this.scoped(work, input, authorize);
			if (action === "resume") {
				if (
					actor === "agent" &&
					(input.leaseId !== undefined || work.lease || input.authorization === undefined)
				)
					throw new WorkflowError(
						"Sólo la persona puede reanudar el seguimiento, mediante una nueva instrucción verificada en el chat.",
						403,
					);
				// The gateway supplies this from its human-message ledger, outside the model's tool schema.
				const resumeAuthorization =
					actor === "agent" ? text(input.authorization, "authorization", MAX_AUTHORIZATION_CHARS) : undefined;
				if (this.busy || this.automaticInFlight.has(work.id))
					throw new WorkflowError("Espera a que termine la operación en curso antes de reanudar.", 429);
				const renew = !!work.yieldQuestion;
				if (
					!["paused", "failed"].includes(work.state) ||
					(!renew && deadline(work) <= this.now()) ||
					runLimitReached(work)
				)
					throw new WorkflowError("El plazo o el límite de este seguimiento no permite reanudarlo.", 409);
				if (
					[...this.works.values()].some(
						(other) =>
							other.id !== work.id &&
							(other.mode === "session") === (work.mode === "session") &&
							(active(other) || other.state === "paused") &&
							other.sessions.some((target) =>
								work.sessions.some((session) => pair(target) === pair(session)),
							),
					)
				)
					throw new WorkflowError("Una sesión ya pertenece a otro seguimiento activo.", 409);
				const resumeRevision = this.approvalRevisions.get(work.id);
				const resumeState = work.state;
				const snapshot = await this.options.snapshot();
				this.ensure(authorize);
				if (this.approvalRevisions.get(work.id) !== resumeRevision || work.state !== resumeState)
					throw new WorkflowError("La delegación cambió durante la revisión de actividad.", 409);
				for (const target of work.sessions) {
					const session = snapshot.sessions.find(s => pair(s) === pair(target));
					if (!session?.connected || session.capabilities?.activityFence !== 1) throw new WorkflowError("Sólo avisos: actualiza el adaptador con protección de actividad antes de reanudar.", 403);
					work.observed[pair(target)] = {...work.observed[pair(target)], state:session.state, connected:true, humanActivityAt:session.humanActivityAt ?? null, activityInstanceId:session.activityInstanceId};
				}
				if (renew) work.expiresAt = stamp(this.now() + (work.renewalHours ?? 24) * 3600_000);
				work.state = "waiting";
				if (!work.authorization && resumeAuthorization) work.authorization = resumeAuthorization;
				work.attempts = 0;
				work.nextAttemptAt = this.now();
				// A human resume permits a new inspection, never a replay of a possibly delivered command.
				work.operations = work.operations.filter((operation) => operation.state === "sent");
				work.lastMessage =
					actor === "agent"
						? "La persona pidió reanudar el seguimiento desde el chat."
						: "La persona pidió reanudar el seguimiento.";
				this.enqueue(work, "La persona pidió revisar y reanudar este objetivo.");
			} else if (action === "update") {
				if (actor === "agent" && work.lease)
					throw new WorkflowError(
						"Una continuación no puede ampliar ni sustituir el objetivo autorizado.",
						403,
					);
				if (!active(work) && work.state !== "paused")
					throw new WorkflowError("Este seguimiento ya terminó.", 409);
				const objective = text(input.objective, "objective", 4000);
				const authorization =
					input.authorization !== undefined
						? text(input.authorization, "authorization", MAX_AUTHORIZATION_CHARS)
						: objective === work.objective
							? work.authorization
							: undefined;
				if (work.mode === "session" && !authorization)
					throw new WorkflowError(
						"Actualizar una delegación requiere una nueva instrucción humana verificada.",
						403,
					);
				work.objective = objective;
				work.authorization = authorization;
				work.approvalPolicy = work.mode === "session" ? sessionApprovalPolicy(authorization) : undefined;
				if (work.lease) {
					delete work.lease;
					work.state = "waiting";
					this.enqueue(work, "La persona actualizó el objetivo; vuelve a inspeccionar antes de continuar.");
				} else if (work.mode === "session" && active(work)) {
					work.attempts = 0;
					work.nextAttemptAt = this.now();
					this.enqueue(work, "La persona actualizó la delegación; revisa sus solicitudes pendientes.");
				}
			} else {
				if (!active(work) && work.state !== "paused" && !(action === "stop" && work.state === "failed"))
					throw new WorkflowError("Este seguimiento ya terminó.", 409);
				work.state = action === "complete" ? "completed" : action === "stop" ? "cancelled" : "paused";
				work.lastMessage =
					action === "complete"
						? "Dot marcó el objetivo como completado; consulta su informe final."
						: action === "stop"
							? "La persona finalizó el seguimiento sin marcar el objetivo como completado."
							: actor === "human"
								? "La persona pausó el seguimiento."
								: "Dot pausó el seguimiento para revisión.";
				delete work.lease;
				if (action === "complete" || action === "stop") work.pending = [];
			}
			delete work.yieldQuestion;
			work.updatedAt = stamp(this.now());
			this.approvalRevisions.set(work.id, (this.approvalRevisions.get(work.id) ?? 0) + 1);
			this.save();
			return this.public(work);
		}
		if (action !== "inspect" && action !== "prompt" && action !== "approve")
			throw new WorkflowError("Acción de seguimiento no admitida.");
		if (work.mode === "session" && action === "prompt")
			throw new WorkflowError(
				"Esta delegación sólo permite resolver solicitudes de la sesión, no encargarle trabajo nuevo.",
				403,
			);
		const target = work.sessions.find(
			(session) => session.paneId === input.paneId && session.sessionId === input.sessionId,
		);
		if (!target) throw new WorkflowError("La sesión no está incluida en el objetivo autorizado.", 403);
		if (this.busy) throw new WorkflowError("Otra operación está en curso.", 429);
		const lease = this.scoped(work, input, authorize);
		const verified = await this.verifyActivity(work, authorize);
		this.scoped(work, input, authorize);
		if (!verified) throw new WorkflowError("La actividad de la sesión cambió; el seguimiento está pausado.", 409);
		this.busy = true;
		const current = () =>
			!this.closed &&
			!this.storageError &&
			active(work) &&
			work.lease?.id === lease.id &&
			lease.expiresAt > this.now() &&
			deadline(work) > this.now() &&
			authorize();
		this.bindActivity(work, current);
		try {
			if (action === "inspect") {
				const result = await this.options.inspect(target.paneId, target.sessionId);
				this.scoped(work, input, authorize);
				if (!record(result) || result.sessionId !== target.sessionId)
					throw new WorkflowError("La sesión cambió durante la inspección.", 409);
				if (result.status === "idle" && !result.question) lease.inspected[pair(target)] = this.now();
				else delete lease.inspected[pair(target)];
				delete lease.questions[pair(target)];
				if (record(result.question) && result.question.answerable === true) {
					lease.questions[pair(target)] = {
						humanOnly: humanOnlyQuestion(result.question),
						id: text(result.question.id, "requestId", 256),
						hash: workflowQuestionHash(result.question),
						at: this.now(),
					};
				}
				this.save();
				return work.mode !== "session" && this.delegated(target)
					? { ...result, approvalDelegated: true }
					: result;
			}
			const operationId = text(input.operationId, "operationId", 256);
			const approval = action === "approve";
			const instruction = approval ? undefined : text(input.text, "text", 16_000);
			const requestId = approval ? text(input.requestId, "requestId", 256) : undefined;
			const reason = approval ? text(input.reason, "reason", 2000) : undefined;
			const answer = approval ? input.answer : undefined;
			if (!work.authorization)
				throw new WorkflowError(
					"Este seguimiento antiguo no tiene una instrucción humana verificable. Actualiza el objetivo antes de delegar acciones o permisos.",
					403,
				);
			if (
				approval &&
				(!record(answer) ||
					Object.keys(answer).some(
						(key) => !["confirmed", "optionId", "text", "answers", "cancelled"].includes(key),
					) ||
					Buffer.byteLength(JSON.stringify(answer)) > 65_536)
			)
				throw new WorkflowError("Indica una respuesta concreta a la solicitud inspeccionada.");
			const digest = createHash("sha256")
				.update(
					JSON.stringify(
						approval ? [pair(target), "approve", requestId, answer, reason] : [pair(target), instruction],
					),
				)
				.digest("hex");
			const existing = work.operations.find((operation) => operation.id === operationId);
			if (existing) {
				if (existing.hash !== digest)
					throw new WorkflowError("Una operación repetida cambió de contenido.", 409);
				if (existing.state === "sent") return { accepted: true, duplicate: true };
				throw new WorkflowError(
					"El envío anterior no pudo confirmarse; no se repetirá automáticamente.",
					409,
				);
			}
			const inspectedAt = lease.inspected[pair(target)];
			const question = lease.questions[pair(target)];
			if (
				!approval &&
				(inspectedAt === undefined ||
					this.now() - inspectedAt > 60_000 ||
					work.observed[pair(target)]?.awaiting)
			)
				throw new WorkflowError(
					"Inspecciona primero el estado actual de esta sesión y espera su resultado pendiente.",
					409,
				);
			if (approval && (!question || question.id !== requestId || this.now() - question.at > 60_000))
				throw new WorkflowError("Inspecciona primero esta solicitud concreta de la sesión autorizada.", 409);
			if (approval && question?.humanOnly !== false)
				throw new WorkflowError("Esta publicación o envío requiere respuesta humana directa.", 403);
			if (approval && !this.options.approve)
				throw new WorkflowError("Esta conexión no permite responder solicitudes del objetivo.", 409);
			if (lease.prompts >= 8)
				throw new WorkflowError(
					"Se alcanzó el límite de acciones de esta continuación; espera el siguiente cambio del agente.",
					409,
				);
			const operation: Operation = {
				id: operationId,
				hash: digest,
				state: "dispatching",
				at: stamp(this.now()),
				kind: approval ? "approve" : "prompt",
				leaseId: lease.id,
				...(approval ? { requestId, reason } : {}),
			};
			work.operations.push(operation);
			delete lease.inspected[pair(target)];
			delete lease.questions[pair(target)];
			this.save();
			const observedBefore = work.observed[pair(target)];
			const sent = this.sending(target);
			let result: unknown;
			try {
				result = approval
					? await this.options.approve?.(
							{
								workflowId: work.id,
								objective: work.objective,
								authorizedInstruction: work.authorization as string,
								paneId: target.paneId,
								sessionId: target.sessionId,
								requestId: requestId as string,
								questionHash: question?.hash as string,
								answer: answer as Record<string, unknown>,
								reason: reason as string,
							},
							current,
						)
					: await this.options.prompt(target.paneId, target.sessionId, instruction as string, current);
			} catch (error) {
				if (approval && error instanceof WorkflowApprovalRejected) {
					work.operations = work.operations.filter((item) => item !== operation);
					this.save();
					throw error;
				}
				const message =
					"No se pudo confirmar el envío. Revisa la sesión antes de reanudar; no se repetirá automáticamente.";
				if (active(work) && work.lease?.id === lease.id) {
					work.state = "paused";
					delete work.lease;
					work.lastMessage = message;
				}
				this.save();
				throw new WorkflowError(message, 409);
			} finally {
				sent();
			}
			operation.state = "sent";
			lease.prompts++;
			if (work.observed[pair(target)] === observedBefore)
				work.observed[pair(target)] = { ...observedBefore, state: "working", awaiting: true };
			this.save();
			if (!current()) throw new WorkflowError("El seguimiento se pausó durante el envío.", 409);
			return result;
		} finally {
			this.busy = false;
		}
	}
	private async start(input: Record<string, unknown>, authorize: () => boolean): Promise<WorkflowStatus> {
		const mode = input.mode ?? "objective";
		if (mode !== "objective" && mode !== "session")
			throw new WorkflowError("El modo de seguimiento no es válido.");
		const objective = text(input.objective, "objective", 4000);
		const authorization =
			input.authorization === undefined
				? undefined
				: text(input.authorization, "authorization", MAX_AUTHORIZATION_CHARS);
		if (!Array.isArray(input.sessions) || input.sessions.length < 1 || input.sessions.length > 8)
			throw new WorkflowError("Selecciona de una a ocho sesiones concretas.");
		if (mode === "session" && (input.sessions.length !== 1 || !authorization))
			throw new WorkflowError(
				"La delegación persistente necesita una sesión exacta y la instrucción humana verificada.",
				403,
			);
		const sessions = input.sessions.map((item) => {
			if (!record(item)) throw new WorkflowError("Sesión inválida.");
			return { paneId: text(item.paneId, "paneId"), sessionId: text(item.sessionId, "sessionId") };
		});
		if (new Set(sessions.map(pair)).size !== sessions.length)
			throw new WorkflowError("Hay sesiones repetidas.");
		const hours = input.expiresInHours;
		const maxRuns = input.maxRuns;
		if (
			(hours !== undefined &&
				(typeof hours !== "number" || !Number.isFinite(hours) || hours < 0.25 || hours > 168)) ||
			(maxRuns !== undefined &&
				(typeof maxRuns !== "number" || !Number.isSafeInteger(maxRuns) || maxRuns < 1 || maxRuns > 200))
		)
			throw new WorkflowError(
				"El plazo debe ser de 15 minutos a 7 días y el límite de 1 a 200 continuaciones.",
			);
		if ([...this.works.values()].filter((work) => !terminal(work)).length >= 16)
			throw new WorkflowError(
				"Se alcanzó el límite de 16 seguimientos pendientes. Finaliza alguno antes de registrar otro.",
				409,
			);
		for (const work of this.works.values())
			if (
				(work.mode === "session") === (mode === "session") &&
				(active(work) || work.state === "paused") &&
				sessions.some((session) => work.sessions.some((other) => pair(other) === pair(session)))
			)
				throw new WorkflowError("Una sesión ya pertenece a otro seguimiento activo o pausado.", 409);
		const revision = this.controlRevision;
		const snapshot = await this.options.snapshot();
		this.ensure(authorize);
		if (revision !== this.controlRevision)
			throw new WorkflowError("La persona detuvo el seguimiento antes de registrarlo.", 409);
		const observed: Record<string, Observation> = {};
		const selected = sessions.map((target) => {
			const session = snapshot.sessions.find(
				(item) => item.paneId === target.paneId && item.sessionId === target.sessionId,
			);
			if (
				!session?.connected ||
				session.capabilities?.inspect !== true ||
				(mode === "session"
					? session.capabilities?.approvals !== true
					: session.capabilities?.prompt !== true)
			)
				throw new WorkflowError(
					mode === "session"
						? "Esta sesión no permite responder solicitudes desde la app. Conecta su adaptador antes de delegar sus permisos."
						: "La sesión seleccionada no está conectada o no permite inspección y continuación.",
					409,
				);
			observed[pair(target)] = {
				humanActivityAt: session.humanActivityAt ?? null,
				activityInstanceId: session.activityInstanceId,
				state: session.state,
				connected: true,
				requestId: snapshot.approvals?.find(
					(item) => item.paneId === target.paneId && item.sessionId === target.sessionId,
				)?.id,
				...(session.assistantMessageId ? { assistantMessageId: session.assistantMessageId } : {}),
			};
			return { ...target, label: session.label.slice(0, 256) };
		});
		const work: StoredWorkflow = {
			id: randomUUID(),
			...(mode === "session" ? { mode } : {}),
			objective,
			...(authorization ? { authorization } : {}),
			...(mode === "session" ? { approvalPolicy: sessionApprovalPolicy(authorization) } : {}),
			sessions: selected,
			state: "waiting",
			createdAt: stamp(this.now()),
			updatedAt: stamp(this.now()),
			expiresAt: stamp(this.now() + (typeof hours === "number" ? hours : 24) * 3600_000),
			renewalHours: typeof hours === "number" ? hours : 24,
			runs: 0,
			...(typeof maxRuns === "number" ? { maxRuns } : {}),
			pending:
				mode === "session"
					? selected
							.filter(
								(session) =>
									observed[pair(session)]?.requestId || observed[pair(session)]?.state === "blocked",
							)
							.map((session) => `Permiso pendiente: ${session.paneId}`)
					: [
							"Seguimiento explícito registrado: inspecciona el estado actual antes de continuar el objetivo.",
						],
			seen: [],
			observed,
			operations: [],
			attempts: 0,
			nextAttemptAt: this.now(),
		};
		this.works.set(work.id, work);
		if (snapshot.sessions.some(session => sessions.some(target => pair(target) === pair(session)) && session.capabilities?.activityFence !== 1)) {
			work.state = "paused";
			work.lastMessage = "Sólo avisos: el adaptador no tiene protección de actividad versionada. Actualízalo antes de activar autonomía.";
		}
		this.save();
		if (active(work) && work.approvalPolicy && work.pending.length) {
			// An existing dialog must not wait for a future event or another model turn.
			// Registration remains durable if its adapter cannot be read immediately.
			const target = selected[0];
			if (target) {
				let page: unknown;
				try {
					page = await this.options.inspect(target.paneId, target.sessionId);
				} catch {
					/* Normal review remains queued. */
				}
				if (record(page) && page.sessionId === target.sessionId && record(page.question))
					await this.tryApprove({ ...target, question: page.question });
			}
		}
		return this.public(work);
	}
	close(): void {
		this.closed = true;
		for (const peer of this.enrollments.values()) peer.socket.destroy();
		this.enrollments.clear();
	}
}
