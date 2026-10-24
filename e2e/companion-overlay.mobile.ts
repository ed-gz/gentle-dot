import { expect, type Page, test } from "@playwright/test";
import type {} from "./mobile-shell-native.ts";

const host = "https://overlay-fixture.test.ts.net";
async function mount(page: Page, partialChat: boolean, restoreNative = false, failNativeRead = false) {
	await page.addInitScript(
		({ host, partialChat, restoreNative, failNativeRead }) => {
			window.__mobileShellFixture = {
				companionStateError: failNativeRead ? "No se pudo recuperar el personaje de Android." : undefined,
				connection: {
					url: host,
					token: "fixture_overlay_token_0123456789abcdef",
					deviceId: "overlay-phone",
					name: "Mi equipo",
				},
				monitoring: false,
				calls: [],
				companion: { partialChat, permission: true, theme: restoreNative ? "capri" : "gentle-dot" },
			};
			if (restoreNative) localStorage.removeItem("gentle-dot-companion-v1");
			else localStorage.setItem("gentle-dot-companion-v1", JSON.stringify({ mode: "capri", visible: true }));
		},
		{ host, partialChat, restoreNative, failNativeRead },
	);
	await page.route(`${host}/**`, (route) => {
		const path = new URL(route.request().url()).pathname;
		return route.fulfill({
			json:
				path === "/orchestration"
					? { available: true, sessions: [], approvals: [], policies: [], events: [] }
					: path === "/api/mobile/companion"
						? { mode: "gentle" }
						: path === "/api/mobile/completions"
							? { enabled: false, pending: 0 }
							: {},
			headers: { "Access-Control-Allow-Origin": "*" },
		});
	});
	await page.routeWebSocket(`${host.replace("https:", "wss:")}/ws`, (socket) => {
		let seq = 0;
		socket.onMessage((data) => {
			const message = JSON.parse(String(data));
			if (message.type === "hello")
				socket.send(
					JSON.stringify({
						type: "ready",
						seq: ++seq,
						agentState: "idle",
						features: { conversations: false },
						voice: { transcribe: false, speak: false },
					}),
				);
			if (message.type === "get_history")
				socket.send(
					JSON.stringify({
						type: "history",
						seq: ++seq,
						messages: [
							{
								id: "a",
								role: "assistant",
								text: "Aquí está tu conversación. Tus sesiones siguen disponibles en el equipo.",
								activities: [],
							},
						],
					}),
				);
		});
	});
	await page.goto("/");
	if (failNativeRead) return;
	await expect(
		page.getByText("Aquí está tu conversación. Tus sesiones siguen disponibles en el equipo."),
	).toBeVisible();
}

test("partial chat reuses the composer, hides the duplicate sprite and collapses explicitly", async ({
	page,
}) => {
	await page.setViewportSize({ width: 375, height: 700 });
	await mount(page, true);
	await expect(page.getByRole("button", { name: "Volver a la burbuja" })).toBeVisible();
	await expect(page.locator(".companion-chat-bar")).toHaveCount(0);
	await expect(page.getByRole("navigation", { name: "Navegación principal" })).toHaveCount(1);
	const header = await page.locator(".mobile-top-nav").boundingBox();
	expect(header?.height).toBeLessThanOrEqual(64);
	const collapse = await page.getByRole("button", { name: "Volver a la burbuja" }).boundingBox();
	expect(collapse?.width).toBeGreaterThanOrEqual(48);
	expect(collapse?.height).toBeGreaterThanOrEqual(48);
	await expect(page.locator(".capri-overlay")).not.toBeVisible();
	const editor = page.locator(".composer textarea");
	await editor.fill("Borrador que quiero conservar al volver");
	await expect
		.poll(() =>
			page.evaluate(
				() => window.__mobileShellFixture.calls.filter((call) => call.method === "saveDraft").length,
			),
		)
		.toBeGreaterThan(0);
	await page.screenshot({ path: ".cache/mobile-companion-partial-portrait.png" });
	await page.getByRole("button", { name: "Volver a la burbuja" }).click();
	await expect
		.poll(() =>
			page.evaluate(
				() => window.__mobileShellFixture.calls.filter((call) => call.method === "closeCompanionChat").length,
			),
		)
		.toBe(1);
	await expect(editor).toHaveValue("Borrador que quiero conservar al volver");
	await page.setViewportSize({ width: 800, height: 375 });
	await page.screenshot({ path: ".cache/mobile-companion-partial-landscape.png" });
	await expect(editor).toBeVisible();
	await expect(page.getByRole("button", { name: "Volver a la burbuja" })).toBeVisible();
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("restores Capri from Android and starts that exact character only on an explicit activation", async ({
	page,
}) => {
	await mount(page, false, true);
	await page.getByRole("button", { name: "Ajustes", exact: true }).click();
	await expect(page.getByRole("switch", { name: "Tema Capri", exact: true })).toHaveAttribute(
		"aria-checked",
		"true",
	);
	const enabledCalls = () =>
		page.evaluate(() =>
			window.__mobileShellFixture.calls.filter(
				(call) => call.method === "setCompanion" && (call.options as { enabled?: boolean })?.enabled === true,
			),
		);
	expect(await enabledCalls()).toHaveLength(0);
	await page.locator("summary").filter({ hasText: "Avisos y teléfono" }).click();
	await page.getByRole("switch", { name: /Sobre otras apps/ }).click();
	await expect
		.poll(enabledCalls)
		.toEqual([{ method: "setCompanion", options: { enabled: true, theme: "capri" } }]);
	await expect(page.getByText(/Capri está lista\./)).toBeVisible();
	expect(await page.evaluate(() => window.__mobileShellFixture.companion?.appliedTheme)).toBe("capri");
});

test("a theme changed in another window reaches both the settings and Android overlay", async ({ page }) => {
	await mount(page, false);
	await page.getByRole("button", { name: "Ajustes", exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.__mobileShellFixture.companion?.theme)).toBe("capri");
	await page.evaluate(() => {
		const key = "gentle-dot-companion-v1";
		localStorage.setItem(key, JSON.stringify({ mode: "gentle", persona: "gentle" }));
		window.dispatchEvent(new StorageEvent("storage", { key }));
	});
	await expect(page.getByRole("switch", { name: "Tema Capri", exact: true })).toHaveAttribute(
		"aria-checked",
		"false",
	);
	await expect
		.poll(() => page.evaluate(() => window.__mobileShellFixture.companion?.theme))
		.toBe("gentle-dot");
	expect(await page.evaluate(() => window.__mobileShellFixture.companion?.enabled)).not.toBe(true);
});

test("failed startup recovers native Capri without persisting the shared UI defaults", async ({ page }) => {
	await mount(page, false, true, true);
	await expect(page.getByRole("alert")).toHaveText("No se pudo recuperar el personaje de Android.");
	await expect(page.getByRole("button", { name: "Ajustes", exact: true })).toHaveCount(0);
	expect(await page.evaluate(() => localStorage.getItem("gentle-dot-companion-v1"))).toBeNull();
	await page.evaluate(() => {
		window.__mobileShellFixture.companionStateError = undefined;
	});
	await page.getByRole("button", { name: "Reintentar personaje" }).click();
	await page.getByRole("button", { name: "Ajustes", exact: true }).click();
	await expect(page.getByRole("switch", { name: "Tema Capri", exact: true })).toHaveAttribute(
		"aria-checked",
		"true",
	);
	expect(await page.evaluate(() => window.__mobileShellFixture.companion?.theme)).toBe("capri");
	expect(
		await page.evaluate(() =>
			window.__mobileShellFixture.calls.filter((call) => call.method === "setCompanion"),
		),
	).toEqual([]);
});
