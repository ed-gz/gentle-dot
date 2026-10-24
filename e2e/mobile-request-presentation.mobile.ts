import { expect, test } from "@playwright/test";

// Browser shell fixture only: never evidence of Android OS notification delivery.
const origin = "https://requests-fixture.test.ts.net";
const token = "fixture_requests_token_0123456789abcdef";

test("responds inline in Dot and from a dismissible actionable popup without visiting the agent list", async ({ page }) => {
	let dotPending = true;
	let agentPending = true;
	const answers: unknown[] = [];
	const expiresAt = new Date(Date.now() + 600_000).toISOString();
	await page.addInitScript(({ origin, token }) => {
		window.__mobileShellFixture = {
			connection: { url: origin, token, deviceId: "fixture-phone", name: "Mi equipo" },
			monitoring: true,
			calls: [],
		};
	}, { origin, token });
	await page.route(`${origin}/**`, async (route) => {
		const path = new URL(route.request().url()).pathname;
		const action = route.request().method() === "POST" ? route.request().postDataJSON() : undefined;
		let body: object = { approvals: [], pending: 0, enabled: false };
		if (path === "/api/mobile/answer") {
			answers.push(action);
			dotPending = false;
			body = { ok: true };
		} else if (path === "/api/mobile/approvals") {
			body = { approvals: dotPending ? [{ id: "dot-1", title: "Permiso de Dot", message: "Detalle íntegro", expiresAt }] : [] };
		} else if (path === "/orchestration") {
			if (action?.action === "answer") {
				answers.push(action);
				agentPending = false;
			}
			body = {
				available: true,
				sessions: [{ paneId: "p", sessionId: "s", terminalId: "t", workspaceId: "w", label: "Agente propietario", state: "blocked", connected: true, managed: true }],
				approvals: agentPending ? [{ id: "question", paneId: "p", sessionId: "s", title: "Documento del agente", message: "Original\nCompleto", action: "question", kind: "editor", answerable: true, createdAt: new Date().toISOString(), expiresAt }] : [],
				policies: [], events: [],
			};
		}
		await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
	});
	await page.routeWebSocket(`${origin.replace("https:", "wss:")}/ws`, (socket) => {
		let seq = 0;
		socket.onMessage((raw) => {
			const command = JSON.parse(String(raw));
			if (command.type === "hello") socket.send(JSON.stringify({ type: "ready", agentState: "idle", model: "Gentle", seq: ++seq }));
			if (command.type === "get_history") socket.send(JSON.stringify({ type: "history", messages: [], seq: ++seq }));
		});
	});
	await page.goto("/");
	await page.getByRole("button", { name: "Aprobar permiso de Dot" }).click();
	await expect.poll(() => answers).toEqual([{ requestId: "dot-1", approved: true }]);
	await page.getByRole("button", { name: "Ajustes", exact: true }).click();
	await page.getByRole("radio", { name: "Ventana emergente con respuestas" }).check();
	const dialog = page.getByRole("dialog", { name: "Solicitudes pendientes", exact: true });
	await expect(dialog).toBeVisible();
	await expect(dialog.getByRole("textbox", { name: "Tu respuesta" })).toHaveValue("Original\nCompleto");
	await expect(dialog.getByRole("button", { name: "Cerrar sin responder" })).toBeFocused();
	await dialog.getByRole("button", { name: "Cerrar sin responder" }).click();
	expect(answers).toHaveLength(1);
	await expect(page.getByRole("textbox", { name: "Tu respuesta", includeHidden: true })).toHaveCount(0);
	await page.getByRole("button", { name: /Ver solicitudes pendientes/ }).click();
	await page.emulateMedia({ reducedMotion: "reduce" });
	for (const size of [{ width: 375, height: 820 }, { width: 780, height: 390 }]) {
		await page.setViewportSize(size);
		await expect(dialog.getByRole("button", { name: "Cerrar sin responder" })).toBeInViewport();
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
	}
	await dialog.getByRole("textbox", { name: "Tu respuesta" }).fill("Respuesta\nLiteral");
	await dialog.getByRole("button", { name: "Enviar respuesta" }).click();
	await expect.poll(() => answers).toEqual([{ requestId: "dot-1", approved: true }, { action: "answer", paneId: "p", sessionId: "s", requestId: "question", text: "Respuesta\nLiteral" }]);
	await expect(dialog).toHaveCount(0);
	await page.reload();
	await page.getByRole("button", { name: "Ajustes", exact: true }).click();
	await expect(page.getByRole("radio", { name: "Ventana emergente con respuestas" })).toBeChecked();
	// Exercise the actual native-to-TS listener, not just the shared window event.
	await page.evaluate(() => window.__mobileShellNativeEvent("foregroundNotification", {
		id: "native-attention", title: "Una sesión te necesita", body: "Atención del agente", event: "agentAttention", session: { paneId: "p", sessionId: "s" },
	}));
	await expect(page.getByRole("region", { name: "Aviso" })).toBeVisible();
	await expect(page.getByText("Atención del agente")).toBeVisible();
});
