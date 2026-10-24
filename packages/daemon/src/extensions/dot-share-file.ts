import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function registerShareFileTool(
	pi: ExtensionAPI,
	publish: (input: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>,
): void {
	pi.registerTool({
		name: "dot_share_file",
		label: "Compartir archivo con la persona",
		description:
			"Comparte un archivo local específico que la persona pidió recibir, o un resultado que acabas de preparar para ella. Usa una ruta absoluta. Crea una copia privada de hasta 50 MiB y devuelve metadata y markdown: incluye ese markdown exacto en tu respuesta para que pueda verlo o descargarlo desde el teléfono. No compartas credenciales, .env, claves privadas, carpetas, enlaces simbólicos ni archivos ajenos al pedido. Revisa el contenido y prepara una copia sin secretos cuando haga falta. No inventes URLs, IDs ni rutas públicas. Una publicación confirmada no significa que el teléfono ya lo descargó.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Ruta absoluta del archivo original" },
				title: { type: "string", description: "Etiqueta breve opcional para el enlace" },
			},
			required: ["path"],
			additionalProperties: false,
		},
		async execute(_id, params, signal) {
			const result = await publish(params as Record<string, unknown>, signal);
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
		},
	});
	pi.registerTool({
		name: "dot_share_screenshot",
		label: "Compartir captura del equipo",
		description:
			"Envía al chat la última captura real del equipo que acabas de ver en este turno. Primero activa la aplicación correcta con mcp__computer__open_app y toma una captura con mcp__computer__screenshot. Las imágenes que esas herramientas te muestran son internas: no se entregan a la persona hasta que llamas dot_share_screenshot. Úsala cuando pide una captura o necesitas mostrarle lo que ves para orientarte. Devuelve markdown privado que debes incluir exacto en la respuesta; el chat también adjunta la imagen si omites el enlace. No recibe rutas, URLs ni base64. Si falla, informa el error y no afirmes que enviaste la captura. Para el navegador dedicado usa dot_browser con share_screenshot.",
		parameters: { type: "object", properties: {}, additionalProperties: false },
		async execute(_id, _params, signal) {
			const result = await publish({ action: "share_computer_screenshot" }, signal);
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
		},
	});
}

export default function shareFile(pi: ExtensionAPI): void {
	const endpoint = process.env.GENTLE_DOT_FILES_URL;
	const key = process.env.GENTLE_DOT_FILES_KEY;
	if (!endpoint || !key) return;
	const url = new URL(endpoint);
	if (
		url.protocol !== "http:" ||
		url.hostname !== "127.0.0.1" ||
		url.pathname !== "/api/files/agent" ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	)
		throw new Error("El canal privado de archivos no es válido.");
	registerShareFileTool(pi, async (input, signal) => {
		const response = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
			body: JSON.stringify(input),
			signal: AbortSignal.any([AbortSignal.timeout(40_000), ...(signal ? [signal] : [])]),
			redirect: "error",
		});
		const result = await response.json();
		if (!response.ok)
			throw new Error(typeof result?.error === "string" ? result.error : "No se pudo compartir el archivo.");
		return result;
	});
}
