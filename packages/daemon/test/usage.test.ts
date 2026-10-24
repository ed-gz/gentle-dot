import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SubscriptionUsage, type UsageSnapshot } from "../src/usage.ts";

const START = Date.parse("2026-10-11T04:00:00.000Z");
const CODEX = "https://chatgpt.com/backend-api/wham/usage";
const CLAUDE = "https://api.anthropic.com/api/oauth/usage";
const RESETS = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
const codexReply = {
	plan_type: "pro",
	email: "private@example.com",
	rate_limit: {
		primary_window: { used_percent: 22, limit_window_seconds: 604800, reset_at: 1792295888 },
		secondary_window: null,
	},
};
const claudeReply = {
	five_hour: { utilization: 9, resets_at: "2026-10-11T08:39:59.640041+00:00" },
	seven_day: { utilization: 34, resets_at: "2026-10-15T02:59:59Z" },
	seven_day_opus: null,
	extra_usage: { used_credits: 900 },
};
const token = (exp = START / 1000 + 3600) =>
	`ey.test-${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.signature`;
const jwt = (claims: object) => `ey.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
let home: string;
let now: number;
async function json(path: string, value: unknown) {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, JSON.stringify(value), { mode: 0o600 });
}
async function codex(value = "codex-secret", overrides: object = {}) {
	await json(join(home, ".codex/auth.json"), {
		tokens: { access_token: value, account_id: "account-123", ...overrides },
	});
}
async function claude() {
	await json(join(home, ".claude/.credentials.json"), {
		claudeAiOauth: {
			accessToken: "claude-secret",
			refreshToken: "never-use-refresh",
			expiresAt: START + 3600_000,
			subscriptionType: "max",
		},
	});
}
function make(
	fetcher = vi.fn(async (url: string | URL | Request) =>
		Response.json(String(url) === CODEX ? codexReply : claudeReply),
	),
) {
	return {
		fetcher,
		service: new SubscriptionUsage({
			homeDir: home,
			env: {},
			now: () => now,
			// Existing quota tests model an account without optional reset-inventory support.
			fetch: ((url, init) =>
				String(url) === RESETS
					? Promise.resolve(new Response(null, { status: 404 }))
					: (fetcher as typeof fetch)(url, init)) as typeof fetch,
		}),
	};
}
function provider(snapshot: UsageSnapshot, id = "codex") {
	const found = snapshot.providers.find((item) => item.id === id);
	expect(found).toBeDefined();
	if (!found) throw new Error("Missing provider");
	return found;
}
beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "gentle-usage-"));
	now = START;
});
afterEach(async () => {
	vi.useRealTimers();
	await rm(home, { recursive: true, force: true });
});

describe("subscription usage", () => {
	it("is lazy, reads real quota units, and exposes no account identifiers or tokens", async () => {
		await codex();
		await claude();
		const { service, fetcher } = make();
		expect(fetcher).not.toHaveBeenCalled();
		const result = await service.read();
		expect(provider(result)).toMatchObject({
			status: "ok",
			plan: "Pro",
			windows: [
				{
					usedPercent: 22,
					remainingPercent: 78,
					windowDurationMins: 10080,
					label: "Semana · 7 días",
					resetAt: "2026-10-18T03:58:08.000Z",
				},
			],
		});
		expect(provider(result, "claude")).toMatchObject({
			status: "ok",
			plan: "Max",
			windows: [
				{ usedPercent: 9, remainingPercent: 91, windowDurationMins: 300 },
				{ usedPercent: 34, remainingPercent: 66 },
			],
		});
		expect(JSON.stringify(result)).not.toMatch(/private@example|account-123|secret|never-use-refresh/);
		expect(fetcher).toHaveBeenCalledTimes(2);
		const calls = fetcher.mock.calls as unknown as [string, RequestInit][];
		expect(calls.find(([url]) => url === CODEX)?.[1]).toMatchObject({
			method: "GET",
			redirect: "error",
			headers: { Authorization: "Bearer codex-secret", "ChatGPT-Account-Id": "account-123" },
		});
		expect(calls.find(([url]) => url === CLAUDE)?.[1]).toMatchObject({
			headers: { Authorization: "Bearer claude-secret", "anthropic-beta": "oauth-2025-04-20" },
		});
	});
	it("caches successes and failures for sixty seconds and returns defensive copies", async () => {
		await codex();
		const { service, fetcher } = make();
		const first = await service.read();
		expect(first.refreshAt).toBe(new Date(START + 60_000).toISOString());
		expect((await service.read()).refreshAt).toBe(first.refreshAt);
		const firstWindow = provider(first).windows[0];
		if (!firstWindow) throw new Error("Missing quota");
		firstWindow.usedPercent = 999;
		expect(provider(await service.read()).windows[0]?.usedPercent).toBe(22);
		now += 59_999;
		await service.read();
		expect(fetcher).toHaveBeenCalledTimes(1);
		now += 1;
		expect((await service.read()).refreshAt).toBe(new Date(START + 120_000).toISOString());
		expect(fetcher).toHaveBeenCalledTimes(2);
	});
	it("keeps independent Codex review and model windows from the existing quota response", async () => {
		await codex();
		const fetcher = vi.fn(async () =>
			Response.json({
				...codexReply,
				code_review_rate_limit: {
					primary_window: { used_percent: 15, limit_window_seconds: 604800, reset_at: 1792295888 },
				},
				additional_rate_limits: [
					null,
					{ limit_name: "codex_spark", rate_limit: { primary_window: { used_percent: "invalid" } } },
					{
						limit_name: "GPT-5.3-Codex-Spark",
						metered_feature: "codex_spark",
						rate_limit: {
							primary_window: { used_percent: 27, limit_window_seconds: 18000, reset_at: 1792295888 },
							secondary_window: { used_percent: 42, limit_window_seconds: 604800, reset_at: 1792295888 },
						},
					},
					{
						metered_feature: "codex_spark",
						rate_limit: { primary_window: { used_percent: 99 } },
					},
					{
						limit_name: "private@example.com https://private.invalid Bearer secret",
						rate_limit: { primary_window: { used_percent: 9, limit_window_seconds: 900 } },
					},
				],
			}),
		);
		const result = provider(await make(fetcher).service.read());
		expect(result.windows).toMatchObject([
			{ id: "primary_window", label: "Semana · 7 días", usedPercent: 22 },
			{ id: "code_review_primary_window", label: "Revisión de código · Semana · 7 días", usedPercent: 15 },
			{
				id: "additional_codex_spark_primary_window",
				label: "Codex Spark · Sesión · 5 horas",
				usedPercent: 27,
			},
			{
				id: "additional_codex_spark_secondary_window",
				label: "Codex Spark · Semana · 7 días",
				usedPercent: 42,
			},
			{ label: "Límite adicional · 15 minutos", usedPercent: 9 },
		]);
		expect(result.windows[2]?.resetAt).toBe("2026-10-18T03:58:08.000Z");
		expect(new Set(result.windows.map((window) => window.id)).size).toBe(5);
		expect(JSON.stringify(result)).not.toMatch(/private@example|private\.invalid|Bearer|secret/);
		expect(fetcher).toHaveBeenCalledOnce();
	});
	it("bounds extra Codex windows and ignores malformed optional groups without losing normal quotas", async () => {
		await codex();
		const extra = Array.from({ length: 40 }, (_, index) => ({
			metered_feature: `additional-model-${index}`,
			rate_limit: {
				primary_window: { used_percent: 10 },
				secondary_window: { used_percent: 20 },
			},
		}));
		const fetcher = vi.fn(async () =>
			Response.json({ ...codexReply, code_review_rate_limit: [], additional_rate_limits: extra }),
		);
		const result = provider(await make(fetcher).service.read());
		expect(result.windows).toHaveLength(12);
		expect(result.windows[0]).toMatchObject({ id: "primary_window", usedPercent: 22 });
		expect(new Set(result.windows.map((window) => window.id)).size).toBe(12);
		for (const malformed of [null, true, {}, "untrusted payload"]) {
			const read = vi.fn(async () => Response.json({ ...codexReply, additional_rate_limits: malformed }));
			expect(provider(await make(read).service.read()).windows).toHaveLength(1);
		}
	});
	it("exposes only reported Codex credit fields and preserves an explicit zero balance", async () => {
		await codex();
		for (const [raw, expected] of [
			[
				{ balance: "123.45", has_credits: true, unlimited: false },
				{ balance: 123.45, hasCredits: true, unlimited: false },
			],
			[
				{ balance: 0, has_credits: false, unlimited: false },
				{ balance: 0, hasCredits: false, unlimited: false },
			],
			[{ balance: "0.00" }, { balance: 0 }],
			[{ unlimited: true }, { unlimited: true }],
			[{ balance: null, has_credits: true }, { hasCredits: true }],
			[{ balance: "9.5", email: "private@example.com", token: "secret", reset_count: 99 }, { balance: 9.5 }],
		] as const) {
			const fetcher = vi.fn(async () => Response.json({ ...codexReply, credits: raw }));
			expect(provider(await make(fetcher).service.read()).credits).toEqual(expected);
			expect(fetcher).toHaveBeenCalledOnce();
		}
	});
	it("does not fabricate credit balances or booleans from absent or malformed provider data", async () => {
		await codex();
		for (const balance of [null, "", " ", "0x10", "1e4", "-1", -1, "NaN", "Infinity", true, [], {}, 1e30]) {
			const fetcher = vi.fn(async () =>
				Response.json({ ...codexReply, credits: { balance, has_credits: "true", unlimited: 1 } }),
			);
			expect(provider(await make(fetcher).service.read()).credits).toBeUndefined();
		}
		expect(provider(await make().service.read()).credits).toBeUndefined();
	});
	it("retains an independently reported credit balance when the account returns no percentage windows", async () => {
		await codex();
		const fetcher = vi.fn(async () => Response.json({ credits: { balance: "7.25" }, rate_limit: null }));
		expect(provider(await make(fetcher).service.read())).toMatchObject({
			status: "ok",
			windows: [],
			credits: { balance: 7.25 },
		});
	});
	it("includes active Claude model-scoped weekly quotas without duplicating existing limits", async () => {
		await claude();
		const scoped = (model: object, percent: unknown, extra: object = {}) => ({
			kind: "weekly_scoped",
			group: "weekly",
			percent,
			resets_at: "2026-10-15T02:59:59Z",
			scope: { model },
			...extra,
		});
		const fetcher = vi.fn(async () =>
			Response.json({
				...claudeReply,
				seven_day_sonnet: { utilization: 18 },
				limits: [
					scoped({ id: "fable", display_name: "Fable only" }, 83, { is_active: true }),
					scoped({ id: "fable" }, 99),
					scoped({ id: "sonnet" }, 99),
					scoped({ id: "all_models" }, 99),
					scoped({ id: "inactive" }, 99, { is_active: false }),
					scoped({ id: "invalid-active" }, 99, { is_active: "true" }),
					scoped({ id: "wrong-group" }, 99, { group: "monthly" }),
					scoped({ id: "wrong-kind" }, 99, { kind: "daily_scoped" }),
					scoped({ id: "invalid-percent" }, "99"),
					scoped({ id: "private@example.com", display_name: "Bearer secret" }, 16),
					scoped({}, 99),
					null,
				],
			}),
		);
		const result = provider(await make(fetcher).service.read(), "claude");
		expect(result.windows).toHaveLength(5);
		expect(result.windows[2]).toMatchObject({ id: "seven_day_sonnet", usedPercent: 18 });
		expect(result.windows[3]).toMatchObject({
			id: "seven_day_fable",
			label: "Fable · 7 días",
			usedPercent: 83,
			remainingPercent: 17,
			windowDurationMins: 10080,
			resetAt: "2026-10-15T02:59:59.000Z",
		});
		expect(result.windows[4]).toMatchObject({ label: "Modelo adicional · 7 días", usedPercent: 16 });
		expect(JSON.stringify(result)).not.toMatch(/private@example|Bearer|secret/);
		expect(fetcher).toHaveBeenCalledOnce();
	});
	it("keeps credit cache defensive and never carries it across account changes", async () => {
		await codex();
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(Response.json({ ...codexReply, credits: { balance: 25 } }))
			.mockRejectedValue(new Error("Temporary network issue"));
		const { service } = make(fetcher);
		const first = provider(await service.read());
		if (!first.credits) throw new Error("Missing fixture credits");
		first.credits.balance = 999;
		now += 61_000;
		expect(provider(await service.read())).toMatchObject({ stale: true, credits: { balance: 25 } });
		await codex("different-account");
		now += 61_000;
		expect(provider(await service.read()).credits).toBeUndefined();
	});
	it("loads reset inventory alongside quotas with the same account and shares its refresh cache", async () => {
		await codex();
		let finishUsage!: (response: Response) => void;
		let finishResets!: (response: Response) => void;
		const fetcher = vi.fn(
			(url: string | URL | Request) =>
				new Promise<Response>((resolve) => {
					if (String(url) === RESETS) finishResets = resolve;
					else if (String(url) === CODEX) finishUsage = resolve;
					else throw new Error("Unexpected endpoint");
				}),
		);
		const service = new SubscriptionUsage({
			homeDir: home,
			env: {},
			now: () => now,
			fetch: fetcher as typeof fetch,
		});
		const reads = [service.read(), service.read(), service.read()];
		await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
		const calls = fetcher.mock.calls as unknown as [string, RequestInit][];
		for (const [url, init] of calls) {
			expect([CODEX, RESETS]).toContain(url);
			expect(init).toMatchObject({
				method: "GET",
				redirect: "error",
				headers: {
					Authorization: "Bearer codex-secret",
					"ChatGPT-Account-Id": "account-123",
				},
			});
		}
		finishUsage(Response.json(codexReply));
		finishResets(
			Response.json({
				available_count: 2,
				credits: [
					{
						id: "private-credit-1",
						reset_type: "codex_rate_limits",
						status: "available",
						expires_at: "2026-11-01T00:00:00Z",
						title: "Bearer secret",
					},
					{ id: "private-credit-2", reset_type: "codex_rate_limits", status: "available", expires_at: null },
					{
						id: "private-credit-3",
						reset_type: "codex_rate_limits",
						status: "redeemed",
						expires_at: "2026-11-01T00:00:00Z",
					},
				],
			}),
		);
		const snapshots = await Promise.all(reads);
		const usage = provider(snapshots[0] as UsageSnapshot);
		expect(usage).toMatchObject({
			status: "ok",
			resetCredits: {
				availableCount: 2,
				credits: [
					{ state: "available", expiresAt: "2026-11-01T00:00:00.000Z" },
					{ state: "available" },
					{ state: "used", expiresAt: "2026-11-01T00:00:00.000Z" },
				],
			},
		});
		expect(JSON.stringify(snapshots)).not.toMatch(/private-credit|secret|account-123|Bearer/);
		if (!usage.resetCredits) throw new Error("Missing fixture resets");
		usage.resetCredits.availableCount = 999;
		expect(provider(await service.read()).resetCredits?.availableCount).toBe(2);
		expect(fetcher).toHaveBeenCalledTimes(2);
	});
	it("adjusts only unequivocally expired available reset credits and sanitizes unknown states", async () => {
		await codex();
		const fetcher = vi.fn(async (url: string | URL | Request) =>
			Response.json(
				String(url) === CODEX
					? codexReply
					: {
							available_count: 2,
							credits: [
								{
									id: "ended",
									reset_type: "codex_rate_limits",
									status: "available",
									expires_at: new Date(START).toISOString(),
								},
								{ id: "live", reset_type: "codex_rate_limits", status: "available" },
								{
									id: "future-status",
									reset_type: "codex_rate_limits",
									status: "new-server-state Bearer secret",
								},
							],
						},
			),
		);
		const service = new SubscriptionUsage({
			homeDir: home,
			env: {},
			now: () => now,
			fetch: fetcher as typeof fetch,
		});
		expect(provider(await service.read()).resetCredits).toEqual({
			availableCount: 1,
			credits: [
				{ state: "expired", expiresAt: new Date(START).toISOString() },
				{ state: "available" },
				{ state: "unavailable" },
			],
		});
	});
	it("preserves a reported zero reset balance and clears it when a later inventory read is unavailable", async () => {
		await codex();
		let available = true;
		const fetcher = vi.fn(async (url: string | URL | Request) => {
			if (String(url) === CODEX) return Response.json(codexReply);
			return available
				? Response.json({ available_count: 0, credits: [] })
				: new Response(null, { status: 404 });
		});
		const service = new SubscriptionUsage({
			homeDir: home,
			env: {},
			now: () => now,
			fetch: fetcher as typeof fetch,
		});
		expect(provider(await service.read()).resetCredits).toEqual({ availableCount: 0, credits: [] });
		available = false;
		now += 61_000;
		const usage = provider(await service.read());
		expect(usage.status).toBe("ok");
		expect(usage.resetCredits).toBeUndefined();
	});
	it("never presents a malformed, duplicate, partial or oversized reset inventory as a balance", async () => {
		await codex();
		const live = { id: "one", reset_type: "codex_rate_limits", status: "available" };
		for (const inventory of [
			{ available_count: -1, credits: [] },
			{ available_count: "1", credits: [live] },
			{ available_count: 1.5, credits: [live] },
			{ available_count: 2, credits: [live] },
			{ available_count: 0, credits: [live] },
			{ available_count: 1, credits: [] },
			{ available_count: 2, credits: [live, live] },
			{ available_count: 1, credits: [{ ...live, expires_at: "malformed-date" }] },
			{ available_count: 1, credits: [{ ...live, id: "" }] },
			{ available_count: 1, credits: [{ ...live, reset_type: "unrecognized-type" }] },
			{ available_count: 0, credits: [null] },
			{ available_count: 65, credits: Array.from({ length: 65 }, (_, i) => ({ ...live, id: String(i) })) },
		]) {
			const fetcher = vi.fn(async (url: string | URL | Request) =>
				Response.json(String(url) === CODEX ? codexReply : inventory),
			);
			const service = new SubscriptionUsage({
				homeDir: home,
				env: {},
				now: () => now,
				fetch: fetcher as typeof fetch,
			});
			const usage = provider(await service.read());
			expect(usage.status).toBe("ok");
			expect(usage.windows).toHaveLength(1);
			expect(usage.resetCredits).toBeUndefined();
		}
	});
	it.each([404, 403, 500, "network", "invalid-json", "oversized"] as const)(
		"preserves valid quotas when the optional reset endpoint fails with %s",
		async (failure) => {
			await codex();
			const fetcher = vi.fn(async (url: string | URL | Request) => {
				if (String(url) === CODEX) return Response.json(codexReply);
				if (typeof failure === "number") return new Response(null, { status: failure });
				if (failure === "network") throw new Error("private failure details");
				return new Response(failure === "oversized" ? "x".repeat(262145) : "not-json");
			});
			const service = new SubscriptionUsage({
				homeDir: home,
				env: {},
				now: () => now,
				fetch: fetcher as typeof fetch,
			});
			const usage = provider(await service.read());
			expect(usage.status).toBe("ok");
			expect(usage.windows).toHaveLength(1);
			expect(usage.resetCredits).toBeUndefined();
			expect(fetcher).toHaveBeenCalledTimes(2);
		},
	);
	it("bounds an unresponsive optional reset request without losing the successful quota read", async () => {
		await codex();
		const fetcher = vi.fn((url: string | URL | Request) =>
			String(url) === CODEX ? Promise.resolve(Response.json(codexReply)) : new Promise<Response>(() => {}),
		);
		const service = new SubscriptionUsage({
			homeDir: home,
			env: {},
			now: () => now,
			fetch: fetcher as typeof fetch,
			timeoutMs: 80,
		});
		const usage = provider(await service.read());
		expect(usage.status).toBe("ok");
		expect(usage.resetCredits).toBeUndefined();
		const calls = fetcher.mock.calls as unknown as [string, RequestInit][];
		expect(calls.find(([url]) => url === RESETS)?.[1].signal?.aborted).toBe(true);
	});
	it("coalesces concurrent refreshes", async () => {
		await codex();
		let finish!: (value: Response) => void;
		const fetcher = vi.fn(
			() =>
				new Promise<Response>((resolve) => {
					finish = resolve;
				}),
		);
		const { service } = make(fetcher);
		const reads = Array.from({ length: 12 }, () => service.read());
		await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
		finish(Response.json(codexReply));
		expect((await Promise.all(reads)).every((value) => provider(value).status === "ok")).toBe(true);
	});
	it("reports missing and API-key-only credentials without fabricating zeros", async () => {
		await json(join(home, ".codex/auth.json"), { OPENAI_API_KEY: "never-use" });
		const { service, fetcher } = make();
		const result = await service.read();
		expect(provider(result)).toMatchObject({ status: "unavailable", windows: [] });
		expect(provider(result, "claude")).toMatchObject({ status: "unauthenticated", windows: [] });
		expect(fetcher).not.toHaveBeenCalled();
	});
	it("uses Pi OAuth only when no native profile is present, with account claim", async () => {
		await json(join(home, ".pi/agent/auth.json"), {
			"openai-codex": {
				type: "oauth",
				access: jwt({
					exp: START / 1000 + 999,
					"https://api.openai.com/auth": { chatgpt_account_id: "pi-account" },
				}),
				expires: START + 300_000,
			},
			anthropic: { type: "oauth", access: "pi-claude", expires: START + 300_000 },
		});
		const { service, fetcher } = make();
		const result = await service.read();
		expect(result.providers.every((value) => value.status === "ok")).toBe(true);
		const calls = fetcher.mock.calls as unknown as [string, RequestInit][];
		expect(calls.find(([url]) => url === CODEX)?.[1].headers).toMatchObject({
			"ChatGPT-Account-Id": "pi-account",
		});
	});
	it("honors explicit CLI profiles without falling back to another account", async () => {
		await codex();
		await claude();
		const fetcher = vi.fn();
		const service = new SubscriptionUsage({
			homeDir: home,
			env: { CODEX_HOME: join(home, "missing-codex"), CLAUDE_CONFIG_DIR: join(home, "missing-claude") },
			fetch: fetcher,
		});
		expect((await service.read()).providers.every((p) => p.status === "unauthenticated")).toBe(true);
		expect(fetcher).not.toHaveBeenCalled();
	});
	it("uses explicit agent home while respecting native CLI precedence", async () => {
		await codex();
		const agentHome = join(home, "dot-agent");
		await json(join(agentHome, "auth.json"), {
			openai: { type: "oauth", access: "pi-other" },
			anthropic: { type: "oauth", access: "pi-claude" },
		});
		const fetcher = vi.fn(async () => Response.json(claudeReply));
		const service = new SubscriptionUsage({
			homeDir: home,
			env: {},
			agentHome,
			fetch: fetcher as typeof fetch,
		});
		await service.read();
		const calls = fetcher.mock.calls as unknown as [string, RequestInit][];
		expect(calls.find(([url]) => url === CODEX)?.[1].headers).toMatchObject({
			Authorization: "Bearer codex-secret",
		});
		expect(calls.find(([url]) => url === CLAUDE)?.[1].headers).toMatchObject({
			Authorization: "Bearer pi-claude",
		});
	});
	it("never refreshes expired JWT or Claude credentials and never writes auth files", async () => {
		await codex(jwt({ exp: START / 1000 - 1 }));
		await json(join(home, ".claude/.credentials.json"), {
			claudeAiOauth: { accessToken: token(), refreshToken: "never", expiresAt: START - 1 },
		});
		const before = await readFile(join(home, ".claude/.credentials.json"), "utf8");
		const { service, fetcher } = make();
		expect((await service.read()).providers.every((p) => p.status === "expired" && !p.windows.length)).toBe(
			true,
		);
		expect(fetcher).not.toHaveBeenCalled();
		expect(await readFile(join(home, ".claude/.credentials.json"), "utf8")).toBe(before);
	});
	it.each([
		[401, "unauthenticated"],
		[403, "unavailable"],
		[429, "error"],
		[503, "error"],
		[302, "error"],
	] as const)("sanitizes HTTP %s and does not retry/login/fallback", async (status, expected) => {
		await codex();
		const fetcher = vi.fn(async () => new Response("Bearer secret https://evil.invalid/private", { status }));
		const { service } = make(fetcher);
		const result = provider(await service.read());
		expect(result).toMatchObject({ status: expected, windows: [] });
		expect(result.error).not.toMatch(/secret|https:|evil/);
		await service.read();
		expect(fetcher).toHaveBeenCalledTimes(1);
	});
	it("bounds network timeout even for a fetch implementation ignoring abort", async () => {
		await codex();
		const fetcher = vi.fn(() => new Promise<Response>(() => {}));
		const service = new SubscriptionUsage({
			homeDir: home,
			env: {},
			fetch: fetcher as typeof fetch,
			timeoutMs: 25,
		});
		const result = provider(await service.read());
		expect(result.status).toBe("error");
		expect(result.error).toContain("tardó demasiado");
		const calls = fetcher.mock.calls as unknown as [string, RequestInit][];
		expect(calls[0]?.[1].signal?.aborted).toBe(true);
	});
	it("retains only same-credential last-good values, timestamp and explicit stale flag", async () => {
		await codex();
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(Response.json(codexReply))
			.mockRejectedValue(new Error("Bearer secret https://evil.invalid"));
		const { service } = make(fetcher);
		const initial = provider(await service.read());
		now += 61_000;
		expect(provider(await service.read())).toMatchObject({
			status: "error",
			stale: true,
			checkedAt: initial.checkedAt,
			windows: initial.windows,
		});
		await codex("new-account-token");
		now += 61_000;
		expect(provider(await service.read())).toMatchObject({ status: "error", windows: [] });
	});
	it("drops previously successful values after401 without changing to Pi", async () => {
		await codex();
		await json(join(home, ".pi/agent/auth.json"), { openai: { type: "oauth", access: "another-account" } });
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(Response.json(codexReply))
			.mockResolvedValue(new Response("private", { status: 401 }));
		const { service } = make(fetcher);
		await service.read();
		now += 61_000;
		expect(provider(await service.read())).toMatchObject({ status: "unauthenticated", windows: [] });
		expect(fetcher).toHaveBeenCalledTimes(2);
	});
	it("does not switch accounts when the native token is malformed or refresh-only", async () => {
		await codex("injected\nheader");
		await json(join(home, ".pi/agent/auth.json"), { openai: { type: "oauth", access: "another-account" } });
		const { service, fetcher } = make();
		expect(provider(await service.read())).toMatchObject({ status: "unauthenticated", windows: [] });
		expect(fetcher).not.toHaveBeenCalled();
	});
	it("treats an empty native profile after logout as authoritative", async () => {
		await codex();
		await claude();
		await json(join(home, ".pi/agent/auth.json"), {
			openai: { type: "oauth", access: "another-account" },
			anthropic: { type: "oauth", access: "another-claude" },
		});
		const { service, fetcher } = make();
		await service.read();
		await json(join(home, ".codex/auth.json"), {});
		await json(join(home, ".claude/.credentials.json"), {});
		now += 61_000;
		expect(
			(await service.read()).providers.every((p) => p.status === "unauthenticated" && p.windows.length === 0),
		).toBe(true);
		expect(fetcher).toHaveBeenCalledTimes(2);
	});
	it("does not retain stale values after expiration, logout or fifteen minutes", async () => {
		await codex();
		const fetcher = vi.fn().mockResolvedValueOnce(Response.json(codexReply)).mockRejectedValue(new Error());
		const { service } = make(fetcher);
		await service.read();
		now += 15 * 60_000;
		expect(provider(await service.read()).windows).toEqual([]);
		await rm(join(home, ".codex/auth.json"));
		now += 61_000;
		expect(provider(await service.read()).status).toBe("unauthenticated");
	});
	it("drops invalid percentages, reset dates, provider strings and absent windows", async () => {
		await codex();
		await claude();
		const fetcher = vi.fn(async (url: string | URL | Request) =>
			Response.json(
				String(url) === CODEX
					? {
							plan_type: "https://secret.invalid",
							rate_limit: {
								primary_window: { used_percent: 0, reset_at: 1e300 },
								secondary_window: { used_percent: "23" },
							},
						}
					: {
							five_hour: { utilization: -1 },
							seven_day: { utilization: 101 },
							extra_usage: { utilization: 50 },
						},
			),
		);
		const { service } = make(fetcher);
		const result = await service.read();
		expect(provider(result)).toMatchObject({
			status: "ok",
			windows: [{ usedPercent: 0, remainingPercent: 100 }],
		});
		expect(provider(result).windows[0]?.resetAt).toBeUndefined();
		expect(provider(result).plan).toBeUndefined();
		expect(provider(result, "claude")).toMatchObject({ status: "unavailable", windows: [] });
	});
	it.each([true, false])("bounds provider response bytes, declared size=%s", async (declared) => {
		await codex();
		const fetcher = vi.fn(
			async () =>
				new Response("x".repeat(262145), { headers: declared ? { "content-length": "262145" } : {} }),
		);
		expect(provider(await make(fetcher).service.read())).toMatchObject({ status: "error", windows: [] });
	});
	it("bounds auth files and sanitizes corrupt JSON without contacting providers", async () => {
		await mkdir(join(home, ".codex"));
		await writeFile(join(home, ".codex/auth.json"), "Bearer secret ".repeat(30000));
		const { service, fetcher } = make();
		expect(provider(await service.read())).toMatchObject({ status: "error", windows: [] });
		expect(fetcher).not.toHaveBeenCalled();
	});
});
