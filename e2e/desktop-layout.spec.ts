import { expect, test } from "@playwright/test";
import { E2E_TOKEN } from "./token.ts";

// Session controls belong to the Android shell and are exercised in mobile-shell.mobile.ts.
// This suite uses the actual shared web UI served by the isolated fake-agent daemon.
for (const viewport of [
	{ width: 375, height: 812 },
	{ width: 1280, height: 900 },
]) {
	test(`desktop opens directly in Dot at ${viewport.width}px and keeps its tools and draft`, async ({
		page,
	}, info) => {
		await page.setViewportSize(viewport);
		await page.emulateMedia({ reducedMotion: "reduce" });
		const sessionRequests: string[] = [];
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		await page.route("**/orchestration", async (route) => {
			sessionRequests.push(route.request().method());
			await route.fulfill({
				json: { available: true, sessions: [], approvals: [], policies: [], events: [] },
			});
		});
		await page.goto(`/#token=${E2E_TOKEN}`);
		const message = page.getByRole("textbox", { name: "Message", exact: true });
		await expect(message).toBeEnabled();
		await expect(page.getByRole("heading", { name: "Gentle Dot", exact: true })).toBeVisible();
		await expect(page.getByRole("navigation", { name: "Espacio de trabajo" })).toHaveCount(0);
		await expect(page.getByRole("navigation", { name: "Navegación principal" })).toHaveCount(0);
		await expect(page.getByRole("button", { name: /^(Chat|Agentes|Sesiones)$/ })).toHaveCount(0);
		await expect(page.locator(".sessions-screen, .chat-mobile")).toHaveCount(0);

		const instruction = `Revisemos el plan en esta ventana de ${viewport.width}px.`;
		await message.fill(instruction);
		await message.press("Enter");
		await expect(page.locator(".message-assistant").last()).toHaveText(`Echo: ${instruction}`);
		await message.fill("Después revisamos los resultados.");
		await page.getByRole("button", { name: "Options", exact: true }).click();
		await page.getByRole("button", { name: "Accounts", exact: true }).click();
		await expect(page.getByRole("region", { name: "Accounts", exact: true })).toBeVisible();
		await page.getByRole("button", { name: "Close accounts", exact: true }).click();
		await expect(message).toHaveValue("Después revisamos los resultados.");
		await page.getByRole("button", { name: "Options", exact: true }).click();
		for (const name of ["Accounts", "Profiles", "Connectors"]) {
			await expect(page.getByRole("button", { name, exact: true })).toBeInViewport();
		}

		await page.keyboard.press("Escape");

		const geometry = await page.evaluate(() => {
			const header = document.querySelector(".chat-header")?.getBoundingClientRect();
			const transcript = document.querySelector(".chat-transcript")?.getBoundingClientRect();
			const composer = document.querySelector(".composer")?.getBoundingClientRect();
			if (!header || !transcript || !composer) throw new Error("Missing desktop chat layout");
			return {
				noHorizontalOverflow: document.documentElement.scrollWidth <= innerWidth,
				gap: transcript.top - header.bottom,
				transcriptHeight: transcript.height,
				composerBottom: composer.bottom,
				height: innerHeight,
			};
		});
		expect(geometry.noHorizontalOverflow).toBe(true);
		expect(geometry.gap).toBeGreaterThanOrEqual(0);
		expect(geometry.gap).toBeLessThanOrEqual(1);
		expect(geometry.transcriptHeight).toBeGreaterThan(viewport.height / 2);
		expect(geometry.composerBottom).toBeLessThanOrEqual(geometry.height);
		await expect(page.getByRole("button", { name: "Send", exact: true })).toBeInViewport();
		expect(sessionRequests).toEqual([]);
		expect(errors).toEqual([]);
		await page.screenshot({ path: info.outputPath(`desktop-dot-${viewport.width}.png`) });
	});
}
