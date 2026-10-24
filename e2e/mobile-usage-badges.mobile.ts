import { expect, type Page, test } from "@playwright/test";

const origin = "https://quota-badges-fixture.test.ts.net";
const token = "fixture_badges_token_0123456789abcdef";
const key = "gentle-dot-usage-badges-v1";
function usage(stale = false) {
	return {
		providers: [
			{
				id: "codex", label: "Codex", status: "ok", stale,
				checkedAt: new Date().toISOString(),
				windows: [
					{ id: "primary_window", label: "5 horas", usedPercent: 24, remainingPercent: 76, windowDurationMins: 300 },
					{ id: "secondary_window", label: "Semana", usedPercent: 81, remainingPercent: 19, windowDurationMins: 10080 },
				],
			},
			{
				id: "claude", label: "Claude", status: "ok", checkedAt: new Date().toISOString(),
				windows: [{ id: "seven_day", label: "Semana", usedPercent: 36, remainingPercent: 64, windowDurationMins: 10080 }],
			},
		],
	};
}
async function mount(page: Page, snapshot: object = usage(), readingGate?: Promise<void>) {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.addInitScript(({ origin, token }) => {
		window.__mobileShellFixture = {
			connection: { url: origin, token, deviceId: "quota-badges-phone", name: "Mi equipo" },
			monitoring: false, calls: [],
		};
	}, { origin, token });
	await page.route(`${origin}/**`, async (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path === "/api/mobile/usage" && route.request().headers().authorization !== `Bearer ${token}`) {
			return route.fulfill({ status: 401 });
		}
		if (path === "/api/mobile/usage") await readingGate;
		return route.fulfill({
			status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" },
			body: JSON.stringify(path === "/api/mobile/usage" ? snapshot : path.endsWith("/orchestration")
				? { available: true, sessions: [], approvals: [], policies: [], events: [] }
				: { approvals: [], workflows: [], watches: [], pending: 0, enabled: false }),
		});
	});
	await page.routeWebSocket(`${origin.replace("https:", "wss:")}/ws`, (socket) => {
		let seq = 0;
		const send = (value: object) => socket.send(JSON.stringify({ ...value, seq: ++seq }));
		socket.onMessage((raw) => {
			const command = JSON.parse(String(raw));
			if (command.type === "hello") send({ type: "ready", agentState: "idle", model: "Gentle" });
			if (command.type === "get_history") send({ type: "history", messages: [] });
		});
	});
	await page.goto("/");
	return errors;
}

for (const viewport of [{ width: 375, height: 812 }, { width: 812, height: 375 }, { width: 1280, height: 800 }]) {
	test(`compact used quota and details geometry at ${viewport.width}x${viewport.height}`, async ({ page }) => {
		await page.setViewportSize(viewport);
		const errors = await mount(page);
		const codex = page.getByRole("img", { name: "Codex, 5 horas: 24% usado", exact: true });
		const claude = page.getByRole("img", { name: "Claude, Semana: 36% usado", exact: true });
		await expect(codex).toBeVisible();
		await expect(claude).toBeVisible();
		await expect(codex.locator("img")).toHaveCount(1);
		await expect(codex.locator("svg")).toHaveCount(1);
		await expect(page.locator(".usage-badges")).not.toContainText("81%");
		const shortcut = page.getByRole("button", { name: "Ver consumo", exact: true });
		const bounds = await Promise.all([codex, claude, shortcut].map((item) => item.boundingBox()));
		const [a, b, details] = bounds;
		expect(a && b && details).toBeTruthy();
		if (!a || !b || !details) throw new Error("Missing badge bounds");
		expect(a.x + a.width).toBeLessThanOrEqual(b.x);
		expect(b.x + b.width).toBeLessThanOrEqual(details.x);
		expect(details.width).toBeGreaterThanOrEqual(44);
		expect(details.height).toBeGreaterThanOrEqual(44);
		expect(details.x + details.width).toBeLessThanOrEqual(viewport.width);
		await expect(page.locator(".usage-badges + button")).toHaveAccessibleName("Ver consumo");
		const composer = await page.locator(".composer").boundingBox();
		if (!composer) throw new Error("Missing composer bounds");
		expect(details.y + details.height).toBeLessThanOrEqual(composer.y + 1);
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
		await shortcut.click();
		await expect(page.getByRole("region", { name: "Uso de suscripciones" })).toBeVisible();
		await expect(page.getByText("24% usado", { exact: true })).toBeVisible();
		await page.getByRole("button", { name: "Volver a Dot", exact: true }).click();
		await expect(shortcut).toBeFocused();
		expect(errors).toEqual([]);
	});
}

test("loading to numeric quota does not move details or the composer", async ({ page }) => {
	await page.setViewportSize({ width: 375, height: 812 });
	let release = () => {};
	const gate = new Promise<void>((resolve) => { release = resolve; });
	await mount(page, usage(), gate);
	await expect(page.getByRole("status", { name: "" }).filter({ hasText: "Consultando consumo…" })).toBeVisible();
	const shortcut = page.getByRole("button", { name: "Ver consumo", exact: true });
	const beforeDetails = await shortcut.boundingBox();
	const beforeComposer = await page.locator(".composer").boundingBox();
	release();
	await expect(page.getByRole("img", { name: "Codex, 5 horas: 24% usado" })).toBeVisible();
	expect(await shortcut.boundingBox()).toEqual(beforeDetails);
	expect(await page.locator(".composer").boundingBox()).toEqual(beforeComposer);
});

test("settings edit priority, persist provider/window choices and switch badges off without losing details", async ({ page }) => {
	await mount(page);
	await expect(page.getByRole("img", { name: "Codex, 5 horas: 24% usado" })).toBeVisible();
	await page.getByRole("button", { name: "Ajustes", exact: true }).click();
	await page.getByText("Porcentajes de consumo", { exact: true }).click();
	await page.getByLabel("Prioridad de Codex", { exact: true }).selectOption("weekly");
	await page.getByRole("button", { name: "Dot", exact: true }).click();
	await expect(page.getByRole("img", { name: "Codex, Semana: 81% usado" })).toBeVisible();
	await page.getByRole("button", { name: "Ajustes", exact: true }).click();
	await page.getByText("Porcentajes de consumo", { exact: true }).click();
	await page.getByLabel("Ventana semanal de Codex", { exact: true }).uncheck();
	await page.getByLabel("Mostrar Claude", { exact: true }).uncheck();
	await page.getByRole("button", { name: "Dot", exact: true }).click();
	await expect(page.getByRole("img", { name: "Codex, 5 horas: 24% usado" })).toBeVisible();
	await expect(page.getByRole("img", { name: /^Claude,/ })).toHaveCount(0);
	await page.reload();
	await expect(page.getByRole("img", { name: "Codex, 5 horas: 24% usado" })).toBeVisible();
	await expect(page.getByRole("img", { name: /^Claude,/ })).toHaveCount(0);
	await page.getByRole("button", { name: "Ajustes", exact: true }).click();
	await page.getByText("Porcentajes de consumo", { exact: true }).click();
	await expect(page.getByLabel("Prioridad de Codex", { exact: true })).toHaveValue("weekly");
	await page.getByLabel("Mostrar porcentajes de consumo", { exact: true }).uncheck();
	await page.getByRole("button", { name: "Dot", exact: true }).click();
	await expect(page.locator(".usage-badges")).toHaveCount(0);
	await page.reload();
	await expect(page.locator(".usage-badges")).toHaveCount(0);
	await page.getByRole("button", { name: "Ver consumo", exact: true }).click();
	await expect(page.getByRole("region", { name: "Uso de suscripciones" })).toBeVisible();
	expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null").visible, key)).toBe(false);
});

test("stale and unknown readings remain honest, with malformed settings defaulting safely", async ({ page }) => {
	const snapshot = usage(true);
	snapshot.providers[1]!.windows = [];
	await page.addInitScript((key) => localStorage.setItem(key, "{broken"), key);
	await mount(page, snapshot);
	await expect(page.getByRole("img", { name: "Codex, 5 horas: 24% usado · lectura anterior" })).toHaveText("24%*");
	await expect(page.getByRole("img", { name: "Claude, ventana prioritaria: no disponible" })).toContainText("—");
	await expect(page.locator(".usage-badges")).not.toContainText("0%");
});
