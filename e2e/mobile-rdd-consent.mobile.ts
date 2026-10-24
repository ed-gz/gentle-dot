import { expect, test } from "@playwright/test";

// Functional mobile web-shell fixture; not an APK or Android notification-delivery test.
const origin = "https://rdd-fixture.test.ts.net";
const token = "fixture_rdd_token_0123456789abcdef";
const consent = {
	schema: "gentle-ai.review-integration.consent/v3", agent: "pi", blocking: true,
	target_identity: "sha256:exact-frozen-candidate", projection: "workspace", risk_level: "high",
	changed_files: 2, changed_lines: 12, headline: "Review this exact candidate?",
	reason: "A process boundary changed.", value: "Independent validation before completion.",
	risk_evidence: ["Original evidence line one", "Original evidence line two"],
	choices: [
		{ answer: "granted", label: "Run the review now", effect: "Only this candidate; no session permission.", invocation: "gentle-ai review start --target sha256:exact-frozen-candidate --consent granted" },
		{ answer: "declined", label: "Not now, just this once", effect: "No lineage or receipt; not the kill switch.", invocation: "gentle-ai review start --target sha256:exact-frozen-candidate --consent declined" },
	],
	off_path: { note: "Manual off-path setting, never executed here.", command: "gentle-ai review mode disable" },
};
const message = JSON.stringify(consent, null, 2);

test("RDD consent preserves its full provider body and two exact answers inline and in a dismissible popup", async ({ page }) => {
	let round = 1;
	const answers: unknown[] = [];
	const expiresAt = new Date(Date.now() + 600_000).toISOString();
	await page.addInitScript(({ origin, token }) => {
		window.__mobileShellFixture = { connection: { url: origin, token, deviceId: "fixture-phone", name: "Mi equipo" }, monitoring: true, calls: [] };
	}, { origin, token });
	await page.route(`${origin}/**`, async route => {
		const path = new URL(route.request().url()).pathname;
		const action = route.request().method() === "POST" ? route.request().postDataJSON() : undefined;
		let body: object = { approvals: [], pending: 0, enabled: false };
		if (path === "/orchestration") {
			if (action?.action === "inspect") body = { sessionId: "s", status: "waiting", question: null, messages: [] };
			else {
				if (action?.action === "answer") { answers.push(action); round++; }
				body = {
					available: true,
					sessions: [{ paneId: "p", sessionId: "s", terminalId: "t", workspaceId: "w", label: "RDD owner", state: "blocked", connected: true, managed: true }],
					approvals: round <= 2 ? [{ id: `review-${round}`, paneId: "p", sessionId: "s", title: consent.headline, message, action: "question", kind: "select", answerable: true, createdAt: new Date().toISOString(), expiresAt, options: consent.choices.map(choice => ({ id: choice.answer, label: `${choice.label}\nEffect: ${choice.effect}` })) }] : [],
					policies: [], events: [],
				};
			}
		}
		await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
	});
	await page.routeWebSocket(`${origin.replace("https:", "wss:")}/ws`, socket => {
		let seq = 0;
		socket.onMessage(raw => {
			const command = JSON.parse(String(raw));
			if (command.type === "hello") socket.send(JSON.stringify({ type: "ready", agentState: "idle", model: "Gentle", seq: ++seq }));
			if (command.type === "get_history") socket.send(JSON.stringify({ type: "history", messages: [], seq: ++seq }));
		});
	});
	await page.goto("/");
	await page.getByRole("button", { name: "Sesiones", exact: true }).click();
	await page.getByRole("button", { name: /RDD owner ·/ }).click();
	const detail = page.getByRole("region", { name: "Detalle de la solicitud" });
	await expect(detail.locator("pre")).toHaveText(message, { useInnerText: false });
	await expect(page.getByRole("radio")).toHaveCount(2);
	await expect(page.getByText("Review and allow this session", { exact: true })).toHaveCount(0);
	await page.getByRole("radio", { name: /Run the review now/ }).check();
	await page.getByRole("button", { name: "Enviar respuesta" }).click();
	await expect.poll(() => answers).toEqual([{ action: "answer", paneId: "p", sessionId: "s", requestId: "review-1", optionId: "granted" }]);
	await page.getByRole("button", { name: "Ajustes", exact: true }).click();
	await page.getByRole("radio", { name: "Ventana emergente con respuestas" }).check();
	const dialog = page.getByRole("dialog", { name: "Solicitudes pendientes", exact: true });
	await expect(dialog).toBeVisible();
	await expect(dialog.getByRole("button", { name: "Cerrar sin responder" })).toBeFocused();
	await expect(dialog.getByRole("region", { name: "Detalle de la solicitud" }).locator("pre")).toHaveText(message, { useInnerText: false });
	await expect(dialog.getByRole("radio")).toHaveCount(2);
	await dialog.getByRole("button", { name: "Cerrar sin responder" }).click();
	expect(answers).toHaveLength(1);
	await page.getByRole("button", { name: /Ver solicitudes pendientes/ }).click();
	await page.emulateMedia({ reducedMotion: "reduce" });
	for (const size of [{ width: 375, height: 820 }, { width: 780, height: 390 }]) {
		await page.setViewportSize(size);
		await expect(dialog.getByRole("button", { name: "Cerrar sin responder" })).toBeInViewport();
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
	}
	await dialog.getByRole("radio", { name: /Not now, just this once/ }).check();
	await dialog.getByRole("button", { name: "Enviar respuesta" }).click();
	await expect.poll(() => answers).toEqual([
		{ action: "answer", paneId: "p", sessionId: "s", requestId: "review-1", optionId: "granted" },
		{ action: "answer", paneId: "p", sessionId: "s", requestId: "review-2", optionId: "declined" },
	]);
	await expect(dialog).toHaveCount(0);
});
