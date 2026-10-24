import { expect, type Page, test } from "@playwright/test";

// The APK entry point and chat are real. Only the native boundary and server are fixtures.
const origin = "https://mobile-fixture.test.ts.net";
const token = "fixture_mobile_token_0123456789abcdef";
const paragraph =
	"Revisa este párrafo con calma. Los resultados nuevos deben aparecer al final sin mover el punto donde estás leyendo. El equipo continúa trabajando mientras consultas la conversación.";
interface FixtureMessage {
	id: string;
	role: "user" | "assistant";
	text: string;
	activities: { id: string; kind: "other"; title: string; status: "done" }[];
}
const initialHistory: FixtureMessage[] = Array.from({ length: 9 }, (_, index) => [
	{
		id: `user-${index}`,
		role: "user" as const,
		text: `Revisa la parte ${index + 1} del proyecto.`,
		activities: [],
	},
	{
		id: `tools-${index}`,
		role: "assistant" as const,
		text: "",
		activities: [
			{ id: `tool-${index}`, kind: "other" as const, title: "Paso interno", status: "done" as const },
		],
	},
	{
		id: `answer-${index}`,
		role: "assistant" as const,
		text: `### Punto de lectura ${index + 1}\n\n${paragraph}\n\n${paragraph}`,
		activities: [],
	},
]).flat();

async function mountChat(page: Page, history: FixtureMessage[] = initialHistory) {
	const commands: Record<string, unknown>[] = [];
	const errors: string[] = [];
	const http: { path: string; body?: unknown }[] = [];
	let approvals: { id: string; title: string; message: string; expiresAt: string }[] = [];
	let emit: (data: object) => void = () => {
		throw new Error("The fixture websocket is not connected");
	};
	page.on("pageerror", (error) => errors.push(error.message));
	await page.setViewportSize({ width: 375, height: 812 });
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
	await page.route(`${origin}/**`, async (route) => {
		const request = route.request();
		const path = new URL(request.url()).pathname;
		const body = request.postData() ? request.postDataJSON() : undefined;
		http.push({ path, body });
		if (path === "/api/mobile/answer") {
			approvals = [];
			emit({ type: "ask_resolved", requestId: "ask-private-permission" });
		}
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify(
				path === "/orchestration"
					? { available: true, sessions: [], approvals: [], policies: [], events: [] }
					: path === "/api/mobile/approvals"
						? { approvals }
						: { approvals: [], workflows: [], pending: 0, enabled: false },
			),
		});
	});
	await page.routeWebSocket(`${origin.replace("https:", "wss:")}/ws`, (socket) => {
		let seq = 0;
		emit = (data) => socket.send(JSON.stringify({ ...data, seq: ++seq }));
		socket.onMessage((raw) => {
			const command = JSON.parse(String(raw)) as Record<string, unknown>;
			commands.push(command);
			if (command.type === "hello")
				emit({ type: "ready", agentState: "idle", model: "Gentle", conversationId: "scroll-fixture" });
			if (command.type === "get_history")
				emit({
					type: "history",
					conversationId: "scroll-fixture",
					messages: history,
					hasEarlier: true,
				});
			if (command.type === "auth_list")
				emit({
					type: "auth_providers",
					providers: [{ id: "openai-codex", name: "Codex", configured: true, methods: ["oauth"] }],
				});
			// Pagination is deliberately deferred until the test records its reading anchor.
		});
	});
	await page.goto("/");
	await expect(page.getByRole("textbox", { name: "Mensaje", exact: true })).toBeEnabled();
	await expect(page.getByRole("heading", { name: "Punto de lectura 9", exact: true })).toBeAttached();
	await expect.poll(() => distanceFromEnd(page)).toBeLessThanOrEqual(4);
	return {
		emit: (data: object) => emit(data),
		commands,
		errors,
		http,
		requestPermission: () => {
			approvals = [
				{
					id: "private-permission",
					title: "Publicar cambios preparados",
					message: "Repositorio: proyecto de prueba\nAcción: publicar los cambios revisados",
					expiresAt: new Date(Date.now() + 60_000).toISOString(),
				},
			];
			emit({ type: "agent_state", state: "needs_you" });
			emit({
				type: "ask",
				ask: {
					requestId: "ask-private-permission",
					method: "app",
					title: "Necesito permiso para continuar",
					message: "Puedes revisar y responder desde el teléfono vinculado.",
				},
			});
		},
	};
}

const conversation = (page: Page) => page.locator(".chat-body.chat-transcript:not([hidden])");
const distanceFromEnd = (page: Page) =>
	conversation(page).evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop);
const screenTop = (page: Page, name: string) =>
	page.getByRole("heading", { name, exact: true }).evaluate((element) => element.getBoundingClientRect().top);

function steps(emit: (data: object) => void) {
	for (let index = 0; index < 3; index++) {
		emit({
			type: "activity",
			messageId: `live-tool-${index}`,
			activity: { id: `step-${index}`, kind: "other", title: "Paso interno", status: "running" },
		});
		emit({
			type: "activity",
			messageId: `live-tool-${index}`,
			activity: { id: `step-${index}`, kind: "other", title: "Paso interno", status: "done" },
		});
		emit({ type: "message_done", messageId: `live-tool-${index}`, text: "" });
	}
}

test("phone streaming keeps the reading position and resumes following only on request", async ({
	page,
}, info) => {
	const { emit, errors } = await mountChat(page);
	await expect.poll(() => distanceFromEnd(page)).toBeLessThanOrEqual(4);
	// Internal-only history produces no empty articles or repeated completed-step cards.
	await expect(page.locator(".messages > .message")).toHaveCount(18);
	await expect(page.getByText(/Completó \d+ pasos?/)).toHaveCount(0);
	emit({ type: "agent_state", state: "working" });
	steps(emit);
	await expect(page.getByText("Trabajando…", { exact: true })).toHaveCount(1);
	await expect(page.locator(".messages > .message")).toHaveCount(18);
	const firstChunk = `### Respuesta en curso\n\n${paragraph}`;
	emit({ type: "message_delta", messageId: "streamed-answer", delta: firstChunk });
	await expect(page.getByRole("heading", { name: "Respuesta en curso" })).toBeVisible();
	await expect.poll(() => distanceFromEnd(page)).toBeLessThanOrEqual(4);
	await page.getByRole("heading", { name: "Punto de lectura 4", exact: true }).scrollIntoViewIfNeeded();
	const jump = page.getByRole("button", { name: "Volver al final", exact: true });
	await expect(jump).toBeVisible();
	const before = await screenTop(page, "Punto de lectura 4");
	const scrollBefore = await conversation(page).evaluate((element) => element.scrollTop);
	const extra = `\n\n${paragraph}\n\n${paragraph}\n\nNueva información recibida.`;
	emit({ type: "message_delta", messageId: "streamed-answer", delta: extra });
	await expect(page.getByText("Nueva información recibida.", { exact: true })).toBeAttached();
	expect(Math.abs((await screenTop(page, "Punto de lectura 4")) - before)).toBeLessThanOrEqual(2);
	expect(
		Math.abs((await conversation(page).evaluate((element) => element.scrollTop)) - scrollBefore),
	).toBeLessThanOrEqual(2);
	await expect(jump).toBeInViewport();
	await page.screenshot({ path: info.outputPath("apk-chat-reading-preserved.png") });
	await jump.click();
	await expect.poll(() => distanceFromEnd(page)).toBeLessThanOrEqual(4);
	await expect(jump).toBeHidden();
	emit({ type: "message_delta", messageId: "streamed-answer", delta: "\n\nÚltimo párrafo del turno." });
	await expect(page.getByText("Último párrafo del turno.", { exact: true })).toBeVisible();
	await expect.poll(() => distanceFromEnd(page)).toBeLessThanOrEqual(4);
	await page.screenshot({ path: info.outputPath("apk-chat-working-clean.png") });
	emit({
		type: "message_done",
		messageId: "streamed-answer",
		text: `${firstChunk}${extra}\n\nÚltimo párrafo del turno.`,
	});
	emit({ type: "agent_state", state: "idle" });
	await expect(page.getByText("Trabajando…", { exact: true })).toHaveCount(0);
	await expect(page.locator(".messages > .message")).toHaveCount(19);
	await expect(page.getByText(/Completó \d+ pasos?/)).toHaveCount(0);
	expect(
		await page
			.locator(".messages > .message")
			.evaluateAll((items) => items.every((item) => (item.textContent ?? "").trim().length > 0)),
	).toBe(true);
	expect(errors).toEqual([]);
});

test("loading earlier phone messages preserves the first visible message as an anchor", async ({
	page,
}, info) => {
	const { emit, commands, errors } = await mountChat(page);
	const earlier = page.getByRole("button", { name: "Ver mensajes anteriores", exact: true });
	await earlier.scrollIntoViewIfNeeded();
	await earlier.click();
	await expect.poll(() => commands.filter((command) => command.type === "get_earlier").length).toBe(1);
	const request = commands.find((command) => command.type === "get_earlier");
	expect(request?.before).toBe("user-0");
	const anchor = page.getByText("Revisa la parte 1 del proyecto.", { exact: true });
	const before = await anchor.evaluate((element) => element.getBoundingClientRect().top);
	emit({
		type: "earlier",
		before: request?.before,
		hasEarlier: false,
		messages: [
			{
				id: "older-user",
				role: "user",
				text: "Este mensaje estaba en una página anterior.",
				activities: [],
				earlier: true,
			},
			{
				id: "older-tools",
				role: "assistant",
				text: "",
				activities: [{ id: "older-step", kind: "other", title: "Paso anterior", status: "done" }],
				earlier: true,
			},
			{
				id: "older-answer",
				role: "assistant",
				text: `### Página anterior\n\n${paragraph}\n\n${paragraph}`,
				activities: [],
				earlier: true,
			},
		],
	});
	await expect(page.getByRole("heading", { name: "Página anterior", exact: true })).toBeAttached();
	await expect(earlier).toHaveCount(0);
	await expect
		.poll(async () =>
			Math.abs((await anchor.evaluate((element) => element.getBoundingClientRect().top)) - before),
		)
		.toBeLessThanOrEqual(2);
	await expect(page.locator(".messages > .message")).toHaveCount(20);
	await expect(page.getByText(/Completó \d+ pasos?/)).toHaveCount(0);
	await page.screenshot({ path: info.outputPath("apk-chat-earlier-anchor.png") });
	expect(errors).toEqual([]);
});

test("an arriving permission stays available without pulling the phone away from the current reading", async ({
	page,
}, info) => {
	const { requestPermission, http, errors } = await mountChat(page);
	await page.getByRole("heading", { name: "Punto de lectura 4", exact: true }).scrollIntoViewIfNeeded();
	const jump = page.getByRole("button", { name: "Volver al final", exact: true });
	await expect(jump).toBeVisible();
	const before = await screenTop(page, "Punto de lectura 4");
	requestPermission();
	const approval = page.getByRole("heading", { name: "Publicar cambios preparados", exact: true });
	await expect(approval).toBeAttached();
	await expect(approval).not.toBeInViewport();
	expect(Math.abs((await screenTop(page, "Punto de lectura 4")) - before)).toBeLessThanOrEqual(2);
	expect(http.filter((request) => request.path === "/api/mobile/answer")).toHaveLength(0);
	await jump.click();
	await expect(page.getByRole("button", { name: "Rechazar permiso de Dot" })).toBeInViewport();
	await page.screenshot({ path: info.outputPath("apk-chat-permission-on-request.png") });
	await page.getByRole("button", { name: "Rechazar permiso de Dot" }).click();
	await expect(approval).toHaveCount(0);
	expect(http.find((request) => request.path === "/api/mobile/answer")?.body).toEqual({
		requestId: "private-permission",
		approved: false,
	});
	expect(errors).toEqual([]);
});

test("returning from Agents preserves the phone reading position after updates while hidden", async ({
	page,
}, info) => {
	const { emit, errors } = await mountChat(page);
	await page.getByRole("heading", { name: "Punto de lectura 4", exact: true }).scrollIntoViewIfNeeded();
	await expect(page.getByRole("button", { name: "Volver al final", exact: true })).toBeVisible();
	const before = await screenTop(page, "Punto de lectura 4");
	await page.getByRole("button", { name: "Sesiones", exact: true }).click();
	await expect(page.locator(".chat-transcript")).toBeHidden();
	emit({ type: "agent_state", state: "working" });
	emit({
		type: "message_delta",
		messageId: "hidden-answer",
		delta: `### Respuesta recibida mientras consultabas agentes\n\n${paragraph}\n\n${paragraph}`,
	});
	await expect(
		page.getByRole("heading", {
			name: "Respuesta recibida mientras consultabas agentes",
			includeHidden: true,
		}),
	).toBeAttached();
	await page.getByRole("button", { name: "Dot", exact: true }).click();
	await expect(conversation(page)).toBeVisible();
	await expect
		.poll(async () => Math.abs((await screenTop(page, "Punto de lectura 4")) - before))
		.toBeLessThanOrEqual(2);
	await expect(page.getByRole("button", { name: "Volver al final", exact: true })).toBeVisible();
	await page.screenshot({ path: info.outputPath("apk-chat-return-preserved.png") });
	expect(errors).toEqual([]);
});

test("a late image above the phone reading anchor does not move the text being read", async ({
	page,
}, info) => {
	const imageUrl = "https://images.fixture.test/late-preview.svg";
	let releaseImage: (() => Promise<void>) | undefined;
	await page.route(imageUrl, (route) => {
		releaseImage = () =>
			route.fulfill({
				status: 200,
				contentType: "image/svg+xml",
				body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="900"><rect width="640" height="900" fill="#e95892"/></svg>',
			});
	});
	const history = initialHistory.map((message) =>
		message.id === "answer-2"
			? { ...message, text: `${message.text}\n\n![Vista previa demorada](${imageUrl})` }
			: message,
	);
	const { errors } = await mountChat(page, history);
	await page
		.getByRole("button", { name: "Ampliar Vista previa demorada", exact: true })
		.scrollIntoViewIfNeeded();
	await expect.poll(() => Boolean(releaseImage)).toBe(true);
	await page.getByRole("heading", { name: "Punto de lectura 6", exact: true }).scrollIntoViewIfNeeded();
	await expect(page.getByRole("button", { name: "Volver al final", exact: true })).toBeVisible();
	const before = await screenTop(page, "Punto de lectura 6");
	await releaseImage?.();
	await expect
		.poll(() =>
			page
				.getByRole("img", { name: "Vista previa demorada", exact: true })
				.evaluate((image: HTMLImageElement) => image.naturalHeight),
		)
		.toBe(900);
	await expect
		.poll(async () => Math.abs((await screenTop(page, "Punto de lectura 6")) - before))
		.toBeLessThanOrEqual(2);
	await page.screenshot({ path: info.outputPath("apk-chat-image-anchor.png") });
	expect(errors).toEqual([]);
});
