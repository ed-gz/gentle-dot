import { expect, type Page, test } from "@playwright/test";

const origin = "https://mobile-usage-fixture.test.ts.net";
const token = "fixture_usage_token_0123456789abcdef";
const now = Date.parse("2026-10-13T18:00:00Z");
const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
const quotaWindow = (
	id: string,
	label: string,
	remainingPercent: number,
	resetMinutes?: number,
	duration?: number,
) => ({
	id,
	label,
	usedPercent: 100 - remainingPercent,
	remainingPercent,
	...(resetMinutes === undefined ? {} : { resetAt: at(resetMinutes) }),
	...(duration === undefined ? {} : { windowDurationMins: duration }),
});
const freshUsage = () => ({
	providers: [
		{
			id: "codex",
			label: "Codex",
			status: "ok",
			plan: "Plus",
			checkedAt: at(-2),
			credits: { balance: 12.75, hasCredits: true },
			resetCredits: {
				availableCount: 2,
				credits: [
					{ state: "available", expiresAt: at(5 * 1440) },
					{ state: "available", expiresAt: at(5 * 1440) },
					{ state: "used" },
				],
			},
			windows: [
				quotaWindow("primary", "Sesión · 5 horas", 24, 42, 300),
				quotaWindow("secondary", "Semana", 88, 3 * 1440 + 240, 10080),
				quotaWindow("review", "Revisiones de código", 61, 6 * 1440 + 60),
				quotaWindow("additional", "Generaciones complementarias", 37.5),
			],
		},
		{
			id: "claude",
			label: "Claude",
			status: "ok",
			plan: "Pro",
			checkedAt: at(-1),
			windows: [
				quotaWindow("session", "Sesión · 5 horas", 68, 130, 300),
				quotaWindow("weekly", "Semana", 43, 4 * 1440 + 420, 10080),
				quotaWindow("sonnet", "Sólo Sonnet", 9, 22 * 60),
			],
		},
	],
	refreshAt: at(1),
});
const historicalUsage = () => ({
	providers: [
		{
			...freshUsage().providers[0],
			status: "error",
			stale: true,
			checkedAt: at(-120),
			error: "No se pudo actualizar. Se conserva la última lectura.",
			windows: [
				quotaWindow("primary", "Sesión · 5 horas", 24, -15, 300),
				quotaWindow("secondary", "Semana", 88, 3 * 1440, 10080),
			],
		},
		{
			id: "claude",
			label: "Claude",
			status: "unauthenticated",
			checkedAt: at(0),
			windows: [],
			error: "Conecta tu cuenta de Claude desde el equipo.",
		},
	],
	refreshAt: at(1),
});

async function mountUsage(
	page: Page,
	snapshot: object,
	theme: "dark" | "light" = "dark",
	badgesEnabled = true,
) {
	const errors: string[] = [];
	const requests: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.clock.setFixedTime(new Date(now));
	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.addInitScript(
		({ origin, token, theme, badgesEnabled }) => {
			window.__mobileShellFixture = {
				connection: { url: origin, token, deviceId: "usage-fixture-phone", name: "Mi equipo" },
				monitoring: false,
				calls: [],
			};
			if (!badgesEnabled) {
				localStorage.setItem("gentle-dot-usage-badges-v1", JSON.stringify({
					version: 1,
					visible: false,
					providers: {
						codex: { visible: true, fiveHour: true, weekly: true, priority: "5h" },
						claude: { visible: true, fiveHour: true, weekly: true, priority: "5h" },
					},
				}));
			}
			localStorage.setItem(
				"gentle-dot-chat-appearance-v1",
				JSON.stringify({ version: 1, theme, fontSize: 16 }),
			);
		},
		{ origin, token, theme, badgesEnabled },
	);
	await page.route(`${origin}/**`, (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path === "/api/mobile/usage") {
			requests.push(route.request().headers().authorization ?? "");
			if (requests.at(-1) !== `Bearer ${token}`) return route.fulfill({ status: 401 });
		}
		return route.fulfill({
			status: 200,
			contentType: "application/json",
			headers: { "Access-Control-Allow-Origin": "*" },
			body: JSON.stringify(
				path === "/api/mobile/usage"
					? snapshot
					: path.endsWith("/orchestration")
						? { available: true, sessions: [], approvals: [], policies: [], events: [] }
						: { approvals: [], workflows: [], watches: [], pending: 0, enabled: false },
			),
		});
	});
	await page.routeWebSocket(`${origin.replace("https:", "wss:")}/ws`, (socket) => {
		let seq = 0;
		const send = (value: object) => socket.send(JSON.stringify({ ...value, seq: ++seq }));
		socket.onMessage((raw) => {
			const command = JSON.parse(String(raw));
			if (command.type === "hello") send({ type: "ready", agentState: "idle", model: "Gentle" });
			if (command.type === "get_history") send({ type: "history", messages: [] });
			if (command.type === "auth_list")
				send({
					type: "auth_providers",
					providers: [
						{ id: "openai-codex", name: "Codex", configured: true, methods: ["oauth"] },
						{ id: "anthropic", name: "Claude", configured: true, methods: ["oauth"] },
					],
				});
		});
	});
	await page.goto("/");
	const shortcut = page.getByRole("button", { name: "Ver consumo", exact: true });
	await expect(shortcut).toBeVisible();
	if (badgesEnabled) {
		// Default compact quota may read; the full details remain lazy and closed.
		await expect(page.getByRole("img", { name: /^Codex,/ })).toBeVisible();
		expect(requests.length).toBeGreaterThan(0);
		expect(requests.every((authorization) => authorization === `Bearer ${token}`)).toBe(true);
	} else {
		await expect(page.locator(".usage-badges")).toHaveCount(0);
		// This branch is exercised with an installed clock, not a real-time wait.
		await page.clock.fastForward(120_000);
		expect(requests).toEqual([]);
	}
	await expect(page.getByRole("region", { name: "Uso de suscripciones" })).toHaveCount(0);
	await expect(page.locator(".usage-panel")).toHaveCount(0);
	const compactReads = requests.length;
	await expect(shortcut).toHaveText("");
	await expect(shortcut.locator("svg")).toHaveCount(1);
	const button = await shortcut.boundingBox();
	expect(button?.width).toBeGreaterThanOrEqual(44);
	expect(button?.height).toBeGreaterThanOrEqual(44);
	await shortcut.click();
	await expect(page.getByRole("region", { name: "Uso de suscripciones" })).toHaveAttribute(
		"aria-busy",
		"false",
	);
	// Opening details explicitly reads its full view, independently of compact reads.
	// StrictMode may abort/reissue mounts, so verify phase boundaries and every auth header,
	// rather than asserting one exact mount-dependent request count.
	expect(requests.length).toBeGreaterThan(compactReads);
	expect(new Set(requests)).toEqual(new Set([`Bearer ${token}`]));
	await expect(page.getByRole("button", { name: "Actualizar consumo", exact: true })).toBeDisabled();
	return { errors, requests };
}

async function noOverflow(page: Page) {
	expect(
		await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
	).toBeLessThanOrEqual(1);
	const excess = await page
		.locator(".usage-panel, .usage-card, .usage-window")
		.evaluateAll((elements) =>
			elements
				.filter((element) => element.getClientRects().length > 0)
				.map((element) =>
					Math.max(
						element.scrollWidth - element.clientWidth,
						element.getBoundingClientRect().right - window.innerWidth,
						-element.getBoundingClientRect().left,
					),
				),
		);
	for (const width of excess) expect(width).toBeLessThanOrEqual(1);
}

test.use({ timezoneId: "America/Monterrey", locale: "es-MX" });

test("mobile consumption shows readable gauges, clear resets and optional limits without overflowing", async ({
	page,
}, testInfo) => {
	const { errors, requests } = await mountUsage(page, freshUsage());
	const initialReads = requests.length;
	const codex = page.getByRole("article", { name: "Consumo de Codex", exact: true });
	const claude = page.getByRole("article", { name: "Consumo de Claude", exact: true });
	await expect(codex).toBeVisible();
	await expect(claude).toBeVisible();
	await expect(codex.getByText("12,75", { exact: true })).toBeVisible();
	await expect(
		codex.getByRole("progressbar", { name: "Codex, Sesión · 5 horas: 24% disponible", exact: true }),
	).toHaveAttribute("value", "24");
	await expect(
		claude.getByRole("progressbar", { name: "Claude, Semana: 43% disponible", exact: true }),
	).toHaveAttribute("value", "43");
	await expect(page.locator(".usage-ring")).toHaveCount(4);
	await expect(codex.locator(".usage-reset-countdown").first()).toHaveText("En 42 min");
	await expect(claude.locator(".usage-reset-countdown").first()).toHaveText("En 2 h 10 min");
	await expect(codex.locator(".usage-reset-date").first()).toHaveAttribute("datetime", at(42));
	await expect(codex.getByText("Generaciones complementarias", { exact: true })).toBeHidden();
	for (const viewport of [
		{ width: 320, height: 740 },
		{ width: 375, height: 812 },
		{ width: 412, height: 915 },
		{ width: 780, height: 390 },
	]) {
		await page.setViewportSize(viewport);
		await page.getByRole("heading", { name: "Consumo", exact: true }).scrollIntoViewIfNeeded();
		await noOverflow(page);
		for (const ring of await page.locator(".usage-ring").all()) {
			const bounds = await ring.boundingBox();
			expect(bounds?.width).toBeGreaterThanOrEqual(70);
			expect(Math.abs((bounds?.width ?? 0) - (bounds?.height ?? 0))).toBeLessThanOrEqual(1);
		}
		await page.screenshot({ path: testInfo.outputPath(`usage-dark-${viewport.width}.png`), fullPage: false });
	}
	await page.setViewportSize({ width: 375, height: 812 });
	await codex.getByText("Otros límites (2)", { exact: true }).click();
	await expect(codex.getByText("Generaciones complementarias", { exact: true })).toBeVisible();
	await expect(
		codex.getByRole("progressbar", { name: /Generaciones complementarias: 37,5%/ }),
	).toHaveAttribute("value", "37.5");
	await expect(codex.getByText("No informado", { exact: true })).toBeVisible();
	await expect(codex.locator(`.usage-reading time[datetime="${at(-2)}"]`)).toBeVisible();
	await expect(codex.locator(".usage-reset-date")).toHaveCount(3);
	const bank = codex.locator(".usage-reset-bank");
	await expect(bank.locator("summary strong")).toHaveText("2");
	await bank.locator("summary").click();
	await expect(bank.getByRole("listitem")).toHaveCount(2);
	await expect(bank.getByText("2 × Disponible", { exact: true })).toBeVisible();
	await expect(bank.getByText("Utilizado", { exact: true })).toBeVisible();
	await expect(bank.locator("time")).toHaveAttribute("datetime", at(5 * 1440));
	await page.setViewportSize({ width: 320, height: 740 });
	await noOverflow(page);
	await bank.scrollIntoViewIfNeeded();
	await page.screenshot({ path: testInfo.outputPath("usage-reset-bank-320.png"), fullPage: false });
	await page.setViewportSize({ width: 375, height: 812 });
	await page.screenshot({ path: testInfo.outputPath("usage-details-375.png"), fullPage: false });
	await claude.getByText("Otros límites (1)", { exact: true }).click();
	await expect(
		claude.getByRole("progressbar", { name: "Claude, Sólo Sonnet: 9% disponible", exact: true }),
	).toHaveAttribute("value", "9");
	await claude.scrollIntoViewIfNeeded();
	await noOverflow(page);
	await page.screenshot({ path: testInfo.outputPath("usage-claude-limits-375.png"), fullPage: false });
	await page.getByRole("button", { name: "Volver a Dot", exact: true }).click();
	await expect(page.getByRole("region", { name: "Uso de suscripciones" })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Ver consumo", exact: true })).toBeFocused();
	expect(requests).toHaveLength(initialReads);
	expect(errors).toEqual([]);
});

for (const badgesEnabled of [true, false]) {
	test(`quota reads respect auth and cooldown with badges ${badgesEnabled ? "enabled" : "disabled"}`, async ({ page }) => {
		await page.clock.install({ time: new Date(now) });
		// mountUsage checks the pre-details phase: compact reads only when enabled;
		// disabled badges stay silent even across two minutes of timer callbacks.
		const { errors, requests } = await mountUsage(page, freshUsage(), "dark", badgesEnabled);
		const initialReads = requests.length;
		await page.clock.setFixedTime(new Date(now + 30_000));
		await page.clock.fastForward(30_000);
		expect(requests).toHaveLength(initialReads);
		expect(requests.every((authorization) => authorization === `Bearer ${token}`)).toBe(true);
		await expect(page.getByRole("button", { name: "Actualizar consumo", exact: true })).toBeDisabled();
		await expect(page.getByRole("region", { name: "Uso de suscripciones" })).toHaveAttribute("aria-busy", "false");
		expect(errors).toEqual([]);
	});
}

test("mobile consumption distinguishes historical readings from disconnected accounts in light mode", async ({
	page,
}, testInfo) => {
	await page.setViewportSize({ width: 320, height: 740 });
	const { errors } = await mountUsage(page, historicalUsage(), "light");
	const codex = page.getByRole("article", { name: "Consumo de Codex", exact: true });
	const claude = page.getByRole("article", { name: "Consumo de Claude", exact: true });
	await expect(codex.getByText("Datos anteriores", { exact: true })).toBeVisible();
	await expect(codex.getByText("Ventana terminada", { exact: true })).toBeVisible();
	await expect(
		codex.getByRole("progressbar", { name: /24% disponible en la última lectura/ }),
	).toHaveAttribute("value", "24");
	await expect(claude.getByText("Sin conectar", { exact: true })).toBeVisible();
	await expect(claude.getByRole("progressbar")).toHaveCount(0);
	await expect(claude.getByText(/0%|100%/)).toHaveCount(0);
	for (const caption of await codex.locator(".usage-remaining > span").all()) {
		const layout = await caption.evaluate((element) => {
			const bounds = element.getBoundingClientRect();
			const ring = element.closest(".usage-gauge")?.getBoundingClientRect();
			return { captionWidth: bounds.width, gaugeWidth: ring?.width ?? 0 };
		});
		expect(layout.captionWidth).toBeLessThanOrEqual(layout.gaugeWidth * 0.82);
	}
	await noOverflow(page);
	await page.screenshot({ path: testInfo.outputPath("usage-historical-light-320.png"), fullPage: false });
	await page.setViewportSize({ width: 412, height: 915 });
	await noOverflow(page);
	await page.screenshot({ path: testInfo.outputPath("usage-historical-light-412.png"), fullPage: false });
	expect(errors).toEqual([]);
});
