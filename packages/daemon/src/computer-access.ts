import type { AppApproval } from "./app-channel.ts";

/** Only the desktop's private channel may create these previews. Never accept them from chat or HTTP. */
export function computerApproval(params: unknown): AppApproval {
	if (!params || typeof params !== "object" || Array.isArray(params))
		throw new Error("Invalid computer approval");
	const fields = params as Record<string, unknown>;
	if (
		Object.keys(fields).some((key) => key !== "kind" && key !== "message" && key !== "requestId") ||
		!["grant", "action"].includes(String(fields.kind)) ||
		typeof fields.requestId !== "string" ||
		!/^[a-f0-9]{64}$/.test(fields.requestId) ||
		typeof fields.message !== "string" ||
		!fields.message.trim() ||
		fields.message.length > 8000
	)
		throw new Error("Invalid computer approval");
	return {
		connector: "Equipo",
		action: fields.kind === "grant" ? "controlar el escritorio" : "confirmar una acción",
		title:
			fields.kind === "grant" ? "¿Permitir el control del equipo?" : "¿Permitir esta acción en el equipo?",
		summary: fields.message,
		preview: [],
	};
}

/** An explicit allowlist keeps private helper endpoints and credentials out of the mobile API. */
export function computerSnapshot(value: unknown): object {
	if (!value || typeof value !== "object") throw new Error("Invalid computer status");
	const source = value as Record<string, unknown>;
	if (typeof source.available !== "boolean" || typeof source.platform !== "string")
		throw new Error("Invalid computer status");
	const fields = (item: unknown): Record<string, unknown> =>
		item && typeof item === "object" && !Array.isArray(item) ? (item as Record<string, unknown>) : {};
	const permissions = fields(source.permissions);
	const state = fields(source.state);
	const capabilities = fields(source.capabilities);
	const strings = (item: unknown) =>
		Array.isArray(item)
			? item
					.filter((entry): entry is string => typeof entry === "string")
					.slice(0, 30)
					.map((entry) => entry.slice(0, 1000))
			: [];
	const time = (item: unknown) => (typeof item === "number" && Number.isFinite(item) ? item : undefined);
	return {
		available: source.available,
		platform: source.platform.slice(0, 40),
		permissions: {
			accessibility: permissions.accessibility === true,
			screenRecording: permissions.screenRecording === true,
			screenshotsSupported: permissions.screenshotsSupported === true,
		},
		state: {
			active: state.active === true,
			yolo: state.yolo === true,
			endsAt: time(state.endsAt),
			yoloEndsAt: time(state.yoloEndsAt),
		},
		...(typeof capabilities.backend === "string"
			? {
					capabilities: {
						backend: capabilities.backend.slice(0, 80),
						supported: capabilities.supported === true,
						missingDependencies: strings(capabilities.missingDependencies),
						limitations: strings(capabilities.limitations),
					},
				}
			: {}),
	};
}
