import { expect, test } from "@playwright/test";

declare global {
	interface Window {
		__desktopApprovalFixture: {
			calls: { command: string; args: Record<string, unknown> }[];
			finish(): void;
		};
	}
}

const origin = "https://desktop-approval.fixture.test";
const preview = `Gentle Dot solicita abrir una página en el navegador dedicado.\n\nSitio: https://example.test/revision\nAcción: consultar el estado del proyecto\n\n${"Detalle de prueba sin cuentas ni archivos privados. ".repeat(90)}\n\nFin de la solicitud completa.`;

test("desktop permissions expose the complete preview and answer exactly once through native IPC", async ({
	page,
}, info) => {
	const errors: string[] = [];
	const webSocketMessages: Record<string, unknown>[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.addInitScript(
		({ origin }) => {
			let callbackId = 0;
			let finish: (() => void) | undefined;
			window.__desktopApprovalFixture = {
				calls: [],
				finish: () => {
					finish?.();
					finish = undefined;
				},
			};
			Object.assign(window, {
				isTauri: true,
				__TAURI_INTERNALS__: {
					metadata: { currentWindow: { label: "panel" }, currentWebview: { label: "panel" } },
					transformCallback: () => ++callbackId,
					unregisterCallback: () => {},
					invoke: (command: string, args: Record<string, unknown> = {}) => {
						window.__desktopApprovalFixture.calls.push({ command, args });
						if (command === "connection_info")
							return Promise.resolve({
								url: `${origin.replace("https:", "wss:")}/ws`,
								token: "fixture-desktop-token",
							});
						if (command === "computer_status") return Promise.resolve({});
						if (command === "computer_endpoint") return Promise.resolve(null);
						if (command === "rose_hidden") return Promise.resolve(false);
						if (command === "plugin:event|listen") return Promise.resolve(++callbackId);
						if (command === "connector_command")
							return new Promise<void>((resolve) => {
								finish = resolve;
							});
						return Promise.resolve(null);
					},
				},
				__TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
			});
		},
		{ origin },
	);
	await page.route(`${origin}/**`, (route) =>
		route.fulfill({ status: 200, json: {}, headers: { "Access-Control-Allow-Origin": "*" } }),
	);
	let publish: (event: object) => void = () => {};
	await page.routeWebSocket(`${origin.replace("https:", "wss:")}/ws`, (socket) => {
		let seq = 0;
		publish = (event) => socket.send(JSON.stringify({ ...event, seq: ++seq }));
		socket.onMessage((raw) => {
			const command = JSON.parse(String(raw)) as Record<string, unknown>;
			webSocketMessages.push(command);
			if (command.type === "hello")
				publish({
					type: "ready",
					agentState: "needs_you",
					clientId: "fixture-desktop-window",
					model: "Gentle",
				});
			if (command.type === "get_history") {
				publish({ type: "history", messages: [] });
				publish({
					type: "ask",
					ask: {
						requestId: "app-first",
						method: "app",
						title: "Abrir el navegador",
						message: preview,
						expiresAt: new Date(Date.now() + 120_000).toISOString(),
					},
				});
			}
			if (command.type === "auth_list")
				publish({
					type: "auth_providers",
					providers: [{ id: "fixture", name: "Fixture", configured: true, methods: ["oauth"] }],
				});
		});
	});
	await page.setViewportSize({ width: 1120, height: 860 });
	await page.goto("/?surface=panel&effects=none");
	const card = page.getByRole("region", { name: "Permiso de Gentle Dot", exact: true });
	await expect(card).toBeVisible();
	await expect(card.getByRole("region", { name: "Detalles de la solicitud", exact: true })).toHaveText(
		preview,
	);
	for (const width of [1120, 320]) {
		await page.setViewportSize({ width, height: 860 });
		await card.scrollIntoViewIfNeeded();
		await expect(card.getByRole("button", { name: "Permitir", exact: true })).toBeInViewport();
		await expect(card.getByRole("button", { name: "Rechazar", exact: true })).toBeInViewport();
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
		expect(await card.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
		await page.screenshot({ path: info.outputPath(`desktop-approval-${width}.png`) });
	}
	await card.getByRole("button", { name: "Permitir", exact: true }).click();
	await expect(card).toHaveAttribute("aria-busy", "true");
	await expect(card.getByRole("status")).toHaveText("Enviando respuesta…");
	await expect(card.getByRole("button", { name: "Permitir", exact: true })).toBeDisabled();
	await expect(card.getByRole("button", { name: "Rechazar", exact: true })).toBeDisabled();
	await card
		.getByRole("button", { name: "Permitir", exact: true })
		.evaluate((node: HTMLButtonElement) => node.click());
	await page.evaluate(() => window.__desktopApprovalFixture.finish());
	await expect(card.getByRole("status")).toHaveText("Permiso concedido.");
	publish({ type: "ask_resolved", requestId: "app-first" });
	await expect(card).toHaveCount(0);
	publish({
		type: "ask",
		ask: {
			requestId: "app-second",
			method: "app",
			title: "Segunda solicitud",
			message: "Solicitud de prueba que será rechazada.",
		},
	});
	await card.getByRole("button", { name: "Rechazar", exact: true }).click();
	await page.evaluate(() => window.__desktopApprovalFixture.finish());
	await expect(card.getByRole("status")).toHaveText("Permiso rechazado.");
	const calls = await page.evaluate(() =>
		window.__desktopApprovalFixture.calls.filter((call) => call.command === "connector_command"),
	);
	expect(calls).toEqual([
		{
			command: "connector_command",
			args: {
				clientId: "fixture-desktop-window",
				message: { type: "app_approval_reply", requestId: "app-first", approved: true },
			},
		},
		{
			command: "connector_command",
			args: {
				clientId: "fixture-desktop-window",
				message: { type: "app_approval_reply", requestId: "app-second", approved: false },
			},
		},
	]);
	expect(
		webSocketMessages.filter(
			(message) => message.type === "ui_response" || message.type === "app_approval_reply",
		),
	).toHaveLength(0);
	expect(errors).toEqual([]);
});
