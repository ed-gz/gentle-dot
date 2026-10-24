import type { ServerPayload } from "@gentle-dot/protocol";
import type { OrchestrationEvent } from "./orchestration/index.ts";

/** Alerts are independent of whether Dot also prepares a summary or follows an objective. */
export function sessionNotice(
	event: OrchestrationEvent,
): Extract<ServerPayload, { type: "toast" }> | undefined {
	if (event.type === "policy" || event.intentional) return;
	const notificationEvent =
		event.type === "completed"
			? event.resultChanged !== false && event.assistantMessageId
				? "agentCompleted"
				: "agentAvailable"
			: event.type === "disconnected"
				? "agentError"
				: event.requestId
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
	return {
		type: "toast",
		level: event.type === "completed" ? "info" : "warning",
		notificationEvent,
		notificationId: event.id,
		...(event.paneId
			? { session: { paneId: event.paneId, ...(event.sessionId ? { sessionId: event.sessionId } : {}) } }
			: {}),
		title: copy[0],
		message: copy[1],
	};
}
