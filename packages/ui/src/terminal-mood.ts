import type { ConnectionInfo } from "./client.ts";
import { uploadBase } from "./uploads.ts";

export type TerminalMood = "hacker" | "afterlife" | "sunset";
export interface TerminalMoodState {
	available: boolean;
	paneId: string;
	scope: "window";
	mood: TerminalMood | null;
	canRestore: boolean;
	windowId?: number;
	affectedPaneIds: string[];
	sharedWindow: boolean;
	requiresSharedConfirmation: boolean;
	reason?: string;
}
export interface TerminalMoodClient {
	status(paneId: string, signal?: AbortSignal): Promise<TerminalMoodState>;
	apply(paneId: string, mood: TerminalMood | "restore", allowSharedWindow?: true, signal?: AbortSignal): Promise<TerminalMoodState & { verified: true }>;
}
export class TerminalMoodError extends Error {
	readonly status: number;
	constructor(message: string, status: number) { super(message); this.name = "TerminalMoodError"; this.status = status; }
}
const legacyReason = "Actualiza Gentle Dot en tu equipo para cambiar el ambiente de la terminal.";
export function unavailableTerminalMood(paneId: string, reason = legacyReason): TerminalMoodState {
	return { available: false, paneId, scope: "window", mood: null, canRestore: false,
		affectedPaneIds: [], sharedWindow: false, requiresSharedConfirmation: false, reason };
}
export function parseTerminalMood(value: unknown, paneId: string): TerminalMoodState {
	const item = value as Partial<TerminalMoodState> | null;
	if (!item || typeof item !== "object" || item.paneId !== paneId || item.scope !== "window" ||
		typeof item.available !== "boolean" || typeof item.canRestore !== "boolean" ||
		typeof item.sharedWindow !== "boolean" || typeof item.requiresSharedConfirmation !== "boolean" ||
		(item.mood !== null && !["hacker", "afterlife", "sunset"].includes(String(item.mood))) ||
		!Array.isArray(item.affectedPaneIds) || item.affectedPaneIds.length > 1024 ||
		item.affectedPaneIds.some(id => typeof id !== "string" || !id || id.length > 256) ||
		(item.windowId !== undefined && (!Number.isSafeInteger(item.windowId) || item.windowId <= 0)) ||
		(item.reason !== undefined && (typeof item.reason !== "string" || item.reason.length > 2000)))
		throw new Error("El equipo devolvió un estado de ambiente no válido. Actualiza su estado antes de cambiarlo.");
	return { available: item.available, paneId, scope: "window", mood: item.mood as TerminalMood | null,
		canRestore: item.canRestore, affectedPaneIds: [...item.affectedPaneIds], sharedWindow: item.sharedWindow,
		requiresSharedConfirmation: item.requiresSharedConfirmation,
		...(item.windowId !== undefined ? { windowId: item.windowId } : {}),
		...(item.reason !== undefined ? { reason: item.reason } : {}) };
}

/** Credentials remain in the header. Window changes are never retried automatically. */
export function createTerminalMoodClient(info: ConnectionInfo): TerminalMoodClient {
	const endpoint = `${uploadBase(info.url)}/api/mobile/terminal-mood`;
	async function request(paneId: string, change: { mood: TerminalMood | "restore"; allowSharedWindow?: true } | undefined, signal?: AbortSignal) {
		const response = await fetch(change ? endpoint : `${endpoint}?${new URLSearchParams({ paneId })}`, {
			method: change ? "POST" : "GET", credentials: "omit", redirect: "error", cache: "no-store",
			headers: { Authorization: `Bearer ${info.token}`, ...(change ? { "Content-Type": "application/json" } : {}) },
			...(change ? { body: JSON.stringify({ paneId, ...change }) } : {}),
			signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
		});
		if (response.status === 404 && !change) return unavailableTerminalMood(paneId);
		const body: unknown = await response.json().catch(() => undefined);
		if (!response.ok) {
			const detail = body && typeof body === "object" && "error" in body ? body.error : undefined;
			throw new TerminalMoodError(response.status === 404 ? legacyReason : typeof detail === "string" ? detail :
				response.status === 401 ? "La conexión con el equipo necesita autenticarse de nuevo." :
				response.status === 409 ? "Cambió el alcance de la ventana. Revísalo antes de continuar." :
				"No se pudo confirmar el cambio de ambiente. Actualiza su estado antes de reintentar.", response.status);
		}
		const state = parseTerminalMood(body, paneId);
		if (change && (!body || typeof body !== "object" || !("verified" in body) || body.verified !== true ||
			!state.available || state.mood !== (change.mood === "restore" ? null : change.mood)))
			throw new Error("El equipo no confirmó el cambio de ambiente. Actualiza su estado antes de reintentar.");
		return change ? { ...state, verified: true as const } : state;
	}
	return {
		status: (paneId, signal) => request(paneId, undefined, signal),
		apply: async (paneId, mood, allowSharedWindow, signal) => await request(paneId,
			{ mood, ...(allowSharedWindow ? { allowSharedWindow: true as const } : {}) }, signal) as TerminalMoodState & { verified: true },
	};
}
