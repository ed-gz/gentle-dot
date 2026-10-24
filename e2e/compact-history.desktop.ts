import { expect, type Page, test } from "@playwright/test";

const origin = "https://compact-desktop.fixture.test";
const item = (index: number) => ({
	id: `m${index}`,
	role: index % 2 ? "assistant" : "user",
	text:
		index % 2
			? `### Resultado ${index}\n\nEl trabajo continúa en segundo plano. Este mensaje conserva su lugar mientras llegan otras respuestas.\n\nDetalle del objetivo ${index}.`
			: `Revisa el objetivo ${index} y avísame al terminar.`,
	activities: [],
});
async function mount(page: Page) {
	const errors: string[] = [];
	const commands: Record<string, unknown>[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.addInitScript(
		({ origin }) => {
			let id = 0;
			Object.assign(window, {
				isTauri: true,
				__TAURI_INTERNALS__: {
					metadata: { currentWindow: { label: "panel" }, currentWebview: { label: "panel" } },
					transformCallback: () => ++id,
					unregisterCallback: () => {},
					invoke: (command: string) => {
						if (command === "connection_info")
							return Promise.resolve({
								url: `${origin.replace("https:", "wss:")}/ws`,
								token: "fixture-only",
							});
						if (command === "computer_status") return Promise.resolve({});
						if (command === "rose_hidden") return Promise.resolve(false);
						if (command === "plugin:event|listen") return Promise.resolve(++id);
						return Promise.resolve(null);
					},
				},
				__TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
			});
		},
		{ origin },
	);
	await page.route(`${origin}/**`, (route) =>
		route.fulfill({ json: {}, headers: { "Access-Control-Allow-Origin": "*" } }),
	);
	let emit: (event: object) => void = () => {};
	await page.routeWebSocket(`${origin.replace("https:", "wss:")}/ws`, (socket) => {
		let seq = 0;
		emit = (event) => socket.send(JSON.stringify({ ...event, seq: ++seq }));
		socket.onMessage((raw) => {
			const command = JSON.parse(String(raw)) as Record<string, unknown>;
			commands.push(command);
			if (command.type === "hello")
				emit({
					type: "ready",
					agentState: "thinking",
					clientId: "desktop-test",
					features: { conversations: false, historyRefresh: true },
					model: "Gentle",
					conversationId: "continuous",
				});
			if (command.type === "get_history" && !command.requestId)
				emit({
					type: "history",
					conversationId: "continuous",
					hasEarlier: true,
					messages: Array.from({ length: 300 }, (_, index) => item(index)),
				});
			if (command.type === "get_earlier")
				emit({
					type: "earlier",
					before: command.before,
					hasEarlier: false,
					messages: Array.from({ length: 100 }, (_, index) => item(index - 100)),
				});
			if (command.type === "auth_list")
				emit({
					type: "auth_providers",
					providers: [{ id: "openai-codex", name: "Codex", configured: true, methods: ["oauth"] }],
				});
		});
	});
	await page.goto("/?surface=panel&effects=none");
	await expect(page.locator('[data-message-id="m299"]')).toBeAttached();
	return { emit, errors, commands };
}
const transcript = (page: Page) => page.locator(".chat-transcript");

test("compact desktop preserves content, opens secondary options and stays within narrow and expanded panels", async ({
	page,
}, info) => {
	await page.setViewportSize({ width: 420, height: 760 });
	const fixture = await mount(page);
	for (const width of [320, 420, 1120]) {
		await page.setViewportSize({ width, height: 760 });
		await expect(page.getByRole("heading", { name: "Gentle Dot", exact: true })).toBeVisible();
		await expect(page.getByRole("button", { name: "Accounts", exact: true })).toHaveCount(0);
		expect(await page.locator(".chat-header button").count()).toBe(3);
		expect(
			await page.locator(".chat-header").evaluate((node) => node.getBoundingClientRect().height),
		).toBeLessThan(70);
		await page.screenshot({ path: info.outputPath(`compact-dot-${width}.png`) });
		await page.getByRole("button", { name: "Options", exact: true }).click();
		for (const name of ["Accounts", "Profiles", "Connectors", "Settings", "Hide the rose"])
			await expect(page.getByRole("button", { name, exact: true })).toBeInViewport();
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
		const menu = await page.locator(".desktop-options-panel").boundingBox();
		expect(menu?.x).toBeGreaterThanOrEqual(0);
		await page.screenshot({ path: info.outputPath(`compact-options-${width}.png`) });
		await page.keyboard.press("Escape");
		await expect(page.getByRole("button", { name: "Options", exact: true })).toBeFocused();
	}
	expect(fixture.errors).toEqual([]);
});

test("hundreds of live messages keep bounded DOM, selected reading anchor, accessible history and current approvals", async ({
	page,
}) => {
	await page.setViewportSize({ width: 420, height: 760 });
	const fixture = await mount(page);
	await expect(page.locator("[data-message-id]")).toHaveCount(120);
	const anchor = page.locator('[data-message-id="m221"] .message-body p').first();
	await transcript(page).evaluate((viewport) => {
		const node = viewport.querySelector('[data-message-id="m221"]');
		if (node)
			viewport.scrollTop += node.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 30;
	});
	await expect(page.getByRole("button", { name: "Jump to latest" })).toBeVisible();
	await anchor.evaluate((node) => {
		const range = document.createRange();
		range.selectNodeContents(node);
		getSelection()?.removeAllRanges();
		getSelection()?.addRange(range);
	});
	const before = await anchor.evaluate((node) => node.getBoundingClientRect().top);
	const selected = await page.evaluate(() => getSelection()?.toString());
	for (let index = 300; index < 500; index++)
		fixture.emit({
			type: "message_done",
			messageId: `m${index}`,
			text: item(index).text,
			intermediate: true,
		});
	await expect(page.getByRole("button", { name: "Show newer" })).toBeVisible();
	await expect(page.locator("[data-message-id]")).toHaveCount(120);
	expect(await page.evaluate(() => getSelection()?.toString())).toBe(selected);
	expect(
		Math.abs((await anchor.evaluate((node) => node.getBoundingClientRect().top)) - before),
	).toBeLessThanOrEqual(2);
	await page.getByRole("button", { name: "Jump to latest" }).click();
	await expect(page.locator('[data-message-id="m499"]')).toBeInViewport();
	await expect(page.locator("[data-message-id]")).toHaveCount(120);
	await page.getByRole("textbox", { name: "Message", exact: true }).fill("Conserva este borrador");
	for (let index = 0; index < 6; index++) {
		await transcript(page).evaluate((node) => {
			node.scrollTop = 0;
		});
		const button = page.getByRole("button", { name: "Show earlier", exact: true });
		if (!(await button.count())) break;
		await button.click();
		await expect.poll(() => page.locator("[data-message-id]").count()).toBeLessThanOrEqual(120);
	}
	await expect(page.locator('[data-message-id="m-100"]')).toBeAttached();
	expect(fixture.commands.filter((command) => command.type === "get_earlier")).toHaveLength(1);
	fixture.emit({
		type: "ask",
		ask: {
			method: "app",
			requestId: "app-test",
			title: "Confirmar publicación",
			message: "Solicitud de prueba",
		},
	});
	await expect(page.getByRole("button", { name: "Permitir", exact: true })).toBeAttached();
	await page.getByRole("button", { name: "Jump to latest" }).click();
	await expect(page.getByRole("button", { name: "Permitir", exact: true })).toBeInViewport();
	await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveValue(
		"Conserva este borrador",
	);
	expect(fixture.errors).toEqual([]);
});

test("a slow background history response never replaces a selection made while it was in flight", async ({
	page,
}) => {
	await page.setViewportSize({ width: 420, height: 760 });
	const fixture = await mount(page);
	for (let index = 300; index < 500; index++)
		fixture.emit({
			type: "message_done",
			messageId: `m${index}`,
			text: item(index).text,
			intermediate: true,
		});
	await expect(page.locator('[data-message-id="m499"]')).toBeInViewport();
	fixture.emit({ type: "agent_state", state: "idle" });
	await expect
		.poll(
			() => fixture.commands.filter((command) => command.type === "get_history" && command.requestId).length,
		)
		.toBe(1);
	const request = fixture.commands.find((command) => command.type === "get_history" && command.requestId);
	const anchor = page.locator('[data-message-id="m421"] .message-body p').first();
	await transcript(page).evaluate((viewport) => {
		const node = viewport.querySelector('[data-message-id="m421"]');
		if (node)
			viewport.scrollTop += node.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 30;
	});
	await expect(page.getByRole("button", { name: "Jump to latest" })).toBeVisible();
	await anchor.evaluate((node) => {
		const range = document.createRange();
		range.selectNodeContents(node);
		getSelection()?.removeAllRanges();
		getSelection()?.addRange(range);
	});
	const before = await anchor.evaluate((node) => node.getBoundingClientRect().top);
	const selected = await page.evaluate(() => getSelection()?.toString());
	fixture.emit({
		type: "history",
		requestId: request?.requestId,
		conversationId: "continuous",
		hasEarlier: true,
		messages: Array.from({ length: 100 }, (_, index) => ({ ...item(index + 400), id: `h${index + 400}` })),
	});
	await expect(page.locator('[data-message-id="m421"]')).toBeAttached();
	await expect(page.locator('[data-message-id="h421"]')).toHaveCount(0);
	expect(await page.evaluate(() => getSelection()?.toString())).toBe(selected);
	expect(
		Math.abs((await anchor.evaluate((node) => node.getBoundingClientRect().top)) - before),
	).toBeLessThanOrEqual(2);
	expect(fixture.errors).toEqual([]);
});
