import { expect, type Page, test } from "@playwright/test";

const origin = "https://mobile-sessions-fixture.test.ts.net";
const token = "fixture_sessions_token_0123456789abcdef";
const session = (id: string, label: string, state = "working") => ({
	paneId: id,
	sessionId: `session-${id}`,
	label,
	state,
	provider: "herdr",
	terminalId: `terminal-${id}`,
	workspaceId: "workspace",
	connected: true,
	managed: true,
	capabilities: { inspect: true, prompt: true, abort: true, approvals: true, close: true, duplicate: true },
});
const conversation = (id: string) => ({
	sessionId: `session-${id}`,
	status: "working",
	question: null,
	metadata: {
		version: 1,
		model: { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openai-codex", contextWindow: 200000 },
		thinkingLevel: "high",
		profile: { name: "Desarrollo", source: "repo" },
		context: { tokens: 84000, contextWindow: 200000, percent: 42 },
		mcp: [
			{ name: "GitHub", status: "available", tools: 12 },
			{ name: "Engram", status: "available", tools: 7 },
		],
		tools: { active: ["read", "bash"], available: 21 },
		skills: [],
	},
	messages: [
		{
			id: "human",
			role: "user",
			content: [{ type: "text", text: "Revisa la aplicación y valida los cambios." }],
		},
		...Array.from({ length: 8 }, (_, i) => ({
			id: `answer-${i}`,
			role: "assistant",
			content: [
				{
					type: "text",
					text: `Paso ${i + 1}. La revisión conserva la conversación y valida los cambios del proyecto.`,
				},
			],
		})),
		{
			id: "delegate",
			role: "assistant",
			provenance: { kind: "subagent", label: "Revisor" },
			content: [{ type: "text", text: "Revisión terminada. Las pruebas pasan y el cambio está listo." }],
		},
		{
			id: "last",
			role: "assistant",
			content: [{ type: "text", text: "Estoy integrando la revisión y comprobando el resultado." }],
		},
	],
	work: {
		version: 1,
		truncated: false,
		plan: {
			source: "live",
			completed: 2,
			total: 3,
			tasks: [
				{ id: "one", title: "Revisar cambios", status: "done" },
				{ id: "two", title: "Validar pruebas", status: "done" },
				{ id: "three", title: "Comprobar en móvil", status: "in_progress" },
			],
		},
		agents: [
			{
				id: "active",
				agent: "Implementador",
				label: "Comprobar la vista móvil",
				status: "running",
				source: "live",
			},
			...Array.from({ length: 20 }, (_, i) => ({
				id: `old-${i}`,
				agent: "Subagente antiguo",
				status: "completed",
				source: "history",
			})),
		],
		commands: [
			{
				id: "old-command",
				tool: "bash",
				label: "pnpm test",
				status: "completed",
				source: "history",
				output: "Logs de prueba",
			},
		],
	},
});

async function setup(page: Page, theme: "dark" | "light" = "dark", fontSize = 16) {
	await page.addInitScript(
		({ origin, token, theme, fontSize }) => {
			window.__mobileShellFixture = {
				connection: { url: origin, token, deviceId: "fixture-phone", name: "Mi equipo" },
				monitoring: false,
				calls: [],
			};
			localStorage.setItem("gentle-dot-chat-appearance-v1", JSON.stringify({ version: 1, theme, fontSize }));
		},
		{ origin, token, theme, fontSize },
	);
	await page.route(`${origin}/**`, (route) => {
		const path = new URL(route.request().url()).pathname;
		const action = route.request().method() === "POST" ? route.request().postDataJSON() : undefined;
		const body =
			path === "/orchestration"
				? action?.action === "inspect"
					? conversation(action.paneId)
					: {
							available: true,
							sessions: [session("a", "Aplicación móvil"), session("b", "Revisión de API", "idle")],
							approvals: [],
							policies: [],
							events: [],
						}
				: { approvals: [], workflows: [], pending: 0, enabled: false };
		return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
	});
	let emit!: (payload: object) => void;
	await page.routeWebSocket(`${origin.replace("https:", "wss:")}/ws`, (socket) => {
		let seq = 0;
		emit = (data) => socket.send(JSON.stringify({ ...data, seq: ++seq }));
		socket.onMessage((raw) => {
			const command = JSON.parse(String(raw));
			if (command.type === "hello") emit({ type: "ready", agentState: "idle", model: "Gentle" });
			if (command.type === "get_history") emit({ type: "history", messages: [] });
		});
	});
	await page.goto("/");
	await expect(page.locator(".chat-mobile")).toHaveAttribute("data-chat-theme", theme);
	await page.getByRole("button", { name: "Sesiones", exact: true }).click();
	await page.getByRole("button", { name: "Aplicación móvil · Trabajando" }).click();
	await expect(page.getByText("Estoy integrando la revisión y comprobando el resultado.")).toBeVisible();
	return (id: string, paneId: string) =>
		emit({
			type: "toast",
			level: "info",
			title: "Una sesión terminó",
			message: "La respuesta está lista en Sesiones.",
			notificationEvent: "agentCompleted",
			notificationId: id,
			session: { paneId, sessionId: `session-${paneId}` },
		});
}

test("session chat keeps only active work, separates delegated replies and opens orchestrator details", async ({
	page,
}, info) => {
	const failures: string[] = [];
	page.on("pageerror", (error) => failures.push(error.message));
	await setup(page);
	await expect(page.locator(".agent-message-user")).toHaveCount(1);
	await expect(page.locator('[data-message-id="delegate"]')).not.toHaveClass(/agent-message-user/);
	await expect(page.getByText("Subagente antiguo")).toHaveCount(0);
	await expect(page.getByText("Ver resultado", { exact: true })).toHaveCount(0);
	await expect(page.getByText("GPT-5.6 Sol").first()).toBeVisible();
	await expect(page.getByText(/42\s?%/).first()).toBeVisible();
	await page.screenshot({ path: info.outputPath("session-dark-412.png") });
	await page.locator(".agent-workflow > summary").click();
	const delegates = page.getByRole("list", { name: "Subagentes activos" });
	await expect(delegates.getByRole("listitem")).toHaveCount(1);
	await expect(delegates.getByRole("img", { name: "Trabajando" })).toBeVisible();
	await page.screenshot({ path: info.outputPath("session-active-delegates-412.png") });
	await page.locator(".agent-workflow > summary").click();
	for (const width of [320, 375, 780]) {
		await page.setViewportSize({ width, height: width === 780 ? 390 : 820 });
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
	}
	await page.setViewportSize({ width: 375, height: 820 });
	await page.getByText("GPT-5.6 Sol").first().click();
	const dialog = page.getByRole("dialog", { name: "Información de la sesión" });
	await expect(dialog).toBeVisible();
	await expect(dialog.getByText(/Desarrollo/)).toBeVisible();
	await expect(dialog.getByRole("progressbar", { name: "Contexto utilizado" })).toHaveAttribute(
		"value",
		"42",
	);
	await dialog.locator("summary").filter({ hasText: /MCP/ }).click();
	await expect(dialog.getByText("GitHub", { exact: true })).toBeVisible();
	await page.screenshot({ path: info.outputPath("session-details-dark-375.png") });
	expect(failures).toEqual([]);
});

test("compact notifications respect the session being read and open a different session without scrolling chat", async ({
	page,
}, info) => {
	const notify = await setup(page, "light", 20);
	await page.emulateMedia({ reducedMotion: "reduce" });
	const viewport = page.locator(".agent-detail-scroll");
	await viewport.evaluate((node) => {
		node.scrollTop = 10;
	});
	const before = await viewport.evaluate((node) => node.scrollTop);
	notify("same-session", "a");
	await expect(page.locator(".floating-notice")).toHaveCount(0);
	notify("other-session", "b");
	await expect(page.locator(".floating-notice")).toBeVisible();
	await expect(page.locator(".floating-notice")).not.toContainText("La respuesta está lista en Sesiones.");
	expect(await viewport.evaluate((node) => node.scrollTop)).toBe(before);
	await page.screenshot({ path: info.outputPath("session-notice-light-412.png") });
	await page.getByRole("button", { name: "Respuesta lista · Abrir sesión" }).click();
	await expect(page.getByRole("region", { name: "Sesión Revisión de API", exact: true })).toBeVisible();
	await expect(page.locator(".floating-notice")).toHaveCount(0);
	await page.setViewportSize({ width: 320, height: 820 });
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
	await page.screenshot({ path: info.outputPath("session-light-320.png") });
});
