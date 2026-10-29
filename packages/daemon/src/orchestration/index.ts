import { createHash, randomUUID } from "node:crypto";
import { ATTACHMENT_LIMITS, type AttachmentRef } from "@gentle-dot/protocol";
import type { UploadStore } from "../uploads.ts";
import { attachmentCapability, decodeSessionFiles, type AttachmentCapability } from "./session-attachments.ts";
import { lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeDir } from "../runtime.ts";
import {
	WorkflowApprovalRejected,
	type WorkflowApprovalRequest,
	type WorkflowPendingApproval,
	workflowQuestionHash,
	verifyWorkflowActivity,
} from "../workflows.ts";
import { parseCompanionActivity } from "./companion-activity.ts";
import { CompanionContext } from "./companion-context.ts";
import { CompanionActivityPoll, type CompanionPollPeer } from "./companion-poll.ts";
import { boundSessionWork, readBoundSessionEntries } from "./activity-files.ts";
import {
	defaultTerminalLauncher,
	launchTerminal,
	OrcaDisplay,
	type ProviderStatus,
	type RunCli,
} from "./displays.ts";
import { defaultHerdrSocket, localRequest, OrchestrationError, record } from "./herdr.ts";
import { canAnswerQuestion, humanOnlyQuestion, questionAnswer, questionDetails, questionRevision, type RemoteQuestion } from "./questions.ts";
import { type DisplayProvider, type Manifest, readManifests } from "./registry.ts";
import { isSessionCopy } from "./session-copy.ts";
import { historySessionMetadata, publicSessionMetadata, type SessionMetadata } from "./session-info.ts";
import { peerSessionMetadata } from "./session-peer.ts";
import { normalizeBoundMessages } from "./transcript.ts";
import { textOnlySessionMessages } from "./session-display-projection.ts";

export { OrchestrationError } from "./herdr.ts";

const runtime = runtimeDir();
export const ORCHESTRATOR_EXTENSION_PATH = runtime
	? join(runtime, "daemon", "extensions", "dot-orchestrator.ts")
	: fileURLToPath(new URL("../extensions/dot-orchestrator.ts", import.meta.url));
export const SESSION_EXTENSION_PATH = runtime
	? join(runtime, "daemon", "extensions", "dot-session.ts")
	: fileURLToPath(new URL("../extensions/dot-session.ts", import.meta.url));

export interface Session {
	humanActivityAt?: string;
	activityInstanceId?: string;
	provider: DisplayProvider;
	capabilities: {
		inspect: boolean;
		prompt: boolean;
		activityFence?: number;
		enrollmentProtocol?: number;
		deliveryReceipts?: boolean;
		deliveryModes?: ("steer" | "followUp")[];
		abort: boolean;
		approvals: boolean;
		close?: boolean;
		duplicate?: boolean;
		attachments?: AttachmentCapability;
	};
	paneId: string;
	terminalId: string;
	workspaceId: string;
	label: string;
	state: "idle" | "working" | "blocked" | "done" | "unknown";
	sessionId?: string;
	connected: boolean;
	managed: boolean;
	cwd?: string;
	lastMessage?: string;
	/** Stable transcript entry identity; absent for older session adapters. */
	assistantMessageId?: string;
}
export interface Approval extends Partial<RemoteQuestion> {
	id: string;
	paneId: string;
	sessionId: string;
	title: string;
	message: string;
	action: string;
	createdAt: string;
	expiresAt: string;
	answerable: boolean;
	policyEligible?: boolean;
	questionRevision?: string;
	unavailableReason?: "legacy_connection" | "terminal_only";
}
export interface Policy {
	id: string;
	paneId: string;
	sessionId: string;
	action: string;
	expiresAt: string;
	remainingUses: number;
}
export interface OrchestrationEvent {
	dialogKind?: "question" | "permission";
	dialogTitle?: string;
	intentional?: boolean;
	resultChanged?: boolean;
	requestId?: string;
	id: string;
	at: string;
	type: "completed" | "attention" | "disconnected" | "policy";
	paneId?: string;
	sessionId?: string;
	assistantMessageId?: string;
	message: string;
}
export interface OrchestrationSnapshot {
	mutationInstanceFence?: 1;
	providers: ProviderStatus[];
	available: boolean;
	error?: string;
	sessions: Session[];
	approvals: Approval[];
	policies: Policy[];
	events: OrchestrationEvent[];
}
interface Bound {
	pane: Record<string, unknown>;
	manifest: Manifest;
}
interface StoredPolicy extends Policy {
	fingerprint: string;
}
export interface OrchestratorOptions {
	dataDir: string;
	socketPath?: string;
	piCommand?: string;
	piArgs?: string[];
	registryDirs?: string[];
	orcaCommand?: string | false;
	orcaRun?: RunCli;
	terminalLauncher?: string[] | false;
	launchTerminal?: typeof launchTerminal;
	/** Zero disables background polling, useful for deterministic tests. */
	pollMs?: number;
	onEvent?: (event: OrchestrationEvent) => void;
	onInteraction?: (target: {paneId:string; sessionId:string}, origin: "human" | "workflow") => void;
	/** Resolve an exact, already authorized confirmation before publishing a pending alert. */
	onApproval?: (request: WorkflowPendingApproval) => Promise<boolean>;
	request?: typeof localRequest;
	registry?: typeof readManifests;
}

function text(value: unknown, name: string, max = 256): string {
	if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0"))
		throw new OrchestrationError("INVALID_INPUT", `El campo ${name} no es válido.`, 400);
	return value;
}
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export class Orchestrator {
	private readonly options: OrchestratorOptions;
	private readonly socketPath: string;
	private readonly directory: string;
	private readonly directories: string[];
	private readonly request: typeof localRequest;
	private readonly registry: typeof readManifests;
	private readonly orca: OrcaDisplay;
	private readonly terminalLauncher: string[] | undefined;
	private readonly policies = new Map<string, StoredPolicy>();
	private readonly expectedClosures = new Set<string>();
	private readonly events: OrchestrationEvent[] = [];
	private readonly settledMessages = new Map<string, string | undefined>();
	private readonly humanActivity = new Map<string, string | undefined>();
	private readonly metadataPeers = new Map<string, { until: number; metadata?: SessionMetadata }>();
	private last: OrchestrationSnapshot = {
		available: false,
		providers: [],
		sessions: [],
		approvals: [],
		policies: [],
		events: [],
	};
	private refreshing?: Promise<OrchestrationSnapshot>;
	private timer?: ReturnType<typeof setInterval>;
	private closed = false;
	private readonly mutatingPanes = new Set<string>();
	private uploads?: UploadStore;
	private readonly companionContext = new CompanionContext();
    private companionNativePane: string | undefined;
	private companionPeers = new Map<string, CompanionPollPeer & { bound: Bound }>();
	private readonly companionPoll = new CompanionActivityPoll({
		peer: () => {
			const context = this.companionContext.read();
			const pane = this.companionNativePane ?? context.focusedPaneId;
            return context.stale || !pane ? undefined : this.companionPeers.get(pane);
		},
		read: async (peer: CompanionPollPeer & { bound: Bound }) => {
			const value = (await this.call(peer.bound, "companion.activity", {}, () => true, 1000)).companionActivity;
			if (!parseCompanionActivity(value)) throw new OrchestrationError("PROTOCOL", "Pi devolvió actividad inválida.");
			this.observeHumanActivity(peer.paneId, peer.sessionId, value);
			return value;
		},
		accept: (peer, value) => this.companionContext.acceptActivity(peer.paneId, peer.sessionId, value),
		unavailable: peer => this.companionContext.activityUnavailable(peer.paneId, peer.sessionId),
	});

	private observeHumanActivity(paneId: string, sessionId: string, value: unknown): void {
		const key = JSON.stringify([paneId, sessionId]);
		const at = record(value) && typeof value.humanActivityAt === "string" ? value.humanActivityAt : undefined;
		const previous = this.humanActivity.get(key);
		if (at && Number.isFinite(Date.parse(at)) && (!previous || Date.parse(at) > Date.parse(previous))) {
			if (this.humanActivity.has(key)) this.options.onInteraction?.({paneId, sessionId}, "human");
			this.humanActivity.set(key, at);
		} else if (!this.humanActivity.has(key)) this.humanActivity.set(key, undefined);
	}

	companion() { this.companionPoll.touch(); return this.companionContext.read(); }
    companionGeometryBindings() { return [...this.companionPeers.values()].map(peer => ({paneId:peer.paneId,sessionId:peer.sessionId,pid:peer.bound.manifest.pid,herdrSocketPath:peer.bound.manifest.binding.herdrSocketPath ?? this.socketPath})); }
    observeCompanionPane(paneId: string | undefined) { this.companionNativePane=paneId; this.companionPoll.touch(); }

	/** Human-only focus request: verify the exact live Pi binding before touching HERDR. */
	async focusCompanion(input: Record<string, unknown>, authorize: () => boolean) {
		this.assertAuthorized(authorize);
		if (Object.keys(input).some(key => key !== "paneId" && key !== "sessionId"))
			throw new OrchestrationError("INVALID_INPUT", "La solicitud de foco no es válida.", 400);
		const paneId = text(input.paneId, "paneId");
		const sessionId = text(input.sessionId, "sessionId");
		const bound = await this.bind(paneId, sessionId);
		if ((bound.manifest.binding.provider ?? "herdr") !== "herdr")
			throw new OrchestrationError("UNSUPPORTED", "Esta terminal no permite abrir la sesión desde Capri.");
		await this.call(bound, "snapshot", { limit: 1 }, authorize);
		this.assertAuthorized(authorize);
		await this.request(this.socketPath, "pane.focus", { pane_id: paneId }, 5000, authorize);
		this.assertAuthorized(authorize);
		const result = await this.request(this.socketPath, "session.snapshot");
		this.assertAuthorized(authorize);
		if (!record(result.snapshot) || result.snapshot.focused_pane_id !== paneId)
			throw new OrchestrationError("FOCUS_UNCONFIRMED", "HERDR no confirmó que esta sesión recibió el foco.");
		return { focused: true, paneId, sessionId, scope: "herdr" };
	}

	setUploadStore(store: UploadStore) { this.uploads = store; }

	/** Resolve a live native session before any window decoration; never accept a client PID/socket. */
	async terminalTarget(paneId: string, authorize: () => boolean) {
		this.assertAuthorized(authorize);
		const bound = await this.bind(text(paneId, "paneId"));
		const manifest = bound.manifest;
		if (manifest.version !== 2 || !manifest.processIdentity || !manifest.instanceId)
			throw new OrchestrationError("UNBOUND", "Esta sesión necesita el adaptador Gentle Dot actualizado.");
		await this.call(bound, "snapshot", { limit: 1 }, authorize);
		const peers = (await this.registry(this.directories, this.socketPath)).filter(entry => entry.version === 2 && entry.processIdentity).map(entry => ({
			paneId: entry.binding.provider === "herdr" || !entry.binding.provider
				? entry.binding.paneId ?? this.last.sessions.find(session => session.terminalId === String(entry.binding.terminalId))?.paneId
				: `pi:${entry.instanceId}`,
			pid: entry.pid,
			processIdentity: entry.processIdentity!,
		}));
		this.assertAuthorized(authorize);
		return { paneId, pid: manifest.pid, processIdentity: manifest.processIdentity, sessionId: manifest.sessionId, instanceId: manifest.instanceId, ...((manifest.binding.provider ?? "herdr") === "herdr" ? {herdrSocketPath:manifest.binding.herdrSocketPath ?? this.socketPath}:{}), peers };
	}

	private uploadOwner(bound: Bound, paneId: string, device: string) {
		return createHash("sha256").update(JSON.stringify([device, paneId, bound.manifest.sessionId, bound.manifest.instanceId])).digest("hex");
	}

	/** Called before upload bytes are accepted; capabilities belong to the exact native adapter, not the display provider. */
	async attachmentDestination(input: Record<string, unknown>, device: string, authorize: () => boolean) {
		this.assertAuthorized(authorize);
		const paneId = text(input.paneId, "paneId");
		const bound = await this.bind(paneId, text(input.sessionId, "sessionId"));
		const page = await this.call(bound, "snapshot", { limit: 1 }, authorize);
		if (bound.manifest.version !== 2 || !bound.manifest.instanceId || !bound.manifest.processIdentity || !bound.manifest.managed || !record(page.capabilities) || !attachmentCapability(page.capabilities.attachments))
			throw new OrchestrationError("UNSUPPORTED_ATTACHMENTS", "Esta conexión no admite archivos adjuntos. Inicia Pi con el adaptador Gentle Dot actualizado.");
		if (record(page.question)) throw new OrchestrationError("QUESTION_PENDING", "Responde al permiso pendiente antes de adjuntar archivos.");
		return { bound, capability: page.capabilities.attachments, owner: this.uploadOwner(bound, paneId, device) };
	}

	constructor(options: OrchestratorOptions) {
		this.options = options;
		this.socketPath = options.socketPath ?? defaultHerdrSocket();
		this.directory = join(options.dataDir, "pi-sessions");
		this.directories = [
			this.directory,
			...(options.registryDirs ?? [
				process.env.HERDR_MOBILE_PI_DIR ||
					join(
						process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"),
						"herdr-mobile",
						"pi-connect",
					),
			]),
		];
		this.request = options.request ?? localRequest;
		this.registry = options.registry ?? readManifests;
		this.orca = new OrcaDisplay(options.orcaCommand, options.orcaRun);
		this.terminalLauncher =
			options.terminalLauncher === false
				? undefined
				: (options.terminalLauncher ?? defaultTerminalLauncher());
		if (options.pollMs !== 0) {
			this.timer = setInterval(() => {
				void this.snapshot();
			}, options.pollMs ?? 3000);
			this.timer.unref();
		}
	}

	private emit(
		type: OrchestrationEvent["type"],
		message: string,
		paneId?: string,
		sessionId?: string,
		assistantMessageId?: string,
		requestId?: string,
		resultChanged?: boolean,
		intentional?: boolean,
		dialog?: { dialogKind: "question" | "permission"; dialogTitle: string },
	) {
		const event = {
			id: randomUUID(),
			at: new Date().toISOString(),
			type,
			message,
			...(paneId ? { paneId } : {}),
			...(sessionId ? { sessionId } : {}),
			...(assistantMessageId ? { assistantMessageId } : {}),
			...(requestId ? { requestId } : {}),
			...(resultChanged !== undefined ? { resultChanged } : {}),
			...(intentional !== undefined ? { intentional } : {}),
			...(dialog ? { dialogKind: dialog.dialogKind, dialogTitle: dialog.dialogTitle.slice(0, 160) } : {}),
		};
		this.events.push(event);
		if (this.events.length > 100) this.events.shift();
		try {
			this.options.onEvent?.(event);
		} catch {
			/* A notification consumer cannot interrupt control. */
		}
	}

	private async bind(paneId: string, expectedSessionId?: string, manifests?: Manifest[]): Promise<Bound> {
		if (paneId.startsWith("pi:")) {
			const entries = manifests ?? (await this.registry(this.directories, this.socketPath));
			const matches = entries.filter(
				(entry) =>
					entry.version === 2 && entry.binding.provider !== "herdr" && `pi:${entry.instanceId}` === paneId,
			);
			const manifest = matches[0];
			if (matches.length !== 1 || !manifest)
				throw new OrchestrationError("UNBOUND", "Esta sesión ya no está conectada. Actualiza la lista.");
			if (expectedSessionId !== undefined && manifest.sessionId !== expectedSessionId)
				throw new OrchestrationError(
					"SESSION_CHANGED",
					"La sesión cambió. Actualiza antes de enviar instrucciones.",
				);
			return { pane: this.portablePane(manifest), manifest };
		}
		if (paneId.startsWith("orca:"))
			throw new OrchestrationError(
				"UNBOUND",
				"Inicia Pi con el adaptador Gentle Dot para controlar esta terminal de Orca.",
			);
		const [paneResult, processResult, entries] = await Promise.all([
			this.request(this.socketPath, "pane.get", { pane_id: paneId }),
			this.request(this.socketPath, "pane.process_info", { pane_id: paneId }),
			manifests ?? this.registry(this.directories, this.socketPath),
		]);
		const pane = paneResult.pane;
		const info = processResult.process_info;
		if (!record(pane) || !record(info) || !Array.isArray(info.foreground_processes))
			throw new OrchestrationError("UNBOUND", "No hay una conversación Pi vinculada a este panel.");
		const pids = new Set(info.foreground_processes.filter(record).map((process) => process.pid));
		let matches = entries.filter(
			(entry) =>
				(entry.binding.provider ?? "herdr") === "herdr" &&
				String(entry.binding.terminalId) === String(pane.terminal_id) &&
				pids.has(entry.pid),
		);
		// A Dot adapter and the existing HERDR Mobile adapter can coexist in the same Pi process.
		matches = matches.filter(
			(entry) =>
				entry.managed ||
				!matches.some(
					(other) =>
						other.version === 2 &&
						other.managed &&
						other.pid === entry.pid &&
						other.sessionId === entry.sessionId,
				),
		);
		const manifest = matches[0];
		if (matches.length !== 1 || !manifest)
			throw new OrchestrationError(
				"UNBOUND",
				"Activa el adaptador Gentle Dot en esta sesión de Pi antes de enviar instrucciones.",
			);
		const reported = pane.agent_session;
		if (
			record(reported) &&
			reported.agent === "pi" &&
			((reported.kind === "id" && reported.value !== manifest.sessionId) ||
				(reported.kind === "path" && reported.value !== manifest.sessionFile))
		)
			throw new OrchestrationError("SESSION_CHANGED", "HERDR indica otra sesión en este panel.");
		if (expectedSessionId !== undefined && manifest.sessionId !== expectedSessionId)
			throw new OrchestrationError(
				"SESSION_CHANGED",
				"La sesión cambió. Actualiza antes de enviar instrucciones.",
			);
		return { pane, manifest };
	}

	private assertAuthorized(authorize: () => boolean): void {
		if (this.closed || !authorize())
			throw new OrchestrationError(
				"UNAUTHORIZED",
				"El acceso de este dispositivo fue revocado o la conexión se cerró.",
				401,
			);
	}

	private async call(
		bound: Bound,
		method: string,
		params: Record<string, unknown> = {},
		authorize: () => boolean = () => true,
		timeoutMs = 5000,
	) {
		this.assertAuthorized(authorize);
		const result = await this.request(
			bound.manifest.socketPath,
			method,
			{
				...params,
				expectedSessionId: bound.manifest.sessionId,
				...(bound.manifest.instanceId ? { expectedInstanceId: bound.manifest.instanceId } : {}),
			},
			timeoutMs,
			() => !this.closed && authorize(),
		).catch(error => {
			if (error instanceof OrchestrationError && error.code === "HUMAN_ACTIVE")
				this.options.onInteraction?.({paneId:String(bound.pane.pane_id),sessionId:bound.manifest.sessionId}, "human");
			throw error;
		});
		this.assertAuthorized(authorize);
		if (bound.manifest.instanceId && result.instanceId !== bound.manifest.instanceId)
			throw new OrchestrationError("INSTANCE_CHANGED", "Pi respondió desde otro proceso.");
		if (result.sessionId !== bound.manifest.sessionId)
			throw new OrchestrationError("SESSION_CHANGED", "Pi respondió desde otra sesión.");
		if (method !== "snapshot" && method !== "companion.activity" && result.accepted !== true)
			throw new OrchestrationError(
				"NOT_ACKNOWLEDGED",
				"Pi no confirmó la operación. Actualiza antes de reintentar.",
			);
		return result;
	}

	private async peerMetadata(bound: Bound, authorize: () => boolean): Promise<SessionMetadata | undefined> {
		if (bound.manifest.version !== 2 || !bound.manifest.processIdentity) return;
		const key = JSON.stringify([
			bound.manifest.socketPath,
			bound.manifest.instanceId,
			bound.manifest.pid,
			bound.manifest.processIdentity,
			bound.manifest.sessionId,
		]);
		const cached = this.metadataPeers.get(key);
		if (cached && cached.until > Date.now()) return cached.metadata;
		let entries: Manifest[];
		try {
			entries = await this.registry(this.directories, this.socketPath);
		} catch {
			this.assertAuthorized(authorize);
			return;
		}
		this.assertAuthorized(authorize);
		const metadata = await peerSessionMetadata(
			bound.manifest,
			entries,
			this.request,
			() => !this.closed && authorize(),
		);
		this.assertAuthorized(authorize);
		if (this.metadataPeers.size >= 32) this.metadataPeers.clear();
		this.metadataPeers.set(key, { until: Date.now() + (metadata ? 4_000 : 10_000), metadata });
		return metadata;
	}

	snapshot(): Promise<OrchestrationSnapshot> {
		if (this.closed) return Promise.resolve(this.last);
		if (this.refreshing) return this.refreshing;
		this.refreshing = this.refresh().then(snapshot => ({...snapshot,mutationInstanceFence:1 as const})).finally(() => {
			this.refreshing = undefined;
		});
		return this.refreshing;
	}

	private async refresh(): Promise<OrchestrationSnapshot> {
		for (const [id, policy] of this.policies) {
			if (Date.parse(policy.expiresAt) <= Date.now() || policy.remainingUses <= 0) this.policies.delete(id);
		}
		const providers: ProviderStatus[] = [];
		try {
			// Provider failures are isolated: a stopped desktop must not hide another display's Pi sessions.
			const [herdrResult, orca, registryResult] = await Promise.allSettled([
				this.request(this.socketPath, "session.snapshot"),
				this.orca.list(),
				this.registry(this.directories, this.socketPath),
			]);
			const herdr =
				herdrResult.status === "fulfilled" &&
				record(herdrResult.value.snapshot) &&
				Array.isArray(herdrResult.value.snapshot.panes)
					? herdrResult.value.snapshot
					: undefined;
			providers.push({
				id: "herdr",
				available: !!herdr,
				canCreate: !!herdr,
				...(!herdr
					? {
							error:
								herdrResult.status === "rejected" && herdrResult.reason instanceof Error
									? herdrResult.reason.message
									: "HERDR no está disponible.",
						}
					: {}),
			});
			const manifests = registryResult.status === "fulfilled" ? registryResult.value : [];
			providers.push(
				orca.status === "fulfilled"
					? orca.value.status
					: { id: "orca", available: false, canCreate: false, error: "Orca no está disponible." },
			);
			const portable = manifests.filter((entry) => entry.version === 2 && entry.binding.provider !== "herdr");
			providers.push({
				id: "terminal",
				available: !!this.terminalLauncher || portable.some((entry) => entry.binding.provider === "terminal"),
				canCreate: !!this.terminalLauncher,
				...(!this.terminalLauncher
					? {
							error:
								"Sin lanzador configurado; puedes conectar Pi desde cualquier terminal con sessions:launch.",
						}
					: {}),
			});
			const orcaStatus = providers.find((provider) => provider.id === "orca");
			if (orcaStatus && portable.some((entry) => entry.binding.provider === "orca"))
				orcaStatus.available = true;
			const approvals: Approval[] = [];
			const companionActivity = new Map<string, unknown>();
			const companionPeers = new Map<string, CompanionPollPeer & { bound: Bound }>();
			const sessions: Session[] = [];
			const panes = [
				...(herdr && Array.isArray(herdr.panes) ? herdr.panes.filter(record) : []),
				...(orca.status === "fulfilled" ? orca.value.panes : []),
				...portable.map((entry) => this.portablePane(entry)),
			];
			const workspaces = herdr && Array.isArray(herdr.workspaces) ? herdr.workspaces.filter(record) : [];
			const tabs = herdr && Array.isArray(herdr.tabs) ? herdr.tabs.filter(record) : [];

			for (let index = 0; index < panes.length; index += 8) {
				await Promise.all(
					panes.slice(index, index + 8).map(async (pane) => {
						if (typeof pane.pane_id !== "string") return;
						const session: Session = {
							provider: (pane.provider as DisplayProvider | undefined) ?? "herdr",
							capabilities: { inspect: false, prompt: false, abort: false, approvals: false },
							paneId: pane.pane_id,
							terminalId: String(pane.terminal_id),
							workspaceId: String(pane.workspace_id),
							label: String(
								pane.label ||
									pane.title ||
									pane.terminal_title_stripped ||
									tabs.find((tab) => tab.tab_id === pane.tab_id)?.label ||
									workspaces.find((workspace) => workspace.workspace_id === pane.workspace_id)?.label ||
									pane.pane_id,
							),
							state: ["idle", "working", "blocked", "done"].includes(String(pane.agent_status))
								? (pane.agent_status as Session["state"])
								: "unknown",
							connected: false,
							managed: false,
							...(typeof pane.foreground_cwd === "string"
								? { cwd: pane.foreground_cwd }
								: typeof pane.cwd === "string"
									? { cwd: pane.cwd }
									: {}),
						};
						try {
							if (!manifests.some((entry) => String(entry.binding.terminalId) === session.terminalId))
								throw new Error("No adapter");
							const bound = await this.bind(session.paneId, undefined, manifests);
							const page = await this.call(bound, "snapshot", { limit: 10 });
							companionActivity.set(session.paneId, page.companionActivity);
							session.sessionId = bound.manifest.sessionId;
							session.activityInstanceId = bound.manifest.instanceId;
							this.observeHumanActivity(session.paneId, session.sessionId, page.companionActivity);
							session.connected = true;
							session.managed = bound.manifest.managed === true;
							const caps = record(page.capabilities) ? page.capabilities : {};
							if (record(page.companionActivity) && typeof page.companionActivity.humanActivityAt === "string") session.humanActivityAt = page.companionActivity.humanActivityAt;
							if (caps.companionActivity === true && bound.manifest.version === 2 && bound.manifest.instanceId)
								companionPeers.set(session.paneId, { paneId: session.paneId, sessionId: bound.manifest.sessionId,
									key: `${bound.manifest.socketPath}:${bound.manifest.instanceId}:${bound.manifest.sessionId}`, bound });
							session.capabilities = {
								inspect: true,
								...(caps.activityFence === 1 ? {activityFence:1} : {}),
								...(caps.enrollmentProtocol === 1 ? {enrollmentProtocol:1} : {}),
								prompt: caps.prompt === true,
								...(caps.deliveryReceipts === true ? { deliveryReceipts: true } : {}),
								...(Array.isArray(caps.deliveryModes) ? { deliveryModes: caps.deliveryModes.filter((mode): mode is "steer" | "followUp" => mode === "steer" || mode === "followUp") } : {}),
								...(bound.manifest.version === 2 && bound.manifest.managed && attachmentCapability(caps.attachments) ? { attachments: caps.attachments } : {}),
								abort: caps.abort === true,
								approvals: caps.questions === true,
								close: bound.manifest.managed === true && caps.close === true,
								duplicate:
									bound.manifest.managed === true &&
									caps.duplicate === true &&
									providers.some((provider) => provider.id === session.provider && provider.canCreate),
							};
							if (page.status === "working") session.state = "working";
							else if (page.status === "waiting") session.state = "blocked";
							else if (page.status === "idle") session.state = "idle";
							if (Array.isArray(page.messages)) {
								const messages = page.messages.filter(record);
								const assistantIndex = messages.findLastIndex(
									(message) => message.role === "assistant" && !message.provenance,
								);
								const latest = messages[assistantIndex];
								if (
									latest &&
									assistantIndex >= messages.findLastIndex((message) => message.role === "user") &&
									typeof latest.id === "string" &&
									latest.id.length > 0 &&
									latest.id.length <= 512
								)
									session.assistantMessageId = latest.id;
								if (latest && Array.isArray(latest.content))
									session.lastMessage = latest.content
										.filter(record)
										.filter((part) => part.type === "text")
										.map((part) => String(part.text))
										.join("\n")
										.slice(-2000);
							}
							if (record(page.question) && typeof page.question.id === "string") {
								const question = page.question;
								const details = questionDetails(question);
								const potentiallyAnswerable = canAnswerQuestion(session.managed, question, caps);
								const validRevision = caps.questionBinding === 1 && potentiallyAnswerable && typeof page.questionRevision === "string" && page.questionRevision === questionRevision(question);
								// An adapter advertising binding must not silently downgrade on a missing or mismatched revision.
								const answerable = potentiallyAnswerable && (caps.questionBinding !== 1 || validRevision);
								const policyEligible =
									answerable &&
									session.managed &&
									question.kind === "confirm" &&
									typeof question.fingerprint === "string";
								const approval: Approval = {
									id: question.id as string,
									paneId: session.paneId,
									sessionId: session.sessionId,
									title: String(question.title || "Pi necesita tu respuesta"),
									message: String(question.message || ""),
									action: String(question.action || question.title || "Confirmar"),
									createdAt:
										typeof question.createdAt === "string" ? question.createdAt : new Date().toISOString(),
									expiresAt: typeof question.expiresAt === "string" ? question.expiresAt : "",
									...details,
									answerable,
									policyEligible,
									...(validRevision ? {questionRevision:page.questionRevision as string} : {}),
									...(!answerable
										? {
												unavailableReason: session.managed
													? ("terminal_only" as const)
													: ("legacy_connection" as const),
											}
										: {}),
								};
								const policy = approval.policyEligible
									? [...this.policies.values()].find(
											(policy) =>
												policy.paneId === session.paneId &&
												policy.sessionId === session.sessionId &&
												policy.fingerprint === question.fingerprint &&
												policy.remainingUses > 0 &&
												Date.parse(policy.expiresAt) > Date.now(),
										)
									: undefined;
								if (policy && !this.mutatingPanes.has(session.paneId) && !this.closed) {
									this.mutatingPanes.add(session.paneId);
									try {
										// Recheck process/session/question immediately before consuming a human grant.
										const current = await this.bind(session.paneId, session.sessionId);
										const fresh = await this.call(current, "snapshot");
										if (
											this.policies.get(policy.id) === policy &&
											record(fresh.question) &&
											fresh.question.id === approval.id &&
											current.manifest.managed === true &&
											fresh.question.kind === "confirm" &&
											canAnswerQuestion(true, fresh.question, fresh.capabilities) &&
											fresh.question.fingerprint === policy.fingerprint &&
											Date.parse(policy.expiresAt) > Date.now()
										) {
											policy.remainingUses--;
											await this.call(
												current,
												"answer",
												{ questionId: approval.id, confirmed: true },
												() =>
													this.policies.get(policy.id) === policy &&
													Date.parse(policy.expiresAt) > Date.now() &&
													this.mutatingPanes.has(session.paneId),
											);
											this.emit(
												"policy",
												`Se aplicó la autorización limitada: ${policy.action}.`,
												session.paneId,
											);
										} else approvals.push(approval);
									} finally {
										this.mutatingPanes.delete(session.paneId);
									}
								} else {
									let answered = false;
									if (answerable && this.options.onApproval && !this.closed) {
										try {
											answered =
												!this.mutatingPanes.has(session.paneId) &&
												(await this.options.onApproval({
                                                    activity:{version:caps.activityFence === 1 ? 1 : 0, enrollmentProtocol: caps.enrollmentProtocol === 1 ? 1 : 0, at:session.humanActivityAt ?? null, instanceId:session.activityInstanceId},
													paneId: session.paneId,
													sessionId: session.sessionId,
													question,
												}));
										} catch {
											/* A failed background decision must leave the human dialog visible. */
										}
									}
									if (answered) session.state = "working";
									else approvals.push(approval);
								}
							}
						} catch {
							/* Session state stays visible even when its adapter is unavailable. */
						}
						sessions.push(session);
					}),
				);
			}
			sessions.sort((a, b) => a.paneId.localeCompare(b.paneId));
			for (const session of sessions) {
				const previous = this.last.sessions.find(
					(old) => old.terminalId === session.terminalId && old.sessionId === session.sessionId,
				);
				if (
					session.state === "blocked" &&
					previous?.state !== "blocked" &&
					!approvals.some((approval) => approval.paneId === session.paneId)
				)
					this.emit(
						"attention",
						`${session.label}: necesita atención en la terminal.`,
						session.paneId,
						session.sessionId,
					);
				if (
					previous &&
					(["working", "blocked"].includes(previous.state) ||
						this.last.approvals.some(approval => approval.paneId === session.paneId && approval.sessionId === session.sessionId) ||
						(previous.connected &&
							session.connected &&
							session.assistantMessageId &&
							session.assistantMessageId !== previous.assistantMessageId)) &&
					["idle", "done"].includes(session.state) &&
					!approvals.some(approval => approval.paneId === session.paneId && approval.sessionId === session.sessionId)
				)
					this.emit(
						"completed",
						`${session.label}: el agente volvió a estar disponible. Revisa el resultado de su conversación.`,
						session.paneId,
						session.sessionId,
						session.assistantMessageId,
						undefined,
						Boolean(
							session.assistantMessageId &&
								session.assistantMessageId !==
									this.settledMessages.get(`${session.terminalId}:${session.sessionId}`),
						),
					);
			}
			const currentIdentities = new Set(
				sessions.map((session) => `${session.terminalId}:${session.sessionId}`),
			);
			for (const key of this.settledMessages.keys())
				if (!currentIdentities.has(key)) this.settledMessages.delete(key);
			for (const session of sessions)
				if (["idle", "done"].includes(session.state) && !approvals.some(approval => approval.paneId === session.paneId && approval.sessionId === session.sessionId))
					this.settledMessages.set(`${session.terminalId}:${session.sessionId}`, session.assistantMessageId);

			for (const approval of approvals) {
				if (
					!this.last.approvals.some((old) => old.id === approval.id && old.sessionId === approval.sessionId)
				)
					this.emit("attention", approval.title, approval.paneId, approval.sessionId, undefined, approval.id, undefined, undefined, {
						dialogKind: approval.kind === "confirm" ? "permission" : "question",
						dialogTitle: approval.title,
					});
			}
			for (const previous of this.last.sessions) {
				if (
					previous.connected &&
					!sessions.some(
						(session) =>
							session.terminalId === previous.terminalId &&
							session.sessionId === previous.sessionId &&
							session.connected,
					)
				) {
					const intentional = this.expectedClosures.delete(`${previous.paneId}\0${previous.sessionId}`);
					this.emit(
						"disconnected",
						intentional
							? `${previous.label}: la persona cerró esta sesión.`
							: `${previous.label}: la sesión dejó de estar conectada.`,
						previous.paneId,
						previous.sessionId,
						undefined,
						undefined,
						undefined,
						intentional || undefined,
					);
				}
			}
			const liveClosureKeys = new Set(
				sessions
					.filter((session) => session.connected)
					.map((session) => `${session.paneId}\0${session.sessionId}`),
			);
			for (const key of this.expectedClosures)
				if (!liveClosureKeys.has(key)) this.expectedClosures.delete(key);
			this.last = {
				available: providers.some((provider) => provider.available),
				providers,
				...(!providers.some((provider) => provider.available)
					? { error: "No hay terminales conectadas. Abre HERDR u Orca, o conecta Pi con sessions:launch." }
					: {}),
				sessions,
				approvals,
				policies: this.publicPolicies(),
				events: [...this.events],
			};
			this.companionPeers = companionPeers;
			this.companionContext.update(this.last, herdr, companionActivity);
		} catch (error) {
			if (this.last.available)
				this.emit("disconnected", "No se pudo actualizar la conexión con las sesiones.");
			this.last = {
				available: false,
				providers,
				error: error instanceof Error ? error.message : "HERDR no está disponible.",
				sessions: [],
				approvals: [],
				policies: this.publicPolicies(),
				events: [...this.events],
			};
			this.companionPeers.clear();
			this.companionContext.update(this.last, undefined, new Map());
		}
		return this.last;
	}

	private portablePane(manifest: Manifest): Record<string, unknown> {
		return {
			pane_id: `pi:${manifest.instanceId}`,
			terminal_id: manifest.binding.terminalId,
			workspace_id: manifest.cwd ?? manifest.binding.provider,
			label: manifest.label ?? "Pi / Gentle Shell",
			cwd: manifest.cwd,
			provider: manifest.binding.provider,
			agent_status: "unknown",
		};
	}

	private publicPolicies(): Policy[] {
		return [...this.policies.values()]
			.filter((policy) => policy.remainingUses > 0 && Date.parse(policy.expiresAt) > Date.now())
			.map(({ fingerprint: _fingerprint, ...policy }) => policy);
	}

	/** Called only by the workflow coordinator after validating its live lease and inspected request. */
	async answerForWorkflow(input: WorkflowApprovalRequest, authorize: () => boolean): Promise<unknown> {
		let submitted = false;
		let acquired = false;
		try {
			if (this.closed) throw new OrchestrationError("CLOSED", "La orquestación está detenida.");
			this.assertAuthorized(authorize);
			if (this.mutatingPanes.has(input.paneId))
				throw new OrchestrationError("BUSY", "Otra operación está en curso en esta sesión.", 429);
			this.mutatingPanes.add(input.paneId);
			acquired = true;
			const bound = await this.bind(input.paneId, input.sessionId);
			const page = await this.call(bound, "snapshot", {}, authorize);
			if (!verifyWorkflowActivity(authorize, input, {
				version: record(page.capabilities) && page.capabilities.activityFence === 1 ? 1 : 0,
				instanceId: bound.manifest.instanceId,
				at: record(page.companionActivity) && typeof page.companionActivity.humanActivityAt === "string" ? page.companionActivity.humanActivityAt : null,
			})) throw new OrchestrationError("HUMAN_ACTIVE", "La actividad o el adaptador cambió; la autonomía está pausada.");
			this.observeHumanActivity(input.paneId, input.sessionId, page.companionActivity);
			this.assertAuthorized(authorize);
			const question = page.question;
			if (
				!record(question) ||
				question.id !== input.requestId ||
				!canAnswerQuestion(bound.manifest.managed === true, question, page.capabilities) ||
				workflowQuestionHash(question) !== input.questionHash
			)
				throw new OrchestrationError(
					"QUESTION_CHANGED",
					"La solicitud cambió; vuelve a inspeccionar la sesión.",
				);
			if (humanOnlyQuestion(question)) throw new OrchestrationError("HUMAN_REQUIRED", "Esta solicitud no tiene permiso verificable para delegación o contiene un bloqueo estructural.", 403);
			if (!record(page.capabilities) || page.capabilities.activityFence !== 1) throw new OrchestrationError("ACTIVITY_FENCE_REQUIRED", "Actualiza el adaptador antes de delegar acciones.", 403);
			const answer = questionAnswer(question, input.answer);
			this.assertAuthorized(authorize);
			submitted = true;
			const result = await this.call(bound, "answer", { questionId: input.requestId, ...answer,
				expectedHumanActivityAt:this.humanActivity.get(JSON.stringify([input.paneId,input.sessionId])) ?? null }, authorize);
			this.emit(
				"policy",
				`Dot resolvió una solicitud del objetivo: ${input.reason}`,
				input.paneId,
				input.sessionId,
			);
			return result;
		} catch (error) {
			if (submitted) throw error;
			throw Object.assign(
				new WorkflowApprovalRejected(
					error instanceof Error ? error.message : "No se pudo comprobar la solicitud actual.",
					error instanceof OrchestrationError ? error.status : 409,
				),
				error instanceof OrchestrationError ? { code: error.code } : {},
			);
		} finally {
			if (acquired) this.mutatingPanes.delete(input.paneId);
		}
	}

	async dispatch(
		input: Record<string, unknown>,
		actor: "human" | "agent",
		authorize: () => boolean = () => true,
		device?: string,
	): Promise<unknown> {
		if (this.closed) throw new OrchestrationError("CLOSED", "La orquestación está detenida.");
		this.assertAuthorized(authorize);
		const action = text(input.action, "action");
		if (["answer", "grant", "revoke", "close", "duplicate"].includes(action) && actor !== "human")
			throw new OrchestrationError(
				"HUMAN_REQUIRED",
				"Sólo una persona autenticada puede responder o delegar permisos.",
				403,
			);
		if (action === "snapshot") {
			const snapshot = await this.snapshot();
			this.assertAuthorized(authorize);
			return snapshot;
		}
		if (action === "revoke") {
			this.policies.delete(text(input.policyId, "policyId"));
			this.emit("policy", "La autorización anterior fue revocada.");
			return { revoked: true };
		}
		// Reading history must not hold permissions or work in other sessions hostage.
		// Mutations serialize only on the concrete pane (including recycled pane IDs).
		const mutationKey =
			action === "inspect" ? undefined : action === "create" ? "" : text(input.paneId, "paneId");
		if (mutationKey !== undefined && this.mutatingPanes.has(mutationKey))
			throw new OrchestrationError(
				"BUSY",
				"Otra operación está en curso en esta sesión. Inténtalo de nuevo.",
				429,
			);
		if (mutationKey !== undefined) this.mutatingPanes.add(mutationKey);
		try {
			if (action === "create") return await this.create(input, authorize);
			const paneId = text(input.paneId, "paneId");
			const sessionId = text(input.sessionId, "sessionId");
			const bound = await this.bind(paneId, sessionId);
			this.assertAuthorized(authorize);
			if (input.expectedInstanceId !== undefined && (typeof input.expectedInstanceId !== "string" || !input.expectedInstanceId || input.expectedInstanceId !== bound.manifest.instanceId))
				throw new OrchestrationError("SESSION_CHANGED", "La instancia cambió desde la revisión. Actualiza la sesión.");
			if (action === "inspect") {
				if (input.historyContent !== undefined && input.historyContent !== "text-only-v1")
					throw new OrchestrationError("INVALID_HISTORY", "La proyección del historial no es válida.", 400);
				const limit = input.limit ?? 50;
				if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 100)
					throw new OrchestrationError(
						"INVALID_HISTORY",
						"El tamaño de página debe ser de 1 a 100 mensajes.",
						400,
					);
				const before = input.before === undefined ? undefined : text(input.before, "before", 256);
				const raw = await this.call(bound, "snapshot", { limit, ...(before ? { before } : {}) }, authorize);
				const cwd = bound.manifest.cwd ?? bound.pane.foreground_cwd ?? bound.pane.cwd;
				const identity = {
					sessionId: bound.manifest.sessionId,
					...(bound.manifest.sessionFile ? { sessionFile: bound.manifest.sessionFile } : {}),
					...(typeof cwd === "string" ? { cwd } : {}),
				};
				const transcript = readBoundSessionEntries(identity, raw);
				const reported = publicSessionMetadata(raw.metadata);
				let metadata = reported ?? historySessionMetadata(transcript?.entries ?? []);
				if (!reported?.model || !reported?.context) {
					const peer = await this.peerMetadata(bound, authorize);
					if (peer)
						metadata = {
							...(metadata ?? { version: 1, source: "live" as const }),
							...(!reported?.model && peer.model ? { model: peer.model } : {}),
							...(!reported?.context && peer.context ? { context: peer.context } : {}),
						};
				}
				const messages = normalizeBoundMessages(bound.manifest.sessionId, raw.messages, transcript);
				const page: Record<string, unknown> = {
					...raw,
					messages: input.historyContent === "text-only-v1" ? textOnlySessionMessages(messages) : messages,
					metadata,
					capabilities: {
						...(record(raw.capabilities) ? raw.capabilities : {}),
						attachments: bound.manifest.version === 2 && bound.manifest.managed && record(raw.capabilities) && attachmentCapability(raw.capabilities.attachments)
							? raw.capabilities.attachments : undefined,
						close:
							bound.manifest.managed === true && record(raw.capabilities) && raw.capabilities.close === true,
						duplicate:
							bound.manifest.managed === true &&
							record(raw.capabilities) &&
							raw.capabilities.duplicate === true &&
							(await this.canDuplicate(bound)),
					},
				};
				this.assertAuthorized(authorize);
				const history =
					record(page.history) && page.history.supported === true
						? page.history
						: { supported: false, hasEarlier: false };
				if (before && !history.supported)
					throw new OrchestrationError(
						"HISTORY_UNAVAILABLE",
						"Esta conexión todavía no permite cargar mensajes anteriores.",
					);
				if (record(page.work)) return { ...page, history };
				return {
					...page,
					history,
					work: boundSessionWork(identity, raw),
				};
			}
			if (action === "close" || action === "duplicate") {
				const page = await this.call(bound, "snapshot", { limit: 1 }, authorize);
				if (
					bound.manifest.managed !== true ||
					!record(page.capabilities) ||
					page.capabilities[action] !== true
				)
					throw new OrchestrationError(
						"UNSUPPORTED",
						action === "close"
							? "Esta conexión no permite cerrar la sesión desde el teléfono."
							: "Esta sesión no se puede duplicar ahora. Espera a que termine y resuelve las preguntas pendientes.",
					);
				if (action === "close") {
					const result = await this.call(bound, "close", {}, authorize);
					if (result.accepted === true && result.closing === true)
						this.expectedClosures.add(`${paneId}\0${sessionId}`);
					for (const [id, policy] of this.policies)
						if (policy.paneId === paneId && policy.sessionId === sessionId) this.policies.delete(id);
					return result;
				}
				if (!(await this.canDuplicate(bound)))
					throw new OrchestrationError(
						"NO_TERMINAL",
						"El gestor de esta sesión no permite abrir otra terminal ahora.",
						503,
					);
				const exported = await this.call(bound, "duplicate", {}, authorize);
				const copy = exported.copy;
				if (
					!isSessionCopy(copy) ||
					copy.sessionId === sessionId ||
					copy.sessionFile !==
						join(dirname(bound.manifest.socketPath), "copies", `${copy.sessionId}.jsonl`) ||
					!isAbsolute(copy.profile.agentDir) ||
					!isAbsolute(copy.profile.configHome) ||
					[copy.profile.agentDir, copy.profile.configHome].some((value) => value.includes("\0"))
				)
					throw new OrchestrationError("INVALID_COPY", "La sesión no devolvió una copia válida.");
				const file = lstatSync(copy.sessionFile);
				if (
					!file.isFile() ||
					file.isSymbolicLink() ||
					(file.mode & 0o077) !== 0 ||
					(process.getuid && file.uid !== process.getuid())
				)
					throw new OrchestrationError("INVALID_COPY", "La copia de sesión no tiene almacenamiento privado.");
				this.assertAuthorized(authorize);
				const created = await this.create(
					{
						cwd: copy.cwd,
						provider: bound.manifest.binding.provider ?? "herdr",
						label: `${bound.manifest.label || "Conversación"} (copia)`.slice(0, 120),
						...(typeof bound.pane.workspace_id === "string" &&
						(bound.manifest.binding.provider ?? "herdr") === "herdr"
							? { workspaceId: bound.pane.workspace_id }
							: {}),
					},
					authorize,
					copy,
				);
				return { ...created, sessionId: copy.sessionId, sourceSessionId: sessionId };
			}
			if (action === "abort") return await this.call(bound, "abort", {}, authorize);
			if (action === "prompt" && input.deliverAs !== undefined && input.deliverAs !== "steer" && input.deliverAs !== "followUp")
				throw new OrchestrationError("INVALID_DELIVERY", "El modo de entrega no es válido.", 400);
			if (action === "prompt" && input.clientMessageId !== undefined && (typeof input.clientMessageId !== "string" || !/^[A-Za-z0-9_-]{8,96}$/.test(input.clientMessageId)))
				throw new OrchestrationError("INVALID_DELIVERY", "El mensaje no contiene una identidad válida.", 400);
			if (action === "prompt" && actor === "human") this.options.onInteraction?.({paneId, sessionId:bound.manifest.sessionId}, "human");
			if (action === "prompt" && actor === "agent") {
				const fresh = await this.call(bound, "snapshot", {limit:1}, authorize);
				if (!record(fresh.capabilities) || fresh.capabilities.activityFence !== 1) throw new OrchestrationError("ACTIVITY_FENCE_REQUIRED", "Actualiza el adaptador antes de delegar acciones.", 403);
				if (!verifyWorkflowActivity(authorize, {paneId, sessionId:bound.manifest.sessionId}, {
					version: 1,
					instanceId: bound.manifest.instanceId,
					at: record(fresh.companionActivity) && typeof fresh.companionActivity.humanActivityAt === "string" ? fresh.companionActivity.humanActivityAt : null,
				})) throw new OrchestrationError("HUMAN_ACTIVE", "La actividad o el adaptador cambió; la autonomía está pausada.");
				this.observeHumanActivity(paneId, bound.manifest.sessionId, fresh.companionActivity);
				this.assertAuthorized(authorize);
			}
			const delivery = { humanInteraction: actor === "human", ...(actor === "agent" ? {expectedHumanActivityAt:this.humanActivity.get(JSON.stringify([paneId,bound.manifest.sessionId])) ?? null} : {}), deliverAs: input.deliverAs ?? "followUp", ...(input.clientMessageId ? { clientMessageId: input.clientMessageId } : {}) };
			if (action === "prompt" && input.attachments !== undefined) {
				if (actor !== "human" || !device || !this.uploads)
					throw new OrchestrationError("HUMAN_REQUIRED", "Los archivos requieren un dispositivo autenticado.", 403);
				const refs = input.attachments;
				if (!Array.isArray(refs) || refs.length === 0 || refs.length > ATTACHMENT_LIMITS.files || refs.some(ref =>
					!record(ref) || Object.keys(ref).some(key => !["uploadId", "name"].includes(key)) || typeof ref.uploadId !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(ref.uploadId) || typeof ref.name !== "string" || ref.name.length > 120))
					throw new OrchestrationError("INVALID_ATTACHMENTS", "Las referencias de archivos no son válidas.", 400);
				if (typeof input.text !== "string" || input.text.length > 65_536 || Buffer.byteLength(input.text) > 65_536 || input.text.includes("\0"))
					throw new OrchestrationError("INVALID_INPUT", "El mensaje no es válido.", 400);
				const target = await this.attachmentDestination(input, device, authorize);
				if (target.bound.manifest.instanceId !== bound.manifest.instanceId)
					throw new OrchestrationError("SESSION_CHANGED", "La sesión cambió durante el envío.");
				const checked = this.uploads.resolve(refs as AttachmentRef[], target.owner);
				if (!checked.ok) throw new OrchestrationError(checked.code, checked.message, 400);
				let files;
				try { files = this.uploads.readForSession(refs as AttachmentRef[], target.owner); }
				catch { throw new OrchestrationError("ATTACHMENT_CHANGED", "Un archivo cambió o ya no está disponible. Vuelve a adjuntarlo.", 400); }
				decodeSessionFiles(files, target.capability.images);
				this.assertAuthorized(authorize);
				const deliveryTokens = (refs as AttachmentRef[]).map(ref => createHash("sha256").update(JSON.stringify([target.owner, ref.uploadId, ref.name])).digest("hex"));
				const deliveryId = createHash("sha256").update(JSON.stringify([...deliveryTokens].sort())).digest("hex");
				// The native adapter deduplicates delivery IDs/tokens if its acknowledgement is lost.
				// Rejections leave refs usable; only an exact accepted response consumes them.
				const result = await this.call(bound, "prompt", { text: input.text, files, deliveryTokens, deliveryId, ...delivery }, authorize);
				this.uploads.consume(refs as AttachmentRef[]);
				return result;
			}
			if (action === "prompt")
				return await this.call(
					bound,
					"prompt",
					{
						text: text(input.text, "text", 65_536),
						...delivery,
					},
					authorize,
				);
			if (!["answer", "grant"].includes(action))
				throw new OrchestrationError("UNKNOWN_ACTION", "Acción no admitida.", 400);
			const requestId = text(input.requestId, "requestId");
			this.options.onInteraction?.({paneId, sessionId:bound.manifest.sessionId}, "human");
			const page = await this.call(bound, "snapshot", {}, authorize);
			const question = page.question;
			if (!record(question) || question.id !== requestId)
				throw new OrchestrationError(
					"QUESTION_CHANGED",
					"Esta solicitud ya se respondió o cambió. Actualiza la sesión para ver la solicitud vigente.",
				);
			if (!canAnswerQuestion(bound.manifest.managed === true, question, page.capabilities))
				throw new OrchestrationError(
					"REMOTE_UNAVAILABLE",
					typeof question.expiresAt === "string" &&
						question.expiresAt &&
						Date.parse(question.expiresAt) <= Date.now()
						? "Esta solicitud venció. Actualiza la sesión antes de responder."
						: bound.manifest.managed
							? "Este formulario no ofrece una respuesta remota compatible; resuélvelo en la terminal del equipo. Las confirmaciones y preguntas compatibles siguen disponibles desde la app."
							: "La conexión de esta sesión no permite responder este formulario desde el teléfono. Carga el adaptador de Gentle Dot en la sesión o responde en la terminal del equipo.",
				);
			if (action === "answer" && input.expectedQuestionRevision !== undefined) {
				if (typeof input.expectedQuestionRevision !== "string" || !/^[a-f0-9]{64}$/.test(input.expectedQuestionRevision) || !record(page.capabilities) || page.capabilities.questionBinding !== 1 || page.questionRevision !== input.expectedQuestionRevision || questionRevision(question) !== input.expectedQuestionRevision)
					throw new OrchestrationError("QUESTION_CHANGED", "El contenido de la solicitud cambió o el adaptador no puede verificarlo.");
			}
			if (action === "answer") {
				return await this.call(
					bound,
					"answer",
					{ questionId: requestId, ...questionAnswer(question, input), ...(typeof input.expectedQuestionRevision === "string" ? {expectedQuestionRevision:input.expectedQuestionRevision} : {}) },
					authorize,
				);
			}
			if (!bound.manifest.managed || question.kind !== "confirm" || typeof question.fingerprint !== "string")
				throw new OrchestrationError(
					"INVALID_POLICY",
					"Sólo una confirmación exacta permite una autorización temporal; las opciones se eligen individualmente.",
					400,
				);
			const expiresAt = text(input.expiresAt, "expiresAt");
			const expiration = Date.parse(expiresAt);
			if (
				!Number.isFinite(expiration) ||
				expiration <= Date.now() ||
				expiration > Date.now() + 12 * 60 * 60 * 1000 ||
				!Number.isInteger(input.maxUses) ||
				(input.maxUses as number) < 1 ||
				(input.maxUses as number) > 100 ||
				typeof question.fingerprint !== "string"
			)
				throw new OrchestrationError(
					"INVALID_POLICY",
					"La autorización necesita vencimiento dentro de 12 horas y entre 1 y 100 usos.",
					400,
				);
			const policy: StoredPolicy = {
				id: randomUUID(),
				paneId,
				sessionId,
				action: String(question.action || question.title),
				expiresAt: new Date(expiration).toISOString(),
				remainingUses: input.maxUses as number,
				fingerprint: question.fingerprint,
			};
			this.assertAuthorized(authorize);
			this.policies.set(policy.id, policy);
			this.emit("policy", `Autorización limitada creada: ${policy.action}.`, paneId);
			return { policy: this.publicPolicies().find((entry) => entry.id === policy.id) };
		} finally {
			if (mutationKey !== undefined) this.mutatingPanes.delete(mutationKey);
		}
	}

	private async canDuplicate(bound: Bound): Promise<boolean> {
		const provider = bound.manifest.binding.provider ?? "herdr";
		if (provider === "terminal") return Boolean(this.terminalLauncher);
		if (provider === "orca") return (await this.orca.list()).status.canCreate;
		return true;
	}

	private async create(
		input: Record<string, unknown>,
		authorize: () => boolean,
		copy?: { sessionFile: string; profile: { agentDir: string; configHome: string }; resources: string[] },
	) {
		const cwd = text(input.cwd, "cwd", 4096);
		if (!isAbsolute(cwd) || !statSync(cwd).isDirectory())
			throw new OrchestrationError("INVALID_FOLDER", "Elige una carpeta absoluta existente.", 400);
		const label = input.label === undefined ? "Gentle Dot" : text(input.label, "label", 120);
		mkdirSync(this.directory, { recursive: true, mode: 0o700 });
		if (Buffer.byteLength(join(this.directory, "12345678-12345678.sock")) > 103)
			throw new OrchestrationError(
				"PATH_TOO_LONG",
				"La carpeta de datos es demasiado larga para conectar sesiones Pi.",
			);
		const canonical = realpathSync(cwd);
		const provider = input.provider ?? "herdr";
		if (!["herdr", "orca", "terminal"].includes(String(provider)))
			throw new OrchestrationError("INVALID_PROVIDER", "Elige HERDR, Orca o terminal.", 400);
		const argv = [
			...(copy
				? [
						"env",
						`PI_CODING_AGENT_DIR=${copy.profile.agentDir}`,
						`GENTLE_PI_AGENT_HOME=${copy.profile.agentDir}`,
						`GENTLE_PI_CONFIG_HOME=${copy.profile.configHome}`,
					]
				: []),
			this.options.piCommand || "pi",
			...(this.options.piArgs ?? []),
			...(copy?.resources ?? []),
			"-e",
			SESSION_EXTENSION_PATH,
			...(copy ? ["--session", copy.sessionFile] : []),
		];
		if (provider === "orca") {
			const command = [
				"env",
				"-u",
				"HERDR_ENV",
				"-u",
				"HERDR_SOCKET_PATH",
				"-u",
				"HERDR_PANE_ID",
				"-u",
				"HERDR_SESSION",
				`GENTLE_DOT_SESSION_DIR=${this.directory}`,
				...argv,
			]
				.map(quote)
				.join(" ");
			return await this.orca.create(canonical, label, command, () => !this.closed && authorize());
		}
		if (provider === "terminal") {
			if (!this.terminalLauncher)
				throw new OrchestrationError(
					"NO_TERMINAL",
					"Configura GENTLE_DOT_TERMINAL_ARGV o conecta Pi con sessions:launch.",
					503,
				);
			await (this.options.launchTerminal ?? launchTerminal)(
				this.terminalLauncher,
				argv,
				canonical,
				this.directory,
				() => !this.closed && authorize(),
			);
			this.assertAuthorized(authorize);
			return { created: true, provider, starting: true };
		}
		this.assertAuthorized(authorize);
		const created = await this.request(
			this.socketPath,
			input.workspaceId ? "tab.create" : "workspace.create",
			{
				cwd: canonical,
				label,
				focus: false,
				...(input.workspaceId ? { workspace_id: text(input.workspaceId, "workspaceId") } : {}),
				env: { GENTLE_DOT_SESSION_DIR: this.directory },
			},
			5000,
			() => !this.closed && authorize(),
		);
		this.assertAuthorized(authorize);
		if (!record(created.root_pane) || typeof created.root_pane.pane_id !== "string")
			throw new OrchestrationError("PROTOCOL", "HERDR no devolvió el panel creado.", 502);
		const paneId = created.root_pane.pane_id;
		const command = argv.map(quote).join(" ");
		// Input is sent only to the new pane returned by this create call, never an existing shell.
		await this.request(
			this.socketPath,
			"pane.send_input",
			{
				pane_id: paneId,
				text: command,
				keys: ["enter"],
			},
			5000,
			() => !this.closed && authorize(),
		);
		return {
			created: true,
			provider,
			paneId,
			terminalId: String(created.root_pane.terminal_id),
			starting: true,
		};
	}

	async close(): Promise<void> {
		this.companionPoll.close();
		this.companionPeers.clear();
		this.closed = true;
		if (this.timer) clearInterval(this.timer);
		this.policies.clear();
		this.expectedClosures.clear();
		await this.refreshing;
	}
}
