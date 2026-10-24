import { expect, type Page, test } from "@playwright/test";
import type {} from "./mobile-shell-native.ts";

const host = "https://overlay-fixture.test.ts.net";
async function mount(page: Page, partialChat: boolean) {
	await page.addInitScript(
		({ host, partialChat }) => {
			window.__mobileShellFixture = {
				connection: {
					url: host,
					token: "fixture_overlay_token_0123456789abcdef",
					deviceId: "overlay-phone",
					name: "Mi equipo",
				},
				monitoring: false,
				calls: [],
				companion: { partialChat, permission: true },
			};
			localStorage.setItem("gentle-dot-companion-v1", JSON.stringify({ mode: "capri", visible: true }));
		},
		{ host, partialChat },
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
