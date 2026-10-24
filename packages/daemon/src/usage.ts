/** Read-only subscription quotas using the same provider endpoints as Orca.
 * Existing CLI credentials take precedence over Pi. Never launches a CLI, logs a
 * credential, follows redirects, refreshes OAuth, or consumes reset credits.
 */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type UsageProviderId = "codex" | "claude";
export type UsageStatus = "ok" | "unavailable" | "unauthenticated" | "expired" | "error";
export interface UsageWindow {
	id: string;
	label: string;
	usedPercent: number;
	remainingPercent: number;
	resetAt?: string;
	windowDurationMins?: number;
}
export interface ProviderUsage {
	id: UsageProviderId;
	label: string;
	status: UsageStatus;
	plan?: string;
	checkedAt: string;
	stale?: boolean;
	error?: string;
	windows: UsageWindow[];
	/** Provider-reported Codex credit units, independent of quotas and reset credits. */
	credits?: { balance?: number; unlimited?: boolean; hasCredits?: boolean };
	resetCredits?: {
		availableCount: number;
		credits: Array<{ expiresAt?: string; state: "available" | "unavailable" | "expired" | "used" }>;
	};
}
export interface UsageSnapshot {
	providers: ProviderUsage[];
	/** Earliest time a read can contact providers again; manual refresh shares this cooldown. */
	refreshAt?: string;
}
export interface SubscriptionUsageOptions {
	env?: NodeJS.ProcessEnv;
	homeDir?: string;
	agentHome?: string;
	fetch?: typeof fetch;
	now?: () => number;
	cacheMs?: number;
	timeoutMs?: number;
}
type JsonObject = Record<string, unknown>;
interface Credential {
	token: string;
	account?: string;
	plan?: string;
	expiresAt?: number;
	fingerprint: string;
}
interface LastGood {
	fingerprint: string;
	at: number;
	usage: ProviderUsage;
}
const MAX_JSON_BYTES = 256 * 1024;
const MAX_WINDOWS = 12;
const STALE_MS = 15 * 60_000;
const ENDPOINTS = {
	codex: "https://chatgpt.com/backend-api/wham/usage",
	claude: "https://api.anthropic.com/api/oauth/usage",
	codexResets: "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
} as const;
const LABELS = { codex: "Codex", claude: "Claude" } as const;
class UsageFailure extends Error {
	readonly status: UsageStatus;
	constructor(status: UsageStatus, message: string) {
		super(message);
		this.status = status;
	}
}
function object(value: unknown): JsonObject {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}
function finite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}
function header(value: unknown): string | undefined {
	return typeof value === "string" && /^[\x21-\x7e]{1,32768}$/.test(value) ? value : undefined;
}
function plan(value: unknown): string | undefined {
	// Fixed vocabulary: provider responses and JWT fields must never echo arbitrary text.
	if (typeof value !== "string") return undefined;
	const known: Record<string, string> = {
		free: "Free",
		plus: "Plus",
		pro: "Pro",
		team: "Team",
		business: "Business",
		enterprise: "Enterprise",
		edu: "Edu",
		max: "Max",
		claude_pro: "Pro",
		claude_max: "Max",
	};
	const key = value.toLowerCase();
	return Object.hasOwn(known, key) ? known[key] : undefined;
}
function jwt(token: string): JsonObject {
	try {
		const part = token.split(".")[1];
		return part ? object(JSON.parse(Buffer.from(part, "base64url").toString("utf8"))) : {};
	} catch {
		return {};
	}
}
function readJson(path: string): JsonObject | undefined {
	let file: number | undefined;
	try {
		// NONBLOCK also makes a substituted FIFO fail safely without hanging the daemon.
		file = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
		const stat = fstatSync(file);
		if (!stat.isFile() || stat.size > MAX_JSON_BYTES) throw new Error();
		const bytes = Buffer.alloc(MAX_JSON_BYTES + 1);
		let size = 0;
		while (size < bytes.length) {
			const read = readSync(file, bytes, size, bytes.length - size, null);
			if (read === 0) break;
			size += read;
		}
		if (size > MAX_JSON_BYTES) throw new Error();
		return object(JSON.parse(bytes.subarray(0, size).toString("utf8")));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new UsageFailure("error", "No se pudo leer la sesión local de forma segura.");
	} finally {
		if (file !== undefined) closeSync(file);
	}
}
function credential(
	id: UsageProviderId,
	source: string,
	tokenValue: unknown,
	expiresValue?: unknown,
	accountValue?: unknown,
	planValue?: unknown,
): Credential | undefined {
	const token = header(tokenValue);
	if (!token) return undefined;
	const claims = jwt(token);
	const auth = object(claims["https://api.openai.com/auth"]);
	const account = id === "codex" ? header(accountValue ?? auth.chatgpt_account_id) : undefined;
	const expiries = [expiresValue, finite(claims.exp) ? claims.exp * 1000 : undefined].filter(finite);
	return {
		token,
		account,
		plan: plan(planValue ?? auth.chatgpt_plan_type),
		expiresAt: expiries.length ? Math.min(...expiries) : undefined,
		fingerprint: createHash("sha256")
			.update(JSON.stringify([source, token, account]))
			.digest("hex"),
	};
}
function resetAt(value: unknown, seconds = false): string | undefined {
	const ms = finite(value)
		? value * (seconds ? 1000 : 1)
		: typeof value === "string"
			? Date.parse(value)
			: NaN;
	if (!Number.isFinite(ms) || ms <= 0 || ms > 8.64e15) return undefined;
	return new Date(ms).toISOString();
}
function windowLabel(minutes: number | undefined, fallback: string): string {
	if (minutes === 300) return "Sesión · 5 horas";
	if (minutes === 10080) return "Semana · 7 días";
	if (minutes && minutes % 60 === 0) return `${minutes / 60} horas`;
	return minutes ? `${minutes} minutos` : fallback;
}
function quota(
	id: string,
	label: string,
	used: unknown,
	reset: unknown,
	minutes?: number,
	seconds = false,
): UsageWindow | undefined {
	if (!finite(used) || used < 0 || used > 100) return undefined;
	return {
		id,
		label,
		usedPercent: used,
		remainingPercent: 100 - used,
		resetAt: resetAt(reset, seconds),
		windowDurationMins: minutes,
	};
}
function codexRateWindows(value: unknown, prefix = "", label?: string): UsageWindow[] {
	const limits = object(value);
	const result: UsageWindow[] = [];
	for (const [key, fallback] of [
		["primary_window", "Ventana principal"],
		["secondary_window", "Ventana secundaria"],
	] as const) {
		const value = object(limits[key]);
		const seconds = value.limit_window_seconds;
		const minutes = finite(seconds) && seconds > 0 && seconds <= 366 * 86400 ? seconds / 60 : undefined;
		const item = quota(
			`${prefix}${key}`,
			[label, windowLabel(minutes, fallback)].filter(Boolean).join(" · "),
			value.used_percent,
			value.reset_at,
			minutes,
			true,
		);
		if (item) result.push(item);
	}
	return result;
}
function limitName(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 && value.length <= 128
		? value.trim().toLowerCase()
		: undefined;
}
function limitId(name: string): string {
	// Unknown provider labels are never echoed into the mobile UI or identifier.
	return createHash("sha256").update(name).digest("hex").slice(0, 16);
}
function codexWindows(data: JsonObject): UsageWindow[] {
	const result = [
		...codexRateWindows(data.rate_limit),
		...codexRateWindows(data.code_review_rate_limit, "code_review_", "Revisión de código"),
	];
	const seen = new Set<string>();
	const additional = Array.isArray(data.additional_rate_limits) ? data.additional_rate_limits : [];
	for (const entry of additional.slice(0, 32)) {
		if (result.length >= MAX_WINDOWS) break;
		const limit = object(entry);
		const name = limitName(limit.metered_feature) ?? limitName(limit.limit_name);
		if (!name) continue;
		const spark = [limitName(limit.metered_feature), limitName(limit.limit_name)].some(
			(value) => value !== undefined && ["codex_spark", "codex-spark", "gpt-5.3-codex-spark"].includes(value),
		);
		const id = spark ? "codex_spark" : limitId(name);
		if (seen.has(id)) continue;
		const windows = codexRateWindows(
			limit.rate_limit,
			`additional_${id}_`,
			spark ? "Codex Spark" : "Límite adicional",
		);
		if (!windows.length) continue;
		seen.add(id);
		result.push(...windows);
	}
	return result.slice(0, MAX_WINDOWS);
}
function codexCredits(data: JsonObject): ProviderUsage["credits"] {
	const value = object(data.credits);
	const balance =
		typeof value.balance === "string" &&
		value.balance.length <= 32 &&
		/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value.balance)
			? Number(value.balance)
			: value.balance;
	const credits: NonNullable<ProviderUsage["credits"]> = {};
	if (finite(balance) && balance >= 0 && balance <= Number.MAX_SAFE_INTEGER) credits.balance = balance;
	if (typeof value.unlimited === "boolean") credits.unlimited = value.unlimited;
	if (typeof value.has_credits === "boolean") credits.hasCredits = value.has_credits;
	return Object.keys(credits).length ? credits : undefined;
}
function codexResetCredits(data: JsonObject, now: number): ProviderUsage["resetCredits"] {
	if (
		!Number.isSafeInteger(data.available_count) ||
		!finite(data.available_count) ||
		data.available_count < 0 ||
		!Array.isArray(data.credits) ||
		data.credits.length > 64
	)
		return undefined;
	const ids = new Set<string>();
	const credits: NonNullable<ProviderUsage["resetCredits"]>["credits"] = [];
	let reportedAvailable = 0;
	let expiredAvailable = 0;
	for (const raw of data.credits) {
		const credit = object(raw);
		if (
			typeof credit.id !== "string" ||
			!credit.id.trim() ||
			credit.id.length > 256 ||
			ids.has(credit.id) ||
			credit.reset_type !== "codex_rate_limits" ||
			typeof credit.status !== "string" ||
			!credit.status ||
			credit.status.length > 64
		)
			return undefined;
		ids.add(credit.id);
		const expiresAt = typeof credit.expires_at === "string" ? resetAt(credit.expires_at) : undefined;
		if (credit.expires_at != null && !expiresAt) return undefined;
		let state: (typeof credits)[number]["state"] = "unavailable";
		if (credit.status === "available") {
			reportedAvailable++;
			if (expiresAt && Date.parse(expiresAt) <= now) {
				state = "expired";
				expiredAvailable++;
			} else state = "available";
		} else if (credit.status === "expired") state = "expired";
		else if (credit.status === "redeemed" || credit.status === "used") state = "used";
		credits.push({ ...(expiresAt ? { expiresAt } : {}), state });
	}
	// A mismatched or partial inventory must not masquerade as a complete reset balance.
	if (reportedAvailable !== data.available_count) return undefined;
	return { availableCount: data.available_count - expiredAvailable, credits };
}
function claudeWindows(data: JsonObject): UsageWindow[] {
	const result: UsageWindow[] = [];
	for (const [key, label, minutes] of [
		["five_hour", "Sesión · 5 horas", 300],
		["seven_day", "Semana · 7 días", 10080],
		["seven_day_opus", "Opus · 7 días", 10080],
		["seven_day_sonnet", "Sonnet · 7 días", 10080],
		["seven_day_oauth_apps", "Aplicaciones OAuth · 7 días", 10080],
		["seven_day_cowork", "Cowork · 7 días", 10080],
	] as const) {
		const value = object(data[key]);
		const item = quota(key, label, value.utilization ?? value.used_percentage, value.resets_at, minutes);
		if (item) result.push(item);
	}
	const limits = Array.isArray(data.limits) ? data.limits : [];
	for (const entry of limits.slice(0, 32)) {
		if (result.length >= MAX_WINDOWS) break;
		const limit = object(entry);
		if (
			limit.kind !== "weekly_scoped" ||
			(limit.group !== undefined && limit.group !== "weekly") ||
			(limit.is_active !== undefined && limit.is_active !== true)
		)
			continue;
		const model = object(object(limit.scope).model);
		const name = limitName(model.id) ?? limitName(model.display_name);
		if (!name || ["all", "all models", "all_models", "all-models"].includes(name)) continue;
		const known = [limitName(model.id), limitName(model.display_name)]
			.flatMap((name) => (name ? [name] : []))
			.flatMap((name) => {
				const match = /^(?:claude[ -])?(fable|sonnet|opus)(?: only|-[a-z0-9-]+)?$/.exec(name);
				return match?.[1] ? [match[1]] : [];
			})[0];
		const id = known ? `seven_day_${known}` : `claude_weekly_${limitId(name)}`;
		if (result.some((window) => window.id === id)) continue;
		const label = known
			? `${known[0]?.toUpperCase()}${known.slice(1)} · 7 días`
			: "Modelo adicional · 7 días";
		const item = quota(id, label, limit.percent, limit.resets_at, 10080);
		if (item) result.push(item);
	}
	return result;
}
async function responseJson(response: Response): Promise<JsonObject> {
	const size = response.headers.get("content-length");
	if (size !== null && (!/^\d+$/.test(size) || Number(size) > MAX_JSON_BYTES)) {
		await response.body?.cancel();
		throw new UsageFailure("error", "El proveedor devolvió una respuesta de uso no válida.");
	}
	const reader = response.body?.getReader();
	if (!reader) throw new Error();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > MAX_JSON_BYTES) throw new Error();
			chunks.push(value);
		}
		return object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

/** Lazy, bounded and coalesced: a settings refresh cannot bypass the provider cache. */
export class SubscriptionUsage {
	private readonly env: NodeJS.ProcessEnv;
	private readonly home: string;
	private readonly agentHomes: string[];
	private readonly request: typeof fetch;
	private readonly now: () => number;
	private readonly cacheMs: number;
	private readonly timeoutMs: number;
	private cached?: UsageSnapshot;
	private nextRead = 0;
	private pending?: Promise<UsageSnapshot>;
	private readonly good = new Map<UsageProviderId, LastGood>();

	constructor(options: SubscriptionUsageOptions = {}) {
		this.env = { ...(options.env ?? process.env) };
		this.home = options.homeDir ?? homedir();
		this.agentHomes = [
			...new Set(
				[options.agentHome, this.env.PI_CODING_AGENT_DIR, join(this.home, ".pi", "agent")].filter(
					(value): value is string => Boolean(value),
				),
			),
		];
		this.request = options.fetch ?? fetch;
		this.now = options.now ?? Date.now;
		this.cacheMs = options.cacheMs ?? 60_000;
		this.timeoutMs = options.timeoutMs ?? 10_000;
	}

	async read(): Promise<UsageSnapshot> {
		if (this.cached && this.now() < this.nextRead) return structuredClone(this.cached);
		if (!this.pending) {
			this.pending = Promise.all([this.provider("codex"), this.provider("claude")])
				.then((providers) => {
					this.nextRead = this.now() + this.cacheMs;
					this.cached = { providers, refreshAt: new Date(this.nextRead).toISOString() };
					return this.cached;
				})
				.finally(() => {
					this.pending = undefined;
				});
		}
		return structuredClone(await this.pending);
	}

	private credentials(id: UsageProviderId): Credential {
		const explicit = id === "codex" ? this.env.CODEX_HOME : this.env.CLAUDE_CONFIG_DIR;
		const path = join(
			explicit || join(this.home, id === "codex" ? ".codex" : ".claude"),
			id === "codex" ? "auth.json" : ".credentials.json",
		);
		const data = readJson(path);
		if (data) {
			const value = object(id === "codex" ? data.tokens : data.claudeAiOauth);
			const found =
				id === "codex"
					? credential(id, path, value.access_token, undefined, value.account_id)
					: credential(id, path, value.accessToken, value.expiresAt, undefined, value.subscriptionType);
			if (found) return found;
			if (data.OPENAI_API_KEY || data.apiKey)
				throw new UsageFailure(
					"unavailable",
					"La cuenta local usa una clave API; no ofrece cuotas de suscripción.",
				);
			throw new UsageFailure(
				"unauthenticated",
				`La sesión local de ${LABELS[id]} no contiene un acceso válido. Inicia sesión de nuevo en el equipo.`,
			);
		}
		// An explicit profile is authoritative. Do not silently show another account.
		if (!explicit) {
			for (const home of this.agentHomes) {
				const file = join(home, "auth.json");
				const auth = readJson(file);
				if (!auth) continue;
				const keys = id === "codex" ? ["openai-codex", "openai"] : ["anthropic"];
				for (const key of keys) {
					const value = object(auth[key]);
					if (value.type === "oauth") {
						const found = credential(id, file, value.access, value.expires, value.accountId);
						if (found) return found;
					} else if (value.type === "api_key") {
						throw new UsageFailure(
							"unavailable",
							"La cuenta de Pi usa una clave API; no ofrece cuotas de suscripción.",
						);
					}
				}
			}
		}
		throw new UsageFailure(
			"unauthenticated",
			`No hay una sesión local de ${LABELS[id]} disponible. Inicia sesión en su aplicación del equipo.`,
		);
	}
	private async resets(
		headers: Record<string, string>,
		parent: AbortSignal,
	): Promise<ProviderUsage["resetCredits"]> {
		const controller = new AbortController();
		const signal = AbortSignal.any([parent, controller.signal]);
		let timer: ReturnType<typeof setTimeout> | undefined;
		let cancel: (() => void) | undefined;
		const deadline = new Promise<undefined>((resolve) => {
			cancel = () => resolve(undefined);
			if (parent.aborted) cancel();
			else parent.addEventListener("abort", cancel, { once: true });
			// Optional enrichment cannot use the entire primary request's budget.
			timer = setTimeout(() => resolve(undefined), Math.min(4000, this.timeoutMs / 2));
		});
		try {
			return await Promise.race([
				deadline,
				(async () => {
					if (signal.aborted) return undefined;
					const response = await this.request(ENDPOINTS.codexResets, {
						method: "GET",
						headers,
						redirect: "error",
						signal,
					});
					if (!response.ok) {
						await response.body?.cancel();
						return undefined;
					}
					const data = await responseJson(response);
					return signal.aborted ? undefined : codexResetCredits(data, this.now());
				})().catch(() => undefined),
			]);
		} finally {
			clearTimeout(timer);
			if (cancel) parent.removeEventListener("abort", cancel);
			controller.abort();
		}
	}

	private async provider(id: UsageProviderId): Promise<ProviderUsage> {
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		let identity: string | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				controller.abort();
				reject(
					new UsageFailure("error", "La consulta de uso tardó demasiado. Inténtalo de nuevo más tarde."),
				);
			}, this.timeoutMs);
		});
		try {
			const usage = await Promise.race([
				timeout,
				(async (): Promise<ProviderUsage> => {
					const auth = this.credentials(id);
					identity = auth.fingerprint;
					controller.signal.throwIfAborted();
					if (auth.expiresAt !== undefined && auth.expiresAt <= this.now()) {
						throw new UsageFailure(
							"expired",
							`La sesión de ${LABELS[id]} venció. Ábrelo en el equipo para iniciar sesión de nuevo.`,
						);
					}
					const headers: Record<string, string> = {
						Authorization: `Bearer ${auth.token}`,
						Accept: "application/json",
					};
					if (id === "codex") {
						headers["User-Agent"] = "codex-cli";
						headers["OpenAI-Beta"] = "codex-1";
						headers.originator = "Codex Desktop";
						if (auth.account) headers["ChatGPT-Account-Id"] = auth.account;
					} else {
						headers["anthropic-beta"] = "oauth-2025-04-20";
						headers["User-Agent"] = "claude-code/2.1.0";
					}
					const resetRequest = id === "codex" ? this.resets(headers, controller.signal) : undefined;
					const response = await this.request(ENDPOINTS[id], {
						method: "GET",
						headers,
						redirect: "error",
						signal: controller.signal,
					});
					if (!response.ok) {
						await response.body?.cancel();
						if (response.status === 401)
							throw new UsageFailure(
								"unauthenticated",
								`La sesión de ${LABELS[id]} ya no es válida. Inicia sesión de nuevo en el equipo.`,
							);
						if (response.status === 403)
							throw new UsageFailure(
								"unavailable",
								"Esta cuenta no permite consultar las cuotas de suscripción.",
							);
						throw new UsageFailure(
							"error",
							response.status === 429
								? "El proveedor limitó las consultas de uso. Inténtalo más tarde."
								: "El proveedor no pudo consultar el uso. Inténtalo más tarde.",
						);
					}
					const data = await responseJson(response);
					controller.signal.throwIfAborted();
					const windows = id === "codex" ? codexWindows(data) : claudeWindows(data);
					const credits = id === "codex" ? codexCredits(data) : undefined;
					const resetCredits = await resetRequest;
					controller.signal.throwIfAborted();
					if (!windows.length && !credits && !resetCredits?.availableCount)
						throw new UsageFailure(
							"unavailable",
							"El proveedor no devolvió porcentajes de uso de suscripción válidos.",
						);
					return {
						id,
						label: LABELS[id],
						status: "ok",
						checkedAt: new Date(this.now()).toISOString(),
						plan: plan(data.plan_type) ?? auth.plan,
						windows,
						...(credits ? { credits } : {}),
						...(resetCredits ? { resetCredits } : {}),
					};
				})(),
			]);
			this.good.set(id, { fingerprint: identity ?? "", at: this.now(), usage });
			return usage;
		} catch (error) {
			const failure =
				error instanceof UsageFailure
					? error
					: new UsageFailure(
							"error",
							"No se pudo consultar el uso. Revisa la conexión y vuelve a intentarlo.",
						);
			const good = this.good.get(id);
			if (
				failure.status === "error" &&
				identity &&
				good?.fingerprint === identity &&
				this.now() - good.at < STALE_MS
			) {
				return { ...good.usage, status: "error", stale: true, error: failure.message };
			}
			this.good.delete(id);
			return {
				id,
				label: LABELS[id],
				status: failure.status,
				checkedAt: new Date(this.now()).toISOString(),
				error: failure.message,
				windows: [],
			};
		} finally {
			clearTimeout(timer);
			controller.abort();
		}
	}
}
