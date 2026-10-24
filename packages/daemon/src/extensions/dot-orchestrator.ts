import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type OrchestrationCall = (input: Record<string, unknown>) => Promise<unknown>;

/** Direct session tools never grant authority; delegated answers go through a live workflow lease. */
export function registerOrchestrationTools(pi: ExtensionAPI, call: OrchestrationCall): void {
	pi.registerTool({
		name: "dot_sessions",
		label: "Gestionar sesiones de agentes",
		description:
			"Lista, crea, continúa y detiene tareas de Pi/Gentle Shell conectadas en HERDR, Orca o cualquier terminal con adaptador Gentle Dot. snapshot indica proveedores y capacidades; selecciona un provider disponible para crear. snapshot muestra sesiones/permisos/resultados; create abre una nueva sesión en cwd; inspect lee su conversación; prompt envía una instrucción; abort detiene la tarea actual, sin cerrar la terminal. No uses entrada de terminal para continuar sesiones sin adaptador. Usa paneId y sessionId exactos del snapshot. Las solicitudes dentro de un objetivo delegado se resuelven durante su continuación con dot_workflows approve, tras inspeccionarlas. Las demás se consultan a la persona. Nunca simules respuestas humanas ni uses entrada de terminal para evadir un permiso. Los avisos de sesión inactiva no prueban éxito: inspecciona el resultado.",
		parameters: {
			type: "object",
			properties: {
				action: { type: "string", enum: ["snapshot", "create", "inspect", "prompt", "abort"] },
				provider: { type: "string", enum: ["herdr", "orca", "terminal"] },
				cwd: { type: "string" },
				label: { type: "string" },
				workspaceId: { type: "string" },
				paneId: { type: "string" },
				sessionId: { type: "string" },
				text: { type: "string" },
				before: {
					type: "string",
					description: "Id del mensaje más antiguo de la página para cargar mensajes anteriores.",
				},
				limit: { type: "integer", minimum: 1, maximum: 100 },
			},
			required: ["action"],
			additionalProperties: false,
		},
		async execute(_id, params) {
			const input = params as Record<string, unknown>;
			if (!["snapshot", "create", "inspect", "prompt", "abort"].includes(String(input.action)))
				throw new Error("Esta operación requiere a la persona en la app.");
			const result = await call(input);
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
		},
	});
}

export default function dotOrchestrator(pi: ExtensionAPI): void {
	const url = process.env.GENTLE_DOT_ORCHESTRATION_URL;
	const key = process.env.GENTLE_DOT_ORCHESTRATION_KEY;
	if (!url || !key) return;
	registerOrchestrationTools(pi, async (input) => {
		const response = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
			body: JSON.stringify(input),
			signal: AbortSignal.timeout(40_000),
			redirect: "error",
		});
		const result = await response.json();
		if (!response.ok)
			throw new Error(
				typeof result?.error === "string" ? result.error : "La orquestación rechazó la operación.",
			);
		return result;
	});
}
