import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { CAPRI_PERSONA } from "@gentle-dot/theme-capri/persona";

export { CAPRI_PERSONA } from "@gentle-dot/theme-capri/persona";

export function registerTerminalMoodTool(
	pi: ExtensionAPI,
	apply: (input: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>,
) {
	pi.registerTool({
		name: "set_terminal_mood",
		label: "Ambiente de terminal",
		description:
			"Change or restore the colors of one live session's Kitty window when the person requests it. First obtain the exact paneId from the session list. Presets: hacker (Hacker), afterlife (Afterlife), sunset (Atardecer), restore (Restaurar). This affects the entire Kitty window, including sessions sharing it, and never injects terminal input. If the backend reports SHARED_WINDOW, explain the scope and obtain explicit permission for that whole window before using allowSharedWindow:true. Never enable remote control, edit Kitty config or restart sessions as a workaround. Report success only when verified:true; unavailable or uncertain outcomes are not success.",
		parameters: {
			type: "object",
			properties: {
				paneId: {
					type: "string",
					minLength: 1,
					maxLength: 256,
					description: "Exact paneId from the connected sessions list",
				},
				mood: { type: "string", enum: ["hacker", "afterlife", "sunset", "restore"] },
				allowSharedWindow: {
					type: "boolean",
					description: "True only after the person explicitly authorizes recoloring the entire shared window",
				},
			},
			required: ["paneId", "mood"],
			additionalProperties: false,
		},
		async execute(_id, params, signal) {
			if (!params || typeof params !== "object" || Array.isArray(params))
				throw new Error("Elige una sesión y un ambiente.");
			const input = params as Record<string, unknown>;
			if (
				typeof input.paneId !== "string" ||
				!input.paneId.trim() ||
				input.paneId.length > 256 ||
				input.paneId.includes("\0") ||
				!["hacker", "afterlife", "sunset", "restore"].includes(input.mood as string) ||
				Object.keys(input).some((key) => !["paneId", "mood", "allowSharedWindow"].includes(key)) ||
				(input.allowSharedWindow !== undefined && typeof input.allowSharedWindow !== "boolean")
			)
				throw new Error("La solicitud de ambiente no es válida.");
			const result = await apply(input, signal);
			if (!result || typeof result !== "object" || !("verified" in result) || result.verified !== true)
				throw new Error("La terminal no confirmó el ambiente.");
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
		},
	});
}

/** Dot alone loads this extension. Read the current preference at each turn, without restarting sessions. */
export default function dotCompanion(pi: ExtensionAPI): void {
	const url = process.env.GENTLE_DOT_COMPANION_URL;
	const key = process.env.GENTLE_DOT_COMPANION_KEY;
	if (!url || !key) return;
	registerTerminalMoodTool(pi, async (input, signal) => {
		const response = await fetch(url, {
			method: "POST",
			redirect: "error",
			headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
			body: JSON.stringify(input),
			signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
		});
		const result = (await response.json()) as { error?: string; code?: string };
		if (!response.ok)
			throw new Error(
				`${result.code ? `${result.code}: ` : ""}${result.error || "No se pudo cambiar el ambiente."}`,
			);
		return result;
	});
	pi.on("before_agent_start", async (event) => {
		try {
			const response = await fetch(url, {
				headers: { Authorization: `Bearer ${key}` },
				signal: AbortSignal.timeout(1500),
			});
			if (!response.ok) return;
			const preference = (await response.json()) as { mode?: unknown };
			// The Claude bridge forwards mutable options rather than returned full prompts.
			const base = event.systemPromptOptions.appendSystemPrompt.replace(CAPRI_PERSONA, "");
			event.systemPromptOptions.appendSystemPrompt =
				preference.mode === "capri" ? `${base}${CAPRI_PERSONA}` : base;
		} catch {
			/* A decoration must never prevent the assistant from answering. */
		}
	});
}
