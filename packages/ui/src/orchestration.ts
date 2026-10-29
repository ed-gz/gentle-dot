import type { AttachmentRef, UploadedFile } from "@gentle-dot/protocol";
import type { ConnectionInfo } from "./client.ts";
import { uploadBase } from "./uploads.ts";
import { createTerminalMoodClient, type TerminalMoodClient } from "./terminal-mood.ts";
import { type FollowedWorkAction, type FollowedWorkSnapshot, parseFollowedWork } from "./workflows.ts";

export interface AgentSession {
	provider?: "herdr" | "orca" | "terminal";
	capabilities?: {
		attachments?: { version: 1; files: true; images: boolean; audio: "file" };
		inspect: boolean;
		prompt: boolean;
		deliveryReceipts?: boolean;
		deliveryModes?: ("steer" | "followUp")[];
		abort: boolean;
		approvals: boolean;
		close?: boolean;
		duplicate?: boolean;
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
}

export interface AgentQuestion {
	id: string;
	question: string;
	header?: string;
	multiSelect: boolean;
	options: { label: string; description?: string; preview?: string }[];
}
export type AgentAnswer =
	| { approved: boolean }
	| { optionId: string }
	| { text: string }
	| { answers: { questionId: string; optionIndices?: number[]; text?: string }[] }
	| { cancelled: true };

export interface AgentApproval {
	id: string;
	paneId: string;
	sessionId: string;
	title: string;
	message: string;
	action: string;
	createdAt: string;
	expiresAt: string;
	answerable: boolean;
	kind?: "confirm" | "select" | "input" | "questionnaire" | "editor" | "custom";
	/** Provider consent/effect-bearing choices always require an explicit submit. */
	requiresConfirmation?: boolean;
	options?: { id: string; label: string; description?: string; effect?: string; consequence?: string }[];
	placeholder?: string;
	questions?: AgentQuestion[];
	questionRevision?: string;
	policyEligible?: boolean;
	unavailableReason?: "legacy_connection" | "terminal_only";
}

export interface AgentPolicy {
	id: string;
	paneId: string;
	sessionId: string;
	action: string;
	expiresAt: string;
	remainingUses: number;
}

export interface AgentEvent {
	intentional?: boolean;
	id: string;
	at: string;
	type: "completed" | "attention" | "disconnected" | "policy";
	paneId?: string;
	message: string;
}

export interface OrchestrationSnapshot {
	mutationInstanceFence?: 1;
	available: boolean;
	providers?: { id: "herdr" | "orca" | "terminal"; available: boolean; canCreate: boolean; error?: string }[];
	error?: string;
	sessions: AgentSession[];
	approvals: AgentApproval[];
	policies: AgentPolicy[];
	events: AgentEvent[];
}

export type OrchestrationAction =
	| {
			action: "create";
			cwd: string;
			label?: string;
			workspaceId?: string;
			provider?: "herdr" | "orca" | "terminal";
	  }
	| { action: "abort"; paneId: string; sessionId: string }
	| { action: "close" | "duplicate"; paneId: string; sessionId: string; expectedInstanceId?: string }
	| { action: "prompt"; paneId: string; sessionId: string; text: string; attachments?: AttachmentRef[]; clientMessageId?: string; deliverAs?: "steer" | "followUp" }
	| ({ action: "answer"; paneId: string; sessionId: string; requestId: string; reviewedApproval?: AgentApproval; expectedQuestionRevision?: string } & AgentAnswer)
	| {
			action: "grant";
			paneId: string;
			sessionId: string;
			requestId: string;
			expiresAt: string;
			maxUses: number;
	  }
	| { action: "revoke"; policyId: string };

export interface OrchestrationClient {
	requiresReviewedApproval?: boolean;
	terminalMood?: TerminalMoodClient;
	snapshot(signal?: AbortSignal): Promise<OrchestrationSnapshot>;
	act(action: OrchestrationAction): Promise<void>;
	uploadAttachment?(paneId: string, sessionId: string, file: File, uploadId?: string, signal?: AbortSignal): Promise<UploadedFile>;
	inspect(
		paneId: string,
		sessionId: string,
		signal?: AbortSignal,
		page?: { before?: string; limit?: number },
	): Promise<AgentConversation>;
	computerStatus?(signal?: AbortSignal): Promise<ComputerSnapshot>;
	stopComputer?(): Promise<ComputerSnapshot>;
	browserStatus?(signal?: AbortSignal): Promise<BrowserStatus>;
	browserAction?(
		action: BrowserHumanAction,
		signal?: AbortSignal,
	): Promise<BrowserStatus | BrowserPage | BrowserInstallation>;
	dotApprovals?(signal?: AbortSignal): Promise<{ allowed: boolean; approvals: DotApproval[] }>;
	answerDotApproval?(requestId: string, approved: boolean): Promise<void>;
	followedWork?(signal?: AbortSignal): Promise<FollowedWorkSnapshot>;
	controlFollowedWork?(action: FollowedWorkAction): Promise<void>;
}

export interface DotApproval {
	id: string;
	title: string;
	message: string;
	expiresAt: string;
}

export interface ComputerSnapshot {
	available: boolean;
	platform: string;
	permissions: { accessibility: boolean; screenRecording: boolean; screenshotsSupported: boolean };
	state: { active: boolean; yolo: boolean; endsAt?: number; yoloEndsAt?: number };
	capabilities?: {
		backend: string;
		supported: boolean;
		missingDependencies: string[];
		limitations: string[];
	};
}

function parseComputerStatus(value: unknown): ComputerSnapshot {
	const status = value as ComputerSnapshot | undefined;
	if (
		!status ||
		typeof status.available !== "boolean" ||
		typeof status.platform !== "string" ||
		typeof status.permissions?.accessibility !== "boolean" ||
		typeof status.permissions?.screenRecording !== "boolean" ||
		typeof status.state?.active !== "boolean" ||
		typeof status.state?.yolo !== "boolean" ||
		(status.capabilities &&
			(!Array.isArray(status.capabilities.missingDependencies) ||
				!Array.isArray(status.capabilities.limitations) ||
				[...status.capabilities.missingDependencies, ...status.capabilities.limitations].some(
					(item) => typeof item !== "string",
				)))
	)
		throw new Error("El equipo devolvió un estado de control no válido.");
	return status;
}

export interface BrowserInstallation {
	requestId: string;
	status:
		| "pending"
		| "succeeded"
		| "denied"
		| "cancelled"
		| "failed"
		| "unsupported"
		| "helper_unavailable"
		| "busy"
		| "unknown";
	message: string;
}
export interface BrowserStatus {
	canRequestInstall?: boolean;
	installation?: BrowserInstallation;
	available: boolean;
	active: boolean;
	running: boolean;
	mode: "headless" | "window";
	expiresAt?: string;
	reason?: string;
	tabs: { id: string; title: string; url: string }[];
	desktopControl: "native-app";
}

export interface BrowserPage {
	tabId: string;
	snapshotId: string;
	title: string;
	url: string;
	text: string;
	image?: { mime: "image/jpeg"; data: string };
}

export type BrowserHumanAction =
	| { action: "start"; minutes?: number; window: boolean }
	| { action: "stop" }
	| { action: "install_browser"; reason: string }
	| { action: "snapshot"; tabId: string; screenshot: true };

export interface AgentDelivery {
	id: string;
	status: "accepted" | "queued" | "delivered" | "unconfirmed";
	preview?: string;
	deliverAs: "steer" | "followUp";
	acceptedAt: string;
	deliveredAt?: string;
	/** Evidence that the session correlated this receipt to its native message. */
	evidence?: "correlated-v1";
}

export interface AgentConversation {
	deliveries?: AgentDelivery[];
	metadata?: AgentMetadata;
	capabilities?: {
		prompt?: boolean;
		abort?: boolean;
		questions?: boolean;
		close?: boolean;
		duplicate?: boolean;
	};
	history?: { hasEarlier: boolean; before?: string; supported: boolean };
	sessionId: string;
	status: "idle" | "working" | "waiting";
	messages: {
		id: string;
		clientMessageId?: string;
		deliveryId?: string;
		role: "user" | "assistant" | "tool" | "system";
		timestamp?: string;
		isError?: boolean;
		stopReason?: string;
		provenance?: { kind: "subagent" | "session"; label?: string };
		content: { type: "text"; text: string }[];
	}[];
	question: { id: string; kind: string; title: string; message?: string; answerable: boolean } | null;
	work?: AgentWork;
}

export function parseAgentDeliveries(value: unknown): AgentDelivery[] | undefined {
	if (!Array.isArray(value)) return;
	return value.slice(0, 500).filter((item): item is AgentDelivery => Boolean(item) &&
		typeof item.id === "string" && /^[A-Za-z0-9_-]{8,96}$/.test(item.id) &&
		["accepted", "queued", "delivered", "unconfirmed"].includes(item.status) &&
		["steer", "followUp"].includes(item.deliverAs) && typeof item.acceptedAt === "string" && Number.isFinite(Date.parse(item.acceptedAt)))
		.map(item => ({ id: item.id, status: item.status, deliverAs: item.deliverAs, acceptedAt: item.acceptedAt,
			...(item.evidence === "correlated-v1" ? { evidence: "correlated-v1" as const } : {}),
			...(typeof item.preview === "string" ? { preview: item.preview.slice(0, 2000) } : {}),
			...(typeof item.deliveredAt === "string" && Number.isFinite(Date.parse(item.deliveredAt)) ? { deliveredAt: item.deliveredAt } : {}) }));
}

export interface AgentMetadata {
	version: 1;
	source?: "live" | "history";
	model?: { id: string; name: string; provider: string; contextWindow?: number; source?: "live" };
	thinkingLevel?: string;
	context?: { tokens: number | null; contextWindow: number; percent: number | null; source?: "live" };
	tools?: { active: string[]; available: number };
	skills?: { name: string; description?: string }[];
	/** The currently configured profile; model reports the actual session runtime. */
	profile?: { name: string; source: "global" | "local" | "repo" | "session" };
	/** Evidence for this particular tool only; does not identify the launcher. */
	gentleReview?: { tool: "gentle_review"; evidence: "source-hash" };
	mcp?: { name: string; status: "configured" | "disabled" | "available"; tools: number }[];
}

export function parseAgentMetadata(value: unknown): AgentMetadata | undefined {
	if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1) return;
	const item = value as Record<string, unknown>;
	const result: AgentMetadata = { version: 1 };
	if (item.source === "history" || item.source === "live") result.source = item.source;
	const object = (value: unknown): value is Record<string, unknown> =>
		Boolean(value) && typeof value === "object" && !Array.isArray(value);
	const text = (value: unknown): value is string =>
		typeof value === "string" && value.length > 0 && value.length <= 200;
	const number = (value: unknown): value is number =>
		typeof value === "number" && Number.isFinite(value) && value >= 0;
	if (item.source === "live" && object(item.gentleReview) && item.gentleReview.tool === "gentle_review" && item.gentleReview.evidence === "source-hash")
		result.gentleReview = { tool: "gentle_review", evidence: "source-hash" };
	if (object(item.model) && text(item.model.id) && text(item.model.name) && text(item.model.provider))
		result.model = {
			id: item.model.id,
			name: item.model.name,
			provider: item.model.provider,
			...(item.model.source === "live" ? { source: "live" } : {}),
			...(number(item.model.contextWindow) && item.model.contextWindow > 0
				? { contextWindow: item.model.contextWindow }
				: {}),
		};
	if (text(item.thinkingLevel)) result.thinkingLevel = item.thinkingLevel;
	if (object(item.context) && number(item.context.contextWindow) && item.context.contextWindow > 0)
		result.context = {
			contextWindow: item.context.contextWindow,
			tokens: number(item.context.tokens) ? item.context.tokens : null,
			percent: number(item.context.percent) ? item.context.percent : null,
			...(item.context.source === "live" ? { source: "live" } : {}),
		};
	if (object(item.tools) && Array.isArray(item.tools.active) && number(item.tools.available))
		result.tools = { active: item.tools.active.filter(text).slice(0, 512), available: item.tools.available };
	if (Array.isArray(item.skills))
		result.skills = item.skills
			.filter(object)
			.filter((skill) => text(skill.name))
			.slice(0, 512)
			.map((skill) => ({
				name: skill.name as string,
				...(text(skill.description) ? { description: skill.description } : {}),
			}));
	if (
		object(item.profile) &&
		text(item.profile.name) &&
		["global", "local", "repo", "session"].includes(String(item.profile.source))
	)
		result.profile = {
			name: item.profile.name,
			source: item.profile.source as "global" | "local" | "repo" | "session",
		};
	if (Array.isArray(item.mcp))
		result.mcp = item.mcp
			.filter(object)
			.filter(
				(server) =>
					text(server.name) &&
					["configured", "disabled", "available"].includes(String(server.status)) &&
					number(server.tools),
			)
			.slice(0, 128)
			.map((server) => ({
				name: server.name as string,
				status: server.status as "configured" | "disabled" | "available",
				tools: server.tools as number,
			}));
	return result;
}

export interface AgentWork {
	version: 1;
	capturedAt?: string;
	commands: {
		id: string;
		messageId?: string;
		tool: string;
		label: string;
		status: "running" | "completed" | "failed" | "unknown";
		source: "live" | "history";
		startedAt?: string;
		finishedAt?: string;
		output?: string;
		outputTruncated?: boolean;
	}[];
	agents: {
		id: string;
		agent: string;
		label?: string;
		status: "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "timed_out" | "unknown";
		source: "live" | "history";
		updatedAt?: string;
	}[];
	plan?: {
		source: "history" | "live";
		tasks: { id: string; title: string; status: "pending" | "in_progress" | "done"; note?: string }[];
		completed: number;
		total: number;
	};
	truncated: boolean;
}

/** Access keys stay in the header; mutations are never retried automatically. */
export function createOrchestrationClient(info: ConnectionInfo, transport: { fetch?: typeof fetch; terminalMood?: boolean } = {}): OrchestrationClient {
	const requestFetch = transport.fetch ?? globalThis.fetch;
	const endpoint = `${uploadBase(info.url)}/orchestration`;
	async function request(
		action?:
			| OrchestrationAction
			| BrowserHumanAction
			| FollowedWorkAction
			| { action: "inspect"; paneId: string; sessionId: string; before?: string; limit?: number }
			| { requestId: string; approved: boolean },
		signal?: AbortSignal,
		path = endpoint,
		allowForbidden = false,
	): Promise<unknown> {
		const timeout = path.endsWith("/browser")
			? action && "action" in action && action.action === "install_browser"
				? 980_000
				: 45_000
			: action && "action" in action && (action.action === "create" || action.action === "duplicate")
				? 40_000
				: 15_000;
		const response = await requestFetch(path, {
			method: action ? "POST" : "GET",
			headers: {
				Authorization: `Bearer ${info.token}`,
				...(action ? { "Content-Type": "application/json" } : {}),
			},
			...(action ? { body: JSON.stringify(action) } : {}),
			signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
			cache: "no-store",
			credentials: "omit",
			redirect: "error",
		});
		const body: unknown = await response.json().catch(() => undefined);
		if (response.status === 403 && allowForbidden) return false;
		if (!response.ok) {
			const detail = body && typeof body === "object" && "error" in body ? body.error : undefined;
			throw new Error(
				typeof detail === "string" ? detail : `Falló la conexión con los agentes (${response.status}).`,
			);
		}
		return body;
	}
	return {
		terminalMood: transport.terminalMood === false ? undefined : createTerminalMoodClient(info),
		async snapshot(signal) {
			const body = await request(undefined, signal);
			if (
				!body ||
				typeof body !== "object" ||
				!("available" in body) ||
				typeof body.available !== "boolean" ||
				!("sessions" in body) ||
				!Array.isArray(body.sessions) ||
				!("approvals" in body) ||
				!Array.isArray(body.approvals) ||
				!("policies" in body) ||
				!Array.isArray(body.policies) ||
				!("events" in body) ||
				!Array.isArray(body.events)
			)
				throw new Error("El equipo devolvió un estado de agentes no válido.");
			return body as OrchestrationSnapshot;
		},
		async act(action) {
			if (action.action === "answer") {
				const { reviewedApproval: _reviewedApproval, ...wireAction } = action;
				await request(wireAction);
			} else await request(action);
		},
		async uploadAttachment(paneId, sessionId, file, uploadId, signal) {
			const response = await requestFetch(`${uploadBase(info.url)}/upload`, {
				method: "POST", body: file, signal,
				headers: { Authorization: `Bearer ${info.token}`, "X-File-Name": encodeURIComponent(file.name),
					"X-Agent-Pane": paneId, "X-Agent-Session": sessionId, ...(uploadId ? { "X-Upload-Id": uploadId } : {}) },
				credentials: "omit", redirect: "error", cache: "no-store",
			});
			const body = await response.json().catch(() => undefined);
			if (!response.ok) throw new Error(typeof body?.message === "string" ? body.message : "No se pudo subir el archivo.");
			if (!body || typeof body.uploadId !== "string" || typeof body.name !== "string" || typeof body.mime !== "string" || typeof body.size !== "number")
				throw new Error("El equipo devolvió un archivo no válido.");
			return body as UploadedFile;
		},
		async inspect(paneId, sessionId, signal, page) {
			const result = (await request(
				{ action: "inspect", paneId, sessionId, ...page },
				signal,
			)) as AgentConversation;
			return {
				...result,
				deliveries: parseAgentDeliveries(result.deliveries),
				metadata: parseAgentMetadata(result.metadata),
				messages: result.messages.map(({ provenance, ...message }) => ({
					...message,
					// Older or malformed payloads cannot turn a human message into a delegate result.
					...(message.role === "assistant" &&
					(provenance?.kind === "subagent" || provenance?.kind === "session")
						? {
								provenance: {
									kind: provenance.kind,
									...(typeof provenance.label === "string" &&
									provenance.label.trim() &&
									provenance.label.length <= 80
										? { label: provenance.label.replace(/\p{Cc}/gu, " ").trim() }
										: {}),
								},
							}
						: {}),
				})),
			};
		},
		async computerStatus(signal) {
			return parseComputerStatus(
				await request(undefined, signal, `${uploadBase(info.url)}/api/mobile/computer`),
			);
		},
		async stopComputer() {
			return parseComputerStatus(
				await request({ action: "stop" }, undefined, `${uploadBase(info.url)}/api/mobile/computer`),
			);
		},
		async browserStatus(signal) {
			const value = await request(undefined, signal, `${uploadBase(info.url)}/browser`);
			if (
				!value ||
				typeof value !== "object" ||
				!("active" in value) ||
				typeof value.active !== "boolean" ||
				!("available" in value) ||
				typeof value.available !== "boolean" ||
				!("tabs" in value) ||
				!Array.isArray(value.tabs) ||
				("canRequestInstall" in value && typeof value.canRequestInstall !== "boolean") ||
				("installation" in value &&
					value.installation !== undefined &&
					!validInstallation(value.installation))
			)
				throw new Error("El equipo devolvió un estado de navegador no válido.");
			return value as BrowserStatus;
		},
		async browserAction(action, signal) {
			const result = await request(action, signal, `${uploadBase(info.url)}/browser`);
			if (action.action === "install_browser") {
				if (!validInstallation(result))
					throw new Error(
						"No se pudo confirmar el resultado de la instalación. Revisa su estado en el equipo.",
					);
				return result;
			}
			return result as BrowserStatus | BrowserPage;
		},
		async dotApprovals(signal) {
			const body = await request(undefined, signal, `${uploadBase(info.url)}/api/mobile/approvals`, true);
			if (body === false) return { allowed: false, approvals: [] };
			if (
				!body ||
				typeof body !== "object" ||
				!("approvals" in body) ||
				!Array.isArray(body.approvals) ||
				body.approvals.some(
					(item) =>
						!item ||
						typeof item !== "object" ||
						typeof item.id !== "string" ||
						typeof item.title !== "string" ||
						typeof item.message !== "string" ||
						typeof item.expiresAt !== "string" ||
						!Number.isFinite(Date.parse(item.expiresAt)),
				)
			)
				throw new Error("El equipo devolvió permisos de Gentle Dot no válidos.");
			return { allowed: true, approvals: body.approvals as DotApproval[] };
		},
		async answerDotApproval(requestId, approved) {
			await request({ requestId, approved }, undefined, `${uploadBase(info.url)}/api/mobile/answer`);
		},
		async followedWork(signal) {
			return parseFollowedWork(
				await request(undefined, signal, `${uploadBase(info.url)}/api/mobile/workflows`),
			);
		},
		async controlFollowedWork(action) {
			await request(action, undefined, `${uploadBase(info.url)}/api/mobile/workflows`);
		},
	};
}

function validInstallation(value: unknown): value is BrowserInstallation {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.requestId === "string" &&
		record.requestId.length > 0 &&
		record.requestId.length <= 96 &&
		typeof record.message === "string" &&
		record.message.length <= 2000 &&
		typeof record.status === "string" &&
		[
			"pending",
			"succeeded",
			"denied",
			"cancelled",
			"failed",
			"unsupported",
			"helper_unavailable",
			"busy",
			"unknown",
		].includes(record.status)
	);
}
