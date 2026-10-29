import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type AgentState,
	APP_REQUIRED,
	type Ask,
	type ClientMessage,
	type ConnectorDraft,
	type ConnectorInfo,
	type Features,
	isAppCommand,
	isPinCommand,
	isThinkingLevel,
	type MessageQueue,
	type ModelGroup,
	type ModelRef,
	PIN_REQUIRED,
	parseClientMessage,
	parseQueue,
	type RoleRoute,
	type ServerPayload,
	type VoiceCapability,
	type WorkSyncRequest,
	type WorkSyncReply,
} from "@gentle-dot/protocol";
import { APPROVAL_WAIT_MS, type AppApproval, type AppLink } from "./app-channel.ts";
import { lastIndexedPiEntry, pageBranchHistory } from "./branch-history.ts";
import type { AuthManager } from "./auth.ts";
import { type ConnectorManager, type ConnectorRefusal, INTEGRITY_UNCHECKED } from "./connectors.ts";
import {
	conversationIdOf,
	type HistoryPage,
	listConversations,
	pageHistory,
	resolveConversation,
} from "./conversations.ts";
import { directAccess, type EngineAccess } from "./engine-access.ts";
import { DRAFT_STATUS_KEY } from "./extensions/approval-guard.ts";
import { MobileApprovals } from "./mobile-approvals.ts";
import type { MobilePresence, PresenceSummary } from "./mobile-presence.ts";
import { describeTool, textOf } from "./presentation.ts";
import {
	LiveModelSwitch,
	ProfileError,
	type ProfileStore,
	type SwitchOutcome,
	splitModel,
	toModelChoices,
	toModelOptions,
} from "./profiles.ts";
import { DEFAULT_ROTATION, type RotationLimits, SessionRotator } from "./rotation.ts";
import { hasToolCalls, ScreenshotDelivery } from "./screenshot-delivery.ts";
import type { AgentRecord, AgentSupervisor, SupervisorEvent } from "./supervisor.ts";
import { composePrompt, type StoredFile, splitAttachments, type UploadStore } from "./uploads.ts";
import type { VoiceService } from "./voice.ts";
import type { PinGate } from "./web-pin.ts";
import type { WorkflowStatus } from "./workflows.ts";
import { isBlockedInput, presentText, shouldShowToast } from "./white-label.ts";

export interface BridgeClient {
	/** Set only after authenticating a paired phone, never by a client message. */
	mobileKey?: string;
	/** Installed by the authenticated transport, never supplied by a client frame. */
	workSync?: { handle(request: WorkSyncRequest): Promise<WorkSyncReply>; meetingDrafts: boolean; limits?: { audioBytes: number; attachmentBytes: number } };
	send(payload: ServerPayload): void;
}

export interface BridgeOptions {
	mobilePresence?: MobilePresence;
	dataDir: string;
	log?: (line: string) => void;
	auth?: AuthManager;
	profiles?: ProfileStore;
	connectors?: ConnectorManager;
	/** Speech to text and text to speech with an OpenAI API key (S30.2). */
	voice?: VoiceService;
	/** Files the user uploaded for their messages (S31). */
	uploads?: UploadStore;
	/**
	 * The desktop app that launched the daemon, over its private channel (S25.1): the only source of
	 * connector changes and desktop approval replies. Without it they fail closed.
	 */
	app?: AppLink;
	/**
	 * A server without the desktop app (S25.8): the web page makes connector changes and allows
	 * sending actions with this PIN instead. Never set together with `app`.
	 */
	pin?: PinGate;
	/** A phone explicitly trusted by the native app may answer an exact pending approval. */
	mobileApprovals?: MobileApprovals;
	/** At least one native-approved phone currently has an authenticated live connection. */
	hasApprovalClient?: () => boolean;
	/** How long a PIN approval waits for an answer. Default 130 s, like the app's. */
	approvalWaitMs?: number;
	/**
	 * How the engine's session and upload files are read and written; in server mode as the engine's
	 * user (S25.8, B1), since the engine can plant links there. Default: as the daemon is.
	 */
	engineAccess?: EngineAccess;
	/** How long switching conversations waits for a running answer to stop. Default 10 s. */
	stopTimeoutMs?: number;
	/** Optional parts of the app; by default one continuous chat. */
	features?: Features;
	/** When the open session is replaced by a fresh one (docs/design.md §7). */
	rotation?: RotationLimits;
	/** How many messages `history` and each `get_earlier` page carry. Default 100. */
	historyPage?: number;
	/** Authenticated client text, before engine delivery; engine events never establish human authority. */
	onHumanPrompt?: (originalText: string, engineText: string) => void;
	/** Forget unpublished native screenshots immediately when Stop or a session switch is requested. */
	onCaptureInvalidated?: () => void;
}

type ProfileCommand = Extract<
	ClientMessage,
	{
		type:
			| "profile_save"
			| "profile_rename"
			| "profile_duplicate"
			| "profile_delete"
			| "profile_apply"
			| "profile_import"
			| "profile_save_current";
	}
>;

const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);
const WAITING_IN_APP = "Waiting for your answer in the Gentle Dot app.";
const DECLINED = { code: "declined", message: "Nothing was changed." } as const;

/**
 * An open dialog; `options` keeps the agent's original option strings for the answer. An `app` ask
 * can only be answered through the native channel or the trusted phone's approval broker.
 */
type PendingAsk = {
	ask: Ask;
	options?: string[];
	timer?: NodeJS.Timeout;
};
const REMEMBERED_REQUEST_IDS = 500;
const READY_TIMEOUT_MS = 60_000;
const ANSWER_FAILED = "Something went wrong while answering. Please try again.";
const HISTORY_PAGE = 100;

/**
 * Translates between protocol v1 clients and the supervised agent: it keeps
 * the derived agent state, the pending asks, and the streaming message ids,
 * and broadcasts every agent event to all connected clients.
 */
export class DotBridge {
	private readonly clients = new Set<BridgeClient>();
	/** Each window's id, for the app's commands on its behalf. */
	private readonly clientIds = new Map<string, BridgeClient>();
	private readonly asks = new Map<string, PendingAsk>();
	private readonly continuationAnswers = new Map<string, (choice: "continue" | "stop") => Promise<void>>();
	/** One decision shared by the native dialog, desktop card, and any trusted phone. */
	private readonly appApprovals: MobileApprovals;
	/** The answer each open PIN approval waits for, by request id (S25.8). */
	private readonly pinWaiters = new Map<string, (allowed: boolean) => void>();
	/** Connector changes a window confirmed with the PIN: their own confirmation is not asked again. */
	private readonly pinConfirmed = new WeakSet<ClientMessage>();
	/** Told to every window that connects during this run (a connectors file set aside at start). */
	private readonly notices: ServerPayload[] = [];
	private readonly runningTools = new Set<string>();
	private readonly screenshotDelivery = new ScreenshotDelivery();
	private readonly seenRequestIds: string[] = [];
	private readonly sessionDir: string;
	private readonly supervisor: AgentSupervisor;
	private readonly options: BridgeOptions;
	private state: AgentState = "starting";
	private interrupted = false;
	// A restarted bridge starts its sequence at zero. Namespace that sequence
	// so a phone restoring an earlier live event cannot overwrite it after a
	// daemon restart; the ID remains the same for every update of one stream.
	private readonly messageNamespace = randomUUID();
	private nextMessage = 0;
	private assistantId: string | undefined;
	private restartPending = false;
	private restarting = false;
	private restartAgain = false;
	/** The running answer is being stopped on purpose, so its end is not an error. */
	private stopRequested = false;
	/** The engine is replacing only its current inference to incorporate a new human message. */
	private liveInputHandoff = false;
	/** The conversation switch in progress; messages sent meanwhile wait for it. */
	private switching: Promise<void> = Promise.resolve();
	/** Messages waiting for the agent, as shown to the user. */
	private queue: MessageQueue = { steering: [], followUp: [] };
	/** Messages on their way to the agent; the session is never rotated under them. */
	private sending = 0;
	/** A run settled while a message was still on its way; check for rotation once it arrived. */
	private rotationDeferred = false;
	private readonly features: Features;
	private readonly rotator: SessionRotator;
	private readonly liveSwitch: LiveModelSwitch;

	constructor(supervisor: AgentSupervisor, options: BridgeOptions) {
		this.supervisor = supervisor;
		this.options = options;
		this.appApprovals = options.mobileApprovals ?? new MobileApprovals({ waitMs: options.approvalWaitMs });
		this.liveSwitch = new LiveModelSwitch(supervisor, (line) => this.log(line));
		this.sessionDir = join(options.dataDir, "sessions");
		this.features = options.features ?? { conversations: false };
		this.rotator = new SessionRotator(supervisor, {
			limits: options.rotation ?? DEFAULT_ROTATION,
			canRotate: () =>
				supervisor.state === "ready" &&
				!supervisor.busy &&
				this.asks.size === 0 &&
				this.sending === 0 &&
				!this.queued(),
			...(options.engineAccess ? { access: options.engineAccess } : {}),
			log: (line) => this.log(line),
		});
		supervisor.onEvent((event) => this.onAgentEvent(event));
		if (options.auth) options.auth.onCredentialsChanged = () => this.afterCredentialsChange();
		if (options.connectors) {
			options.connectors.onChanged = (restart) => this.afterConnectorsChange(restart);
			options.connectors.onBlocked = () => this.connectorChangeBlocked();
			options.connectors.onSetAside = (notice) => this.connectorsSetAside(notice);
			options.connectors.imagesSupported = () => supervisor.modelImages;
		}
		this.state = this.deriveState();
	}

	/** Status from a real external session, never a model-generated approval. */
	notifySession(notice: Extract<ServerPayload, { type: "toast" }>): void {
		this.broadcast(notice);
	}

	/** A daemon-owned choice, displayed by the same desktop/phone ask channel as engine requests. */
	askWatchContinuation(
		label: string,
		answer: (choice: "continue" | "stop") => Promise<void>,
		pause?: Pick<WorkflowStatus, "pauseReason" | "lastMessage">,
	): void {
		const requestId = `watch-${randomUUID()}`;
		const title = pause?.pauseReason === "adapter-outdated" && pause.lastMessage
			? pause.lastMessage
			: `¿Sigo vigilando la sesión ${label} o la dejo?`;
		const ask: Ask = {requestId, method:"select", title:presentText(title), options:["Continuar", "Dejar de vigilar"]};
		this.continuationAnswers.set(requestId, answer);
		const timer = setTimeout(() => this.resolveAsk(requestId), APPROVAL_WAIT_MS);
		timer.unref();
		this.asks.set(requestId, {ask, timer});
		this.broadcast({type:"ask",ask});
		this.refreshState();
	}

	get agentState(): AgentState {
		return this.state;
	}

	/**
	 * Asks the user through the trusted desktop or phone. The first valid answer wins across both.
	 * Resolves true only when the user allows it; declining, no answer, `signal`, or the app quitting
	 * resolve false. Rejects when there is no app to ask (fail closed).
	 */
	askInApp(request: AppApproval, signal?: AbortSignal): Promise<boolean> {
		const app = this.options.app;
		if (!app?.connected && this.options.pin) return this.askWithPin(request, signal);
		if (!app?.connected) return Promise.reject(new Error(APP_REQUIRED));
		if (signal?.aborted) return Promise.resolve(false);
		const phoneOnline = this.options.mobileApprovals && this.options.hasApprovalClient?.() === true;
		const requestId = `app-${randomUUID()}`;
		try {
			const waiting = this.appApprovals.begin(requestId, request, signal);
			const preview = this.appApprovals.list().find((item) => item.id === requestId);
			if (!preview) return waiting.answer;
			const ask: Ask = {
				requestId,
				method: "app",
				title: presentText(request.title ?? `Allow ${request.connector} to ${request.action}?`),
				message: preview.message,
				expiresAt: preview.expiresAt,
			};
			this.asks.set(requestId, { ask });
			this.broadcast({ type: "ask", ask });
			this.refreshState();
			const native = new AbortController();
			const nativeSignal = signal ? AbortSignal.any([signal, native.signal]) : native.signal;
			// Avoid a redundant desktop popup while using the phone; the desktop card stays actionable.
			if (!phoneOnline) {
				void app.approve(request, nativeSignal).then(
					(approved) => this.appApprovals.answer(requestId, approved === true),
					() => this.appApprovals.answer(requestId, false),
				);
			}
			return waiting.answer.finally(() => {
				native.abort();
				waiting.cancel();
				this.resolveAsk(requestId);
			});
		} catch (error) {
			this.resolveAsk(requestId);
			return Promise.reject(error);
		}
	}

	/**
	 * On a server (S25.8): every window shows the approval with its full preview, and it is allowed
	 * only with the PIN (`pin_approve`). Declining, no answer in time, `signal`, or the run ending
	 * resolve false.
	 */
	private askWithPin(request: AppApproval, signal?: AbortSignal): Promise<boolean> {
		if (signal?.aborted) return Promise.resolve(false);
		const requestId = `pin-${randomUUID()}`;
		const preview = request.preview.map(
			({ name, value }) => `${name}: ${typeof value === "string" ? value : JSON.stringify(value)}`,
		);
		const ask: Ask = {
			requestId,
			method: "pin",
			title: presentText(request.title ?? `Allow ${request.connector} to ${request.action}?`),
			message: presentText(
				[
					request.summary ?? `The assistant wants to ${request.action} in ${request.connector}.`,
					...preview,
				].join("\n\n"),
			),
		};
		return new Promise<boolean>((resolve) => {
			const timer = setTimeout(
				() => this.resolveAsk(requestId),
				this.options.approvalWaitMs ?? APPROVAL_WAIT_MS,
			);
			this.pinWaiters.set(requestId, resolve);
			signal?.addEventListener("abort", () => this.resolveAsk(requestId), { once: true });
			this.asks.set(requestId, { ask, timer });
			this.broadcast({ type: "ask", ask });
			this.refreshState();
		});
	}

	/** A window's PIN message on a server (S25.8); without server mode they open nothing. */
	private async pinMessage(
		client: BridgeClient,
		message: Extract<ClientMessage, { type: "pin_set" | "pin_command" | "pin_approve" }>,
	): Promise<void> {
		const pin = this.options.pin;
		if (!pin || this.options.app?.connected) {
			this.deliver(client, { type: "error", code: "app_required", message: APP_REQUIRED });
			return;
		}
		if (message.type === "pin_set") {
			const outcome = await pin.set(message.pin);
			if (outcome.ok) this.broadcast({ type: "pin_status", pin: pin.status() });
			else this.deliver(client, { type: "error", code: outcome.code, message: outcome.message });
			return;
		}
		if (message.type === "pin_approve" && this.asks.get(message.requestId)?.ask.method !== "pin") {
			this.deliver(client, {
				type: "error",
				code: "ask_not_found",
				message: "That question is no longer open.",
			});
			return;
		}
		const outcome = await pin.verify(message.pin);
		if (!outcome.ok) {
			this.deliver(client, { type: "error", code: outcome.code, message: outcome.message });
			if (outcome.code === "pin_locked") this.broadcast({ type: "pin_status", pin: pin.status() });
			return;
		}
		if (message.type === "pin_approve") {
			const waiter = this.pinWaiters.get(message.requestId);
			this.pinWaiters.delete(message.requestId);
			waiter?.(true);
			this.resolveAsk(message.requestId);
			return;
		}
		if (!isPinCommand(message.command)) return;
		this.pinConfirmed.add(message.command);
		await this.run(client, message.command);
	}

	attach(client: BridgeClient): () => void {
		this.clients.add(client);
		const clientId = randomBytes(18).toString("base64url");
		this.clientIds.set(clientId, client);
		this.deliver(client, {
			type: "ready",
			agentState: this.state,
			clientId,
			...this.conversationRef(),
			...(this.supervisor.model ? { model: this.supervisor.model } : {}),
			features: { conversations: this.features.conversations, historyRefresh: true, historyPaging: 1, sendAccepted: 1,
				...(client.workSync ? { workSync: 1, ...(client.workSync.limits ? { workSyncAudioBytes: client.workSync.limits.audioBytes, workSyncAttachmentBytes: client.workSync.limits.attachmentBytes } : {}), ...(client.workSync.meetingDrafts ? { meetingDrafts: 1 } : {}) } : {}) },
			...(this.options.voice ? { voice: this.options.voice.capability() } : {}),
			...(this.options.pin && !this.options.app?.connected ? { pin: this.options.pin.status() } : {}),
		});
		// Keep ready synchronous/backward compatible, then publish freshly checked PC availability.
		void this.refreshVoiceCapability();
		if (this.queued()) this.deliver(client, { type: "queue", ...this.queue });
		for (const { ask } of this.asks.values()) this.deliver(client, { type: "ask", ask });
		for (const draft of this.options.connectors?.drafts() ?? [])
			this.deliver(client, { type: "connector_draft", draft });
		if (this.interrupted) this.deliver(client, { type: "interrupted" });
		for (const notice of this.notices) this.deliver(client, notice);
		return () => {
			this.clients.delete(client);
			this.clientIds.delete(clientId);
			this.options.auth?.cancelOwnedBy(client);
			this.options.connectors?.cancelOwnedBy(client);
		};
	}

	/** Recheck the desktop model independently of the accounts screen. */
	async refreshVoiceCapability(): Promise<void> {
		const voice = this.options.voice;
		if (!voice) return;
		const before = voice.capability();
		try {
			const fresh = await voice.refresh();
			if (before.transcribe !== fresh.transcribe || before.speak !== fresh.speak || before.local !== fresh.local)
				this.broadcast({ type: "voice_capability", voice: fresh });
		} catch {
			this.log("could not refresh voice capability");
		}
	}

	/** A window's message. Connector changes come only from the desktop app (S25.2). */
	async handle(client: BridgeClient, message: ClientMessage): Promise<void> {
		if (message.type === "work_sync") {
			const unavailable = (text: string) => this.deliver(client, { type: "work_sync_reply", requestId: message.requestId, transferId: message.transferId, state: "error", code: "storage", message: text });
			if (!client.workSync) { unavailable("Durable work transfer is unavailable on this connection."); return; }
			if (message.operation === "process" && !client.workSync.meetingDrafts) { unavailable("Meeting processing is unavailable on this host."); return; }
			try { this.deliver(client, await client.workSync.handle(message)); }
			catch { unavailable("The host could not confirm this work operation."); }
			return;
		}
		if (message.type === "pin_set" || message.type === "pin_command" || message.type === "pin_approve") {
			await this.pinMessage(client, message);
			return;
		}
		if (isAppCommand(message)) {
			// On a server the PIN stands in for the app (S25.8); the computer helper is the desktop's only.
			if (this.options.pin && !this.options.app?.connected && isPinCommand(message))
				this.deliver(client, { type: "error", code: "pin_required", message: PIN_REQUIRED });
			else this.deliver(client, { type: "error", code: "app_required", message: APP_REQUIRED });
			return;
		}
		await this.run(client, message);
	}

	/**
	 * A connector change from the desktop app's channel, on behalf of the window with `clientId`: its
	 * sign-in steps and refusals go to that window. Throws when there is no such window or it is not
	 * an app command.
	 */
	async handleFromApp(clientId: string, raw: unknown): Promise<void> {
		const client = this.clientIds.get(clientId);
		if (!client) throw new Error("That window is not connected to the assistant any more.");
		const message = parseClientMessage(JSON.stringify(raw ?? null));
		if (!message || !isAppCommand(message)) throw new Error("Only trusted commands come from the app.");
		if (message.type === "app_approval_reply") {
			if (!this.options.app?.connected) throw new Error(APP_REQUIRED);
			if (
				this.asks.get(message.requestId)?.ask.method !== "app" ||
				!this.appApprovals.answer(message.requestId, message.approved)
			)
				throw new Error("Este permiso ya fue respondido, cancelado o venció.");
			this.resolveAsk(message.requestId);
			return;
		}
		await this.run(client, message);
	}

	private async run(client: BridgeClient, message: ClientMessage): Promise<void> {
		try {
			await this.dispatch(client, message);
		} catch (error) {
			this.log(`command ${message.type} failed: ${(error as Error).message}`);
			if (this.supervisor.state !== "ready") {
				this.deliver(client, {
					type: "error",
					code: "agent_unavailable",
					message: "The assistant is restarting. Try again in a moment.",
				});
			} else if (message.type === "send" && !(await this.hasAccount())) {
				this.deliver(client, {
					type: "error",
					code: "no_account",
					message: "Connect an AI account first: open Accounts or type /login.",
				});
			} else {
				this.deliver(client, {
					type: "error",
					code: "command_failed",
					message: "That did not work. Please try again.",
				});
			}
		}
	}

	/** True when an account is connected, or when that cannot be told. */
	private async hasAccount(): Promise<boolean> {
		if (!this.options.auth) return true;
		return this.options.auth.hasAccount().catch(() => true);
	}

	private async dispatch(client: BridgeClient, message: ClientMessage): Promise<void> {
		switch (message.type) {
			case "hello":
				return;
			case "send": {
				if (isBlockedInput(message.text)) {
					this.deliver(client, {
						type: "error",
						code: "unsupported",
						message: "I can't run that command here.",
					});
					return;
				}
				if (message.requestId && this.alreadySeen(message.requestId)) return;
				const files = message.attachments ? this.attachedFiles(client, message.attachments) : [];
				if (!files) return;
				// Slash commands are typed alone; a message with files always goes to the assistant.
				if (files.length === 0 && (await this.openScreen(client, message.text))) return;
				await this.switching;
				this.interrupted = false;
				const prompt =
					files.length > 0
						? composePrompt(message.text, files, {
								images: this.supervisor.modelImages,
								// The stored file may have been swapped for a link since: read it as the engine.
								read: (path) => this.engine(() => readFileSync(path)),
							})
						: { message: message.text };
				this.sending += 1;
				try {
					if (this.clients.has(client)) this.options.onHumanPrompt?.(message.text, prompt.message);
					// Let the engine choose atomically: a second message can arrive before
					// agent_start reaches this process. Every human message has priority over
					// continuing the old answer, including messages with attachments.
					await this.supervisor.request({ type: "prompt", ...prompt, streamingBehavior: "steer" });
					if (message.receipt === "accepted-v1" && message.requestId && this.clients.has(client))
						this.deliver(client, { type: "request_accepted", requestId: message.requestId });
					if (message.attachments) this.options.uploads?.consume(message.attachments);
				} finally {
					this.sending -= 1;
					// The run may have settled before the answer to this prompt was handled.
					if (this.sending === 0 && this.rotationDeferred) {
						this.rotationDeferred = false;
						if (!this.supervisor.busy) this.rotateWhenIdle();
					}
				}
				return;
			}
			case "steer":
				if (this.clients.has(client)) this.options.onHumanPrompt?.(message.text, message.text);
				await this.supervisor.request({ type: "steer", message: message.text });
				return;
			case "abort":
				this.invalidateCapture();
				if (this.supervisor.busy) this.stopRequested = true;
				await this.supervisor.request({ type: "abort" });
				return;
			case "ui_response": {
				const pending = this.asks.get(message.requestId);
				if (!pending) {
					this.deliver(client, {
						type: "error",
						code: "ask_not_found",
						message: "That question is no longer open.",
					});
					return;
				}
				const { requestId } = message;
				const continuation = this.continuationAnswers.get(requestId);
				if (continuation) {
					if (message.cancelled) this.resolveAsk(requestId);
					else if (message.value === "Continuar" || message.value === "Dejar de vigilar") {
						await continuation(message.value === "Continuar" ? "continue" : "stop");
						this.resolveAsk(requestId);
					}
					return;
				}
				if (pending.ask.method === "app") {
					this.deliver(client, { type: "error", code: "app_required", message: WAITING_IN_APP });
					return;
				}
				// Allowing needs the PIN (`pin_approve`); declining narrows nothing, so any window may.
				if (pending.ask.method === "pin") {
					if (message.confirmed === false || message.cancelled) this.resolveAsk(requestId);
					else this.deliver(client, { type: "error", code: "pin_required", message: PIN_REQUIRED });
					return;
				}
				const answer: Record<string, unknown> = {};
				if (message.cancelled) answer.cancelled = true;
				else if (message.confirmed !== undefined) answer.confirmed = message.confirmed;
				else if (message.value !== undefined) {
					// Options are shown rewritten; answer with the agent's original string.
					const index = pending.ask.options?.indexOf(message.value) ?? -1;
					answer.value = index >= 0 ? (pending.options?.[index] ?? message.value) : message.value;
				}
				this.supervisor.send({ type: "extension_ui_response", id: requestId, ...answer });
				this.resolveAsk(requestId);
				return;
			}
			case "new_conversation":
				if (!this.conversationsOn(client)) return;
				await this.changeConversation(async () => {
					await this.switchAfterStop(() => this.supervisor.request({ type: "new_session" }));
					this.afterConversationChange();
				});
				return;
			case "list_conversations":
				this.deliver(client, this.conversationsPayload());
				return;
			case "open_conversation": {
				if (!this.conversationsOn(client)) return;
				const path = this.engine(() => resolveConversation(this.sessionDir, message.conversationId));
				if (!path) {
					this.deliver(client, {
						type: "error",
						code: "conversation_not_found",
						message: "That conversation does not exist.",
					});
					return;
				}
				await this.changeConversation(async () => {
					await this.switchAfterStop(() =>
						this.supervisor.request({ type: "switch_session", sessionPath: path }),
					);
					this.afterConversationChange(await this.currentHistory());
				});
				return;
			}
			case "auth_list":
				await this.sendProviders(client);
				return;
			case "auth_login": {
				const refused = this.requireAuth().start(client, message.providerId, message.method, (payload) =>
					this.deliver(client, payload),
				);
				if (refused) this.deliver(client, { type: "error", ...refused });
				return;
			}
			case "auth_reply":
				if (
					this.options.connectors?.owns(message.flowId)
						? !this.options.connectors.reply(client, message.flowId, message)
						: !this.requireAuth().reply(client, message.flowId, message)
				) {
					this.deliver(client, {
						type: "error",
						code: "auth_flow_not_found",
						message: "That sign-in is no longer active.",
					});
				}
				return;
			case "voice_transcribe":
			case "voice_speak": {
				const { requestId } = message;
				const voice = this.options.voice;
				if (!voice) {
					this.deliver(client, {
						type: "voice_unavailable",
						requestId,
						reason: "Voice is not available here.",
					});
					return;
				}
				if (message.type === "voice_transcribe") {
					const result = await voice.transcribe(message.mime, message.data);
					this.deliver(
						client,
						result.ok
							? { type: "voice_transcript", requestId, text: result.text }
							: { type: "voice_unavailable", requestId, reason: result.reason },
					);
					return;
				}
				const result = await voice.speak(message.text);
				this.deliver(
					client,
					result.ok
						? { type: "voice_speech", requestId, mime: result.mime, data: result.data }
						: { type: "voice_unavailable", requestId, reason: result.reason },
				);
				return;
			}
			case "auth_logout": {
				const refused = await this.requireAuth().logout(message.providerId);
				if (refused) this.deliver(client, { type: "error", ...refused });
				return;
			}
			case "profiles_list":
				await this.sendProfiles(client);
				return;
			case "models_list":
				this.deliver(client, await this.modelsPayload());
				return;
			case "model_set":
				await this.setModel(client, message);
				return;
			case "connectors_list":
				this.deliver(client, { type: "connectors", connectors: this.requireConnectors().list() });
				return;
			case "connector_connect":
			case "connector_signin":
			case "connector_setup":
			case "connector_disconnect":
			case "connector_mode":
			case "connector_remove":
				await this.connectorCommand(client, message);
				return;
			case "connector_draft_reply": {
				const emit = (payload: ServerPayload) => this.deliver(client, payload);
				const { draftId, approve } = message;
				const draft = this.options.connectors?.drafts().find((d) => d.draftId === draftId);
				if (approve && draft && !(await this.confirmChange(client, draftApproval(draft), message))) return;
				const refused = this.requireConnectors().decideDraft(client, draftId, approve, emit);
				if (refused) this.deliver(client, { type: "error", ...refused });
				else this.broadcast({ type: "connector_draft_resolved", draftId, approved: approve });
				return;
			}
			case "connectors_scan":
				this.deliver(client, { type: "connector_imports", found: this.requireConnectors().scan() });
				return;
			case "computer_register":
				this.requireConnectors().registerComputer(client, { url: message.url, token: message.token });
				return;
			case "computer_unregister":
				this.requireConnectors().unregisterComputer(client);
				return;
			case "connector_import": {
				const connectors = this.requireConnectors();
				// The confirmed plan is what gets imported, whatever a later scan finds.
				const plan = connectors.importPlan(message.ids);
				if (
					plan.choices.length > 0 &&
					!(await this.confirmChange(client, importApproval(plan.choices), message))
				)
					return;
				this.deliver(client, {
					type: "connector_imported",
					names: await connectors.importServers(message.ids, plan.servers),
				});
				return;
			}
			case "profile_save":
			case "profile_rename":
			case "profile_duplicate":
			case "profile_delete":
			case "profile_apply":
			case "profile_import":
			case "profile_save_current":
				await this.profileCommand(client, message);
				return;
			case "get_history": {
				// Windows ask for history as soon as they connect, often while the agent starts.
				await this.whenReady();
				const ref = this.conversationRef();
				try {
					const checked = await this.checkedHistory();
					this.deliver(client, { type: "history", ...(message.requestId !== undefined ? { requestId: message.requestId } : {}), ...checked.ref, ...checked.page });
				} catch { this.deliver(client, { type: "error", code: "history_unavailable", message: "No pude verificar la rama actual de la conversación. El historial guardado se conserva.", ...(message.requestId !== undefined ? { requestId: message.requestId, ...ref } : {}) }); }
				return;
			}
			case "get_earlier": {
				const file = this.supervisor.sessionFile;
				const sessionId = this.supervisor.sessionId;
				const conversationId = this.conversationRef().conversationId;
				const correlated = message.requestId !== undefined || message.conversationId !== undefined;
				const ref = { ...(message.requestId !== undefined ? { requestId: message.requestId } : {}),
					...(correlated && (message.conversationId ?? conversationId) !== undefined ? { conversationId: message.conversationId ?? conversationId } : {}) };
				try {
					if (message.conversationId !== undefined && message.conversationId !== conversationId) throw new Error("Conversation changed");
					const page = await this.currentHistory(message.before);
					if (this.supervisor.sessionFile !== file || this.supervisor.sessionId !== sessionId || this.conversationRef().conversationId !== conversationId) throw new Error("Conversation changed");
					this.deliver(client, { type: "earlier", before: message.before, ...ref, ...page });
				} catch { this.deliver(client, { type: "error", code: "history_unavailable", message: "No pude verificar la rama anterior. El historial guardado se conserva.", ...ref }); }
				return;
			}
		}
	}

	/** `/login`, `/profiles`, and `/connectors` open their screen instead of reaching the assistant. */
	private async openScreen(client: BridgeClient, text: string): Promise<boolean> {
		if (/^\s*\/login\s*$/i.test(text)) {
			await this.sendProviders(client, true);
			return true;
		}
		if (/^\s*\/profiles\s*$/i.test(text)) {
			await this.sendProfiles(client, true);
			return true;
		}
		if (/^\s*\/connectors\s*$/i.test(text)) {
			this.deliver(client, { type: "connectors", connectors: this.requireConnectors().list(), open: true });
			return true;
		}
		return false;
	}

	/** The uploaded files a message sends; undefined (and an error for the window) when one is not available. */
	private attachedFiles(
		client: BridgeClient,
		refs: NonNullable<Extract<ClientMessage, { type: "send" }>["attachments"]>,
	): StoredFile[] | undefined {
		const found = this.options.uploads?.resolve(refs) ?? {
			ok: false as const,
			code: "attachment_not_found",
			message: "Files cannot be sent here.",
		};
		if (found.ok) return found.files;
		this.deliver(client, { type: "error", code: found.code, message: found.message });
		return undefined;
	}

	/** With the conversations list off there is one chat; starting or opening another is refused. */
	private conversationsOn(client: BridgeClient): boolean {
		if (this.features.conversations) return true;
		this.deliver(client, {
			type: "error",
			code: "conversations_off",
			message: "This assistant keeps one continuous chat.",
		});
		return false;
	}

	/** Runs a conversation switch; a message sent meanwhile goes to the new conversation, after its history. */
	private changeConversation(change: () => Promise<void>): Promise<void> {
		const run = change();
		this.switching = run.catch(() => {});
		return run;
	}

	/**
	 * The engine aborts a running answer when it switches sessions, and its end
	 * would land in the new conversation. Stop it first and wait (bounded) for
	 * the run to settle, then switch; that stop is intentional, not an error.
	 */
	private async switchAfterStop(switchTo: () => Promise<unknown>): Promise<void> {
		this.invalidateCapture();
		if (!this.supervisor.busy) {
			await switchTo();
			return;
		}
		this.stopRequested = true;
		try {
			const settled = this.nextSettle(this.options.stopTimeoutMs ?? 10_000);
			await this.supervisor.request({ type: "abort" });
			if (!(await settled)) this.log("the running answer did not stop in time; switching anyway");
			await switchTo();
		} finally {
			this.stopRequested = false;
		}
	}

	/** Resolves true when the run settles or the agent goes away, false after `timeoutMs`. */
	private nextSettle(timeoutMs: number): Promise<boolean> {
		return new Promise((resolve) => {
			const finish = (settled: boolean) => {
				clearTimeout(timer);
				off();
				resolve(settled);
			};
			const timer = setTimeout(() => finish(false), timeoutMs);
			const off = this.supervisor.onEvent((event) => {
				if (event.type === "agent_settled") finish(true);
				else if (event.type === "supervisor_state" && event.state !== "ready") finish(true);
			});
		});
	}

	/** Waits until the agent can take commands; gives up after a minute or when it stopped. */
	private whenReady(): Promise<void> {
		if (this.supervisor.state === "ready") return Promise.resolve();
		return new Promise((resolve, reject) => {
			const finish = (error?: Error) => {
				clearTimeout(timer);
				off();
				if (error) reject(error);
				else resolve();
			};
			const timer = setTimeout(() => finish(new Error("the agent did not start in time")), READY_TIMEOUT_MS);
			timer.unref();
			const off = this.supervisor.onEvent((event) => {
				if (event.type !== "supervisor_state") return;
				if (event.state === "ready") finish();
				else if (event.state === "stopped") finish(new Error("the agent stopped"));
			});
		});
	}

	private requireAuth(): AuthManager {
		if (!this.options.auth) throw new Error("sign-in is not available");
		return this.options.auth;
	}

	private async sendProviders(client: BridgeClient, open = false): Promise<void> {
		const providers = await this.requireAuth().providers();
		this.deliver(client, {
			type: "auth_providers",
			providers,
			...(open ? { open: true } : {}),
			...(await this.voiceCapability()),
		});
	}

	/** The voice capability, checked now, for the accounts list. */
	private async voiceCapability(): Promise<{ voice?: VoiceCapability }> {
		const voice = this.options.voice;
		return voice ? { voice: await voice.refresh() } : {};
	}

	private requireConnectors(): ConnectorManager {
		if (!this.options.connectors) throw new Error("connectors are not available");
		return this.options.connectors;
	}

	/** Runs one connector change; a sign-in's steps go only to the window that started it. */
	private async connectorCommand(
		client: BridgeClient,
		message: Extract<ClientMessage, { connectorId: string }>,
	): Promise<void> {
		const connectors = this.requireConnectors();
		const emit = (payload: ServerPayload) => this.deliver(client, payload);
		const widening = wideningApproval(connectors.list(), message);
		if (widening && !(await this.confirmChange(client, widening, message))) return;
		let refused: ConnectorRefusal | undefined;
		switch (message.type) {
			case "connector_connect":
				refused = connectors.connect(client, message.connectorId, emit);
				break;
			case "connector_signin":
				refused = connectors.signIn(client, message.connectorId, emit);
				break;
			case "connector_setup":
				refused = connectors.setup(client, message.connectorId, emit);
				break;
			case "connector_disconnect":
				refused = connectors.disconnect(message.connectorId);
				break;
			case "connector_mode":
				refused = connectors.setMode(message.connectorId, message.mode);
				break;
			case "connector_remove":
				refused = await connectors.remove(message.connectorId);
				break;
		}
		if (refused) this.deliver(client, { type: "error", ...refused });
	}

	/**
	 * A change that widens what the assistant can reach, confirmed in the app's native dialog even
	 * though the app sent it (S25.3). False, with a note for the window, when it was not allowed.
	 */
	private async confirmChange(
		client: BridgeClient,
		request: AppApproval,
		message: ClientMessage,
	): Promise<boolean> {
		// The PIN the user typed for this very change confirms it (S25.8).
		if (this.pinConfirmed.has(message)) return true;
		const allowed = await this.askInApp(request).catch(() => undefined);
		if (allowed === undefined) {
			this.deliver(client, { type: "error", code: "app_required", message: APP_REQUIRED });
			return false;
		}
		if (!allowed) this.deliver(client, { type: "error", ...DECLINED });
		return allowed;
	}

	/**
	 * A connector the assistant drafted with `propose_connector`. It reaches the daemon on the
	 * engine's own output, and every window shows it as a card; nothing changes until the user answers.
	 */
	private onConnectorDraft(text: unknown): void {
		const draft = typeof text === "string" ? this.options.connectors?.propose(text) : undefined;
		if (!draft) {
			this.log("ignored a malformed connector draft");
			return;
		}
		this.log(`the assistant drafted a connector: ${draft.name}`);
		this.broadcast({ type: "connector_draft", draft });
	}

	/**
	 * A `connectors.json` changed while the daemon was down was set aside (S25.6), usually before any
	 * window is open: every window of this run is told once, when it connects.
	 */
	private connectorsSetAside(message: string): void {
		if (this.notices.some((notice) => notice.type === "toast" && notice.message === message)) return;
		const notice: ServerPayload = {
			type: "toast",
			level: "warning",
			message,
			...(message === INTEGRITY_UNCHECKED ? { code: "connectors_unchecked" as const } : {}),
		};
		this.notices.push(notice);
		this.broadcast(notice);
		this.broadcast({ type: "connectors", connectors: this.requireConnectors().list() });
	}

	/** The connector files were changed outside the Connectors screen and put back. */
	private connectorChangeBlocked(): void {
		this.broadcast({ type: "toast", level: "warning", message: "A change to your connectors was blocked." });
		this.broadcast({ type: "connectors", connectors: this.requireConnectors().list() });
	}

	/** Every window sees the new statuses; a new mcp.json needs an agent restart, once it is idle. */
	private afterConnectorsChange(restart: boolean): void {
		this.broadcast({ type: "connectors", connectors: this.requireConnectors().list() });
		if (!restart) return;
		if (this.supervisor.busy) this.restartPending = true;
		else this.restartAgent();
	}

	private requireProfiles(): ProfileStore {
		if (!this.options.profiles) throw new Error("profiles are not available");
		return this.options.profiles;
	}

	private async sendProfiles(client: BridgeClient, open = false): Promise<void> {
		try {
			this.deliver(client, { ...(await this.profilesPayload()), ...(open ? { open: true } : {}) });
		} catch (error) {
			if (!(error instanceof ProfileError)) throw error;
			this.deliver(client, { type: "error", code: error.code, message: error.message });
		}
	}

	private async profilesPayload(): Promise<Extract<ServerPayload, { type: "profiles" }>> {
		const store = this.requireProfiles();
		const { profiles, active } = store.list();
		const models = await this.supervisor.request({ type: "get_available_models" }).then(
			(response) => toModelOptions(response.data),
			() => [],
		);
		return {
			type: "profiles",
			profiles,
			...(active ? { active } : {}),
			roles: store.roles(),
			models,
			importable: store.importable(),
		};
	}

	/** Runs one profile change; every window gets the new list, errors go to the window that asked. */
	private async profileCommand(client: BridgeClient, message: ProfileCommand): Promise<void> {
		const store = this.requireProfiles();
		try {
			switch (message.type) {
				case "profile_save":
					await store.save(message.name, message.roles);
					// Editing the profile in use takes effect right away.
					if (store.list().active === message.name) await this.applyProfile(message.name);
					break;
				case "profile_rename":
					await store.rename(message.from, message.to);
					break;
				case "profile_duplicate":
					await store.duplicate(message.from, message.to);
					break;
				case "profile_delete":
					await store.remove(message.name);
					break;
				case "profile_apply":
					await this.applyProfile(message.name);
					break;
				case "profile_save_current":
					await store.saveCurrent(message.name, await this.runningRoute());
					break;
				case "profile_import": {
					const providers = await (this.options.auth?.providers() ?? Promise.resolve([])).catch(() => []);
					this.deliver(client, { type: "profiles_imported", ...(await store.import(providers)) });
					break;
				}
			}
		} catch (error) {
			if (!(error instanceof ProfileError)) throw error;
			this.deliver(client, { type: "error", code: error.code, message: error.message });
			return;
		}
		this.broadcast(await this.profilesPayload());
	}

	private async applyProfile(name: string): Promise<void> {
		const orchestrator = await this.requireProfiles().apply(name);
		if (orchestrator) this.reportSwitch(await this.liveSwitch.switchTo(orchestrator));
		// The chat's model picker follows the profile.
		this.broadcastModels();
	}

	/**
	 * The model picker's choice (S32): only a model of a connected account, and a thinking level
	 * it supports. It is saved like a profile's model and switched live; during a reply the switch
	 * waits for the next message instead of stopping the reply.
	 */
	private async setModel(client: BridgeClient, message: Extract<ClientMessage, { type: "model_set" }>) {
		const available = await this.supervisor.request({ type: "get_available_models" });
		const model = toModelChoices(available.data).find(
			(m) => m.provider === message.provider && m.id === message.id,
		);
		if (!model) {
			this.deliver(client, {
				type: "error",
				code: "model_unavailable",
				message: "That model is not available. Connect its account in Accounts first.",
			});
			return;
		}
		if (message.thinking && !model.thinkingLevels?.includes(message.thinking)) {
			this.deliver(client, {
				type: "error",
				code: "thinking_unavailable",
				message: "That model does not support that thinking level.",
			});
			return;
		}
		const route: RoleRoute = { model: `${model.provider}/${model.id}` };
		if (message.thinking) route.thinking = message.thinking;
		await this.options.profiles?.setDefaultModel(route);
		const outcome = await this.liveSwitch.switchTo(route);
		if (outcome === "failed") {
			this.deliver(client, {
				type: "error",
				code: "model_switch_failed",
				message: "That model could not be selected. Try another one.",
			});
		}
		if (outcome === "switched") this.afterModelSwitch();
		else this.broadcastModels();
	}

	/** The current model, the connected accounts' models by account, and the profiles as quick picks. */
	private async modelsPayload(): Promise<Extract<ServerPayload, { type: "models" }>> {
		const [available, running, accounts] = await Promise.all([
			this.supervisor.request({ type: "get_available_models" }),
			this.runningModel(),
			this.accountNames(),
		]);
		const choices = toModelChoices(available.data);
		const groups: ModelGroup[] = [];
		for (const model of choices) {
			let group = groups.find((g) => g.provider === model.provider);
			if (!group) {
				const name = accounts.get(model.provider) ?? model.provider;
				group = { provider: model.provider, name, models: [] };
				groups.push(group);
			}
			group.models.push(model);
		}
		const ref = (provider: string, id: string, thinking?: unknown): ModelRef => {
			const choice = choices.find((m) => m.provider === provider && m.id === id);
			const found: ModelRef = { provider, id, name: choice?.name ?? id };
			if (isThinkingLevel(thinking) && choice?.thinkingLevels) found.thinking = thinking;
			return found;
		};
		const waiting = this.liveSwitch.waiting;
		const target = waiting?.model ? splitModel(waiting.model) : undefined;
		const { profiles, active } = this.savedProfiles();
		return {
			type: "models",
			...(running ? { current: ref(running.provider, running.id, running.thinking) } : {}),
			...(target ? { next: ref(target.provider, target.modelId, waiting?.thinking) } : {}),
			groups,
			profiles: profiles.map(({ name, roles }) => ({ name, ...roles.orchestrator })),
			...(active ? { activeProfile: active } : {}),
		};
	}

	private savedProfiles(): ReturnType<ProfileStore["list"]> {
		try {
			return this.options.profiles?.list() ?? { profiles: [] };
		} catch {
			return { profiles: [] };
		}
	}

	/** Account names by provider id, as the Accounts screen shows them. */
	private async accountNames(): Promise<Map<string, string>> {
		const providers = await (this.options.auth?.providers() ?? Promise.resolve([])).catch(() => []);
		return new Map(providers.map((p) => [p.id, presentText(p.name)]));
	}

	private broadcastModels(): void {
		void this.modelsPayload()
			.then((payload) => this.broadcast(payload))
			.catch((error: Error) => this.log(`could not list models: ${error.message}`));
	}

	/** A new running model: the picker, and the connectors' image note (S24.5), follow it. */
	private afterModelSwitch(): void {
		this.broadcastModels();
		const connectors = this.options.connectors;
		if (connectors) this.broadcast({ type: "connectors", connectors: connectors.list() });
	}

	private reportSwitch(outcome: SwitchOutcome): void {
		if (outcome !== "failed") return;
		this.broadcast({
			type: "toast",
			level: "warning",
			message:
				"Profile applied. The main assistant keeps its current model until that model's account is connected.",
		});
	}

	/** The main assistant's model and thinking level in the running conversation. */
	private async runningRoute(): Promise<RoleRoute | undefined> {
		const running = await this.runningModel();
		if (!running) return undefined;
		const route: RoleRoute = { model: `${running.provider}/${running.id}` };
		if (isThinkingLevel(running.thinking)) route.thinking = running.thinking;
		return route;
	}

	private async runningModel(): Promise<{ provider: string; id: string; thinking?: unknown } | undefined> {
		const response = await this.supervisor.request({ type: "get_state" });
		const state = response.data as { model?: { provider?: unknown; id?: unknown }; thinkingLevel?: unknown };
		if (typeof state?.model?.provider !== "string" || typeof state.model.id !== "string") return undefined;
		return { provider: state.model.provider, id: state.model.id, thinking: state.thinkingLevel };
	}

	/** New credentials: refresh every window, and restart the agent once it is idle so it sees new models. */
	private afterCredentialsChange(): void {
		void this.requireAuth()
			.providers()
			.then(async (providers) =>
				this.broadcast({ type: "auth_providers", providers, ...(await this.voiceCapability()) }),
			)
			.catch((error: Error) => this.log(`could not list providers: ${error.message}`));
		if (this.supervisor.busy) {
			this.restartPending = true;
			return;
		}
		this.restartAgent();
	}

	/** Restarts the engine; changes that arrive during a restart get one more, so the last one is read. */
	private restartAgent(): void {
		this.restartPending = false;
		if (this.restarting) {
			this.restartAgain = true;
			return;
		}
		this.restarting = true;
		this.supervisor
			.restart()
			.catch((error: Error) => this.log(`agent restart failed: ${error.message}`))
			.finally(() => {
				this.restarting = false;
				if (!this.restartAgain) return;
				this.restartAgain = false;
				this.restartAgent();
			});
	}

	/** A profile applied while the assistant was busy switches the model now. */
	private settleModelSwitch(): void {
		void this.liveSwitch.settle().then((outcome) => {
			this.reportSwitch(outcome);
			if (outcome === "switched") this.afterModelSwitch();
		});
	}

	private afterConversationChange(page: HistoryPage = { messages: [], hasEarlier: false }): void {
		this.screenshotDelivery.reset();
		this.interrupted = false;
		this.assistantId = undefined;
		this.broadcast({ type: "history", ...this.conversationRef(), ...page });
		this.broadcast(this.conversationsPayload());
	}

	/** After a run settles, replace an oversized session; every window gets the same chat, now marked earlier. */
	private rotateWhenIdle(): void {
		void this.changeConversation(async () => {
			if (!(await this.rotator.maybeRotate())) return;
			const { ref, page } = await this.checkedHistory();
			this.broadcast({ type: "history", ...ref, ...page });
		}).catch(() => {
			this.broadcast({ type: "error", code: "history_unavailable", message: "La sesión cambió, pero no pude verificar su historial. La conversación anterior se conserva; vuelve a cargarla antes de continuar." });
		});
	}

	/** Bind an async history read to the session whose identity will label it. */
	private async checkedHistory(): Promise<{ ref: { conversationId?: string }; page: HistoryPage }> {
		const file = this.supervisor.sessionFile, sessionId = this.supervisor.sessionId, ref = this.conversationRef();
		const page = await this.currentHistory();
		if (this.supervisor.sessionFile !== file || this.supervisor.sessionId !== sessionId || this.conversationRef().conversationId !== ref.conversationId) throw new Error("Conversation changed");
		return { ref, page };
	}

	/**
	 * History replaces what a window shows, so it must not be older than the
	 * messages already sent: read it again when one arrived while loading.
	 */
	private async currentHistory(before?: string): Promise<HistoryPage> {
		for (let attempt = 0; attempt < 3; attempt++) {
			const seen = this.nextMessage;
			// The engine writes a message to its session file right after announcing it;
			// one round trip makes sure everything announced so far is on disk.
			await this.supervisor.request({ type: "get_state" });
			const chain = this.chain(); const active = chain.at(-1); const sessionId = this.supervisor.sessionId;
			if (!active) return { messages: [], hasEarlier: false };
			const metadata = this.engine(() => chain.map(lastIndexedPiEntry));
			if (metadata.slice(0, -1).some(value => !value.exists)) throw new Error("Earlier session file missing");
			const current = metadata.at(-1)!;
			if (current.legacy) {
				const page = this.engine(() => metadata.some(value => value.hasFork) ? pageBranchHistory(chain, this.pageSize(), null, before) : pageHistory(chain, this.pageSize(), before));
				if (this.nextMessage === seen && this.supervisor.sessionFile === active) return page;
				continue;
			}
			if (!sessionId || current.sessionId !== sessionId) throw new Error("Pi session identity changed");
			const getLeaf = async () => {
				const response = await this.supervisor.request({ type: "get_entries", ...(current.id ? { since: current.id } : {}) });
				const data = response.data as { entries?: unknown; leafId?: unknown } | undefined;
				if (!data || !Array.isArray(data.entries) || (data.leafId !== null && (typeof data.leafId !== 'string' || !data.leafId || data.leafId.length > 512))) throw new Error("Unverifiable Pi leaf");
				return { leaf: data.leafId as string | null, changed: data.entries.length !== 0 };
			};
			const first = await getLeaf();
			if (first.changed || this.supervisor.sessionFile !== active || this.supervisor.sessionId !== sessionId) continue;
			const branched = metadata.some(value => value.hasFork) || first.leaf !== (current.id ?? null);
			const page = this.engine(() => branched
				? pageBranchHistory(chain, this.pageSize(), first.leaf, before) : pageHistory(chain, this.pageSize(), before));
			const second = await getLeaf();
			if (!second.changed && second.leaf === first.leaf && this.nextMessage === seen && this.supervisor.sessionFile === active && this.supervisor.sessionId === sessionId && JSON.stringify(this.chain()) === JSON.stringify(chain)) return branched ? { ...page, branchVerified: true } : page;
		}
		throw new Error("Pi branch changed while reading");
	}

	/** The open chat's session files, oldest first. */
	private chain(): string[] {
		const file = this.supervisor.sessionFile;
		return file ? [...this.supervisor.previousSessions, file] : [];
	}

	private pageSize(): number {
		return this.options.historyPage ?? HISTORY_PAGE;
	}

	private conversationsPayload(): ServerPayload {
		return {
			type: "conversations",
			// A continuous chat has no conversation picker. Scanning every archived
			// file here would make each completed turn slower as the years accumulate.
			conversations: this.features.conversations ? this.engine(() => listConversations(this.sessionDir)) : [],
			...this.activeRef(),
		};
	}

	private conversationRef(): { conversationId?: string } {
		const file = this.supervisor.sessionFile;
		return file ? { conversationId: conversationIdOf(this.sessionDir, file) } : {};
	}

	private activeRef(): { activeId?: string } {
		const ref = this.conversationRef();
		return ref.conversationId ? { activeId: ref.conversationId } : {};
	}

	private onAgentEvent(event: SupervisorEvent): void {
		switch (event.type) {
			case "supervisor_state":
				if (event.state !== "ready") {
					this.stopRequested = false;
					this.liveInputHandoff = false;
					this.clearRun();
					this.clearQueue();
				} else {
					this.settleModelSwitch();
					// The engine knows its model only once it is ready; windows that connected
					// earlier (for example while it restarted) would show none until they asked.
					this.broadcastModels();
				}
				break;
			case "interrupted":
				this.invalidateCapture();
				this.interrupted = true;
				this.broadcast({ type: "interrupted" });
				break;
			case "message_start":
				this.onMessageStart(event);
				break;
			case "message_update":
				this.onMessageUpdate(event);
				break;
			case "message_end":
				this.onMessageEnd(event);
				break;
			case "tool_execution_start":
			case "tool_execution_end":
				this.onTool(event);
				break;
			case "queue_update":
				this.onQueueUpdate(event);
				break;
			case "agent_settled":
				this.screenshotDelivery.reset();
				// The run may have changed the connector files.
				this.options.connectors?.enforce();
				this.runningTools.clear();
				this.assistantId = undefined;
				this.stopRequested = false;
				// Settlement does not empty Pi's steering queue (notably after Stop).
				// Keep received messages visible until the engine consumes or clears them.
				// The title of a new conversation comes from its first message.
				this.broadcast(this.conversationsPayload());
				// A new human prompt is already owned by the engine. Do not rotate its
				// conversation or restart it in the brief gap before that prompt starts.
				if (this.liveInputHandoff) break;
				this.settleModelSwitch();
				if (this.restartPending) this.restartAgent();
				else if (this.sending > 0) this.rotationDeferred = true;
				else this.rotateWhenIdle();
				break;
			case "extension_ui_request":
				this.onUiRequest(event);
				break;
		}
		this.refreshState();
	}

	/** The engine sends both complete queues on every change. */
	private onQueueUpdate(event: AgentRecord): void {
		const queue = parseQueue(event);
		if (!queue) return;
		const shown = (text: string) => presentText(queuedText(text));
		this.queue = { steering: queue.steering.map(shown), followUp: queue.followUp.map(shown) };
		this.broadcast({ type: "queue", ...this.queue });
	}

	private queued(): boolean {
		return this.queue.steering.length > 0 || this.queue.followUp.length > 0;
	}

	private clearQueue(): void {
		if (!this.queued()) return;
		this.queue = { steering: [], followUp: [] };
		this.broadcast({ type: "queue", ...this.queue });
	}

	private onMessageStart(event: AgentRecord): void {
		const message = event.message as { role?: string } | undefined;
		if (message?.role === "user") {
			this.screenshotDelivery.reset();
			const { text, attachments } = splitAttachments(textOf(message));
			this.broadcast({
				type: "user_message",
				messageId: `u${this.messageNamespace}:${++this.nextMessage}`,
				text,
				...(attachments.length > 0 ? { attachments } : {}),
			});
		}
		if (message?.role === "assistant") this.assistantId = `m${this.messageNamespace}:${++this.nextMessage}`;
	}

	private onMessageUpdate(event: AgentRecord): void {
		const update = event.assistantMessageEvent as { type?: string; delta?: unknown } | undefined;
		if (update?.type !== "text_delta" || typeof update.delta !== "string") return;
		this.assistantId ??= `m${this.messageNamespace}:${++this.nextMessage}`;
		this.broadcast({ type: "message_delta", messageId: this.assistantId, delta: update.delta });
	}

	private onMessageEnd(event: AgentRecord): void {
		const message = event.message as
			| { role?: string; stopReason?: string; errorMessage?: string }
			| undefined;
		if (message?.role !== "assistant") return;
		if (message.stopReason === "aborted" || message.stopReason === "error") this.invalidateCapture();
		const messageId = this.assistantId ?? `m${this.messageNamespace}:${++this.nextMessage}`;
		const intermediate = ["toolUse", "deferred"].includes(message.stopReason ?? "") || hasToolCalls(message);
		const text = this.screenshotDelivery.finish(
			presentText(textOf(message)),
			this.stopRequested ? "aborted" : message.stopReason,
			intermediate,
		);
		// The engine ends a stopped answer as "aborted", or as an error when a session switch tore it down.
		if (message.stopReason === "aborted" && this.liveInputHandoff && !this.stopRequested) {
			this.broadcast({ type: "message_done", messageId, text, intermediate: true });
		} else if (message.stopReason === "aborted" || (message.stopReason === "error" && this.stopRequested)) {
			this.broadcast({ type: "message_done", messageId, text, stopped: true });
		} else if (message.stopReason === "error") {
			this.log(`assistant error: ${message.errorMessage ?? "unknown"}`);
			this.broadcast({ type: "message_done", messageId, text, error: ANSWER_FAILED });
		} else {
			this.broadcast({
				type: "message_done",
				messageId,
				text,
				...(intermediate ? { intermediate: true as const } : {}),
			});
		}
	}

	private onTool(event: AgentRecord): void {
		const id = String(event.toolCallId ?? "");
		const started = event.type === "tool_execution_start";
		if (started) this.runningTools.add(id);
		else this.runningTools.delete(id);
		if (!this.stopRequested) {
			if (started) this.screenshotDelivery.start(event.toolCallId, event.toolName);
			else this.screenshotDelivery.result(event.toolCallId, event.result, event.isError);
		}
		const status = started ? "running" : event.isError ? "failed" : "done";
		// Start and end of one tool call must land on the same message.
		this.assistantId ??= `m${this.messageNamespace}:${++this.nextMessage}`;
		this.broadcast({
			type: "activity",
			messageId: this.assistantId,
			activity: { id, ...describeTool(String(event.toolName ?? ""), event.args, status), status },
		});
	}

	private onUiRequest(event: AgentRecord): void {
		const method = String(event.method ?? "");
		const requestId = String(event.id ?? "");
		if (method === "setStatus" && event.statusKey === "gentle-dot-live-input") {
			this.liveInputHandoff = event.statusText === "interrupting";
			return;
		}
		if (method === "notify") {
			const level =
				event.notifyType === "error" ? "error" : event.notifyType === "warning" ? "warning" : "info";
			if (shouldShowToast(level))
				this.broadcast({ type: "toast", level, message: presentText(String(event.message ?? "")) });
			return;
		}
		if (method === "setStatus" && event.statusKey === DRAFT_STATUS_KEY) {
			this.onConnectorDraft(event.statusText);
			return;
		}
		if (!DIALOG_METHODS.has(method) || !requestId) return;
		const ask: Ask = {
			requestId,
			method: method as Ask["method"],
			title: presentText(String(event.title ?? "")),
		};
		const entry: PendingAsk = { ask };
		if (typeof event.message === "string") ask.message = presentText(event.message);
		if (Array.isArray(event.options)) {
			entry.options = event.options.map(String);
			ask.options = entry.options.map(presentText);
		}
		if (typeof event.placeholder === "string") ask.placeholder = presentText(event.placeholder);
		if (typeof event.prefill === "string") ask.prefill = event.prefill;
		if (typeof event.timeout === "number" && event.timeout > 0) {
			ask.timeoutMs = event.timeout;
			// Pi resolves the dialog by itself when it times out; drop it here too.
			entry.timer = setTimeout(() => this.resolveAsk(requestId), event.timeout);
		}
		this.asks.set(requestId, entry);
		this.broadcast({ type: "ask", ask });
	}

	private resolveAsk(requestId: string): void {
		const entry = this.asks.get(requestId);
		if (!entry) return;
		clearTimeout(entry.timer);
		this.appApprovals.answer(requestId, false);
		this.asks.delete(requestId);
		this.continuationAnswers.delete(requestId);
		// A PIN approval still waiting is refused: declined, timed out, or the run ended.
		this.pinWaiters.get(requestId)?.(false);
		this.pinWaiters.delete(requestId);
		this.broadcast({ type: "ask_resolved", requestId });
		this.refreshState();
	}

	private invalidateCapture(): void {
		this.screenshotDelivery.reset();
		this.options.onCaptureInvalidated?.();
	}

	private clearRun(): void {
		this.invalidateCapture();
		for (const requestId of [...this.asks.keys()]) this.resolveAsk(requestId);
		this.runningTools.clear();
		this.assistantId = undefined;
	}

	private deriveState(): AgentState {
		switch (this.supervisor.state) {
			case "starting":
				return "starting";
			case "restarting":
				return "restarting";
			case "stopped":
				return "error";
		}
		if (this.asks.size > 0) return "needs_you";
		if (!this.supervisor.busy) return "idle";
		return this.runningTools.size > 0 ? "working" : "thinking";
	}

	private refreshState(): void {
		const next = this.deriveState();
		if (next === this.state) return;
		this.state = next;
		this.broadcast({ type: "agent_state", state: next });
	}

	private alreadySeen(requestId: string): boolean {
		if (this.seenRequestIds.includes(requestId)) return true;
		this.seenRequestIds.push(requestId);
		if (this.seenRequestIds.length > REMEMBERED_REQUEST_IDS) this.seenRequestIds.shift();
		return false;
	}

	/** A summary is also retained by the gate for polling/reconnect catch-up. */
	releaseMobileSummary(key: string, summary: PresenceSummary): void {
		const payload = this.mobileSummaryPayload(summary);
		for (const client of this.clients) if (client.mobileKey === key) this.deliver(client, payload);
	}

	mobileSummaryPayload(summary: PresenceSummary): Extract<ServerPayload, {type: "toast"}> & { notificationBatch: PresenceSummary } {
		return {type: "toast", level: "info", notificationId: summary.id, notificationEvent: "agentCompleted",
			title: "Mientras usabas la PC", message: summary.summaries.join("\n") + (summary.dropped ? `\n+${summary.dropped} más` : ""), notificationBatch: summary};
	}

	private broadcast(payload: ServerPayload): void {
		const gate = this.options.mobilePresence;
		const held = new Set<string>();
		if (gate) {
			const notice = payload.type === "toast" && payload.notificationId && payload.notificationEvent
				? {id: payload.notificationId, event: payload.notificationEvent, text: `${payload.title ?? "Sesión"}: ${payload.message}`}
				: payload.type === "message_done" && !payload.intermediate && !payload.stopped && (payload.text.trim() || payload.error)
					? {id: `dot:${JSON.stringify(this.conversationRef())}:${payload.messageId}`, event: payload.error ? "dotError" : "dotReply", text: payload.error ? "Dot necesita atención." : "Dot respondió. Abre la conversación para revisar el resultado."}
					: undefined;
			if (notice) for (const key of gate.keys()) if (gate.hold(key, notice.id, notice.event, notice.text)) held.add(key);
		}
		for (const client of this.clients) {
			// Keep session/history data intact. Native monitor consumes only this delivery marker.
			const outgoing = client.mobileKey && held.has(client.mobileKey) ? {...payload, mobileNotificationSuppressed: true} : payload;
			this.deliver(client, outgoing);
		}
	}

	private deliver(client: BridgeClient, payload: ServerPayload): void {
		const outgoing = client.mobileKey && this.options.mobilePresence
			? {...payload, mobilePresenceActive: this.options.mobilePresence.muted(client.mobileKey)} : payload;
		client.send(outgoing);
	}

	/** Runs `fn` on the engine's files as the engine's user (server mode). */
	private engine<T>(fn: () => T): T {
		return (this.options.engineAccess ?? directAccess)(fn);
	}

	private log(line: string): void {
		this.options.log?.(line);
	}
}

/** A queued message as the user wrote it; files show by name. */
function queuedText(message: string): string {
	const { text, attachments } = splitAttachments(message);
	if (attachments.length === 0) return text;
	const names = `📎 ${attachments.map((a) => a.name).join(", ")}`;
	return text ? `${text}\n${names}` : names;
}

/**
 * The native confirmation for a connector change that widens access, or undefined when it narrows
 * or keeps it (read only, disconnecting, removing, signing in again) or the connector is unknown.
 */
function wideningApproval(
	list: ConnectorInfo[],
	message: Extract<ClientMessage, { connectorId: string }>,
): AppApproval | undefined {
	const info = list.find((c) => c.id === message.connectorId && !c.builtin);
	if (!info) return undefined;
	const name = info.name;
	if (message.type === "connector_mode") {
		if (message.mode !== "read_write" || info.mode === "read_write") return undefined;
		return {
			connector: name,
			action: "read and send",
			title: `Let ${name} read and send?`,
			summary: `The assistant will be able to send, post, and change things in ${name}. It still asks you before each sending action.`,
			preview: [{ name: "Sends", value: info.sends }],
		};
	}
	if ((message.type === "connector_connect" || message.type === "connector_setup") && !info.enabled) {
		return {
			connector: name,
			action: "connect",
			title: `Connect ${name}?`,
			summary: `The assistant will be able to read ${name}. It starts read only.`,
			preview: [{ name: "Reads", value: info.reads }],
		};
	}
	return undefined;
}

/** Approving a connector the assistant drafted: everything that will run or be reached. */
function draftApproval(draft: ConnectorDraft): AppApproval {
	const preview: AppApproval["preview"] = [
		draft.transport === "http"
			? { name: "Address", value: draft.url ?? "" }
			: { name: "Runs on this computer", value: [draft.command, ...(draft.args ?? [])].join(" ") },
		{ name: "Secrets it needs", value: draft.envNames.length > 0 ? draft.envNames.join(", ") : "None" },
	];
	if (draft.description) preview.unshift({ name: "What it does", value: draft.description });
	return {
		connector: draft.name,
		action: "be added",
		title: `Add ${draft.name}?`,
		summary: "The assistant drafted this connector. It starts read only, with all of its tools hidden.",
		preview,
	};
}

/** Importing servers from the user's other apps: each one by name and what it runs. */
function importApproval(chosen: { name: string; summary?: string }[]): AppApproval {
	const count = chosen.length;
	return {
		connector: count === 1 ? (chosen[0]?.name ?? "1 server") : `${count} servers`,
		action: "be imported",
		title: `Import ${count} server${count === 1 ? "" : "s"}?`,
		summary: "They start read only, with all of their tools hidden.",
		preview: chosen.map((c) => ({ name: c.name, value: c.summary ?? "" })),
	};
}
