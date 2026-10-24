import { expect, test } from "@playwright/test";

const origin = "https://mobile-fixture.test.ts.net";
const token = "fixture_mobile_token_0123456789abcdef";
const message = [
	"## Revisión del proyecto",
	"",
	"El flujo ya tiene dos pasos completados.",
	"",
	"| Agente | Resultado | Siguiente paso |",
	"|---|---|---|",
	"| Implementación | Listo | Revisión cruzada |",
	"| Revisión | Sin bloqueos | Validar cambios |",
	"",
	"### Plan",
	"- [x] Revisar cambios",
	"- [x] Comprobar pruebas",
	"- [ ] Entregar resultado",
	"",
	"```mermaid",
	"flowchart TD",
	"A[Implementación] --> B[Revisión]",
	"B --> C{Pruebas correctas}",
	"C -->|Sí| D[Resultado]",
	"C -->|No| A",
	"```",
	"",
	"> El seguimiento permanece activo mientras los agentes trabajan.",
].join("\n");

test("rich chat renders readable tables, task lists and a real Mermaid diagram on mobile", async ({
	page,
}, testInfo) => {
	await page.addInitScript(
		({ origin, token }) => {
			window.__mobileShellFixture = {
				connection: { url: origin, token, deviceId: "fixture-phone", name: "Mi equipo" },
				monitoring: false,
				calls: [],
			};
		},
		{ origin, token },
	);
	await page.route(`${origin}/**`, (route) =>
		route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify(
				route.request().url().endsWith("/orchestration")
					? { available: true, sessions: [], approvals: [], policies: [], events: [] }
					: { approvals: [], workflows: [], pending: 0, enabled: false },
			),
		}),
	);
	await page.routeWebSocket(`${origin.replace("https:", "wss:")}/ws`, (socket) => {
		let seq = 0;
		const send = (data: object) => socket.send(JSON.stringify({ ...data, seq: ++seq }));
		socket.onMessage((raw) => {
			const command = JSON.parse(String(raw));
			if (command.type === "hello") send({ type: "ready", agentState: "idle", model: "Gentle" });
			if (command.type === "get_history")
				send({ type: "history", messages: [{ id: "a", role: "assistant", text: message, activities: [] }] });
			if (command.type === "auth_list")
				send({
					type: "auth_providers",
					providers: [{ id: "openai-codex", name: "Codex", configured: true, methods: ["oauth"] }],
				});
		});
	});
	await page.goto("/");
	const table = page.getByRole("region", { name: "Tabla", exact: true });
	await expect(table).toBeVisible();
	await expect(table.getByRole("columnheader")).toHaveCount(3);
	const diagram = page.getByRole("button", { name: "Ampliar diagrama" });
	await expect(diagram).toBeVisible({ timeout: 20000 });
	const image = diagram.getByRole("img");
	await expect.poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBeGreaterThan(0);
	await expect(page.locator(".message-body input[type=checkbox]:checked")).toHaveCount(2);
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
	await diagram.click();
	await expect(page.getByRole("dialog", { name: "Diagrama ampliado" })).toBeVisible();
	await page.getByRole("button", { name: "Cerrar diagrama" }).click();
	await expect(page.getByRole("dialog", { name: "Diagrama ampliado" })).toHaveCount(0);
	await table.scrollIntoViewIfNeeded();
	await page.screenshot({ path: testInfo.outputPath("apk-rich-chat.png"), fullPage: false });
	await page.setViewportSize({ width: 780, height: 390 });
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
	await page.screenshot({ path: testInfo.outputPath("apk-rich-chat-landscape.png"), fullPage: false });
});

test("private computer screenshots render once, load with authorization, and open in the mobile viewer", async ({
	page,
}, testInfo) => {
	// Synthetic chart with readable features: no desktop or user data is captured by this test.
	const picture = Buffer.from(
		await page.evaluate(() => {
			const canvas = document.createElement("canvas");
			canvas.width = 1400;
			canvas.height = 900;
			const context = canvas.getContext("2d");
			if (!context) throw new Error("Canvas unavailable");
			context.fillStyle = "#171923";
			context.fillRect(0, 0, 1400, 900);
			context.fillStyle = "#ff91b9";
			context.font = "bold 52px sans-serif";
			context.fillText("Gentle · Captura de prueba", 80, 100);
			context.fillStyle = "#f7f5f7";
			context.font = "30px sans-serif";
			context.fillText("Vista sintética para verificar zoom y desplazamiento", 80, 160);
			for (let n = 0; n < 6; n++) {
				context.fillStyle = n % 2 ? "#272b3b" : "#202432";
				context.fillRect(80, 220 + n * 94, 1240, 76);
				context.fillStyle = "#f7f5f7";
				context.fillText(`Detalle ${n + 1} · Resultado de revisión`, 110, 269 + n * 94);
				context.fillStyle = "#a7dfbd";
				context.fillRect(1050, 243 + n * 94, 200 - n * 20, 30);
			}
			return canvas.toDataURL("image/png").split(",")[1] ?? "";
		}),
		"base64",
	);
	const id = "C".repeat(43);
	const file = { id, name: "captura-equipo.png", size: picture.length, mime: "image/png", image: true };
	const text = `Aquí tienes la captura del equipo.\n\n![Captura del equipo](/api/files/${id}/content)\n\n[Descargar captura](/api/files/${id}/content)`;
	const fileRequests: { path: string; authorization: string | undefined }[] = [];
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.addInitScript(
		({ origin, token }) => {
			window.__mobileShellFixture = {
				connection: { url: origin, token, deviceId: "fixture-phone", name: "Mi equipo" },
				monitoring: false,
				calls: [],
			};
		},
		{ origin, token },
	);
	await page.route(`${origin}/**`, (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path.startsWith("/api/files/")) {
			const authorization = route.request().headers().authorization;
			fileRequests.push({ path, authorization });
			if (authorization !== `Bearer ${token}`) return route.fulfill({ status: 401 });
			if (path === `/api/files/${id}/meta`)
				return route.fulfill({
					status: 200,
					contentType: "application/json",
					headers: { "Access-Control-Allow-Origin": "*" },
					body: JSON.stringify(file),
				});
			if (path === `/api/files/${id}/content`)
				return route.fulfill({
					status: 200,
					contentType: file.mime,
					headers: { "content-length": String(file.size), "Access-Control-Allow-Origin": "*" },
					body: picture,
				});
			return route.fulfill({ status: 404 });
		}
		return route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify(
				path.endsWith("/orchestration")
					? { available: true, sessions: [], approvals: [], policies: [], events: [] }
					: { approvals: [], workflows: [], pending: 0, enabled: false },
			),
		});
	});
	await page.routeWebSocket(`${origin.replace("https:", "wss:")}/ws`, (socket) => {
		let seq = 0;
		const send = (data: object) => socket.send(JSON.stringify({ ...data, seq: ++seq }));
		socket.onMessage((raw) => {
			const command = JSON.parse(String(raw));
			if (command.type === "hello") send({ type: "ready", agentState: "idle", model: "Gentle" });
			if (command.type === "get_history")
				send({
					type: "history",
					messages: [
						{ id: "u", role: "user", text: "Mándame una captura del equipo", activities: [] },
						{ id: "a", role: "assistant", text, activities: [] },
					],
				});
			if (command.type === "auth_list")
				send({
					type: "auth_providers",
					providers: [{ id: "openai-codex", name: "Codex", configured: true, methods: ["oauth"] }],
				});
		});
	});
	await page.goto("/");
	const card = page.getByRole("group", { name: `Archivo: ${file.name}`, exact: true });
	await expect(card).toHaveCount(1);
	await expect(card).toBeVisible();
	const preview = card.getByRole("img", { name: "Captura del equipo", exact: true });
	await expect.poll(() => preview.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBeGreaterThan(0);
	await expect(page.getByText("Aquí tienes la captura del equipo.", { exact: true })).toBeVisible();
	expect(fileRequests.every((request) => request.authorization === `Bearer ${token}`)).toBe(true);
	expect(fileRequests.some((request) => request.path === `/api/files/${id}/meta`)).toBe(true);
	expect(fileRequests.filter((request) => request.path === `/api/files/${id}/content`)).toHaveLength(1);
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
	await page.screenshot({
		path: testInfo.outputPath("apk-private-computer-screenshot.png"),
		fullPage: false,
	});
	await expect(card.getByRole("button")).toHaveCount(1);
	await expect(card.getByText("Guardar archivo")).toHaveCount(0);
	await expect(card.getByText(file.name, { exact: true })).toHaveCount(0);
	const chatScroll = await page.locator(".messages").evaluate((node) => node.scrollTop);
	await card.getByRole("button", { name: `Ampliar ${file.name}` }).click();
	const viewer = page.getByRole("dialog", { name: file.name, exact: true });
	await expect(viewer).toBeVisible();
	await expect
		.poll(() => viewer.getByRole("img").evaluate((node: HTMLImageElement) => node.naturalWidth))
		.toBe(1400);
	const area = viewer.getByRole("region", { name: "Área de imagen" });
	const zoom = viewer.getByRole("group", { name: "Zoom de imagen" });
	const reset = zoom.getByRole("button", { name: "Ajustar imagen a la pantalla" });
	const box = await area.boundingBox();
	if (!box) throw new Error("Image viewport unavailable");
	const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
	const touch = await page.context().newCDPSession(page);
	const points = (spread: number) => [
		{ x: center.x - spread, y: center.y, id: 1 },
		{ x: center.x + spread, y: center.y, id: 2 },
	];
	await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: points(40) });
	await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: points(80) });
	await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
	await expect(reset).toHaveText("200%");
	const before = await area.evaluate((node) => ({ x: node.scrollLeft, y: node.scrollTop }));
	await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...center, id: 1 }] });
	await touch.send("Input.dispatchTouchEvent", {
		type: "touchMove",
		touchPoints: [{ x: center.x - 60, y: center.y - 40, id: 1 }],
	});
	await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
	await expect.poll(() => area.evaluate((node) => node.scrollLeft)).toBeGreaterThan(before.x);
	await reset.click();
	await expect(reset).toHaveText("100%");
	await expect(zoom.getByRole("button", { name: "Reducir imagen" })).toBeDisabled();
	await area.focus();
	for (let n = 0; n < 12; n++) await page.keyboard.press("+");
	await expect(reset).toHaveText("500%");
	await expect(zoom.getByRole("button", { name: "Ampliar imagen" })).toBeDisabled();
	await page.keyboard.press("0");
	await expect(reset).toHaveText("100%");
	await viewer.getByRole("button", { name: "Descargar imagen" }).click();
	await expect(viewer.getByRole("status")).toContainText("Archivo recibido");
	await viewer.getByRole("button", { name: "Compartir imagen" }).click();
	await expect(viewer.getByRole("status")).toContainText("menú para compartir");
	expect(
		await page.evaluate(() =>
			window.__mobileShellFixture.calls
				.filter((call) => call.method === "receiveFile")
				.map((call) => (call.options as { action: string }).action),
		),
	).toEqual(["save", "share"]);
	for (const viewport of [
		{ width: 375, height: 812 },
		{ width: 320, height: 740 },
		{ width: 780, height: 390 },
	]) {
		await page.setViewportSize(viewport);
		await expect(viewer).toBeVisible();
		expect(await viewer.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
		for (const button of await viewer.getByRole("button").all()) {
			const bounds = await button.boundingBox();
			if (!bounds) throw new Error("Viewer control unavailable");
			expect(bounds.width).toBeGreaterThanOrEqual(44);
			expect(bounds.height).toBeGreaterThanOrEqual(44);
			expect(bounds.x).toBeGreaterThanOrEqual(0);
			expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
		}
		await page.screenshot({
			path: testInfo.outputPath(`apk-image-viewer-${viewport.width}.png`),
			fullPage: false,
		});
	}
	await page.setViewportSize({ width: 375, height: 812 });
	await page.keyboard.press("Escape");
	await expect(viewer).toHaveCount(0);
	await expect(card).toHaveCount(1);
	await expect(card.getByRole("button")).toBeFocused();
	await card.getByRole("button").click();
	await page.evaluate(() => window.dispatchEvent(new Event("gentledot-back", { cancelable: true })));
	await expect(viewer).toHaveCount(0);
	// The viewer never transfers the preview again, even when zoomed or reopened.
	expect(fileRequests.filter((request) => request.path.endsWith("/content"))).toHaveLength(1);
	await page.setViewportSize({ width: 393, height: 851 });
	expect(await page.locator(".messages").evaluate((node) => node.scrollTop)).toBeGreaterThanOrEqual(
		Math.max(0, chatScroll - 100),
	);
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

	await page.evaluate(() =>
		localStorage.setItem(
			"gentle-dot-chat-appearance-v1",
			JSON.stringify({ version: 1, theme: "light", fontSize: 20 }),
		),
	);
	await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
	await page.setViewportSize({ width: 320, height: 740 });
	await page.reload();
	await card.getByRole("button", { name: `Ampliar ${file.name}` }).click();
	await expect(viewer).toBeVisible();
	await expect
		.poll(() => viewer.getByRole("img").evaluate((node: HTMLImageElement) => node.naturalWidth))
		.toBe(1400);
	expect(await viewer.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
	await page.screenshot({ path: testInfo.outputPath("apk-image-viewer-light-320.png"), fullPage: false });
	await page.setViewportSize({ width: 1280, height: 800 });
	await zoom.getByRole("button", { name: "Ampliar imagen" }).click();
	await area.focus();
	const scrollBeforeKey = await area.evaluate((node) => node.scrollLeft);
	await page.keyboard.press("ArrowRight");
	await expect.poll(() => area.evaluate((node) => node.scrollLeft)).toBeGreaterThan(scrollBeforeKey);
	await page.screenshot({ path: testInfo.outputPath("image-viewer-desktop-zoom.png"), fullPage: false });
	await viewer.getByRole("button", { name: "Cerrar imagen" }).click();
	await expect(viewer).toHaveCount(0);

	expect(errors).toEqual([]);
});

test("busy mobile composer replaces send with an inline stop icon and still sends follow-up messages", async ({
	page,
}, testInfo) => {
	const commands: Record<string, unknown>[] = [];
	const errors: string[] = [];
	let emit = (_event: object) => {};
	page.on("pageerror", (error) => errors.push(error.message));
	await page.addInitScript(
		({ origin, token }) => {
			window.__mobileShellFixture = {
				connection: { url: origin, token, deviceId: "fixture-phone", name: "Mi equipo" },
				monitoring: false,
				calls: [],
			};
		},
		{ origin, token },
	);
	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.route(`${origin}/**`, (route) =>
		route.fulfill({
			status: 200,
			contentType: "application/json",
			headers: { "Access-Control-Allow-Origin": "*" },
			body: JSON.stringify(
				route.request().url().endsWith("/orchestration")
					? { available: true, sessions: [], approvals: [], policies: [], events: [] }
					: { approvals: [], workflows: [], pending: 0, enabled: false },
			),
		}),
	);
	await page.routeWebSocket(`${origin.replace("https:", "wss:")}/ws`, (socket) => {
		let seq = 0;
		emit = (data) => socket.send(JSON.stringify({ ...data, seq: ++seq }));
		socket.onMessage((raw) => {
			const command = JSON.parse(String(raw)) as Record<string, unknown>;
			commands.push(command);
			if (command.type === "hello") emit({ type: "ready", agentState: "idle", model: "Gentle" });
			if (command.type === "get_history") emit({ type: "history", messages: [] });
			if (command.type === "auth_list")
				emit({
					type: "auth_providers",
					providers: [{ id: "openai-codex", name: "Codex", configured: true, methods: ["oauth"] }],
				});
			if (command.type === "abort") emit({ type: "agent_state", state: "idle" });
		});
	});
	await page.goto("/");
	const input = page.getByRole("textbox", { name: "Mensaje", exact: true });
	const send = page.getByRole("button", { name: "Enviar mensaje", exact: true });
	const stop = page.getByRole("button", { name: /^Detener/ });
	const composer = page.locator("form.composer");
	await expect(input).toBeEnabled();
	await expect(send).toBeVisible();
	const idleBounds = await composer.boundingBox();
	const sendBounds = await send.boundingBox();
	expect(idleBounds).not.toBeNull();
	expect(sendBounds).not.toBeNull();
	emit({ type: "agent_state", state: "working" });
	await expect(stop).toBeVisible();
	await expect(send).toHaveCount(0);
	await expect(input).toBeEnabled();
	await expect(stop.locator("svg")).toHaveCount(1);
	await expect(stop).toHaveText("");
	const busyBounds = await composer.boundingBox();
	const stopBounds = await stop.boundingBox();
	expect(busyBounds?.height).toBeCloseTo(idleBounds?.height ?? 0, 0);
	for (const key of ["x", "y", "width", "height"] as const)
		expect(stopBounds?.[key]).toBeCloseTo(sendBounds?.[key] ?? 0, 0);
	await page.screenshot({ path: testInfo.outputPath("apk-inline-stop.png"), fullPage: false });
	const originalViewport = page.viewportSize();
	for (const viewport of [
		{ width: 375, height: 812 },
		{ width: 780, height: 390 },
	]) {
		await page.setViewportSize(viewport);
		await expect(stop).toBeVisible();
		const compactComposer = await composer.boundingBox();
		const compactStop = await stop.boundingBox();
		expect(compactComposer?.height).toBeCloseTo(idleBounds?.height ?? 0, 0);
		expect(compactStop?.width).toBeGreaterThanOrEqual(44);
		expect(compactStop?.height).toBeGreaterThanOrEqual(44);
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
		await page.screenshot({
			path: testInfo.outputPath(`apk-inline-stop-${viewport.width}.png`),
			fullPage: false,
		});
	}
	if (originalViewport) await page.setViewportSize(originalViewport);
	await input.fill("Revisa también las pruebas");
	await expect(send).toBeEnabled();
	await expect(stop).toHaveCount(0);
	await input.fill("");
	await expect(stop).toBeVisible();
	await expect(send).toHaveCount(0);
	await input.fill("Continúa con las pruebas");
	await send.click();
	await expect.poll(() => commands.filter((command) => command.type === "send").length).toBe(1);
	expect(commands.find((command) => command.type === "send")?.text).toBe("Continúa con las pruebas");
	await expect(input).toHaveValue("");
	await expect(stop).toBeVisible();
	await stop.click();
	await expect.poll(() => commands.filter((command) => command.type === "abort").length).toBe(1);
	await expect(send).toBeVisible();
	await expect(stop).toHaveCount(0);
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
	expect(errors).toEqual([]);
});
