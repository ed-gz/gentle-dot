import { expect, test } from "@playwright/test";

// Run with the mobile-shell Vite fixture (playwright.mobile.vite.config.ts).
// The mobile Playwright config must include this filename in testMatch.
const origin = "https://subagent-fixture.test.ts.net";
const session = {
	paneId: "review",
	sessionId: "review-session",
	terminalId: "terminal",
	workspaceId: "workspace",
	label: "Revisión",
	state: "working",
	provider: "herdr",
	connected: true,
	managed: true,
	capabilities: { inspect: true, prompt: true, abort: true, approvals: true },
};

test("subagent replies disclose only on click or keyboard, leaving the orchestrator visible", async ({ page }) => {
	await page.addInitScript((url) => {
		window.__mobileShellFixture = {
			connection: { url, token: "fixture_subagent_0123456789abcdef", deviceId: "phone", name: "Mi equipo" },
			monitoring: false,
			calls: [],
		};
	}, origin);
	await page.route(`${origin}/**`, (route) => {
		const path = new URL(route.request().url()).pathname;
		const action = route.request().method() === "POST" ? route.request().postDataJSON() : undefined;
		const body =
			path === "/orchestration"
				? action?.action === "inspect"
					? {
							sessionId: session.sessionId,
							status: "working",
							question: null,
							messages: [
								{
									id: "delegate",
									role: "assistant",
									provenance: { kind: "subagent", label: "Revisor" },
									content: [{ type: "text", text: "Resultado completo del subagente." }],
								},
								{
									id: "peer",
									role: "assistant",
									provenance: { kind: "session", label: "Preparación" },
									content: [{ type: "text", text: "La otra sesión sigue visible." }],
								},
								{
									id: "main",
									role: "assistant",
									content: [{ type: "text", text: "Estoy integrando la revisión." }],
								},
							],
						}
					: { available: true, sessions: [session], approvals: [], policies: [], events: [] }
				: { approvals: [], workflows: [], pending: 0, enabled: false };
		return route.fulfill({ json: body });
	});
	await page.routeWebSocket(`${origin.replace("https:", "wss:")}/ws`, (socket) => {
		let seq = 0;
		socket.onMessage((raw) => {
			const command = JSON.parse(String(raw));
			if (command.type === "hello")
				socket.send(JSON.stringify({ type: "ready", agentState: "idle", model: "Gentle", seq: ++seq }));
			if (command.type === "get_history")
				socket.send(JSON.stringify({ type: "history", messages: [], seq: ++seq }));
		});
	});
	await page.goto("/");
	await page.getByRole("button", { name: "Sesiones", exact: true }).click();
	await page.getByRole("button", { name: "Revisión · Trabajando" }).click();
	const delegate = page.getByRole("article", { name: "Subagente · Revisor" });
	const summary = delegate.locator("summary");
	const body = delegate.getByText("Resultado completo del subagente.");
	await expect(summary).toHaveText("Subagente · Revisor");
	await expect(body).toBeHidden();
	await expect(page.getByText("Estoy integrando la revisión.")).toBeVisible();
	await expect(page.getByText("La otra sesión sigue visible.")).toBeVisible();
	await summary.click();
	await expect(body).toBeVisible();
	await summary.click();
	await expect(body).toBeHidden();
	await summary.focus();
	await summary.press("Enter");
	await expect(body).toBeVisible();
	await summary.press("Space");
	await expect(body).toBeHidden();
	await expect(summary).toBeFocused();
	await expect(page.getByText("Estoy integrando la revisión.")).toBeVisible();
	await expect(page.getByText("La otra sesión sigue visible.")).toBeVisible();
});
