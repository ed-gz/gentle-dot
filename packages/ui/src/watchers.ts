import type { ConnectionInfo } from "./client.ts";
import { uploadBase } from "./uploads.ts";

export interface WatchStatus {
	id: string;
	source:
		| { kind: "agents"; sessions?: { paneId: string; sessionId: string }[] }
		| { kind: "email"; connectorId: string };
	instruction: string;
	state: "active" | "paused";
	createdAt: string;
	updatedAt: string;
	pending: number;
	lastEventAt?: string;
	lastCheckedAt?: string;
	lastError?: string;
	nextPollAt?: string;
	intervalMs?: number;
}
export interface WatchSourceOption {
	id: string;
	kind: "agents" | "email";
	label: string;
	available: boolean;
	configured?: boolean;
	error?: string;
}
export interface WatchSessionOption {
	paneId: string;
	sessionId: string;
	label: string;
}
export interface WatchersSnapshot {
	sources?: WatchSourceOption[];
	sessions?: WatchSessionOption[];
	watches: WatchStatus[];
	pending: number;
	error?: string;
}
export type WatchersAction =
	| { action: "pause" | "resume" | "delete"; watchId: string }
	| { action: "start"; source: WatchStatus["source"]; instruction: string; intervalMs?: number };
export interface WatchersClient {
	read(signal?: AbortSignal): Promise<WatchersSnapshot>;
	setup?(signal?: AbortSignal): Promise<WatchersSnapshot>;
	control(action: WatchersAction, signal?: AbortSignal): Promise<void>;
}
const record = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max = 8000): value is string =>
	typeof value === "string" && value.trim().length > 0 && value.length <= max;
const date = (value: unknown) => text(value, 64) && Number.isFinite(Date.parse(value));
const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;

export function parseWatchers(value: unknown): WatchersSnapshot {
	if (
		!record(value) ||
		!Array.isArray(value.watches) ||
		value.watches.length > 100 ||
		!count(value.pending) ||
		(value.sources !== undefined &&
			(!Array.isArray(value.sources) ||
				value.sources.length > 32 ||
				value.sources.some(
					(source) =>
						!record(source) ||
						!text(source.id, 512) ||
						!text(source.label, 512) ||
						!["agents", "email"].includes(String(source.kind)) ||
						typeof source.available !== "boolean" ||
						(source.configured !== undefined && typeof source.configured !== "boolean") ||
						(source.error !== undefined && !text(source.error)),
				))) ||
		(value.sessions !== undefined &&
			(!Array.isArray(value.sessions) ||
				value.sessions.length > 256 ||
				value.sessions.some(
					(session) =>
						!record(session) ||
						!text(session.paneId, 512) ||
						!text(session.sessionId, 512) ||
						!text(session.label, 512),
				))) ||
		(value.error !== undefined && !text(value.error)) ||
		value.watches.some((watch) => {
			if (
				!record(watch) ||
				!text(watch.id, 256) ||
				!text(watch.instruction, 16_000) ||
				!["active", "paused"].includes(String(watch.state)) ||
				!count(watch.pending) ||
				(watch.intervalMs !== undefined &&
					(!Number.isSafeInteger(watch.intervalMs) ||
						Number(watch.intervalMs) < 60_000 ||
						Number(watch.intervalMs) > 3_600_000)) ||
				!date(watch.createdAt) ||
				!date(watch.updatedAt) ||
				["lastEventAt", "lastCheckedAt", "nextPollAt"].some(
					(key) => watch[key] !== undefined && !date(watch[key]),
				) ||
				(watch.lastError !== undefined && !text(watch.lastError)) ||
				!record(watch.source)
			)
				return true;
			if (watch.source.kind === "email") return !text(watch.source.connectorId, 512);
			if (watch.source.kind !== "agents") return true;
			const sessions = watch.source.sessions;
			return (
				sessions !== undefined &&
				(!Array.isArray(sessions) ||
					sessions.length > 32 ||
					sessions.some(
						(session) => !record(session) || !text(session.paneId, 512) || !text(session.sessionId, 512),
					))
			);
		}) ||
		new Set(value.watches.map((watch) => watch.id)).size !== value.watches.length
	)
		throw new Error("No se pudo leer el estado de Dot 24/7. Vuelve a consultar.");
	return value as unknown as WatchersSnapshot;
}

export function createWatchersClient(info: ConnectionInfo): WatchersClient {
	const endpoint = `${uploadBase(info.url)}/api/mobile/watchers`;
	const request = async (action?: WatchersAction, signal?: AbortSignal, setup = false) => {
		const response = await fetch(setup ? `${endpoint}?setup=1` : endpoint, {
			...(action ? { method: "POST", body: JSON.stringify(action) } : {}),
			headers: {
				Authorization: `Bearer ${info.token}`,
				...(action ? { "Content-Type": "application/json" } : {}),
			},
			credentials: "omit",
			redirect: "error",
			cache: "no-store",
			signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
		});
		if (response.status === 401 || response.status === 403)
			throw new Error("El acceso ya no está autorizado. Revisa la conexión con tu equipo.");
		if (response.status === 404 || response.status === 503)
			throw new Error("Dot 24/7 no está disponible en este equipo.");
		if (response.status === 400 || response.status === 409) {
			const detail: unknown = await response.json().catch(() => undefined);
			if (record(detail) && text(detail.error, 1000)) throw new Error(detail.error);
		}
		if (!response.ok) throw new Error("No se pudo confirmar el estado. Comprueba la conexión con tu equipo.");
		return response;
	};
	return {
		async read(signal) {
			return parseWatchers(await (await request(undefined, signal)).json());
		},
		async setup(signal) {
			return parseWatchers(await (await request(undefined, signal, true)).json());
		},
		async control(action, signal) {
			await request(action, signal);
		},
	};
}
