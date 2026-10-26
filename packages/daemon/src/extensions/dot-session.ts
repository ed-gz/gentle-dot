import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmodSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	type ExtensionAPI,
	type ExtensionContext,
	ExtensionEditorComponent,
	type ExtensionUIDialogOptions,
} from "@earendil-works/pi-coding-agent";
import { CompanionActivityTracker, EDITOR_ACTIVITY_EVENT } from "../orchestration/companion-activity.ts";
import { SessionActivity } from "../orchestration/activity.ts";
import { SessionDeliveries } from "../orchestration/delivery.ts";
import { ATTACHMENT_IPC_BYTES, decodeSessionFiles, materializeSessionFiles } from "../orchestration/session-attachments.ts";
import { readLiveAgents } from "../orchestration/activity-files.ts";
import { localRequest, OrchestrationError, record } from "../orchestration/herdr.ts";
import { processIdentity } from "../orchestration/process-identity.ts";
import {
	isNativeQuestionSource,
	type NativeQuestion,
	nativeQuestion,
	questionAnswer,
	humanOnlyQuestion,
	questionDetails,
} from "../orchestration/questions.ts";
import type { Manifest } from "../orchestration/registry.ts";
import { connectReviewConsent, isNativeReviewSource, type LiveReviewConsent, reviewConsentDetails } from "../orchestration/review-consent.ts";
import { copySession } from "../orchestration/session-copy.ts";
import { createSessionMetadata } from "../orchestration/session-info.ts";
import { projectSessionMessages } from "../orchestration/transcript.ts";
import { bindWorkspaceDelegation, workspaceToolPermission } from "./approval-guard.ts";

interface DialogDetails extends Record<string, unknown> {
	kind: "confirm" | "select" | "input" | "editor" | "questionnaire";
	title: string;
}
interface PendingDialog extends DialogDetails {
	id: string;
	expiresAt: string;
	answerable: true;
}

// A global extension and an explicit -e launcher may both load this module. Only one
// adapter owns the runner's shared UI object; neither shadows the other's pending dialog.
const UI_OWNER = Symbol.for("gentle-dot.session-adapter-owner");

/** Runs inside Pi; remote answers resolve the original native dialog Promise. */
export function createDotSession(pi: ExtensionAPI, env: NodeJS.ProcessEnv = process.env) {
	let ctx: ExtensionContext | undefined;
	let sessionId = "";
	let instanceId = "";
	let server: Server | undefined;
	let socketPath: string | undefined;
	let manifestPath: string | undefined;
	let question: PendingDialog | undefined;
	let terminalQuestion: Record<string, unknown> | undefined;
	let answer: ((value: boolean | string | undefined) => void) | undefined;
	let customAnswer: ((response: Record<string, unknown>) => void) | undefined;
	let cancelCustom: (() => void) | undefined;
	let nativeTool: { id: string; dialog: NativeQuestion; armed: boolean } | undefined;
	let reviewTool: string | undefined;
	let reviewConsent: LiveReviewConsent | undefined;
	let restoreDialogs: (() => void) | undefined;
	let confirmTool: ((tool: string, input: Record<string, unknown>) => Promise<boolean>) | undefined;
	const trustedWorkspaceDialogs = new WeakMap<object, () => boolean>();
	// Enrollment is a live coordinator connection, never a dialog/tool argument.
	let enrollment: { socket: Socket; expiresAt: number; leaseUntil: number; humanActivityAt: string | null } | undefined;
	const autonomouslyEnrolled = () => !!enrollment && !enrollment.socket.destroyed &&
		enrollment.expiresAt > Date.now() && enrollment.leaseUntil > Date.now() && enrollment.humanActivityAt ===
		(companionActivity.snapshot(ctx?.isIdle() ?? true, false).humanActivityAt ?? null);
	let ownedUI: object | undefined;
	const owner = {};
	let revision = 0;
	let metadata: ReturnType<typeof createSessionMetadata> | undefined;
	let closing = false;
	const clients = new Set<Socket>();
	const busDisposers: Array<() => void> = [];
	const activity = new SessionActivity();
	const companionActivity = new CompanionActivityTracker();
	const deliveries = new SessionDeliveries();
	const deliveryEvidence = new Map<string, {text: string; acceptedAt: number; baseline: Set<string>}>();
	const deliveredAttachments = new Map<string, string>();
	const deliveredTokens = new Set<string>();
	const remoteAnswers = new WeakSet<object>();
	const remoteReviewAnswers = new WeakSet<object>();
	const queuedHuman: Array<{content: Parameters<ExtensionAPI["sendUserMessage"]>[0]; id?: string}> = [];
	let flushingHuman = false;
	function flushQueuedHuman() {
		if (flushingHuman || !ctx || closing || question || terminalQuestion || ctx.sessionManager.getSessionId() !== sessionId) return;
		flushingHuman = true;
		try {
			while (queuedHuman.length) {
				const next = queuedHuman[0]!;
				try { pi.sendUserMessage(next.content, {deliverAs:"followUp", expandPromptTemplates:false}); }
				catch { return; } // Retain the receipt and payload rather than silently dropping a send.
				queuedHuman.shift();
			}
		} finally { flushingHuman = false; }
	}

	async function close() {
		enrollment = undefined;
		queuedHuman.length = 0;
		deliveries.clear();
		deliveryEvidence.clear();
		companionActivity.reset();
		deliveredAttachments.clear();
		deliveredTokens.clear();
		reviewConsent?.detach();
		reviewConsent = undefined;
		reviewTool = undefined;
		cancelCustom?.();
		customAnswer = cancelCustom = undefined;
		nativeTool = undefined;
		answer?.(undefined);
		for (const dispose of busDisposers.splice(0)) dispose();
		question = undefined;
		restoreDialogs?.();
		restoreDialogs = undefined;
		confirmTool = undefined;
		if (ownedUI && Reflect.get(ownedUI, UI_OWNER) === owner) Reflect.deleteProperty(ownedUI, UI_OWNER);
		ownedUI = undefined;
		for (const socket of clients) socket.destroy();
		clients.clear();
		const previous = server;
		server = undefined;
		if (previous?.listening) await new Promise<void>((resolve) => previous.close(() => resolve()));
		if (manifestPath) rmSync(manifestPath, { force: true });
		if (socketPath) rmSync(socketPath, { force: true });
		manifestPath = socketPath = undefined;
	}

	function installDialogs(context: ExtensionContext) {
		const ui = context.ui;
		const original = {
			confirm: ui.confirm,
			select: ui.select,
			input: ui.input,
			editor: ui.editor,
			custom: ui.custom,
		};
		async function dialog<T extends boolean | string | undefined>(
			details: DialogDetails,
			options: ExtensionUIDialogOptions | undefined,
			local: (options?: ExtensionUIDialogOptions) => Promise<T>,
			cancelled: T,
			verifyPermission?: () => ReturnType<typeof workspaceToolPermission>,
		): Promise<T> {
			if (
				question ||
				!server ||
				context.sessionManager.getSessionId() !== sessionId ||
				!questionDetails(details)
			)
				return local(options);
			const controller = new AbortController();
			const timeout = Math.min(Math.max(options?.timeout ?? 600_000, 1), 600_000);
			const pending: PendingDialog = {
				...details,
				id: randomUUID(),
				createdAt: new Date().toISOString(),
				expiresAt: new Date(Date.now() + timeout).toISOString(),
				answerable: true,
			};
			if (!questionDetails(pending)) return local(options);
			const permission = verifyPermission?.();
			if (permission && verifyPermission) {
				pending.workflowPermission = permission;
				const grant = enrollment;
				trustedWorkspaceDialogs.set(pending, () => enrollment === grant && autonomouslyEnrolled() && JSON.stringify(verifyPermission()) === JSON.stringify(permission));
			}
			question = pending;
			revision++;
			let decided = false;
			const remote = new Promise<T>((resolve) => {
				answer = (value) => {
					if (decided) return;
					decided = true;
					resolve(value === undefined ? cancelled : (value as T));
					controller.abort();
				};
			});
			const cancel = () => answer?.(undefined);
			options?.signal?.addEventListener("abort", cancel, { once: true });
			const timer = setTimeout(cancel, timeout);
			try {
				if (options?.signal?.aborted) {
					cancel();
					return cancelled;
				}
				return await Promise.race([remote, local({ ...options, timeout, signal: controller.signal }).then(value => {
					if (!decided && !controller.signal.aborted) companionActivity.human();
					return value;
				})]);
			} finally {
				decided = true;
				clearTimeout(timer);
				options?.signal?.removeEventListener("abort", cancel);
				controller.abort();
				if (question === pending) {
					question = undefined;
					answer = undefined;
				}
				revision++;
				flushQueuedHuman();
			}
		}
		const confirm: typeof ui.confirm = (title, message, options) =>
			dialog(
				{
					kind: "confirm",
					title,
					message,
					action: title,
					fingerprint: createHash("sha256")
						.update(JSON.stringify([instanceId, sessionId, context.cwd, title, message]))
						.digest("hex"),
				},
				options,
				(opts) => original.confirm.call(ui, title, message, opts),
				false,
			);
		const select: typeof ui.select = (title, options, opts) => {
			const choices = [...options];
			return dialog(
				{ kind: "select", title, options: choices.map((label, index) => ({ id: String(index), label })) },
				opts,
				(options) => original.select.call(ui, title, choices, options),
				undefined,
			);
		};
		const input: typeof ui.input = (title, placeholder, options) =>
			dialog(
				{
					kind: "input",
					title,
					...(placeholder !== undefined ? { placeholder } : {}),
				},
				options,
				(opts) => original.input.call(ui, title, placeholder, opts),
				undefined,
			);
		const editor: typeof ui.editor = (title, prefill) => {
			const details: DialogDetails = { kind: "editor", title, message: prefill ?? "" };
			const showEditor = original.custom?.bind(ui);
			if (!showEditor || question || !server || !questionDetails(details))
				return original.editor.call(ui, title, prefill);
			// editor() has no AbortSignal. Use Pi's own component in a closable custom
			// dialog so a remote answer never leaves an orphaned native editor open.
			return dialog<string | undefined>(
				details,
				undefined,
				(options) => {
					let cancel: (() => void) | undefined;
					return showEditor<string | undefined>((tui, _theme, keys, done) => {
						cancel = () => done(undefined);
						options?.signal?.addEventListener("abort", cancel, { once: true });
						return new ExtensionEditorComponent(tui, keys, title, prefill, done, cancel);
					}).finally(() => {
						if (cancel) options?.signal?.removeEventListener("abort", cancel);
					});
				},
				undefined,
			);
		};
		// Only this closure can mark a pending dialog. Generic ui.confirm, its options,
		// bus events and model-authored tool arguments never enter this channel.
		confirmTool = (tool, input) => {
			const permission = () => workspaceToolPermission({ toolName: tool, input, cwd: context.cwd });
			const title = `Allow ${tool} in this project?`;
			const message = JSON.stringify(input, null, 2);
			return dialog({ kind: "confirm", title, message, action: title,
				fingerprint: createHash("sha256").update(JSON.stringify([instanceId, sessionId, context.cwd, tool, input])).digest("hex"),
			}, undefined, opts => original.confirm.call(ui, title, message, opts), false, permission);
		};
		ui.confirm = confirm;
		if (typeof original.select === "function") ui.select = select;
		if (typeof original.input === "function") ui.input = input;
		if (typeof original.editor === "function") ui.editor = editor;
		const callCustom = original.custom?.bind(ui);
		const custom: typeof ui.custom = async (factory, options) => {
			const selected = nativeTool;
			if (!selected?.armed || question || !server || context.sessionManager.getSessionId() !== sessionId) {
				const consent = reviewConsent;
				const result = await callCustom(factory, options);
				if (consent && !remoteReviewAnswers.has(consent) && result !== undefined) companionActivity.human();
				return result;
			}
			selected.armed = false;
			let pending: PendingDialog | undefined;
			try {
				return await callCustom((tui, theme, keys, done) => {
					let settled = false;
					pending = {
						...selected.dialog.details,
						kind: selected.dialog.details.kind as PendingDialog["kind"],
						title: String(selected.dialog.details.title),
						id: randomUUID(),
						createdAt: new Date().toISOString(),
						expiresAt: "",
						answerable: true,
					};
					const finish = (value: unknown) => {
						if (settled) return;
						settled = true;
						if (pending && !remoteAnswers.has(pending) && !closing) companionActivity.human();
						if (question === pending) {
							question = undefined;
							customAnswer = cancelCustom = undefined;
							terminalQuestion = undefined;
							revision++;
							queueMicrotask(flushQueuedHuman);
						}
						done(value as Parameters<typeof done>[0]);
					};
					question = pending;
					customAnswer = (response) => finish(selected.dialog.result(response));
					cancelCustom = () => finish(selected.dialog.result({ cancelled: true }));
					revision++;
					return factory(tui, theme, keys, finish);
				}, options);
			} finally {
				if (question === pending) {
					question = undefined;
					customAnswer = cancelCustom = undefined;
					revision++;
				}
			}
		};
		if (typeof original.custom === "function") ui.custom = custom;
		restoreDialogs = () => {
			if (ui.confirm === confirm) ui.confirm = original.confirm;
			if (ui.select === select) ui.select = original.select;
			if (ui.input === input) ui.input = original.input;
			if (ui.editor === editor) ui.editor = original.editor;
			if (ui.custom === custom) ui.custom = original.custom;
		};
	}

	async function handle(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
		if (params.expectedInstanceId !== instanceId)
			throw new OrchestrationError(
				"INSTANCE_CHANGED",
				"El proceso de Pi cambió. Actualiza antes de continuar.",
			);
		if (!ctx || params.expectedSessionId !== sessionId || ctx.sessionManager.getSessionId() !== sessionId)
			throw new OrchestrationError("SESSION_CHANGED", "La sesión cambió. Actualiza antes de responder.");
		if (closing) throw new OrchestrationError("SESSION_CLOSING", "Esta sesión ya se está cerrando.");
		if (method === "companion.activity") {
            pi.events?.emit("gentle-dot:editor-activity:probe", { sessionId: ctx.sessionManager.getSessionId() });
            return {
			sessionId, instanceId,
			companionActivity: companionActivity.snapshot(ctx.isIdle(), !!question || !!terminalQuestion),
		};
        }
		if (method === "snapshot") {
            pi.events?.emit("gentle-dot:editor-activity:probe", {sessionId:ctx.sessionManager.getSessionId()});
			const branch = ctx.sessionManager.getBranch();
			// A message_start event can precede final content (or be missed during
			// reconnect). The persisted user branch is authoritative consumption evidence.
			const matchedDeliveries = new Set<string>();
			for (const entry of branch) {
				if (entry.type !== "message" || entry.message.role !== "user") continue;
				const at = Date.parse(entry.timestamp);
				if (!Number.isFinite(at)) continue;
				const content = entry.message.content;
				const text = typeof content === "string" ? content : content.filter(part => part.type === "text").map(part => part.text).join("\n");
				// Reserve evidence for completed receipts too: one real turn must never
				// confirm two identical remote sends on successive snapshot polls.
				const receipt = deliveries.snapshot().find(receipt => {
					const evidence = deliveryEvidence.get(receipt.id);
					return !matchedDeliveries.has(receipt.id) && evidence?.text === text && !evidence.baseline.has(entry.id) && at >= evidence.acceptedAt - 5_000 && at <= evidence.acceptedAt + 600_000;
				});
				if (receipt) {
					matchedDeliveries.add(receipt.id);
					const firstPending = deliveries.snapshot().find(item => item.status !== "delivered" && deliveryEvidence.get(item.id)?.text === text);
					if (receipt.status !== "delivered" && firstPending?.id === receipt.id) deliveries.consume(entry.message);
				}
			}
			const limit = params.limit ?? 50;
			if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 100)
				throw new OrchestrationError("INVALID_HISTORY", "El tamaño de página debe ser de 1 a 100 mensajes.");
			if (
				params.before !== undefined &&
				(typeof params.before !== "string" || !params.before || params.before.length > 256)
			)
				throw new OrchestrationError("INVALID_HISTORY", "La referencia del historial no es válida.");
			const entries = projectSessionMessages(sessionId, branch, ctx.sessionManager.getEntries?.() ?? branch);
			const end =
				params.before === undefined
					? entries.length
					: entries.findIndex((entry) => entry.id === params.before);
			if (end < 0)
				throw new OrchestrationError(
					"HISTORY_CHANGED",
					"La conversación cambió de rama. Actualiza el historial antes de continuar.",
				);
			const start = Math.max(0, end - Number(limit));
			const latestAssistant = entries.findLast((entry) => entry.role === "assistant" && !entry.provenance);
			// Enrich the display projection without changing persisted/model-facing messages.
			const sourceById = new Map(branch.map(entry => [entry.id, entry]));
			const messages = entries.slice(start, end).map(message => {
				const source = sourceById.get(message.id);
				return { ...message,
					...(source?.timestamp && Number.isFinite(Date.parse(source.timestamp)) ? { timestamp: source.timestamp } : {}),
					...(source?.type === "message" && source.message.role === "toolResult" ? { isError: source.message.isError === true } : {}),
				};
			});
			return {
				sessionId,
				instanceId,
				revision: `${sessionId}:${revision}`,
				deliveries: deliveries.snapshot(ctx.isIdle(), !!question || !!terminalQuestion || queuedHuman.length > 0 || (ctx.hasPendingMessages?.() ?? true)),
				companionActivity: companionActivity.snapshot(ctx.isIdle(), !!question || !!terminalQuestion),
				messages,
				history: {
					supported: true,
					hasEarlier: start > 0,
					...(start > 0 && messages[0] ? { before: messages[0].id } : {}),
				},
				work: activity.snapshot(
					branch,
					readLiveAgents(
						env.GENTLE_PI_AGENT_HOME || env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"),
						sessionId,
					),
				),
				stopReason: latestAssistant?.role === "assistant" ? latestAssistant.stopReason : undefined,
				status: question || terminalQuestion ? "waiting" : ctx.isIdle() ? "idle" : "working",
				question: question ?? terminalQuestion ?? null,
				metadata: metadata?.(),
				capabilities: {
					companionActivity: true,
					activityFence: 1,
					enrollmentProtocol: 1,
					prompt: true,
					deliveryReceipts: true,
					deliveryModes: ["steer", "followUp"],
					...(ctx.model?.input.includes("text") && pi.getActiveTools?.().includes("read") ? {
						attachments: { version: 1, files: true, images: ctx.model.input.includes("image"), audio: "file" },
					} : {}),
					abort: true,
					questions: true,
					close: typeof ctx.shutdown === "function",
					duplicate:
						Boolean(env.GENTLE_DOT_SESSION_DIR) &&
						ctx.isIdle() &&
						!question &&
						!terminalQuestion &&
						!ctx.hasPendingMessages?.(),
				},
				managed: true,
			};
		}
		if (method === "duplicate") {
			if (question || terminalQuestion || !env.GENTLE_DOT_SESSION_DIR)
				throw new OrchestrationError(
					"SESSION_BUSY",
					"Resuelve la solicitud pendiente antes de duplicar la sesión.",
				);
			return {
				accepted: true,
				sessionId,
				instanceId,
				copy: copySession(ctx, pi, env.GENTLE_DOT_SESSION_DIR, env),
			};
		}
		if (method === "close") {
			if (typeof ctx.shutdown !== "function")
				throw new OrchestrationError(
					"UNSUPPORTED",
					"Esta versión de Pi no permite cerrar la sesión desde el teléfono.",
				);
			closing = true;
			return { accepted: true, sessionId, instanceId, closing: true };
		}
		if (method === "prompt") {
			// This bit comes from the authenticated daemon's actor, never from prompt text.
			if (params.humanInteraction === true) companionActivity.human();
			if ((question || terminalQuestion) && params.humanInteraction !== true)
				throw new OrchestrationError("QUESTION_PENDING", "Responde al permiso pendiente antes de continuar.");
			if ("model" in ctx && !ctx.model)
				throw new OrchestrationError("NO_MODEL", "Selecciona un modelo en esta sesión antes de enviar instrucciones.");
			if (typeof params.text !== "string" || (!params.text.trim() && params.files === undefined) || (params.files !== undefined && params.text.includes("\0")) || Buffer.byteLength(params.text) > 65_536)
				throw new OrchestrationError(
					"INVALID_PROMPT",
					"El mensaje debe contener texto y ocupar hasta 64 KiB.",
				);
			const waitingForQuestion = !!question || !!terminalQuestion;
			const deliverAs = waitingForQuestion ? "followUp" : (params.deliverAs ?? "followUp") as "steer" | "followUp";
			if (params.deliverAs !== undefined && params.deliverAs !== "steer" && params.deliverAs !== "followUp")
				throw new OrchestrationError("INVALID_DELIVERY", "El modo de entrega no es válido.");
			const clientMessageId = params.clientMessageId;
			if (clientMessageId !== undefined && typeof clientMessageId !== "string")
				throw new OrchestrationError("INVALID_DELIVERY", "El mensaje no contiene una identidad válida.");
			const send = (content: Parameters<ExtensionAPI["sendUserMessage"]>[0]) => {
				if ("expectedHumanActivityAt" in params && params.humanInteraction !== true &&
					params.expectedHumanActivityAt !== (companionActivity.snapshot(ctx!.isIdle(), false).humanActivityAt ?? null))
					throw new OrchestrationError("HUMAN_ACTIVE", "La persona volvió a trabajar en esta sesión; la autonomía debe pausarse.");
				const plain = typeof content === "string" ? content : content.filter(part => part.type === "text").map(part => part.text).join("\n");
				const deliveryId = typeof clientMessageId === "string" ? clientMessageId : waitingForQuestion ? randomUUID() : undefined;
				const prepared = deliveryId
					? deliveries.prepare(deliveryId, [params.text, params.deliveryId, params.deliverAs ?? "followUp"], plain, deliverAs, !waitingForQuestion && ctx!.isIdle(), String(params.text)) : undefined;
				if (!prepared?.duplicate) {
					if (deliveryId && prepared) deliveryEvidence.set(deliveryId, {text:plain, acceptedAt:Date.parse(prepared.receipt.acceptedAt), baseline:new Set(ctx!.sessionManager.getBranch().map(entry => entry.id))});
					if (waitingForQuestion && queuedHuman.length >= 16) {
						if (deliveryId) { deliveries.remove(deliveryId); deliveryEvidence.delete(deliveryId); }
						throw new OrchestrationError("DELIVERY_LIMIT", "Responde la pregunta antes de enviar más mensajes.");
					}
					if (waitingForQuestion) { queuedHuman.push({content, id:deliveryId}); return; }
					try { pi.sendUserMessage(content, { deliverAs, expandPromptTemplates: false }); }
					catch (error) { if (typeof clientMessageId === "string") { deliveries.remove(clientMessageId); deliveryEvidence.delete(clientMessageId); } throw error; }
				}
			};
			// Slash commands can load files or change sessions. User text is always a literal prompt here.
			if (params.files !== undefined) {
				if (!ctx.model?.input.includes("text") || !pi.getActiveTools?.().includes("read"))
					throw new OrchestrationError("UNSUPPORTED_ATTACHMENTS", "Esta sesión necesita un modelo de texto y la herramienta read para recibir archivos.");
				const files = decodeSessionFiles(params.files, ctx.model.input.includes("image"));
				const tokens = params.deliveryTokens;
				if (typeof params.deliveryId !== "string" || !/^[a-f0-9]{64}$/.test(params.deliveryId) || !Array.isArray(tokens) || tokens.length !== files.length ||
					tokens.some(token => typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) || new Set(tokens).size !== tokens.length)
					throw new OrchestrationError("INVALID_ATTACHMENTS", "El envío no contiene una identidad válida.");
				const digest = createHash("sha256").update(JSON.stringify([params.text, params.files, tokens])).digest("hex");
				const previous = deliveredAttachments.get(params.deliveryId);
				if (previous === digest) return { accepted: true, sessionId, instanceId };
				if (previous || tokens.some(token => deliveredTokens.has(token)) || deliveredTokens.size + tokens.length > 100_000)
					throw new OrchestrationError("ATTACHMENT_REPLAY", "Estos archivos ya se enviaron o la sesión alcanzó el límite de envíos. Adjunta archivos nuevos.");
				const delivered = materializeSessionFiles(params.text, files)(ctx.cwd);
				send([{ type: "text", text: delivered.message }, ...delivered.images]);
				deliveredAttachments.set(params.deliveryId, digest);
				for (const token of tokens) deliveredTokens.add(token);
			} else {
				send(params.text);
			}
		} else if (method === "answer") {
			if ("expectedHumanActivityAt" in params && params.expectedHumanActivityAt !== null &&
				(typeof params.expectedHumanActivityAt !== "string" || !Number.isFinite(Date.parse(params.expectedHumanActivityAt))))
				throw new OrchestrationError("INVALID_ANSWER", "La marca de actividad no es válida.");
			if ("expectedHumanActivityAt" in params && params.expectedHumanActivityAt !==
				(companionActivity.snapshot(ctx.isIdle(), false).humanActivityAt ?? null))
				throw new OrchestrationError("HUMAN_ACTIVE", "La persona volvió a trabajar en esta sesión; la autonomía debe pausarse.");
			if (!question || params.questionId !== question.id || Date.parse(question.expiresAt) <= Date.now())
				throw new OrchestrationError("QUESTION_CHANGED", "El permiso ya fue respondido o venció.");
			if (reviewConsent && Object.keys(params).some(key =>
				!["expectedInstanceId", "expectedSessionId", "questionId", "optionId", "cancelled", "expectedHumanActivityAt"].includes(key)))
				throw new OrchestrationError("INVALID_ANSWER", "La respuesta no corresponde a esta solicitud.");
			if ("expectedHumanActivityAt" in params && (humanOnlyQuestion(question) ||
				(record(question.workflowPermission) && question.workflowPermission.category === "workspace-tool" && trustedWorkspaceDialogs.get(question)?.() !== true)))
				throw new OrchestrationError("HUMAN_REQUIRED", "Esta publicación o envío necesita una respuesta humana directa.", 403);
			const response = questionAnswer(question, params);
			if (!("expectedHumanActivityAt" in params)) companionActivity.human();
			remoteAnswers.add(question);
			if (reviewConsent) remoteReviewAnswers.add(reviewConsent);
			if (reviewConsent) {
				const pending = reviewConsent;
				if (response.cancelled === true) {
					pending.detach(); // No answer: leave the original local consent UI usable.
				} else {
					const accepted = await pending.respond({
						consentBinding: pending.consentBinding,
						answer: response.optionId as "granted" | "declined" | "host-session",
					});
					if (!accepted) throw new OrchestrationError("QUESTION_CHANGED", "El proveedor no confirmó esta respuesta.");
				}
			} else if (customAnswer) {
				customAnswer(response);
			} else if (question.kind === "questionnaire") {
				const pending = question;
				const payload: Record<string, unknown> = { id: question.id, sessionId, ...response };
				pi.events.emit("herdr-connect:question:answer", payload);
				if (payload.accepted !== true)
					throw new OrchestrationError("QUESTION_CHANGED", "La sesión original no confirmó esta respuesta.");
				if (question === pending) question = undefined;
			} else {
				if (!answer)
					throw new OrchestrationError("QUESTION_CHANGED", "El permiso ya fue respondido o venció.");
				const resolve = answer;
				const options = questionDetails(question)?.options;
				const value = response.cancelled
					? undefined
					: question.kind === "confirm"
						? (response.confirmed as boolean)
						: question.kind === "select"
							? options?.find((option) => option.id === response.optionId)?.label
							: (response.text as string);
				answer = undefined;
				resolve(value);
			}
		} else if (method === "abort") {
			reviewConsent?.detach();
			cancelCustom?.();
			answer?.(undefined);
			ctx.abort();
		} else throw new OrchestrationError("UNKNOWN_ACTION", "Acción no admitida.");
		revision++;
		flushQueuedHuman();
		return { accepted: true, sessionId, instanceId, ...(method === "prompt" && queuedHuman.length ? {receiptStatus:"queued"} : {}) };
	}

	function accept(socket: Socket) {
		clients.add(socket);
		socket.setTimeout(10_000, () => socket.destroy());
		socket.on("error", () => {});
		socket.once("close", () => clients.delete(socket));
		const chunks: Buffer[] = [];
		let received = 0;
		let handled = false;
		socket.on("data", async (chunk) => {
			if (handled) return;
			const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
			received += bytes.length;
			// Base64 expands the shared 50 MiB message limit by 4/3. The decoded count,
			// per-file and aggregate limits are validated before any materialization.
			if (received > ATTACHMENT_IPC_BYTES) return socket.destroy();
			chunks.push(bytes);
			if (!bytes.includes(10)) return;
			handled = true;
			const buffer = Buffer.concat(chunks, received);
			chunks.length = 0;
			const newline = buffer.indexOf(10);
			let id: unknown = null;
			try {
				const request: unknown = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
				if (
					!record(request) ||
					typeof request.id !== "string" ||
					typeof request.method !== "string" ||
					!record(request.params)
				)
					throw new OrchestrationError("BAD_REQUEST", "Solicitud inválida.");
				id = request.id;
				if ((request.method !== "prompt" || request.params.files === undefined) && newline > 128 * 1024)
					throw new OrchestrationError("TOO_LARGE", "La solicitud local supera el límite.");
				if (request.method === "workflow.enroll") {
					const params = request.params;
					if (!ctx || closing || params.expectedSessionId !== sessionId || params.expectedInstanceId !== instanceId ||
						ctx.sessionManager.getSessionId() !== sessionId || typeof params.expiresAt !== "number" ||
						!Number.isFinite(params.expiresAt) || params.expiresAt <= Date.now() ||
						params.humanActivityAt !== (companionActivity.snapshot(ctx.isIdle(), false).humanActivityAt ?? null))
						throw new OrchestrationError("ENROLLMENT_CHANGED", "La autorización de autonomía ya no está vigente.");
					if (enrollment) enrollment.socket.destroy();
					const grant = { socket, expiresAt: params.expiresAt, leaseUntil: Date.now() + 3000, humanActivityAt: params.humanActivityAt as string | null };
					enrollment = grant;
					const revoke = () => { if (enrollment === grant) enrollment = undefined; };
					// FIN is acknowledged only after revocation. A completed pause therefore
					// cannot leave a stale enrollment; a daemon crash also revokes it.
					socket.once("end", revoke);
					socket.once("close", revoke);
					// Only this live enrollment can renew its short lease. An expired lease
					// cannot be resurrected; the coordinator must positively enroll again.
					let renewal = "";
					socket.on("data", chunk => {
						renewal += String(chunk);
						if (renewal.length > 1024) { socket.destroy(); return; }
						while (renewal.includes("\n")) {
							const end = renewal.indexOf("\n");
							const message = renewal.slice(0, end);
							renewal = renewal.slice(end + 1);
							if (message !== "workflow.renew" || enrollment !== grant || !autonomouslyEnrolled()) { revoke(); socket.destroy(); return; }
							grant.leaseUntil = Date.now() + 3000;
						}
					});
					socket.setTimeout(0);
					socket.write(`${JSON.stringify({ id, result: { accepted: true } })}\n`);
					return;
				}
				const result = await handle(request.method, request.params);
				const shutdown = request.method === "close" ? ctx : undefined;
				const originalId = sessionId;
				socket.end(`${JSON.stringify({ id, result })}\n`, () => {
					// The exact process closes itself only after acknowledging the request.
					if (shutdown && ctx === shutdown && shutdown.sessionManager.getSessionId() === originalId) {
						reviewConsent?.detach();
						cancelCustom?.();
						answer?.(undefined);
						shutdown.shutdown();
					}
				});
			} catch (error) {
				socket.end(
					`${JSON.stringify({
						id,
						error: {
							code: error instanceof OrchestrationError ? error.code : "FAILED",
							message:
								error instanceof OrchestrationError ? error.message : "No se pudo completar la operación.",
						},
					})}\n`,
				);
			}
		});
	}

	pi.on("session_start", async (_event, context) => {
		await close();
		activity.reset();
		ctx = context;
		closing = false;
		metadata = undefined;
		sessionId = context.sessionManager.getSessionId();
		instanceId = randomUUID();
		terminalQuestion = undefined;
		if (context.mode !== "tui" || !env.GENTLE_DOT_SESSION_DIR || Reflect.get(context.ui, UI_OWNER)) return;
		metadata = createSessionMetadata(pi, context, env);
		ownedUI = context.ui;
		const uiIdentity = context.ui;
		bindWorkspaceDelegation(uiIdentity, () => ownedUI === uiIdentity && autonomouslyEnrolled());
		Object.defineProperty(ownedUI, UI_OWNER, { value: owner, configurable: true });
		try {
			const identity = await processIdentity(process.pid);
			if (!identity) throw new Error("No se pudo verificar la identidad del proceso de Pi");
			let binding: Manifest["binding"] = {
				provider: env.ORCA_PANE_KEY ? "orca" : "terminal",
				terminalId: instanceId,
				...(env.ORCA_PANE_KEY ? { orcaPaneKey: env.ORCA_PANE_KEY } : {}),
			};
			if (env.HERDR_ENV === "1" && env.HERDR_SOCKET_PATH && env.HERDR_PANE_ID) {
				const result = await localRequest(env.HERDR_SOCKET_PATH, "pane.get", { pane_id: env.HERDR_PANE_ID });
				if (!record(result.pane) || typeof result.pane.terminal_id !== "string")
					throw new Error("Missing HERDR binding");
				binding = {
					provider: "herdr",
					herdrSocketPath: env.HERDR_SOCKET_PATH,
					terminalId: result.pane.terminal_id,
					paneId: env.HERDR_PANE_ID,
				};
			}
			const directory = env.GENTLE_DOT_SESSION_DIR;
			mkdirSync(directory, { recursive: true, mode: 0o700 });
			const stat = lstatSync(directory);
			if (
				!stat.isDirectory() ||
				stat.isSymbolicLink() ||
				(stat.mode & 0o077) !== 0 ||
				(process.getuid && stat.uid !== process.getuid())
			)
				throw new Error("The session directory must be private");
			const name = `${process.pid}-${randomBytes(4).toString("hex")}`;
			socketPath = join(directory, `${name}.sock`);
			manifestPath = join(directory, `${name}.json`);
			if (Buffer.byteLength(socketPath) > 103) throw new Error("The session directory path is too long");
			server = createServer(accept);
			server.listen(socketPath);
			await once(server, "listening");
			chmodSync(socketPath, 0o600);
			const manifest = {
				version: 2,
				managed: true,
				socketPath,
				pid: process.pid,
				sessionId,
				instanceId,
				processIdentity: identity,
				cwd: context.cwd,
				label: context.sessionManager.getSessionName?.() || "Pi / Gentle Shell",
				sessionFile: context.sessionManager.getSessionFile(),
				binding,
			};
			const temporary = `${manifestPath}.tmp`;
			writeFileSync(temporary, `${JSON.stringify(manifest)}\n`, { flag: "wx", mode: 0o600 });
			renameSync(temporary, manifestPath);
			installDialogs(context);
			busDisposers.push(connectReviewConsent(context.ui, (request) => {
				if (!reviewTool || request.toolCallId !== reviewTool || question ||
					request.sessionId !== sessionId || context.sessionManager.getSessionId() !== sessionId) return;
				const details = reviewConsentDetails(request);
				if (!details || !questionDetails(details)) return;
				const pending: PendingDialog = {
					...details,
					workflowPermission: { provider: "dot-session/v1", category: "native-review-consent" },
					kind: "select",
					title: String(details.title),
					id: randomUUID(),
					createdAt: new Date().toISOString(),
					expiresAt: new Date(request.expiresAt).toISOString(),
					answerable: true,
				};
				question = pending;
				reviewConsent = request;
				revision++;
				return () => {
					if (question === pending) question = undefined;
					if (reviewConsent === request) reviewConsent = undefined;
					revision++;
					queueMicrotask(flushQueuedHuman);
				};
			}));
			if (pi.events) {
				busDisposers.push(pi.events.on(`${EDITOR_ACTIVITY_EVENT}:geometry`, data => {
                    if (record(data) && data.sessionId === sessionId) companionActivity.geometry(data.geometry);
                }));
                busDisposers.push(pi.events.on(EDITOR_ACTIVITY_EVENT, data => {
					if (!record(data) || data.sessionId !== sessionId || !["ready", "changed", "disposed"].includes(String(data.kind))) return;
					companionActivity.editor(data.kind as "ready" | "changed" | "disposed");
				}));
				// A bridge that loaded earlier can announce its capability without exposing its editor.
				pi.events.emit("gentle-dot:editor-activity:probe", { sessionId });

				for (const tool of ["ask_user_question", "ask_user_choice"]) {
					busDisposers.push(
						pi.events.on(`gentle-pi:${tool.replaceAll("_", "-")}:blocked`, (value) => {
							if (nativeTool?.dialog.tool === tool && record(value)) nativeTool.armed = value.active === true;
						}),
					);
				}
				busDisposers.push(
					pi.events.on("herdr-connect:question:request", (value) => {
						if (!record(value) || value.sessionId !== sessionId || typeof value.id !== "string" || question)
							return;
						const pending: PendingDialog = {
							id: value.id,
							kind: "questionnaire",
							title: "Gentle Shell espera tu respuesta",
							questions: value.questions,
							createdAt: new Date().toISOString(),
							expiresAt: "",
							answerable: true,
						};
						if (!questionDetails(pending)) return;
						question = { ...pending, ...questionDetails(pending), kind: "questionnaire" };
						revision++;
					}),
				);
				busDisposers.push(
					pi.events.on("herdr-connect:question:closed", (value) => {
						if (record(value) && value.sessionId === sessionId && value.id === question?.id) {
							if (question && !remoteAnswers.has(question)) companionActivity.human();
							question = undefined;
							revision++;
							queueMicrotask(flushQueuedHuman);
						}
					}),
				);
			}
		} catch (error) {
			await close();
			context.ui.notify(
				`Gentle Dot: ${error instanceof Error ? error.message : "No se pudo conectar la sesión"}`,
				"warning",
			);
		}
	});
	pi.on("session_shutdown", close);
	pi.on("ui_prompt_start", (event) => {
		if (!question)
			terminalQuestion = {
				id: randomUUID(),
				kind: event.kind,
				title: event.title ?? "Pi necesita tu respuesta",
				message: `Diálogo ${event.kind} abierto en Gentle Shell. Esta pantalla no publicó un formulario remoto compatible. Responde o cancela en la terminal del equipo; después actualiza la solicitud aquí.`,
				createdAt: new Date().toISOString(),
				answerable: false,
			};
	});
	pi.on("ui_prompt_end", () => {
		terminalQuestion = undefined;
	});
	const refresh = (_event: unknown, context: ExtensionContext) => {
		ctx = context;
		revision++;
		flushQueuedHuman();
	};
	pi.on("input", (_event, context) => { if (_event.source !== "extension") companionActivity.human(); companionActivity.submitted(); refresh(_event, context); });
	pi.on("agent_start", (event, context) => { companionActivity.response(true); refresh(event, context); });
	pi.on("agent_end", (event, context) => { companionActivity.response(false); refresh(event, context); });
	pi.on("agent_settled", (event, context) => {
		activity.settled();
		refresh(event, context);
	});
	pi.on("message_start", (event, context) => {
		deliveries.consume(event.message);
		refresh(event, context);
	});
	pi.on("message_end", refresh);
	pi.on("session_tree", (event, context) => {
		activity.reset();
		refresh(event, context);
	});
	pi.on("tool_call", async (event, context) => {
		if (!autonomouslyEnrolled() || !confirmTool || context.ui !== ownedUI || context.sessionManager.getSessionId() !== sessionId ||
			!["read", "edit", "write", "bash"].includes(event.toolName)) return;
		// A sibling tool must not fall through to an untracked local dialog. Retry it
		// after the current permission resolves, rather than sharing another call's grant.
		if (question || closing) return { block: true, reason: "Resolve the pending permission before retrying this tool." };
		const allowed = await confirmTool(event.toolName, event.input as Record<string, unknown>);
		return allowed ? undefined : { block: true, reason: "The user did not allow this tool call." };
	});
	pi.on("tool_execution_start", (event, context) => {
		if (event.toolName === "gentle_review" && isNativeReviewSource(
			pi.getAllTools?.().find(tool => tool.name === "gentle_review")?.sourceInfo?.path,
		)) reviewTool = event.toolCallId;
		const source = ["ask_user_question", "ask_user_choice"].includes(event.toolName)
			? pi.getAllTools?.().find((tool) => tool.name === event.toolName)?.sourceInfo?.path
			: undefined;
		const dialog = isNativeQuestionSource(event.toolName, source)
			? nativeQuestion(event.toolName, event.args)
			: undefined;
		if (dialog && !nativeTool) nativeTool = { id: event.toolCallId, dialog, armed: false };
		activity.start(event);
		refresh(event, context);
	});
	pi.on("tool_execution_end", (event, context) => {
		if (reviewTool === event.toolCallId) {
			reviewConsent?.detach();
			reviewTool = undefined;
		}
		if (nativeTool?.id === event.toolCallId) {
			cancelCustom?.();
			nativeTool = undefined;
		}
		activity.end(event);
		refresh(event, context);
	});
	return { close };
}

export default function dotSession(pi: ExtensionAPI): void {
	createDotSession(pi);
}
