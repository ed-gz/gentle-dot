import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";

// Deliberately fictitious host/key: no daemon or user session participates in these tests.
const ORIGIN = "https://mobile-fixture.test.ts.net";
const TOKEN = "fixture_mobile_token_0123456789abcdef";
const CONNECTION = { url: ORIGIN, token: TOKEN, deviceId: "fixture-phone", name: "Mi equipo" };
const providers = [
	{
		id: "openai-codex",
		name: "OpenAI",
		configured: true,
		methods: ["oauth", "api_key"],
		oauthName: "ChatGPT",
		source: "stored",
	},
	{
		id: "anthropic",
		name: "Anthropic",
		configured: false,
		methods: ["oauth", "api_key"],
		oauthName: "Claude",
	},
];
const FILE_ID = "A".repeat(43);
const IMAGE_ID = "B".repeat(43);
const roseImage = readFileSync(new URL("../docs/brand/rose-source.png", import.meta.url));
const models = [{ provider: "openai-codex", id: "gpt-5.6-sol", name: "GPT-5.6 Sol", reasoning: true }];
const usage = {
	providers: [
		{
			id: "codex",
			label: "Codex",
			status: "ok",
			plan: "Pro",
			checkedAt: "2026-10-11T06:00:00Z",
			windows: [
				{
					id: "primary",
					label: "Semanal",
					usedPercent: 22,
					remainingPercent: 78,
					resetAt: new Date(Date.now() + 2 * 24 * 3_600_000).toISOString(),
					windowDurationMins: 10080,
				},
			],
		},
		{
			id: "claude",
			label: "Claude",
			status: "ok",
			plan: "Max",
			checkedAt: "2026-10-11T06:00:00Z",
			windows: [
				{
					id: "five_hour",
					label: "Sesión de 5 horas",
					usedPercent: 9,
					remainingPercent: 91,
					resetAt: new Date(Date.now() + 2 * 3_600_000 + 15 * 60_000).toISOString(),
					windowDurationMins: 300,
				},
				{
					id: "seven_day",
					label: "Semanal",
					usedPercent: 34,
					remainingPercent: 66,
					resetAt: new Date(Date.now() + 4 * 24 * 3_600_000).toISOString(),
					windowDurationMins: 10080,
				},
			],
		},
	],
};
const connectors = [
	{
		id: "github",
		name: "GitHub",
		reads: "Repositorios, cambios y revisiones",
		sends: "Publicar cambios con tu permiso",
		added: true,
		enabled: true,
		mode: "read_only",
		status: "connected",
	},
	{
		id: "calendar",
		name: "Calendario",
		reads: "Eventos y disponibilidad",
		sends: "Crear eventos con tu permiso",
		added: false,
		enabled: false,
		mode: "read_only",
		status: "off",
	},
];
const history = {
	type: "history",
	messages: [
		{
			id: "u1",
			role: "user",
			text: "Continúa la revisión de mi proyecto y avísame cuando termine.",
			activities: [],
		},
		{
			id: "a1",
			role: "assistant",
			text: "La revisión sigue en tu equipo. Te avisaré si necesita un permiso.",
			activities: [],
		},
		{ id: "u2", role: "user", text: "¿Puedo escribirte desde el teléfono mientras trabaja?", activities: [] },
		{
			id: "a2",
			role: "assistant",
			text: "Sí. La sesión delegada continúa. Puedes ver su avance en Agentes y responder aquí.",
			activities: [],
		},
	],
};

async function mountShell(
	page: Page,
	options: {
		connected?: boolean;
		agentError?: boolean;
		disconnectFails?: boolean;
		sharedFiles?: boolean;
		workflow?: boolean;
		followedGoal?: boolean;
		question?: "confirm" | "select" | "questionnaire" | "legacy";
	} = {},
) {
	const traffic: {
		ws: Record<string, unknown>[];
		http: { path: string; method: string; body?: Record<string, unknown> }[];
	} = {
		ws: [],
		http: [],
	};
	let pushServer: (message: { type: string } & Record<string, unknown>) => void = () => {};
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.addInitScript(
		({ connection }) => {
			window.__mobileShellFixture = { connection, monitoring: true, calls: [] };
		},
		{ connection: options.connected === false ? undefined : CONNECTION },
	);
	await page.emulateMedia({ reducedMotion: "reduce" });
	const cdp = await page.context().newCDPSession(page);
	await cdp.send("Emulation.setSafeAreaInsetsOverride", {
		insets: { top: 24, bottom: 24, left: 0, right: 0 },
	});
	let reportsEnabled = false;
	let watchState: "active" | "paused" = "active";
	let watchDeleted = false;
	let createdWatch: Record<string, unknown> | undefined;
	let answered = false;
	let followedState: "waiting" | "paused" | "cancelled" = "waiting";
	const approval = options.question
		? {
				id: "fixture-question",
				paneId: "fixture-pane",
				sessionId: "fixture-session",
				title: options.question === "questionnaire" ? "Preparar el siguiente paso" : "Elegir cómo continuar",
				message: "Revisa las opciones y confirma tu respuesta. No se ejecuta nada al elegir.",
				action: "question",
				createdAt: new Date().toISOString(),
				expiresAt: options.question === "questionnaire" ? "" : new Date(Date.now() + 3_600_000).toISOString(),
				answerable: options.question !== "legacy",
				kind: options.question === "legacy" ? "select" : options.question,
				policyEligible: options.question === "confirm",
				...(options.question === "legacy" ? { unavailableReason: "legacy_connection" } : {}),
				options: [
					{ id: "review-exact", label: "Revisar antes de publicar" },
					{ id: "continue-exact", label: "Continuar el plan aprobado" },
				],
				questions: [
					{
						id: "scope",
						question: "¿Qué partes revisamos?",
						multiSelect: true,
						options: [
							{
								label: "Servidor",
								description: "Comprobar rutas y permisos",
								preview: "GET /status\nPOST /jobs",
							},
							{ label: "Interfaz", description: "Revisar el teléfono" },
						],
					},
				],
			}
		: undefined;
	await page.route(`${ORIGIN}/**`, async (route) => {
		const request = route.request();
		const path = new URL(request.url()).pathname;
		if (request.method() === "OPTIONS") {
			await route.fulfill({
				status: 204,
				headers: {
					"Access-Control-Allow-Origin": "*",
					"Access-Control-Allow-Headers": "authorization,content-type",
					"Access-Control-Allow-Methods": "GET,POST,OPTIONS",
				},
			});
			return;
		}
		expect(request.headers().authorization).toBe(`Bearer ${TOKEN}`);
		const body = request.postData() ? (request.postDataJSON() as Record<string, unknown>) : undefined;
		traffic.http.push({ path, method: request.method(), body });
		if (path === "/orchestration" && request.method() === "POST") {
			if (body?.action === "answer") answered = true;
			await route.fulfill({
				json:
					body?.action === "inspect"
						? {
								sessionId: "fixture-session",
								status: "working",
								metadata: {
									version: 1,
									model: { id: "gpt-6", name: "GPT-6 Sol", provider: "openai-codex" },
									profile: { name: "Trabajo del proyecto", source: "repo" },
									thinkingLevel: "high",
									context: { tokens: 48236, contextWindow: 200000, percent: 24.1 },
									tools: { active: ["bash", "read", "mcp_cloudflare_query"], available: 12 },
									skills: [
										{
											name: "Verificar pruebas",
											description: "Ejecutar pruebas del proyecto antes de presentar resultados.",
										},
									],
									mcp: [
										{ name: "Cloudflare", status: "configured", tools: 0 },
										{ name: "Engram", status: "available", tools: 3 },
									],
								},
								question: null,
								...(options.workflow
									? {
											work: {
												version: 1,
												truncated: false,
												plan: {
													source: "history",
													completed: 1,
													total: 3,
													tasks: [
														{ id: "task1", title: "Revisar la estructura del proyecto", status: "done" },
														{ id: "task2", title: "Comprobar las pruebas", status: "in_progress" },
														{ id: "task3", title: "Preparar un resumen", status: "pending" },
													],
												},
												agents: [
													{
														id: "reviewer",
														agent: "Revisión",
														label: "Comprobar las rutas de acceso y los casos de error",
														status: "running",
														source: "live",
													},
													{
														id: "research",
														agent: "Investigación",
														label: "Consultar el diseño existente",
														status: "completed",
														source: "history",
													},
												],
												commands: [
													{
														id: "command1",
														tool: "bash",
														label: "pnpm test --filter project-with-a-long-name",
														status: "completed",
														source: "history",
														output: "Pruebas de ejemplo: 12 aprobadas.\n".repeat(20),
														outputTruncated: true,
													},
												],
											},
										}
									: {}),
								messages: [
									{
										id: "agent-u1",
										role: "user",
										content: [{ type: "text", text: "Revisa el proyecto y resume los cambios necesarios." }],
									},
									{
										id: "agent-a1",
										role: "assistant",
										content: [
											{
												type: "text",
												text: "Ya revisé la estructura. Estoy comprobando las pruebas y después prepararé un resumen.",
											},
										],
									},
								],
							}
						: { ok: true },
				headers: { "Access-Control-Allow-Origin": "*" },
			});
			return;
		}

		if (path === `/api/files/${IMAGE_ID}/content`) {
			await route.fulfill({
				body: roseImage,
				headers: {
					"Access-Control-Allow-Origin": "*",
					"Content-Type": "image/png",
					"Content-Length": String(roseImage.length),
				},
			});
			return;
		}
		if (path === "/api/mobile/completions" && request.method() === "POST")
			reportsEnabled = body?.enabled === true;
		if (path === "/api/mobile/watchers" && request.method() === "POST") {
			if (body?.action === "start") {
				expect(body.instruction).toEqual(expect.any(String));
				expect(body.source).toMatchObject({ kind: "agents" });
				createdWatch = {
					id: "fixture-created-watch",
					source: body.source,
					instruction: body.instruction,
					state: "active",
					pending: 0,
					createdAt: "2026-10-13T06:00:00Z",
					updatedAt: "2026-10-13T06:00:00Z",
				};
			} else if (body?.watchId === "fixture-created-watch") {
				expect(createdWatch).toBeDefined();
				if (createdWatch && body.action === "pause") createdWatch.state = "paused";
				if (createdWatch && body.action === "resume") createdWatch.state = "active";
				if (body.action === "delete") createdWatch = undefined;
			} else {
				expect(body?.watchId).toBe("fixture-watch");
				if (body?.action === "pause") watchState = "paused";
				if (body?.action === "resume") watchState = "active";
				if (body?.action === "delete") watchDeleted = true;
			}
		}
		if (path === "/api/mobile/workflows" && request.method() === "POST") {
			expect(body?.workflowId).toBe("fixture-goal");
			if (body?.action === "pause") followedState = "paused";
			if (body?.action === "resume") followedState = "waiting";
			if (body?.action === "stop") followedState = "cancelled";
		}
		const bodies: Record<string, unknown> = {
			"/api/mobile/completions": { enabled: reportsEnabled },
			"/api/mobile/watchers": {
				watches: [
					...(watchDeleted
						? []
						: [
								{
									id: "fixture-watch",
									source: { kind: "email", connectorId: "correo-trabajo" },
									instruction: "Avísame de los correos importantes que requieren respuesta",
									state: watchState,
									pending: 0,
									createdAt: "2026-10-11T06:00:00Z",
									updatedAt: "2026-10-11T06:00:00Z",
									lastCheckedAt: "2026-10-11T06:02:00Z",
								},
							]),
					...(createdWatch ? [createdWatch] : []),
				],
				pending: 0,
				sources: [
					{ id: "agents", kind: "agents", label: "Sesiones", available: true },
					{ id: "gmail", kind: "email", label: "Gmail", available: false, configured: false },
				],
				...(new URL(request.url()).searchParams.get("setup") === "1"
					? {
							sessions: [
								{ paneId: "fixture-pane", sessionId: "fixture-session", label: "Portal de clientes" },
							],
						}
					: {}),
			},
			[`/api/files/${FILE_ID}/meta`]: {
				id: FILE_ID,
				name: "Informe de la revisión.pdf",
				size: 4096,
				mime: "application/pdf",
				image: false,
			},
			[`/api/files/${IMAGE_ID}/meta`]: {
				id: IMAGE_ID,
				name: "Rosa Gentle.png",
				size: roseImage.length,
				mime: "image/png",
				image: true,
			},
			"/orchestration": {
				available: true,
				providers: [{ id: "herdr", available: true, canCreate: true }],
				sessions: [
					{
						provider: "herdr",
						paneId: "fixture-pane",
						sessionId: "fixture-session",
						terminalId: "fixture-terminal",
						workspaceId: "fixture-workspace",
						label: "Revisión del proyecto",
						state: "working",
						managed: true,
						connected: true,
						cwd: "/fixture/project",
						capabilities: {
							inspect: true,
							prompt: true,
							abort: true,
							approvals: true,
							close: true,
							duplicate: true,
						},
					},
				],
				approvals: approval && !answered ? [approval] : [],
				policies: [],
				events: [],
			},
			"/browser": {
				available: true,
				active: false,
				running: false,
				mode: "headless",
				tabs: [],
				desktopControl: "native-app",
			},
			"/api/mobile/computer": {
				available: true,
				platform: "linux",
				permissions: { accessibility: true, screenRecording: true, screenshotsSupported: true },
				state: { active: false, yolo: false },
				capabilities: { backend: "hyprland", supported: true, missingDependencies: [], limitations: [] },
			},
			"/api/mobile/approvals": { approvals: [] },
			"/api/mobile/usage": usage,
			"/api/mobile/workflows": {
				workflows: options.followedGoal
					? [
							{
								id: "fixture-goal",
								objective: "Completar la revisión y dejar las pruebas aprobadas",
								sessions: [
									{ paneId: "fixture-pane", sessionId: "fixture-session", label: "Revisión del proyecto" },
								],
								state: followedState,
								createdAt: "2026-10-11T06:00:00Z",
								updatedAt: "2026-10-11T06:00:00Z",
								runs: 500,
								pending: 0,
								lastMessage: "La revisión está en curso; Dot continuará con las pruebas.",
							},
						]
					: [],
				pending: 0,
			},
			"/api/mobile/disconnect": { ok: true },
		};
		if (!(path in bodies)) throw new Error(`Unexpected mobile fixture request: ${request.method()} ${path}`);
		const fails = path === "/api/mobile/disconnect" && options.disconnectFails;
		await route.fulfill({
			status: fails ? 503 : 200,
			json: fails ? { error: "El equipo no respondió. Intenta otra vez." } : bodies[path],
			headers: { "Access-Control-Allow-Origin": "*" },
		});
	});
	await page.routeWebSocket(`${ORIGIN.replace("https:", "wss:")}/ws`, (socket) => {
		let seq = 0;
		const send = (message: { type: string } & Record<string, unknown>) =>
			socket.send(JSON.stringify({ ...message, seq: ++seq }));
		pushServer = send;
		socket.onMessage((raw) => {
			const message = JSON.parse(String(raw)) as Record<string, unknown>;
			traffic.ws.push(message);
			switch (message.type) {
				case "hello":
					expect(message.token).toBe(TOKEN);
					send({
						type: "ready",
						agentState: options.agentError ? "error" : "idle",
						model: "GPT-5.6 Sol",
						features: { conversations: false },
						voice: { transcribe: false, speak: false },
					});
					break;
				case "get_history":
					send(
						options.sharedFiles
							? {
									...history,
									messages: [
										{
											id: "u-files",
											role: "user",
											text: "Envíame el informe y la imagen del equipo.",
											activities: [],
										},
										{
											id: "a-files",
											role: "assistant",
											text: `Aquí tienes el informe y la imagen. Puedes guardarlos o compartirlos desde tu teléfono.\n\n[Informe](/api/files/${FILE_ID}/content)\n\n![Rosa oficial de Gentle Dot](/api/files/${IMAGE_ID}/content)`,
											activities: [],
										},
									],
								}
							: history,
					);
					break;
				case "list_conversations":
					send({ type: "conversations", conversations: [] });
					break;
				case "auth_list":
					send({ type: "auth_providers", providers });
					break;
				case "models_list":
					send({ type: "models", groups: [], profiles: [] });
					break;
				case "profiles_list":
					send({
						type: "profiles",
						profiles: [
							{
								name: "Trabajo-diario",
								roles: { orchestrator: { model: "openai-codex/gpt-5.6-sol", thinking: "high" } },
							},
						],
						active: "Trabajo-diario",
						roles: [{ id: "orchestrator", label: "Asistente principal" }],
						models,
						importable: false,
					});
					break;
				case "connectors_list":
					send({ type: "connectors", connectors });
					break;
				case "send":
					send({ type: "user_message", messageId: "fixture-sent", text: String(message.text) });
					send({
						type: "message_done",
						messageId: "fixture-reply",
						text: "De acuerdo. La sesión sigue trabajando.",
					});
					break;
			}
		});
	});
	await page.goto("/");
	await page.addStyleTag({
		content: ":root { --safe-area-inset-top: 24px; --safe-area-inset-bottom: 24px; }",
	});
	if (options.connected !== false)
		await expect(page.getByRole("textbox", { name: "Mensaje", exact: true })).toBeEnabled();
	return {
		traffic,
		errors,
		pushServer: (message: { type: string } & Record<string, unknown>) => pushServer(message),
	};
}

async function expectCompactChat(page: Page) {
	await expect(page.locator(".mobile-shell")).toBeVisible();
	await expect(page.locator(".chat-header")).toHaveCount(0);
	await expect(page.getByRole("heading", { name: "Gentle Dot", exact: true })).toHaveCount(0);
	await expect(page.getByRole("navigation", { name: "Navegación principal" })).toBeVisible();
	const geometry = await page.evaluate(() => {
		const box = (selector: string) => {
			const rect = document.querySelector(selector)?.getBoundingClientRect();
			if (!rect) throw new Error(`Missing ${selector}`);
			return { top: rect.top, bottom: rect.bottom, height: rect.height };
		};
		return {
			nav: box(".mobile-top-nav"),
			body: box(".chat-transcript"),
			composer: box(".composer"),
			input: box(".composer textarea"),
			height: innerHeight,
			overflow: document.documentElement.scrollWidth - innerWidth,
			scrollHeight: document.documentElement.scrollHeight,
		};
	});
	expect(geometry.overflow).toBeLessThanOrEqual(1);
	expect(geometry.scrollHeight).toBeLessThanOrEqual(geometry.height + 1);
	expect(geometry.body.top).toBeGreaterThanOrEqual(geometry.nav.bottom);
	expect(geometry.nav.top).toBeGreaterThanOrEqual(24);
	expect(geometry.body.bottom).toBeLessThanOrEqual(geometry.composer.top + 1);
	expect(geometry.composer.bottom).toBeLessThanOrEqual(geometry.height - 24);
	expect(geometry.nav.bottom).toBeLessThanOrEqual(geometry.height + 1);
	expect(geometry.input.height).toBeGreaterThanOrEqual(40);
	expect(geometry.body.height).toBeGreaterThanOrEqual(80);
	for (const name of ["Ajustes", "Dot", "Sesiones", "Dictar mensaje", "Enviar mensaje"]) {
		const rect = await page.getByRole("button", { name, exact: true }).boundingBox();
		expect(rect?.height, name).toBeGreaterThanOrEqual(48);
		expect(rect?.width, name).toBeGreaterThanOrEqual(48);
	}
}

for (const viewport of [
	{ width: 375, height: 812 },
	{ width: 412, height: 915 },
	{ width: 812, height: 375 },
	{ width: 915, height: 412 },
]) {
	test(`actual APK shell has top navigation and visible composer at ${viewport.width}×${viewport.height}`, async ({
		page,
	}, info) => {
		await page.setViewportSize(viewport);
		const { errors } = await mountShell(page);
		await expectCompactChat(page);
		await page.screenshot({ path: info.outputPath(`apk-chat-${viewport.width}x${viewport.height}.png`) });
		expect(errors).toEqual([]);
	});
}

test("keyboard resize retains the draft, visible send control and independent message scrolling", async ({
	page,
}, info) => {
	await page.setViewportSize({ width: 375, height: 812 });
	const { traffic, errors } = await mountShell(page);
	const input = page.getByRole("textbox", { name: "Mensaje", exact: true });
	await input.fill("Revisa el avance de mis tareas");
	await input.focus();
	// Android adjustResize shrinks the WebView; this tests the resulting CSS viewport.
	await page.setViewportSize({ width: 375, height: 450 });
	await expect(input).toBeFocused();
	await expectCompactChat(page);
	await page.screenshot({ path: info.outputPath("apk-chat-keyboard-resize.png") });
	await page.getByRole("button", { name: "Enviar mensaje", exact: true }).click();
	await expect.poll(() => traffic.ws.filter((message) => message.type === "send").length).toBe(1);
	expect(traffic.ws.find((message) => message.type === "send")?.text).toBe("Revisa el avance de mis tareas");
	await expect(input).toHaveValue("");
	await page.setViewportSize({ width: 375, height: 812 });
	await expectCompactChat(page);
	expect(errors).toEqual([]);
});

test("APK controls live in the tools menu, native back closes it, and unlink needs confirmation", async ({
	page,
}, info) => {
	await page.setViewportSize({ width: 375, height: 812 });
	const { traffic, errors } = await mountShell(page);
	await expect(page.getByRole("button", { name: "Desvincular teléfono", exact: true })).toBeHidden();
	const trigger = page.getByRole("button", { name: "Ajustes" });
	await trigger.click();
	const menu = page.getByRole("main", { name: "Ajustes", exact: true });
	await expect(menu).toBeVisible();
	await page.screenshot({ path: info.outputPath("apk-tools-menu.png") });
	await menu.getByText("Avisos y teléfono", { exact: true }).click();
	for (const name of ["Cuentas de IA", "Perfiles", "Conexiones", "Desvincular teléfono"])
		await expect(menu.getByRole("button", { name, exact: true })).toBeVisible();
	await expect(menu.getByText("mobile-fixture.test.ts.net", { exact: true })).toBeVisible();
	await page.screenshot({ path: info.outputPath("apk-tools-device.png") });
	const background = menu.getByRole("switch", { name: "Con la app cerrada", exact: true });
	await expect(background).toHaveAttribute("aria-checked", "true");
	await background.click();
	await expect(background).toHaveAttribute("aria-checked", "false");
	await background.click();
	await expect(background).toHaveAttribute("aria-checked", "true");
	await page.evaluate(() => window.__mobileShellNativeEvent("backButton"));
	await expect(menu).toBeHidden();
	expect(
		await page.evaluate(() =>
			window.__mobileShellFixture.calls.some((call) => call.method === "minimizeApp"),
		),
	).toBe(false);
	await trigger.click();
	await menu.getByText("Avisos y teléfono", { exact: true }).click();
	await menu.getByRole("button", { name: "Desvincular teléfono", exact: true }).click();
	expect(traffic.http.filter((request) => request.path.endsWith("/disconnect"))).toHaveLength(0);
	await menu.getByRole("button", { name: "Cancelar", exact: true }).click();
	await menu.getByRole("button", { name: "Desvincular teléfono", exact: true }).click();
	await menu.getByRole("button", { name: "Sí, desvincular", exact: true }).click();
	await expect(page.getByRole("heading", { name: "Tu equipo, a una conversación." })).toBeVisible();
	expect(traffic.http.filter((request) => request.path.endsWith("/disconnect"))).toHaveLength(1);
	expect(await page.evaluate(() => window.__mobileShellFixture.connection)).toBeUndefined();
	expect(errors).toEqual([]);
});

test("failed unlink keeps the secure connection and chat available", async ({ page }) => {
	await page.setViewportSize({ width: 375, height: 812 });
	await mountShell(page, { disconnectFails: true });
	await page.getByRole("button", { name: "Ajustes" }).click();
	await page.getByText("Avisos y teléfono", { exact: true }).click();
	await page.getByRole("button", { name: "Desvincular teléfono", exact: true }).click();
	await page.getByRole("button", { name: "Sí, desvincular", exact: true }).click();
	await expect(page.getByRole("alert")).toBeVisible();
	expect(await page.evaluate(() => window.__mobileShellFixture.connection)).toEqual(CONNECTION);
	await page.getByRole("button", { name: "Dot", exact: true }).click();
	await expectCompactChat(page);
});

test("native dictation is reviewed before sending and survives switching to Agents", async ({
	page,
}, info) => {
	await page.setViewportSize({ width: 412, height: 915 });
	const { traffic, errors } = await mountShell(page);
	await page.getByRole("button", { name: "Dictar mensaje", exact: true }).click();
	const input = page.getByRole("textbox", { name: "Mensaje", exact: true });
	await expect(input).toHaveValue("Revisa el avance de mis tareas");
	expect(traffic.ws.filter((message) => message.type === "send")).toHaveLength(0);
	await page.getByRole("button", { name: "Sesiones", exact: true }).click();
	await expect(page.getByRole("button", { name: /Revisión del proyecto/ })).toBeVisible();
	await expect(input).toBeHidden();
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
	await page.screenshot({ path: info.outputPath("apk-agents.png") });
	await page.getByRole("button", { name: "Dot", exact: true }).click();
	await expect(input).toHaveValue("Revisa el avance de mis tareas");
	await expectCompactChat(page);
	expect(errors).toEqual([]);
});

for (const panel of [
	{ menu: "Cuentas de IA", selector: ".accounts:not(.connectors)", file: "accounts", item: "OpenAI" },
	{ menu: "Perfiles", selector: ".profiles", file: "profiles", item: "Trabajo-diario" },
	{ menu: "Conexiones", selector: ".connectors", file: "connectors", item: "GitHub" },
]) {
	test(`phone ${panel.file} tools screen fits, scrolls and returns to the draft`, async ({ page }, info) => {
		await page.setViewportSize({ width: 375, height: 812 });
		const { errors } = await mountShell(page);
		const input = page.getByRole("textbox", { name: "Mensaje", exact: true });
		await input.fill("Sigue con la revisión");
		await page.getByRole("button", { name: "Ajustes" }).click();
		await page
			.getByRole("main", { name: "Ajustes", exact: true })
			.getByRole("button", { name: panel.menu, exact: true })
			.click();
		const screen = page.locator(panel.selector);
		await expect(screen).toBeVisible();
		await expect(screen.getByText(panel.item, { exact: true }).first()).toBeVisible();
		await expect(input).toBeHidden();
		const close = screen.locator("header button").first();
		await expect(close).toBeInViewport();
		const closeRect = await close.boundingBox();
		expect(closeRect?.height, "Panel close touch height").toBeGreaterThanOrEqual(48);
		expect(closeRect?.width, "Panel close touch width").toBeGreaterThanOrEqual(48);
		const metrics = await screen.evaluate((element) => {
			const body = element.closest(".chat-body");
			const rect = element.getBoundingClientRect();
			return {
				left: rect.left,
				right: rect.right,
				width: innerWidth,
				height: innerHeight,
				scrollHeight: document.documentElement.scrollHeight,
				overflow: document.documentElement.scrollWidth - innerWidth,
				bodyOverflow: body ? body.scrollWidth - body.clientWidth : -1,
			};
		});
		expect(metrics.left).toBeGreaterThanOrEqual(0);
		expect(metrics.right).toBeLessThanOrEqual(metrics.width);
		expect(metrics.overflow).toBeLessThanOrEqual(1);
		expect(metrics.bodyOverflow, "Tools must not require horizontal scrolling").toBeLessThanOrEqual(1);
		expect(metrics.scrollHeight, "Only the tools pane scrolls").toBeLessThanOrEqual(metrics.height + 1);
		await page.screenshot({ path: info.outputPath(`apk-${panel.file}.png`) });
		await close.click();
		await expect(page.getByRole("main", { name: "Ajustes", exact: true })).toBeVisible();
		await page.getByRole("button", { name: "Dot", exact: true }).click();
		await expect(input).toBeVisible();
		await expect(input).toHaveValue("Sigue con la revisión");
		await expectCompactChat(page);
		expect(errors).toEqual([]);
	});
}

test("unpaired Android shell offers the real QR flow and native Back restores pairing", async ({
	page,
}, info) => {
	await page.setViewportSize({ width: 375, height: 812 });
	const { traffic, errors } = await mountShell(page, { connected: false });
	await expect(page.getByRole("heading", { name: "Tu equipo, a una conversación." })).toBeVisible();
	const scan = page.getByRole("button", { name: "Escanear QR", exact: true });
	await expect(scan).toBeEnabled();
	await expect(scan).toBeInViewport();
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
	await page.screenshot({ path: info.outputPath("apk-pairing.png") });
	await scan.click();
	const camera = page.getByRole("dialog", { name: "Escanear QR", exact: true });
	await expect(camera).toBeVisible();
	await expect(camera.getByRole("button", { name: "Cancelar", exact: true })).toBeInViewport();
	await page.evaluate(() => window.__mobileShellNativeEvent("backButton"));
	await expect(camera).toBeHidden();
	await expect(scan).toBeEnabled();
	expect(traffic.ws).toHaveLength(0);
	expect(traffic.http).toHaveLength(0);
	expect(
		await page.evaluate(() => window.__mobileShellFixture.calls.some((call) => call.method === "stopScan")),
	).toBe(true);
	expect(errors).toEqual([]);
});

test("agent workflow unfolds on demand, preserves the draft and fits phone, landscape and enlarged text", async ({
	page,
}, info) => {
	await page.setViewportSize({ width: 375, height: 812 });
	const { traffic, errors } = await mountShell(page, { workflow: true });
	await page.getByRole("button", { name: "Sesiones", exact: true }).click();
	await page.getByRole("button", { name: /Revisión del proyecto/ }).click();
	const workflow = page.locator(".agent-workflow");
	const summary = workflow.locator(":scope > summary");
	await expect(summary).toContainText("1 activo");
	await expect(workflow).not.toHaveAttribute("open", "");
	await expect(page.getByRole("region", { name: "Plan de trabajo" })).toBeVisible();
	await expect(page.locator(".agent-conversation .eyebrow")).toHaveCount(0);
	await page.screenshot({ path: info.outputPath("apk-agent-plan.png") });
	const reply = page.getByRole("textbox", { name: "Continuar esta sesión" });
	await reply.fill("Sigue con el plan después de revisar");
	await summary.focus();
	await page.keyboard.press("Enter");
	await expect(workflow).toHaveAttribute("open", "");
	await expect(
		page.getByRole("region", { name: "Plan de trabajo" }).getByRole("progressbar"),
	).toHaveAttribute("value", "1");
	await page.screenshot({ path: info.outputPath("apk-agent-workflow.png") });
	await expect(workflow.getByRole("list", { name: "Subagentes activos" }).getByRole("listitem")).toHaveCount(
		1,
	);
	await expect(workflow.getByRole("img", { name: "Trabajando" })).toBeVisible();
	await expect(workflow.getByText("Investigación", { exact: true })).toHaveCount(0);
	await expect(workflow.getByText("Ver resultado", { exact: true })).toHaveCount(0);
	const context = page.getByRole("button", { name: /^Ver información de la sesión:/ });
	await expect(context).toContainText("GPT-6 Sol");
	await expect(context).toContainText("24,1%");
	await context.click();
	const details = page.getByRole("dialog", { name: "Información de la sesión" });
	await expect(details).toBeVisible();
	await details.getByText("Conexiones MCP", { exact: false }).click();
	await expect(details.getByText("Engram", { exact: true })).toBeVisible();
	await expect(details.getByText("Configurado · 0 herramientas", { exact: true })).toBeVisible();
	await details.getByRole("button", { name: "Cerrar detalles" }).click();
	await expect(context).toBeFocused();
	await expect(reply).toHaveValue("Sigue con el plan después de revisar");
	expect(traffic.http.filter((request) => request.body?.action === "prompt")).toHaveLength(0);
	for (const viewport of [
		{ width: 375, height: 450 },
		{ width: 812, height: 375 },
	]) {
		await page.setViewportSize(viewport);
		await expect(page.getByRole("button", { name: "Enviar instrucción", exact: true })).toBeInViewport();
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
	}
	await page.screenshot({ path: info.outputPath("apk-agent-workflow-landscape.png") });
	await page.setViewportSize({ width: 375, height: 812 });
	await page.getByRole("button", { name: "Ajustes" }).click();
	await page.getByRole("button", { name: "Apariencia del chat", exact: true }).click();
	await page.getByRole("radio", { name: "Claro", exact: true }).check();
	await page.getByRole("button", { name: "Dot", exact: true }).click();
	await expect(page.locator(".chat-mobile")).toHaveAttribute("data-chat-theme", "light");
	await page.getByRole("button", { name: "Sesiones", exact: true }).click();
	await summary.scrollIntoViewIfNeeded();
	await page.screenshot({ path: info.outputPath("apk-agent-workflow-light.png") });
	await page.addStyleTag({ content: "html { -webkit-text-size-adjust:200%; text-size-adjust:200%; }" });
	await summary.scrollIntoViewIfNeeded();
	expect((await summary.boundingBox())?.height).toBeGreaterThanOrEqual(48);
	expect(await workflow.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
	await page.screenshot({ path: info.outputPath("apk-agent-workflow-text-200.png") });
	await page.evaluate(() => window.__mobileShellNativeEvent("backButton"));
	await expect(workflow).toBeHidden();
	await expect(page.getByRole("button", { name: /Revisión del proyecto/ })).toBeVisible();
	expect(errors).toEqual([]);
});

test("active agent opens its own conversation and native Back returns to the agent list first", async ({
	page,
}, info) => {
	await page.setViewportSize({ width: 375, height: 812 });
	const { traffic, errors } = await mountShell(page);
	await page.getByRole("textbox", { name: "Mensaje", exact: true }).fill("Borrador para Dot");
	await page.getByRole("button", { name: "Sesiones", exact: true }).click();
	await expect(page.getByRole("list", { name: "Conexiones de agentes" })).toBeHidden();
	await page.getByRole("button", { name: /Revisión del proyecto/ }).click();
	const conversation = page.getByRole("region", { name: "Conversación de la sesión" });
	await expect(conversation).toBeVisible();
	await expect(conversation.getByText("Ya revisé la estructura.", { exact: false })).toBeVisible();
	await expect(page.getByRole("button", { name: "Todos los agentes", exact: true })).toBeVisible();
	const reply = page.getByRole("textbox", { name: "Continuar esta sesión", exact: true });
	await expect(reply).toBeInViewport();
	await page.screenshot({ path: info.outputPath("apk-agent-conversation.png") });
	await reply.fill("Continúa y avísame al terminar");
	await reply.focus();
	await page.setViewportSize({ width: 375, height: 450 });
	const send = page.getByRole("button", { name: "Enviar instrucción", exact: true });
	await expect(send).toBeInViewport();
	const sendRect = await send.boundingBox();
	expect(
		(sendRect?.y ?? 0) + (sendRect?.height ?? 0),
		"Agent reply sits above one gesture inset, without an empty band",
	).toBeGreaterThanOrEqual(380);
	expect((sendRect?.y ?? 0) + (sendRect?.height ?? 0)).toBeLessThanOrEqual(426);
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
	await page.screenshot({ path: info.outputPath("apk-agent-keyboard.png") });
	await send.click();
	await expect.poll(() => traffic.http.filter((request) => request.body?.action === "prompt").length).toBe(1);
	expect(traffic.http.find((request) => request.body?.action === "prompt")?.body).toEqual({
		action: "prompt",
		paneId: "fixture-pane",
		sessionId: "fixture-session",
		text: "Continúa y avísame al terminar",
	});
	await expect(reply).toHaveValue("");
	await expect(page.getByText("Instrucción enviada a Revisión del proyecto.", { exact: true })).toBeVisible();
	await page.setViewportSize({ width: 375, height: 812 });
	await page.evaluate(() => window.__mobileShellNativeEvent("backButton"));
	await expect(page.getByRole("button", { name: /Revisión del proyecto/ })).toBeVisible();
	await expect(page.getByRole("button", { name: "Sesiones", exact: true })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await expect(conversation).toBeHidden();
	await page.evaluate(() => window.__mobileShellNativeEvent("backButton"));
	await expect(page.getByRole("textbox", { name: "Mensaje", exact: true })).toHaveValue("Borrador para Dot");
	expect(
		await page.evaluate(() =>
			window.__mobileShellFixture.calls.some((call) => call.method === "minimizeApp"),
		),
	).toBe(false);
	expect(errors).toEqual([]);
});

test("agent tools consume native Back before the session, then list, then Dot chat", async ({ page }) => {
	await page.setViewportSize({ width: 375, height: 812 });
	const { errors } = await mountShell(page);
	await page.getByRole("button", { name: "Sesiones", exact: true }).click();
	await page.getByRole("button", { name: /Revisión del proyecto/ }).click();
	const conversation = page.getByRole("region", { name: "Conversación de la sesión" });
	await expect(conversation).toBeVisible();
	await page.getByRole("button", { name: "Ajustes" }).click();
	await expect(page.getByRole("main", { name: "Ajustes", exact: true })).toBeVisible();
	await page.evaluate(() => window.__mobileShellNativeEvent("backButton"));
	await expect(page.getByRole("main", { name: "Ajustes", exact: true })).toBeHidden();
	await page.getByRole("button", { name: "Sesiones", exact: true }).click();
	await expect(conversation).toBeVisible();
	await page.evaluate(() => window.__mobileShellNativeEvent("backButton"));
	await expect(conversation).toBeHidden();
	await expect(page.getByRole("button", { name: /Revisión del proyecto/ })).toBeVisible();
	await expect(page.getByRole("button", { name: "Sesiones", exact: true })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await page.evaluate(() => window.__mobileShellNativeEvent("backButton"));
	await expect(page.getByRole("textbox", { name: "Mensaje", exact: true })).toBeVisible();
	expect(
		await page.evaluate(() =>
			window.__mobileShellFixture.calls.some((call) => call.method === "minimizeApp"),
		),
	).toBe(false);
	expect(errors).toEqual([]);
});

test("200 percent mobile text adjustment keeps tools readable and within the phone", async ({
	page,
}, info) => {
	await page.setViewportSize({ width: 375, height: 812 });
	const { errors } = await mountShell(page);
	const message = page.locator(".message-user").first();
	const normal = await message.boundingBox();
	// Chromium mobile text adjustment exercises enlarged glyphs even for px-based UI.
	// This is browser reflow coverage, not a claim about a physical Android font setting.
	await page.addStyleTag({
		content: "html { font-size:200%; -webkit-text-size-adjust:200%; text-size-adjust:200%; }",
	});
	const enlarged = await message.boundingBox();
	expect(enlarged?.height ?? 0).toBeGreaterThan((normal?.height ?? 0) * 1.2);
	await page.getByRole("button", { name: "Ajustes" }).click();
	const menu = page.getByRole("main", { name: "Ajustes", exact: true });
	await expect(menu).toBeVisible();
	await expect(page.getByRole("button", { name: "Dot", exact: true })).toBeInViewport();
	const closeRect = await page.getByRole("button", { name: "Dot", exact: true }).boundingBox();
	expect(closeRect?.width, "Large text must not shrink the close touch target").toBeGreaterThanOrEqual(48);
	expect(closeRect?.height).toBeGreaterThanOrEqual(48);
	const metrics = await menu.evaluate((element) => {
		const rect = element.getBoundingClientRect();
		return {
			left: rect.left,
			right: rect.right,
			top: rect.top,
			bottom: rect.bottom,
			overflow: element.scrollWidth - element.clientWidth,
			width: innerWidth,
			height: innerHeight,
		};
	});
	expect(metrics.left).toBeGreaterThanOrEqual(0);
	expect(metrics.right).toBeLessThanOrEqual(metrics.width);
	expect(metrics.top).toBeGreaterThanOrEqual(24);
	expect(metrics.bottom).toBeLessThanOrEqual(metrics.height);
	expect(metrics.overflow).toBeLessThanOrEqual(1);
	await page.screenshot({ path: info.outputPath("apk-tools-text-200.png") });
	await menu.getByText("Avisos y teléfono", { exact: true }).click();
	await menu.getByRole("switch", { name: "Con la app cerrada", exact: true }).click();
	await expect(menu.getByRole("switch", { name: "Con la app cerrada", exact: true })).toHaveAttribute(
		"aria-checked",
		"false",
	);
	await page.evaluate(() => window.__mobileShellNativeEvent("backButton"));
	await expect(menu).toBeHidden();
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
	expect(errors).toEqual([]);
});

test("mobile appearance persists, follows the system, preserves Gentle's rose and restores defaults", async ({
	page,
}, info) => {
	await page.setViewportSize({ width: 375, height: 812 });
	const { errors } = await mountShell(page);
	await page.getByRole("button", { name: "Ajustes" }).click();
	await page.getByRole("button", { name: "Apariencia del chat", exact: true }).click();
	const appearance = page.getByRole("main", { name: "Apariencia del chat", exact: true });
	await appearance.getByRole("radio", { name: "Claro", exact: true }).check();
	await appearance.getByRole("radio", { name: "Azul", exact: true }).check();
	await appearance.getByRole("radio", { name: "20", exact: true }).check();
	await appearance.getByRole("radio", { name: "Compacto", exact: true }).check();
	await appearance.getByRole("radio", { name: "Lectura", exact: true }).check();
	await appearance.getByRole("radio", { name: "Puntos", exact: true }).check();
	await expect(page.locator(".chat-mobile")).toHaveAttribute("data-chat-theme", "light");
	await expect(page.locator(".chat-mobile")).toHaveAttribute("data-chat-layout", "reading");
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
	await page.screenshot({ path: info.outputPath("apk-appearance-light.png") });
	await page.evaluate(() => window.__mobileShellNativeEvent("backButton"));
	await expect(page.getByRole("main", { name: "Ajustes", exact: true })).toBeVisible();
	await page.evaluate(() => window.__mobileShellNativeEvent("backButton"));
	await expect(appearance).toBeHidden();
	await page.reload();
	await expect(page.locator(".chat-mobile")).toHaveAttribute("data-chat-theme", "light");
	await expect(page.locator(".chat-mobile")).toHaveAttribute("data-chat-density", "compact");
	await expect(page.locator(".chat-mobile")).toHaveCSS("--chat-font-size", "20px");
	await page.screenshot({ path: info.outputPath("apk-chat-personalized.png") });
	await page.getByRole("button", { name: "Ajustes" }).click();
	await page.getByRole("button", { name: "Apariencia del chat", exact: true }).click();
	await appearance.getByRole("radio", { name: "Sistema", exact: true }).check();
	await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
	await expect(page.locator(".chat-mobile")).toHaveAttribute("data-chat-theme", "dark");
	await page.setViewportSize({ width: 812, height: 375 });
	await appearance.getByRole("button", { name: "Restaurar Gentle" }).click();
	await expect(page.locator(".chat-mobile")).toHaveAttribute("data-chat-layout", "bubbles");
	await expect(page.locator(".chat-mobile")).toHaveCSS("--chat-font-size", "16px");
	await expect(appearance.getByRole("radio", { name: "Rosa Gentle", exact: true })).toBeChecked();
	await expect(page.getByRole("button", { name: "Dot" })).toBeInViewport();
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
	await page.screenshot({ path: info.outputPath("apk-appearance-landscape.png") });
	expect(errors).toEqual([]);
});

test("chat receives private images and files; Android save/share require an explicit tap", async ({
	page,
}, info) => {
	await page.setViewportSize({ width: 375, height: 812 });
	const { traffic, errors } = await mountShell(page, { sharedFiles: true });
	const pdf = page.getByRole("group", { name: "Archivo: Informe de la revisión.pdf", exact: true });
	const image = page.getByRole("group", { name: "Archivo: Rosa Gentle.png", exact: true });
	await expect(pdf).toBeVisible();
	await expect(image.getByRole("img", { name: "Rosa oficial de Gentle Dot" })).toBeVisible();
	expect(
		await page.evaluate(() =>
			window.__mobileShellFixture.calls.filter((call) => call.method === "receiveFile"),
		),
	).toEqual([]);
	await pdf.getByRole("button", { name: "Guardar archivo" }).click();
	await expect(pdf.getByRole("status")).toContainText("Archivo recibido");
	await image.getByRole("button", { name: "Compartir", exact: true }).click();
	await expect(image.getByRole("status")).toContainText("menú para compartir");
	const calls = await page.evaluate(() =>
		window.__mobileShellFixture.calls
			.filter((call) => call.method === "receiveFile")
			.map((call) => call.options),
	);
	expect(calls).toEqual([
		{
			url: `${ORIGIN}/api/files/${FILE_ID}/content`,
			token: TOKEN,
			name: "Informe de la revisión.pdf",
			mime: "application/pdf",
			action: "save",
		},
		{
			url: `${ORIGIN}/api/files/${IMAGE_ID}/content`,
			token: TOKEN,
			name: "Rosa Gentle.png",
			mime: "image/png",
			action: "share",
		},
	]);
	await image.getByRole("button", { name: "Ampliar Rosa Gentle.png" }).click();
	await expect(page.getByRole("dialog", { name: "Rosa Gentle.png" })).toBeVisible();
	await page.evaluate(() => window.__mobileShellNativeEvent("backButton"));
	await expect(page.getByRole("dialog", { name: "Rosa Gentle.png" })).toBeHidden();
	await expect(page.getByRole("textbox", { name: "Mensaje", exact: true })).toBeVisible();
	expect(traffic.http.some((request) => request.path === `/api/files/${IMAGE_ID}/content`)).toBe(true);
	expect(traffic.http.some((request) => request.path === `/api/files/${FILE_ID}/content`)).toBe(false);
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
	await page.screenshot({ path: info.outputPath("apk-shared-files.png") });
	expect(errors).toEqual([]);
});

test("phone customizes independent alerts and persists them separately from Dot summaries", async ({
	page,
}, info) => {
	await page.setViewportSize({ width: 375, height: 812 });
	const { traffic, errors } = await mountShell(page);
	await page.getByRole("button", { name: "Ajustes", exact: true }).click();
	await page.getByText("Avisos y teléfono", { exact: true }).click();
	const alerts = page.getByRole("region", { name: "Alertas", exact: true });
	await alerts
		.locator("summary")
		.filter({ hasText: /^Sesiones$/ })
		.click();
	const replies = alerts.getByRole("switch", { name: "Nuevas respuestas", exact: true });
	await expect(replies).toHaveAttribute("aria-checked", "true");
	await replies.click();
	await expect(replies).toHaveAttribute("aria-checked", "false");
	await expect(
		alerts.getByRole("switch", { name: "Cambios de disponibilidad", exact: true }),
	).toHaveAttribute("aria-checked", "false");
	await alerts.locator("summary").filter({ hasText: /^Dot$/ }).click();
	await expect(alerts.getByRole("switch", { name: "Respuestas de Dot", exact: true })).toHaveAttribute(
		"aria-checked",
		"true",
	);
	await alerts.getByRole("switch", { name: "Solicitudes de permiso", exact: true }).click();
	await alerts
		.locator("summary")
		.filter({ hasText: /^Resúmenes de sesiones$/ })
		.click();
	const summaries = alerts.getByRole("switch", { name: "Resúmenes en Dot", exact: true });
	await expect(summaries).toHaveAttribute("aria-checked", "false");
	await summaries.click();
	await expect(summaries).toHaveAttribute("aria-checked", "true");
	expect(
		traffic.http.find((request) => request.path === "/api/mobile/completions" && request.method === "POST")
			?.body,
	).toEqual({ enabled: true });
	expect(await page.evaluate(() => window.__mobileShellFixture.preferences)).toMatchObject({
		agentCompleted: false,
		permissions: false,
		dotReplies: true,
		agentAvailable: false,
	});
	await page.screenshot({ path: info.outputPath("apk-notification-options.png") });
	await page.getByRole("button", { name: "Dot", exact: true }).click();
	await page.getByRole("button", { name: "Ajustes", exact: true }).click();
	await page.getByText("Avisos y teléfono", { exact: true }).click();
	await alerts
		.locator("summary")
		.filter({ hasText: /^Sesiones$/ })
		.click();
	await expect(replies).toHaveAttribute("aria-checked", "false");
	await alerts.locator("summary").filter({ hasText: /^Dot$/ }).click();
	await expect(alerts.getByRole("switch", { name: "Solicitudes de permiso", exact: true })).toHaveAttribute(
		"aria-checked",
		"false",
	);
	await alerts
		.locator("summary")
		.filter({ hasText: /^Resúmenes de sesiones$/ })
		.click();
	await expect(summaries).toHaveAttribute("aria-checked", "true");
	await page.setViewportSize({ width: 812, height: 375 });
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
	await page.screenshot({ path: info.outputPath("apk-notification-options-landscape.png") });
	expect(errors).toEqual([]);
});

test("subscription usage stays in settings, refreshes on demand, and preserves the chat draft", async ({
	page,
}, info) => {
	await page.setViewportSize({ width: 375, height: 812 });
	const { traffic, errors } = await mountShell(page);
	const draft = page.getByRole("textbox", { name: "Mensaje", exact: true });
	await draft.fill("Después continúa con la revisión.");
	expect(traffic.http.some((request) => request.path === "/api/mobile/usage")).toBe(false);
	await page.getByRole("button", { name: "Ajustes" }).click();
	expect(traffic.http.some((request) => request.path === "/api/mobile/usage")).toBe(false);
	await page.getByRole("button", { name: "Consumo", exact: true }).click();
	const panel = page.getByRole("main", { name: "Consumo", exact: true });
	await expect(panel.getByRole("article", { name: "Consumo de Codex" })).toBeVisible();
	await expect(panel.getByRole("progressbar", { name: /78% disponible/ })).toBeVisible();
	await expect(panel.locator(".usage-remaining").first()).toHaveText("78%disponible");
	await expect(panel.getByRole("progressbar")).toHaveCount(3);
	await expect(page.getByRole("button", { name: "Dot" })).toBeInViewport();
	expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
	await page.screenshot({ path: info.outputPath("apk-subscription-usage.png") });
	const before = traffic.http.filter((request) => request.path === "/api/mobile/usage").length;
	await panel.getByRole("button", { name: "Actualizar consumo" }).click();
	await expect
		.poll(() => traffic.http.filter((request) => request.path === "/api/mobile/usage").length)
		.toBe(before + 1);
	await page.evaluate(() => window.__mobileShellNativeEvent("backButton"));
	await expect(page.getByRole("main", { name: "Ajustes", exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Apariencia del chat", exact: true }).click();
	await page.getByRole("radio", { name: "Claro", exact: true }).check();
	await page.evaluate(() => window.__mobileShellNativeEvent("backButton"));
	await page.getByRole("button", { name: "Consumo", exact: true }).click();
	await expect(panel.getByRole("progressbar", { name: /78% disponible/ })).toBeVisible();
	await page.screenshot({ path: info.outputPath("apk-subscription-usage-light.png") });
	await page.setViewportSize({ width: 812, height: 375 });
	await page.addStyleTag({
		content: "html { font-size:200%; -webkit-text-size-adjust:200%; text-size-adjust:200%; }",
	});
	await panel.getByRole("progressbar", { name: /66% disponible/ }).scrollIntoViewIfNeeded();
	await expect(page.getByRole("button", { name: "Dot" })).toBeInViewport();
	expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
	await page.screenshot({ path: info.outputPath("apk-subscription-usage-landscape.png") });
	await page.evaluate(() => window.__mobileShellNativeEvent("backButton"));
	await page.evaluate(() => window.__mobileShellNativeEvent("backButton"));
	await expect(draft).toHaveValue("Después continúa con la revisión.");
	expect(traffic.ws.filter((event) => event.type === "send")).toEqual([]);
	expect(
		traffic.http
			.filter((request) => request.path === "/api/mobile/usage")
			.every((request) => request.method === "GET"),
	).toBe(true);
	expect(errors).toEqual([]);
});

for (const kind of ["select", "questionnaire"] as const) {
	test(`phone answers ${kind} only after explicit submit`, async ({ page }, info) => {
		await page.setViewportSize({ width: 375, height: 812 });
		const { traffic, errors } = await mountShell(page, { question: kind });
		await page.getByRole("button", { name: /^Sesiones/ }).click();
		const card = page.locator(".agent-approval");
		await expect(card).toBeVisible();
		await expect(card.getByRole("button", { name: "Enviar respuesta" })).toBeDisabled();
		if (kind === "select") await card.getByRole("radio", { name: "Continuar el plan aprobado" }).check();
		else {
			await card.getByRole("checkbox", { name: /Servidor/ }).check();
			await card.getByRole("checkbox", { name: /Interfaz/ }).check();
		}
		expect(traffic.http.some((request) => request.body?.action === "answer")).toBe(false);
		await card.getByRole("button", { name: "Enviar respuesta" }).scrollIntoViewIfNeeded();
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
		await page.screenshot({ path: info.outputPath(`apk-question-${kind}.png`) });
		await card.getByRole("button", { name: "Enviar respuesta" }).click();
		await expect(card).toBeHidden();
		expect(traffic.http.find((request) => request.body?.action === "answer")?.body).toEqual({
			action: "answer",
			paneId: "fixture-pane",
			sessionId: "fixture-session",
			requestId: "fixture-question",
			...(kind === "select"
				? { optionId: "continue-exact" }
				: { answers: [{ questionId: "scope", optionIndices: [0, 1] }] }),
		});
		expect(errors).toEqual([]);
	});
}

test("an old connection explains why the current question needs the computer", async ({ page }, info) => {
	await page.setViewportSize({ width: 375, height: 812 });
	const { traffic, errors } = await mountShell(page, { question: "legacy" });
	await page.getByRole("button", { name: /^Sesiones/ }).click();
	await expect(page.getByText(/Conexión anterior:/)).toBeVisible();
	await expect(page.getByRole("button", { name: "Enviar respuesta" })).toBeDisabled();
	await expect(page.getByRole("button", { name: "Cancelar pregunta" })).toBeDisabled();
	await page.screenshot({ path: info.outputPath("apk-question-legacy.png") });
	expect(traffic.http.some((request) => request.body?.action === "answer")).toBe(false);
	expect(errors).toEqual([]);
});

test("a continuous goal keeps pause and resume available without manual authorization forms", async ({
	page,
}, info) => {
	await page.setViewportSize({ width: 375, height: 812 });
	const { traffic, errors } = await mountShell(page, { followedGoal: true, question: "confirm" });
	const draft = page.getByRole("textbox", { name: "Mensaje", exact: true });
	await draft.fill("Avísame cuando el objetivo termine.");
	await page.getByRole("button", { name: /^Sesiones/ }).click();
	const permission = page.locator(".agent-approval");
	await expect(permission.getByRole("button", { name: "Permitir", exact: true })).toBeEnabled();
	await expect(permission.getByRole("button", { name: "Rechazar", exact: true })).toBeEnabled();
	await expect(page.getByRole("button", { name: "Permiso nocturno", exact: true })).toHaveCount(0);
	await expect(permission.locator("form, select, input[type=number]")).toHaveCount(0);
	expect(traffic.http.some((request) => request.body?.action === "answer")).toBe(false);
	await permission.getByRole("button", { name: "Rechazar", exact: true }).click();
	await expect(permission).toHaveCount(0);
	expect(traffic.http.find((request) => request.body?.action === "answer")?.body).toEqual({
		action: "answer",
		paneId: "fixture-pane",
		sessionId: "fixture-session",
		requestId: "fixture-question",
		approved: false,
	});
	await page.getByRole("button", { name: "Ajustes", exact: true }).click();
	await page.getByText("Trabajo en segundo plano", { exact: true }).click();
	const panel = page.locator(".followed-work");
	await panel.locator(":scope > summary").click();
	const goal = panel.getByRole("article", {
		name: "Completar la revisión y dejar las pruebas aprobadas",
		exact: true,
	});
	await expect(goal).toBeVisible();
	await expect(goal.getByText("Siguiendo agentes", { exact: true })).toBeVisible();
	await expect(goal.getByText(/continuaciones|Límite acordado|Invalid Date/i)).toHaveCount(0);
	await expect(goal.locator("form, select, input")).toHaveCount(0);
	await goal.getByRole("button", { name: "Pausar seguimiento" }).scrollIntoViewIfNeeded();
	await page.screenshot({ path: info.outputPath("apk-continuous-goal.png") });
	await goal.getByRole("button", { name: "Pausar seguimiento" }).click();
	await expect(goal.getByText("En pausa", { exact: true })).toBeVisible();
	await expect(goal.getByRole("button", { name: "Reanudar seguimiento" })).toBeEnabled();
	await goal.getByRole("button", { name: "Reanudar seguimiento" }).click();
	await expect(goal.getByText("Siguiendo agentes", { exact: true })).toBeVisible();
	expect(
		traffic.http
			.filter((request) => request.path === "/api/mobile/workflows" && request.method === "POST")
			.map((request) => request.body),
	).toEqual([
		{ action: "pause", workflowId: "fixture-goal" },
		{ action: "resume", workflowId: "fixture-goal" },
	]);
	await page.setViewportSize({ width: 812, height: 375 });
	await page.addStyleTag({
		content: "html { font-size:200%; -webkit-text-size-adjust:200%; text-size-adjust:200%; }",
	});
	await goal.getByRole("button", { name: "Pausar seguimiento" }).scrollIntoViewIfNeeded();
	await expect(goal.getByRole("button", { name: "Pausar seguimiento" })).toBeInViewport();
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
	await page.screenshot({ path: info.outputPath("apk-continuous-goal-landscape.png") });
	await page.evaluate(() => window.__mobileShellNativeEvent("backButton"));
	await expect(draft).toHaveValue("Avísame cuando el objetivo termine.");
	expect(errors).toEqual([]);
});

test("watcher settings stay quiet until opened, preserve the draft, and require explicit controls", async ({
	page,
}, info) => {
	await page.setViewportSize({ width: 375, height: 812 });
	const { traffic, errors } = await mountShell(page);
	const requests = () => traffic.http.filter((request) => request.path === "/api/mobile/watchers");
	const actions = () =>
		requests()
			.filter((request) => request.method === "POST")
			.map((request) => request.body);
	const draft = page.getByRole("textbox", { name: "Mensaje", exact: true });
	await draft.fill("Continúa después de revisar las novedades");
	expect(requests()).toHaveLength(0);
	await page.getByRole("button", { name: "Ajustes" }).click();
	expect(requests()).toHaveLength(0);
	await page.getByRole("button", { name: "Dot 24/7", exact: true }).click();
	const panel = page.getByRole("main", { name: "Dot 24/7", exact: true });
	await expect(panel.getByText("En espera", { exact: true })).toBeVisible();
	expect(actions()).toHaveLength(0);
	await expect(panel.getByText("Última comprobación", { exact: true })).toBeHidden();
	await expect(page.getByRole("button", { name: "Dot" })).toBeInViewport();
	const pause = panel.getByRole("button", { name: "Pausar", exact: true });
	expect((await pause.boundingBox())?.height).toBeGreaterThanOrEqual(48);
	await page.screenshot({ path: info.outputPath("apk-watchers.png") });
	await pause.click();
	await expect(panel.getByText("Pausado", { exact: true })).toBeVisible();
	await panel.getByRole("button", { name: "Reanudar", exact: true }).click();
	await expect(panel.getByText("En espera", { exact: true })).toBeVisible();
	await panel.getByText("Ver detalles", { exact: true }).click();
	await expect(panel.getByText("correo-trabajo", { exact: true })).toBeVisible();
	await panel.getByRole("button", { name: "Eliminar tarea", exact: true }).click();
	expect(actions()).toEqual([
		{ action: "pause", watchId: "fixture-watch" },
		{ action: "resume", watchId: "fixture-watch" },
	]);
	await panel.getByRole("button", { name: "Cancelar", exact: true }).click();
	await page.setViewportSize({ width: 812, height: 375 });
	await page.addStyleTag({ content: "html { -webkit-text-size-adjust: 200%; text-size-adjust: 200%; }" });
	expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
	await page.getByRole("button", { name: "Dot" }).scrollIntoViewIfNeeded();
	await expect(page.getByRole("button", { name: "Dot" })).toBeInViewport();
	await page.screenshot({ path: info.outputPath("apk-watchers-landscape.png") });
	await panel.getByRole("button", { name: "Eliminar tarea", exact: true }).click();
	await panel.getByRole("button", { name: "Sí, eliminar tarea", exact: true }).click();
	await expect(panel.getByText("Aún no hay tareas automáticas.")).toBeVisible();
	expect(actions().at(-1)).toEqual({ action: "delete", watchId: "fixture-watch" });
	await page.evaluate(() => window.__mobileShellNativeEvent("backButton"));
	await expect(page.getByRole("main", { name: "Ajustes", exact: true })).toBeVisible();
	await page.evaluate(() => window.__mobileShellNativeEvent("backButton"));
	await expect(draft).toHaveValue("Continúa después de revisar las novedades");
	await expect(page.locator(".chat-header")).toHaveCount(0);
	expect(errors).toEqual([]);
});

test("session history loads earlier pages without moving the text being read and restores each draft", async ({
	page,
}, info) => {
	await page.setViewportSize({ width: 375, height: 812 });
	const { errors, traffic } = await mountShell(page);
	let pageLoads = 0;
	await page.route(`${ORIGIN}/orchestration`, async (route) => {
		const request = route.request();
		const body = request.method() === "POST" ? request.postDataJSON() : undefined;
		if (body?.action !== "inspect") return route.fallback();
		expect(request.headers().authorization).toBe(`Bearer ${TOKEN}`);
		const earlier = body.before === "m40";
		if (earlier) pageLoads++;
		await route.fulfill({
			headers: { "Access-Control-Allow-Origin": "*" },
			json: {
				sessionId: "fixture-session",
				status: "working",
				question: null,
				work: {
					version: 1,
					truncated: false,
					agents: [],
					commands: [],
					plan: {
						source: "live",
						completed: 1,
						total: 2,
						tasks: [
							{ id: "t1", title: "Revisar el proyecto", status: "done" },
							{ id: "t2", title: "Comprobar los resultados", status: "in_progress" },
						],
					},
				},
				history: { supported: true, hasEarlier: !earlier, ...(!earlier ? { before: "m40" } : {}) },
				messages: Array.from({ length: earlier ? 10 : 50 }, (_, i) => ({
					id: `m${i + (earlier ? 30 : 40)}`,
					role: i % 2 ? "assistant" : "user",
					content: [
						{
							type: "text",
							text: `Mensaje ${i + (earlier ? 30 : 40)}. Una respuesta completa de esta sesión para revisar sin interrupciones.`,
						},
					],
				})),
			},
		});
	});
	await page.getByRole("textbox", { name: "Mensaje", exact: true }).fill("Mi borrador para Dot");
	await page.getByRole("button", { name: "Sesiones", exact: true }).click();
	await page.getByRole("button", { name: /Revisión del proyecto/ }).click();
	const conversation = page.getByRole("region", { name: "Conversación de la sesión" });
	await expect(conversation.getByRole("article")).toHaveCount(50);
	const viewport = page.locator(".agent-detail-scroll");
	const plan = page.getByRole("region", { name: "Plan de trabajo" });
	const planToggle = plan.locator("summary");
	await expect(planToggle).toBeInViewport();
	await expect(plan.locator("details")).not.toHaveAttribute("open", "");
	expect(await plan.evaluate((el) => el.closest(".agent-detail-scroll"))).toBeNull();
	await viewport.evaluate((el) => {
		el.scrollTop = el.scrollHeight / 2;
	});
	const readingPosition = await viewport.evaluate((el) => el.scrollTop);
	await planToggle.click();
	await expect(plan.getByText("Comprobar los resultados")).toBeVisible();
	await planToggle.click();
	expect(await viewport.evaluate((el) => el.scrollTop)).toBe(readingPosition);
	await page.screenshot({ path: info.outputPath("apk-plan-always-accessible.png") });
	await viewport.evaluate((el) => {
		el.scrollTop = 0;
	});
	const anchor = page.locator('[data-message-id="m40"]');
	const before = (await anchor.boundingBox())?.y;
	await page.getByRole("button", { name: "Ver mensajes anteriores" }).click();
	await expect(conversation.getByRole("article")).toHaveCount(60);
	await expect
		.poll(async () => Math.abs(((await anchor.boundingBox())?.y ?? 0) - (before ?? 0)))
		.toBeLessThanOrEqual(2);
	expect(pageLoads).toBe(1);
	await expect(page.getByRole("button", { name: "Ver mensajes anteriores" })).toHaveCount(0);
	const draft = page.getByRole("textbox", { name: "Continuar esta sesión" });
	await draft.fill("Borrador para esta sesión");
	const position = await viewport.evaluate((el) => el.scrollTop);
	await page.getByRole("button", { name: "Ajustes", exact: true }).click();
	await page.getByRole("button", { name: "Sesiones", exact: true }).click();
	await expect(draft).toHaveValue("Borrador para esta sesión");
	await expect.poll(() => viewport.evaluate((el) => el.scrollTop)).toBe(position);
	await page.getByRole("button", { name: "Todos los agentes", exact: true }).click();
	await page.getByRole("button", { name: /Revisión del proyecto/ }).click();
	await expect(draft).toHaveValue("Borrador para esta sesión");
	await expect(conversation.getByRole("article")).toHaveCount(60);
	await expect.poll(() => viewport.evaluate((el) => el.scrollTop)).toBe(position);
	await page.screenshot({ path: info.outputPath("apk-session-history.png") });
	await page.getByRole("button", { name: "Dot", exact: true }).click();
	await expect(page.getByRole("textbox", { name: "Mensaje", exact: true })).toHaveValue(
		"Mi borrador para Dot",
	);
	expect(traffic.http.some((request) => request.body?.action === "prompt")).toBe(false);
	expect(errors).toEqual([]);
});

test("phone approvals remain usable when Dot's model has failed", async ({ page }, info) => {
	await page.setViewportSize({ width: 375, height: 812 });
	const { traffic, errors } = await mountShell(page, { question: "confirm", agentError: true });
	let approved = false;
	await page.route(`${ORIGIN}/api/mobile/approvals`, async (route) => {
		if (route.request().method() === "OPTIONS") return route.fallback();
		await route.fulfill({
			headers: { "Access-Control-Allow-Origin": "*" },
			json: {
				approvals: approved
					? []
					: [
							{
								id: "browser-request",
								title: "Acceso al navegador",
								message: "Dot quiere abrir el sitio que solicitaste.",
								expiresAt: new Date(Date.now() + 60_000).toISOString(),
							},
						],
			},
		});
	});
	await page.route(`${ORIGIN}/api/mobile/answer`, async (route) => {
		if (route.request().method() === "OPTIONS") return route.fallback();
		expect(route.request().postDataJSON()).toEqual({ requestId: "browser-request", approved: true });
		expect(route.request().headers().authorization).toBe(`Bearer ${TOKEN}`);
		approved = true;
		await route.fulfill({ headers: { "Access-Control-Allow-Origin": "*" }, json: { ok: true } });
	});
	await page.getByRole("button", { name: /^Sesiones/ }).click();
	await expect(page.getByRole("button", { name: "Aprobar permiso de Dot", exact: true })).toBeEnabled();
	const permission = page.getByRole("region", { name: "Permisos pendientes" });
	await expect(permission.getByRole("button", { name: "Permitir", exact: true })).toBeEnabled();
	await page.screenshot({ path: info.outputPath("apk-independent-approvals.png") });
	await page.getByRole("button", { name: "Aprobar permiso de Dot", exact: true }).click();
	expect(approved).toBe(true);
	await permission.getByRole("button", { name: "Permitir", exact: true }).click();
	await expect.poll(() => traffic.http.filter((item) => item.body?.action === "answer").length).toBe(1);
	expect(traffic.ws.some((event) => event.type === "send")).toBe(false);
	expect(errors).toEqual([]);
});

test("reviewed mobile screens retain Gentle identity at 390px and landscape", async ({ page }, info) => {
	await page.setViewportSize({ width: 390, height: 844 });
	const { errors } = await mountShell(page, { workflow: true });
	await expectCompactChat(page);
	await page.screenshot({ path: info.outputPath("gentle-dot-chat-390.png") });
	await page.getByRole("button", { name: "Sesiones", exact: true }).click();
	await expect(page.locator(".agent-folder")).toHaveCount(0);
	await page.screenshot({ path: info.outputPath("gentle-dot-sessions-390.png") });
	await page.getByRole("button", { name: /Revisión del proyecto/ }).click();
	await expect(page.getByRole("region", { name: "Plan de trabajo" })).toBeVisible();
	await page.screenshot({ path: info.outputPath("gentle-dot-session-390.png") });
	await page.setViewportSize({ width: 844, height: 390 });
	await expect(page.getByRole("button", { name: "Enviar instrucción", exact: true })).toBeInViewport();
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
	await page.screenshot({ path: info.outputPath("gentle-dot-session-landscape.png") });
	await page.setViewportSize({ width: 390, height: 844 });
	await page.getByRole("button", { name: "Ajustes", exact: true }).click();
	await expect(page.getByRole("main", { name: "Ajustes", exact: true })).toBeVisible();
	await page.screenshot({ path: info.outputPath("gentle-dot-settings-390.png") });
	await page.setViewportSize({ width: 844, height: 390 });
	await expect(page.getByRole("button", { name: "Dot", exact: true })).toBeInViewport();
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
	await page.screenshot({ path: info.outputPath("gentle-dot-settings-landscape.png") });
	expect(errors).toEqual([]);
});

test("mobile system installation keeps authentication local and recovers its outcome", async ({
	page,
}, info) => {
	await page.setViewportSize({ width: 390, height: 844 });
	const { errors, traffic } = await mountShell(page);
	let installation: { requestId: string; status: string; message: string } | undefined;
	let finish!: () => void;
	let installCalls = 0;
	await page.route(`${ORIGIN}/browser`, async (route) => {
		if (route.request().method() === "OPTIONS") return route.fallback();
		const headers = { "Access-Control-Allow-Origin": "*" };
		if (route.request().method() === "GET")
			return route.fulfill({
				headers,
				json: {
					available: false,
					active: false,
					running: false,
					mode: "headless",
					tabs: [],
					desktopControl: "native-app",
					canRequestInstall: true,
					...(installation ? { installation } : {}),
				},
			});
		const body = route.request().postDataJSON();
		expect(route.request().headers().authorization).toBe(`Bearer ${TOKEN}`);
		if (body.action === "install_browser") {
			installCalls++;
			expect(body).toEqual({
				action: "install_browser",
				reason: "Quiero habilitar el navegador de Gentle Dot.",
			});
			installation = {
				requestId: "system-install",
				status: "pending",
				message: "Confirma la instalación en el equipo.",
			};
			await new Promise<void>((resolve) => {
				finish = resolve;
			});
			return route.fulfill({ headers, json: installation });
		}
		if (body.action === "stop") {
			await route.fulfill({
				headers,
				json: {
					available: false,
					active: false,
					running: false,
					mode: "headless",
					tabs: [],
					desktopControl: "native-app",
					canRequestInstall: true,
					installation,
				},
			});
			return;
		}
		throw new Error(`Unexpected browser action ${body.action}`);
	});
	await page.getByRole("button", { name: "Ajustes", exact: true }).click();
	await page.getByText("Aplicaciones y navegador", { exact: true }).click();
	await page.getByRole("button", { name: "Ver navegador" }).click();
	await page.getByRole("button", { name: "Instalar Chromium en el equipo" }).click();
	await expect(page.getByText(/La contraseña se escribe únicamente en el diálogo del sistema/)).toBeVisible();
	await expect(page.locator('input[type="password"]')).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Cancelar solicitud" })).toBeInViewport();
	expect(installCalls).toBe(1);
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
	await page.screenshot({ path: info.outputPath("instalacion-movil-0.11.png") });
	await page.getByRole("button", { name: "Cancelar solicitud" }).click();
	await expect(page.getByText(/Cancelación solicitada. Si la instalación ya comenzó/)).toBeVisible();
	await expect(page.getByRole("button", { name: "Cancelar solicitud" })).toBeDisabled();
	installation = {
		requestId: "system-install",
		status: "cancelled",
		message: "La solicitud se canceló antes de comenzar la instalación.",
	};
	finish();
	await expect(page.getByText(installation.message)).toBeVisible();
	await page.getByRole("button", { name: "Dot", exact: true }).click();
	await page.getByRole("button", { name: "Ajustes", exact: true }).click();
	await page.getByText("Aplicaciones y navegador", { exact: true }).click();
	await expect(page.getByText(installation.message)).toBeVisible();
	expect(installCalls).toBe(1);
	expect(traffic.ws.some((event) => event.type === "send")).toBe(false);
	expect(errors).toEqual([]);
});

test("mobile native questionnaires without a deadline stay actionable", async ({ page }, info) => {
	await page.setViewportSize({ width: 390, height: 844 });
	const { traffic, errors } = await mountShell(page, { question: "questionnaire", agentError: true });
	await page.getByRole("button", { name: /^Sesiones/ }).click();
	const card = page.locator(".agent-approval");
	await expect(card).toBeVisible();
	await card.getByRole("checkbox", { name: /Servidor/ }).check();
	await card.getByRole("checkbox", { name: /Interfaz/ }).check();
	await expect(card.getByText("Pendiente de tu respuesta")).toBeVisible();
	await card.getByRole("button", { name: "Enviar respuesta" }).scrollIntoViewIfNeeded();
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
	await page.screenshot({ path: info.outputPath("permisos-movil-0.11.png") });
	expect(traffic.http.some((request) => request.body?.action === "answer")).toBe(false);
	await card.getByRole("button", { name: "Enviar respuesta" }).click();
	await expect(card).toBeHidden();
	expect(traffic.http.find((request) => request.body?.action === "answer")?.body).toEqual({
		action: "answer",
		paneId: "fixture-pane",
		sessionId: "fixture-session",
		requestId: "fixture-question",
		answers: [{ questionId: "scope", optionIndices: [0, 1] }],
	});
	expect(traffic.ws.some((event) => event.type === "send")).toBe(false);
	expect(errors).toEqual([]);
});

test("Dot 24/7 creates a deliberate scoped task, explains unavailable email and preserves its paused state", async ({
	page,
}, info) => {
	await page.setViewportSize({ width: 375, height: 812 });
	const { traffic, errors } = await mountShell(page);
	const actions = () =>
		traffic.http
			.filter((request) => request.path === "/api/mobile/watchers" && request.method === "POST")
			.map((request) => request.body);
	const openTasks = async () => {
		await page.getByRole("button", { name: "Ajustes", exact: true }).click();
		await page.getByRole("button", { name: "Dot 24/7", exact: true }).click();
	};
	await openTasks();
	const panel = page.getByRole("main", { name: "Dot 24/7", exact: true });
	await panel.getByRole("button", { name: "Añadir tarea", exact: true }).click();
	const form = panel.getByRole("form", { name: "Nueva tarea automática" });
	await expect(form.getByRole("checkbox", { name: "Portal de clientes" })).toBeVisible();
	expect(actions()).toEqual([]);
	await form.getByRole("radio", { name: "Correo", exact: true }).check();
	await expect(form.getByText("Conecta Gmail en Conexiones para habilitar esta opción.")).toBeVisible();
	await form.getByRole("textbox", { name: "Qué debe identificar Dot" }).fill("Avísame de mensajes urgentes");
	await expect(form.getByRole("button", { name: "Activar tarea" })).toBeDisabled();
	await form.getByRole("radio", { name: "Sesiones", exact: true }).check();
	await expect(form.getByRole("button", { name: "Activar tarea" })).toBeDisabled();
	await form.getByRole("checkbox", { name: "Portal de clientes" }).check();
	const instruction = "Resume los resultados del portal y destaca los bloqueos";
	await form.getByRole("textbox", { name: "Qué debe identificar Dot" }).fill(instruction);
	const activate = form.getByRole("button", { name: "Activar tarea" });
	await expect(activate).toBeEnabled();
	await activate.scrollIntoViewIfNeeded();
	expect((await activate.boundingBox())?.height).toBeGreaterThanOrEqual(48);
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
	await page.screenshot({ path: info.outputPath("dot-24-7-create-375.png") });
	await page.setViewportSize({ width: 812, height: 375 });
	await page.addStyleTag({ content: "html { -webkit-text-size-adjust:200%; text-size-adjust:200%; }" });
	await activate.scrollIntoViewIfNeeded();
	await expect(activate).toBeInViewport();
	expect(await form.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
	await page.screenshot({ path: info.outputPath("dot-24-7-create-landscape.png") });
	expect(actions()).toEqual([]);
	await activate.click();
	await expect(form).toBeHidden();
	const card = panel.getByRole("article", { name: instruction });
	await expect(card.getByText("En espera", { exact: true })).toBeVisible();
	expect(actions()).toEqual([
		{
			action: "start",
			source: { kind: "agents", sessions: [{ paneId: "fixture-pane", sessionId: "fixture-session" }] },
			instruction,
		},
	]);
	await page.setViewportSize({ width: 375, height: 812 });
	await page.getByRole("button", { name: "Dot", exact: true }).click();
	await openTasks();
	await expect(card.getByText("En espera", { exact: true })).toBeVisible();
	await card.getByRole("button", { name: "Pausar", exact: true }).click();
	await expect(card.getByText("Pausado", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Dot", exact: true }).click();
	await openTasks();
	await expect(card.getByText("Pausado", { exact: true })).toBeVisible();
	expect(actions()).toEqual([
		{
			action: "start",
			source: { kind: "agents", sessions: [{ paneId: "fixture-pane", sessionId: "fixture-session" }] },
			instruction,
		},
		{ action: "pause", watchId: "fixture-created-watch" },
	]);
	expect(traffic.ws.some((event) => event.type === "send")).toBe(false);
	expect(errors).toEqual([]);
});

test("agent banners respect categories, expire without scrolling and leave no persistent activity strip", async ({
	page,
}, info) => {
	await page.setViewportSize({ width: 375, height: 812 });
	const { pushServer, errors } = await mountShell(page);
	const input = page.getByRole("textbox", { name: "Mensaje", exact: true });
	await input.fill("Mi mensaje pendiente");
	const transcript = page.locator(".chat-transcript");
	const before = await transcript.evaluate((el) => ({ top: el.scrollTop, height: el.clientHeight }));
	pushServer({
		type: "toast",
		level: "info",
		notificationEvent: "agentAvailable",
		notificationId: "idle",
		title: "Sesión disponible",
		message: "El agente está listo",
	});
	await expect(page.locator(".floating-notice")).toHaveCount(0);
	pushServer({
		type: "toast",
		level: "info",
		notificationEvent: "agentCompleted",
		notificationId: "complete",
		title: "Una sesión terminó",
		message: "La respuesta está lista en Sesiones.",
	});
	await expect(page.locator(".floating-notice")).toBeVisible();
	expect(await transcript.evaluate((el) => ({ top: el.scrollTop, height: el.clientHeight }))).toEqual(before);
	await expect(input).toHaveValue("Mi mensaje pendiente");
	await page.screenshot({ path: info.outputPath("apk-transient-notification.png") });
	await expect(page.locator(".floating-notice")).toHaveCount(0, { timeout: 7_000 });
	await expect(page.locator(".notices")).toHaveCount(0);
	expect(await transcript.evaluate((el) => ({ top: el.scrollTop, height: el.clientHeight }))).toEqual(before);
	expect(errors).toEqual([]);
});

for (const viewport of [
	{ width: 375, height: 812 },
	{ width: 812, height: 375 },
]) {
	for (const theme of ["dark", "light"]) {
		test(`session menu details visual ${theme} ${viewport.width}`, async ({ page }, info) => {
			await page.setViewportSize(viewport);
			await page.addInitScript(
				(theme) =>
					localStorage.setItem(
						"gentle-dot-chat-appearance-v1",
						JSON.stringify({ version: 1, theme, fontSize: 20 }),
					),
				theme,
			);
			const { traffic, errors } = await mountShell(page);
			await page.getByRole("button", { name: "Sesiones", exact: true }).click();
			await page.getByRole("button", { name: "Revisión del proyecto · Trabajando", exact: true }).click();
			await expect(page.getByText(/Ya revisé la estructura/)).toBeVisible();
			await page.getByLabel("Detalles de la sesión").click();
			await expect(page.getByRole("button", { name: "Duplicar sesión", exact: true })).toBeDisabled();
			await page.getByRole("button", { name: "Información de la sesión", exact: true }).click();
			const dialog = page.getByRole("dialog", { name: "Información de la sesión", exact: true });
			await expect(dialog.locator("dd").filter({ hasText: "GPT-6 Sol" })).toBeVisible();
			for (const label of await dialog.locator("dt").all())
				expect(
					await label.evaluate((element) => element.scrollWidth - element.clientWidth),
				).toBeLessThanOrEqual(1);
			const rect = await dialog.boundingBox();
			expect(rect?.x).toBeGreaterThanOrEqual(0);
			expect((rect?.x ?? 0) + (rect?.width ?? 0)).toBeLessThanOrEqual(viewport.width);
			expect(rect?.y).toBeGreaterThanOrEqual(24);
			expect((rect?.y ?? 0) + (rect?.height ?? 0)).toBeLessThanOrEqual(viewport.height - 24);
			expect(await dialog.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
			await page.screenshot({ path: info.outputPath(`session-info-${theme}-${viewport.width}.png`) });
			await dialog.locator("summary").filter({ hasText: "Conexiones MCP" }).click();
			await expect(dialog.getByText("Configurado · 0 herramientas", { exact: true })).toBeVisible();
			await page.screenshot({ path: info.outputPath(`session-mcp-${theme}-${viewport.width}.png`) });
			await page.keyboard.press("Escape");
			await expect(dialog).toHaveCount(0);
			await expect(page.getByLabel("Continuar esta sesión")).toBeVisible();
			await page.getByLabel("Detalles de la sesión").click();
			await page.getByRole("button", { name: "Cerrar sesión", exact: true }).click();
			await expect(page.getByRole("dialog", { name: "Cerrar esta sesión", exact: true })).toBeVisible();
			await page.getByRole("button", { name: "Volver", exact: true }).click();
			expect(
				traffic.http.filter((x) => x.body?.action === "close" || x.body?.action === "duplicate"),
			).toHaveLength(0);
			expect(errors).toEqual([]);
		});
	}
}

test("session menu confirms duplicate and close for the exact session", async ({ page }) => {
	const { traffic, errors } = await mountShell(page);
	await page.route(`${ORIGIN}/orchestration`, async (route) => {
		if (route.request().method() !== "GET") return route.fallback();
		await route.fulfill({
			json: {
				available: true,
				sessions: [
					{
						provider: "herdr",
						paneId: "fixture-pane",
						sessionId: "fixture-session",
						terminalId: "fixture-terminal",
						workspaceId: "fixture-workspace",
						label: "Revisión del proyecto",
						state: "idle",
						managed: true,
						connected: true,
						cwd: "/fixture/project",
						capabilities: {
							inspect: true,
							prompt: true,
							abort: true,
							approvals: true,
							close: true,
							duplicate: true,
						},
					},
				],
				approvals: [],
				policies: [],
				events: [],
			},
			headers: { "Access-Control-Allow-Origin": "*" },
		});
	});
	await page.getByRole("button", { name: "Sesiones", exact: true }).click();
	await page.getByRole("button", { name: "Actualizar sesiones", exact: true }).click();
	await page.getByRole("button", { name: "Revisión del proyecto · Disponible", exact: true }).click();
	await page.getByLabel("Continuar esta sesión").fill("Un borrador pendiente");
	await page.getByLabel("Detalles de la sesión").click();
	await page.getByRole("button", { name: "Duplicar sesión", exact: true }).click();
	expect(traffic.http.filter((x) => x.body?.action === "duplicate")).toHaveLength(0);
	await page.getByRole("button", { name: "Crear copia", exact: true }).click();
	await expect.poll(() => traffic.http.filter((x) => x.body?.action === "duplicate").length).toBe(1);
	expect(traffic.http.find((x) => x.body?.action === "duplicate")?.body).toEqual({
		action: "duplicate",
		paneId: "fixture-pane",
		sessionId: "fixture-session",
	});
	await expect(page.getByLabel("Continuar esta sesión")).toHaveValue("Un borrador pendiente");
	await page.getByLabel("Detalles de la sesión").click();
	await page.getByRole("button", { name: "Cerrar sesión", exact: true }).click();
	expect(traffic.http.filter((x) => x.body?.action === "close")).toHaveLength(0);
	await page.evaluate(() => window.__mobileShellNativeEvent("backButton"));
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await expect(page.getByLabel("Continuar esta sesión")).toHaveValue("Un borrador pendiente");
	await page.getByLabel("Detalles de la sesión").click();
	await page.getByRole("button", { name: "Cerrar sesión", exact: true }).click();
	await page.getByRole("button", { name: "Sí, cerrar sesión", exact: true }).click();
	await expect.poll(() => traffic.http.filter((x) => x.body?.action === "close").length).toBe(1);
	expect(traffic.http.find((x) => x.body?.action === "close")?.body).toEqual({
		action: "close",
		paneId: "fixture-pane",
		sessionId: "fixture-session",
	});
	await expect(page.getByRole("heading", { name: "Sesiones", exact: true })).toBeVisible();
	expect(errors).toEqual([]);
});

test("phone browser access and Dot rejection require explicit choices in their current screens", async ({
	page,
}, info) => {
	await page.setViewportSize({ width: 375, height: 812 });
	const { errors } = await mountShell(page);
	const actions: Record<string, unknown>[] = [];
	const answers: Record<string, unknown>[] = [];
	let active = false;
	const headers = { "Access-Control-Allow-Origin": "*" };
	await page.route(`${ORIGIN}/browser`, async (route) => {
		if (route.request().method() === "OPTIONS") return route.fallback();
		expect(route.request().headers().authorization).toBe(`Bearer ${TOKEN}`);
		if (route.request().method() === "POST") {
			const action = route.request().postDataJSON() as Record<string, unknown>;
			actions.push(action);
			active = action.action === "start";
		}
		await route.fulfill({
			headers,
			json: {
				available: true,
				active,
				running: active,
				mode: "headless",
				tabs: [],
				desktopControl: "native-app",
			},
		});
	});
	await page.route(`${ORIGIN}/api/mobile/approvals`, async (route) => {
		if (route.request().method() === "OPTIONS") return route.fallback();
		await route.fulfill({
			headers,
			json: {
				approvals: answers.length
					? []
					: [
							{
								id: "reviewed-request",
								title: "Publicar revisión",
								message: "Revisa antes de publicar.",
								expiresAt: new Date(Date.now() + 120_000).toISOString(),
							},
						],
			},
		});
	});
	await page.route(`${ORIGIN}/api/mobile/answer`, async (route) => {
		if (route.request().method() === "OPTIONS") return route.fallback();
		expect(route.request().headers().authorization).toBe(`Bearer ${TOKEN}`);
		answers.push(route.request().postDataJSON());
		await route.fulfill({ headers, json: { ok: true } });
	});
	await page.getByRole("textbox", { name: "Mensaje", exact: true }).fill("Conserva este borrador");
	await page.getByRole("button", { name: "Sesiones", exact: true }).click();
	await expect(page.getByRole("button", { name: "Rechazar permiso de Dot" })).toBeEnabled();
	expect(answers).toEqual([]);
	await page.getByRole("button", { name: "Rechazar permiso de Dot" }).click();
	await expect.poll(() => answers).toEqual([{ requestId: "reviewed-request", approved: false }]);

	await page.getByRole("button", { name: "Ajustes", exact: true }).click();
	await page.getByText("Aplicaciones y navegador", { exact: true }).click();
	await page.getByRole("button", { name: "Ver navegador", exact: true }).click();
	const browser = page.getByRole("region", { name: "Navegador de Gentle Dot", exact: true });
	await expect(browser.getByRole("button", { name: "Activar navegador", exact: true })).toBeDisabled();
	await expect(browser.getByLabel("Desactivar automáticamente")).toBeHidden();
	expect(actions).toEqual([]);
	await browser.getByLabel("Permitir que Dot use este navegador.", { exact: true }).check();
	await browser.getByRole("button", { name: "Activar navegador", exact: true }).click();
	await expect(browser.getByText("Acceso activado", { exact: true })).toBeVisible();
	expect(actions).toEqual([{ action: "start", window: false }]);
	await browser.getByRole("button", { name: "Detener navegador y revocar acceso" }).click();
	await expect.poll(() => actions).toEqual([{ action: "start", window: false }, { action: "stop" }]);
	await expect(browser.getByRole("button", { name: "Activar navegador", exact: true })).toBeDisabled();
	await browser.getByText("Limitar duración", { exact: true }).click();
	await browser.getByLabel("Desactivar automáticamente").selectOption("480");
	await browser.getByLabel("Permitir que Dot use este navegador.", { exact: true }).check();
	await browser.getByRole("button", { name: "Activar navegador", exact: true }).click();
	await expect.poll(() => actions[2]).toEqual({ action: "start", minutes: 480, window: false });
	await browser.getByRole("button", { name: "Detener navegador y revocar acceso" }).scrollIntoViewIfNeeded();
	await expect(browser.getByRole("button", { name: "Detener navegador y revocar acceso" })).toBeInViewport();
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
	await page.screenshot({ path: info.outputPath("phone-browser-human-access.png") });
	await browser.getByRole("button", { name: "Detener navegador y revocar acceso" }).click();
	await expect.poll(() => actions[3]).toEqual({ action: "stop" });
	await page.getByRole("button", { name: "Dot", exact: true }).click();
	await expect(page.getByRole("textbox", { name: "Mensaje", exact: true })).toHaveValue(
		"Conserva este borrador",
	);
	expect(errors).toEqual([]);
});

test("phone revokes a previous permission from the session menu without losing its draft", async ({
	page,
}, info) => {
	await page.setViewportSize({ width: 375, height: 812 });
	const { errors } = await mountShell(page);
	const actions: Record<string, unknown>[] = [];
	let revoked = false;
	await page.route(`${ORIGIN}/orchestration`, async (route) => {
		if (route.request().method() === "OPTIONS") return route.fallback();
		expect(route.request().headers().authorization).toBe(`Bearer ${TOKEN}`);
		const headers = { "Access-Control-Allow-Origin": "*" };
		if (route.request().method() === "POST") {
			const action = route.request().postDataJSON() as Record<string, unknown>;
			if (action.action !== "revoke") return route.fallback();
			actions.push(action);
			revoked = true;
			return route.fulfill({ headers, json: { ok: true } });
		}
		await route.fulfill({
			headers,
			json: {
				available: true,
				sessions: [
					{
						paneId: "fixture-pane",
						sessionId: "fixture-session",
						label: "Revisión del proyecto",
						state: "idle",
						connected: true,
						managed: true,
						cwd: "/fixture/project",
						capabilities: { inspect: true, prompt: true },
					},
				],
				approvals: [],
				policies: revoked
					? []
					: [
							{
								id: "previous-policy",
								paneId: "fixture-pane",
								sessionId: "fixture-session",
								action: "Publicar los cambios revisados",
								expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
								remainingUses: 2,
							},
						],
				events: [],
			},
		});
	});
	await page.getByRole("textbox", { name: "Mensaje", exact: true }).fill("Mi borrador de Dot");
	await page.getByRole("button", { name: "Sesiones", exact: true }).click();
	await page.getByRole("button", { name: /Revisión del proyecto/ }).click();
	const message = page.getByRole("textbox", { name: "Continuar esta sesión", exact: true });
	await message.fill("Mi siguiente instrucción");
	const revoke = page.getByRole("button", { name: "Revocar permiso", exact: true });
	await expect(revoke).toBeHidden();
	await page.getByLabel("Detalles de la sesión", { exact: true }).click();
	await expect(revoke).toBeVisible();
	expect(actions).toEqual([]);
	await page.setViewportSize({ width: 812, height: 375 });
	await revoke.scrollIntoViewIfNeeded();
	await expect(revoke).toBeInViewport();
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
	await page.screenshot({ path: info.outputPath("phone-session-revoke-landscape.png") });
	await revoke.click();
	await expect.poll(() => actions).toEqual([{ action: "revoke", policyId: "previous-policy" }]);
	await expect(revoke).toHaveCount(0);
	await page.getByLabel("Detalles de la sesión", { exact: true }).click();
	await expect(message).toHaveValue("Mi siguiente instrucción");
	await page.getByRole("button", { name: "Dot", exact: true }).click();
	await expect(page.getByRole("textbox", { name: "Mensaje", exact: true })).toHaveValue("Mi borrador de Dot");
	expect(errors).toEqual([]);
});

test("mobile desktop control stays in settings and can stop without the Dot model", async ({
	page,
}, info) => {
	await page.setViewportSize({ width: 390, height: 844 });
	const { errors, traffic } = await mountShell(page);
	let active = true;
	let stopped = 0;
	await page.route(`${ORIGIN}/api/mobile/computer`, async (route) => {
		if (route.request().method() === "OPTIONS") return route.fallback();
		expect(route.request().headers().authorization).toBe(`Bearer ${TOKEN}`);
		if (route.request().method() === "POST") {
			expect(route.request().postDataJSON()).toEqual({ action: "stop" });
			active = false;
			stopped++;
		}
		await route.fulfill({
			headers: { "Access-Control-Allow-Origin": "*" },
			json: {
				available: true,
				platform: "linux",
				permissions: { accessibility: true, screenRecording: true, screenshotsSupported: true },
				state: { active, yolo: false },
				capabilities: { backend: "hyprland", supported: true, missingDependencies: [], limitations: [] },
			},
		});
	});
	expect(traffic.http.some((r) => r.path === "/api/mobile/computer")).toBe(false);
	await page.getByRole("button", { name: "Ajustes", exact: true }).click();
	await page.getByText("Aplicaciones y navegador", { exact: true }).click();
	const control = page.getByRole("region", { name: "Control del equipo", exact: true });
	await expect(control.getByText("Dot está controlando el escritorio")).toBeVisible();
	const stop = control.getByRole("button", { name: "Detener control del equipo" });
	await stop.scrollIntoViewIfNeeded();
	await expect(stop).toBeInViewport();
	await page.screenshot({ path: info.outputPath("phone-desktop-control.png") });
	await stop.click();
	await expect.poll(() => stopped).toBe(1);
	await expect(control.getByText("Listo cuando lo necesites")).toBeVisible();
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
	await page.getByRole("button", { name: "Dot", exact: true }).click();
	await expect(control).not.toBeVisible();
	expect(errors).toEqual([]);
});
