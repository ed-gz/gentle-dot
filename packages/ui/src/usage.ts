import type { ConnectionInfo } from "./client.ts";
import { uploadBase } from "./uploads.ts";

export interface UsageWindow {
	id: string;
	label: string;
	usedPercent: number;
	remainingPercent: number;
	windowDurationMins?: number;
	resetAt?: string;
}
export interface UsageCredits {
	balance?: number;
	unlimited?: boolean;
	hasCredits?: boolean;
}
export interface UsageResetCredits {
	availableCount: number;
	credits: Array<{ expiresAt?: string; state: "available" | "unavailable" | "expired" | "used" }>;
}
export interface ProviderUsage {
	id: "codex" | "claude";
	label: string;
	status: "ok" | "unavailable" | "unauthenticated" | "expired" | "error";
	checkedAt: string;
	plan?: string;
	credits?: UsageCredits;
	resetCredits?: UsageResetCredits;
	stale?: boolean;
	error?: string;
	windows: UsageWindow[];
}
export interface UsageSnapshot {
	providers: ProviderUsage[];
	refreshAt?: string;
}
export interface UsageClient {
	read(signal?: AbortSignal): Promise<UsageSnapshot>;
}
const record = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);
const short = (value: unknown, max = 160): value is string =>
	typeof value === "string" && value.length <= max;
const date = (value: unknown): value is string => short(value, 64) && Number.isFinite(Date.parse(value));

/** Validate percentages instead of turning an absent or malformed quota into zero usage. */
export function parseUsage(value: unknown): UsageSnapshot {
	if (
		!record(value) ||
		(value.refreshAt !== undefined && !date(value.refreshAt)) ||
		!Array.isArray(value.providers) ||
		value.providers.length !== 2 ||
		new Set(value.providers.filter(record).map((provider) => provider.id)).size !== 2 ||
		value.providers.some(
			(provider) =>
				!record(provider) ||
				!["codex", "claude"].includes(String(provider.id)) ||
				!short(provider.label) ||
				!["ok", "unavailable", "unauthenticated", "expired", "error"].includes(String(provider.status)) ||
				!date(provider.checkedAt) ||
				(provider.plan !== undefined && !short(provider.plan)) ||
				(provider.credits !== undefined &&
					(!record(provider.credits) ||
						(provider.credits.balance !== undefined &&
							(typeof provider.credits.balance !== "number" ||
								!Number.isFinite(provider.credits.balance) ||
								provider.credits.balance < 0)) ||
						(provider.credits.unlimited !== undefined && typeof provider.credits.unlimited !== "boolean") ||
						(provider.credits.hasCredits !== undefined &&
							typeof provider.credits.hasCredits !== "boolean"))) ||
				(provider.resetCredits !== undefined &&
					(!record(provider.resetCredits) ||
						!Number.isSafeInteger(provider.resetCredits.availableCount) ||
						typeof provider.resetCredits.availableCount !== "number" ||
						provider.resetCredits.availableCount < 0 ||
						!Array.isArray(provider.resetCredits.credits) ||
						provider.resetCredits.credits.length > 64 ||
						provider.resetCredits.credits.some(
							(credit) =>
								!record(credit) ||
								!["available", "unavailable", "expired", "used"].includes(String(credit.state)) ||
								(credit.expiresAt !== undefined && !date(credit.expiresAt)),
						))) ||
				(provider.stale !== undefined && typeof provider.stale !== "boolean") ||
				(provider.error !== undefined && !short(provider.error, 1000)) ||
				!Array.isArray(provider.windows) ||
				provider.windows.length > 12 ||
				provider.windows.some(
					(window) =>
						!record(window) ||
						!short(window.id) ||
						!short(window.label) ||
						typeof window.usedPercent !== "number" ||
						!Number.isFinite(window.usedPercent) ||
						window.usedPercent < 0 ||
						window.usedPercent > 100 ||
						typeof window.remainingPercent !== "number" ||
						!Number.isFinite(window.remainingPercent) ||
						Math.abs(window.usedPercent + window.remainingPercent - 100) > 0.01 ||
						(window.windowDurationMins !== undefined &&
							(typeof window.windowDurationMins !== "number" ||
								!Number.isFinite(window.windowDurationMins) ||
								window.windowDurationMins <= 0)) ||
						(window.resetAt !== undefined && !date(window.resetAt)),
				),
		)
	)
		throw new Error("El equipo devolvió datos de consumo no válidos. Vuelve a consultar.");
	return value as unknown as UsageSnapshot;
}

export function createUsageClient(info: ConnectionInfo): UsageClient {
	const endpoint = `${uploadBase(info.url)}/api/mobile/usage`;
	return {
		async read(signal) {
			const response = await fetch(endpoint, {
				headers: { Authorization: `Bearer ${info.token}` },
				credentials: "omit",
				redirect: "error",
				cache: "no-store",
				signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(25_000)]) : AbortSignal.timeout(25_000),
			});
			if (response.status === 401 || response.status === 403)
				throw new Error("El acceso del teléfono ya no está autorizado. Revisa la conexión con tu equipo.");
			if (response.status === 503)
				throw new Error("El consumo de suscripciones sólo está disponible desde tu equipo local.");
			if (!response.ok)
				throw new Error("No se pudo consultar el consumo. Comprueba la conexión con tu equipo.");
			return parseUsage(await response.json());
		},
	};
}
