/** Optional, display-only projection for bandwidth-limited clients. Preserve
 * message identity and block order without forwarding inline binary payloads. */
export function textOnlySessionMessages(messages: unknown): unknown {
	if (!Array.isArray(messages)) throw new Error("El historial de la sesión no es válido.");
	return messages.map((message) => {
		if (!message || typeof message !== "object" || Array.isArray(message)) return null;
		const item = message as Record<string, unknown>;
		const safe: Record<string, unknown> = {};
		for (const key of ["id", "role", "timestamp", "isError", "stopReason", "clientMessageId", "deliveryId"])
			if (typeof item[key] === "string" || typeof item[key] === "boolean") safe[key] = item[key];
		if (item.provenance && typeof item.provenance === "object" && !Array.isArray(item.provenance)) {
			const source = item.provenance as Record<string, unknown>;
			if (source.kind === "subagent" || source.kind === "session") safe.provenance = {
				kind: source.kind, ...(typeof source.label === "string" ? { label: source.label } : {}),
			};
		}
		if (typeof item.content === "string") return { ...safe, content: [{ type: "text", text: item.content }] };
		if (!Array.isArray(item.content)) return { ...safe, content: [{ type: "text", text: "[Contenido adjunto no disponible en esta vista]" }] };
		return { ...safe, content: item.content.map((block: unknown) => {
			if (block && typeof block === "object" && !Array.isArray(block)) {
				const part = block as Record<string, unknown>;
				if (part.type === "text" && typeof part.text === "string") return { type: "text", text: part.text };
				if (part.type === "image") return { type: "text", text: "[Imagen adjunta no disponible en esta vista]" };
			}
			return { type: "text", text: "[Contenido adjunto no disponible en esta vista]" };
		}) };
	});
}
