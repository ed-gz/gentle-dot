import type { ServerPayload } from "@gentle-dot/protocol";
import type { OrchestrationEvent } from "./orchestration/index.ts";

/** Alerts are independent of whether Dot also prepares a summary or follows an objective. */
export function sessionNotice(
	event: OrchestrationEvent,
): Extract<ServerPayload, { type: "toast" }> | undefined {
	if (event.type === "policy" || event.intentional) return;
	const dialog = event.type === "attention" && Boolean(event.requestId);
	const question = dialog && event.dialogKind === "question";
	const notificationEvent =
		event.type === "completed"
			? event.resultChanged !== false && event.assistantMessageId
				? "agentCompleted"
				: "agentAvailable"
			: event.type === "disconnected"
				? "agentError"
				: dialog && !question
					? "permission"
					: "agentAttention";
	const copy = (
		{
			agentCompleted: ["Una sesión terminó", "La respuesta está lista en Sesiones."],
			agentAvailable: ["Sesión disponible", "El agente está listo para continuar."],
			agentError: ["Sesión desconectada", "Revisa su conexión en Sesiones."],
			agentAttention: ["Una sesión necesita atención", "Abre Sesiones para ver qué necesita."],
			permission: ["Autorización pendiente", "Puedes responder desde Sesiones."],
		} as const
	)[notificationEvent];
	const label = event.sessionId || event.paneId || "La sesión";
	const summary = (event.dialogTitle || event.message || "Revisa la solicitud en Sesiones.").slice(0, 160);
	return {
		type: "toast",
		level: event.type === "completed" ? "info" : "warning",
		notificationEvent,
		// Stable across repeated attention events; consumers already maintain bounded seen-id ledgers.
		notificationId: dialog ? `dialog:${JSON.stringify([event.paneId, event.sessionId, event.requestId])}` : event.id,
		...(event.paneId
			? { session: { paneId: event.paneId, ...(event.sessionId ? { sessionId: event.sessionId } : {}) } }
			: {}),
		title: dialog ? (question ? "Pregunta" : "Permiso") : copy[0],
		message: dialog ? `${label}${question ? " te pregunta: " : " pide permiso: "}${summary}` : copy[1],
	};
}
