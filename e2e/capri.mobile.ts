import { expect, type Locator, type Page, test } from "@playwright/test";
import type {} from "./mobile-shell-native.ts";

const host = "https://capri-fixture.test.ts.net";

/** The actual mobile shell, with every host call intercepted; no terminal or model is contacted. */
async function mount(page: Page) {
	const requests: string[] = [];
	let mode = "gentle";
	let sendEvent: (event: object) => void = () => {};
	let disconnect = () => {};
	let offline = false;
	await page.addInitScript(
		({ host }) => {
			window.__mobileShellFixture = {
				connection: {
					url: host,
					token: "fixture_capri_token_0123456789abcdef",
					deviceId: "capri-phone",
					name: "Mi equipo",
				},
				monitoring: false,
				calls: [],
			};
		},
		{ host },
	);
	await page.route(`${host}/**`, async (route) => {
		const path = new URL(route.request().url()).pathname;
		requests.push(path);
		if (path === "/api/mobile/companion" && route.request().method() === "POST")
			mode = route.request().postDataJSON().mode;
		const bodies: Record<string, unknown> = {
			"/api/mobile/companion": { mode },
			"/orchestration": { available: true, sessions: [], approvals: [], policies: [], events: [] },
			"/api/mobile/approvals": { approvals: [] },
			"/api/mobile/workflows": { workflows: [], pending: 0 },
			"/api/mobile/browser": { pending: [], connected: false },
			"/api/mobile/computer": { available: false, state: { active: false, yolo: false } },
			"/api/mobile/completions": { enabled: false, pending: 0 },
		};
		await route.fulfill({ json: bodies[path] ?? {}, headers: { "Access-Control-Allow-Origin": "*" } });
	});
	await page.routeWebSocket(`${host.replace("https:", "wss:")}/ws`, (socket) => {
		if (offline) {
			socket.close({ code: 1001 });
			return;
		}
		disconnect = () => {
			offline = true;
			socket.close({ code: 1001 });
		};
		let seq = 0;
		const send = (value: object) => socket.send(JSON.stringify({ ...value, seq: ++seq }));
		sendEvent = send;
		socket.onMessage((data) => {
			const message = JSON.parse(String(data));
			if (message.type === "hello")
				send({
					type: "ready",
					agentState: "idle",
					features: { conversations: false },
					voice: { transcribe: false, speak: false },
				});
			if (message.type === "get_history")
				send({
					type: "history",
					messages: [
						{ id: "u", role: "user", text: "Revisa el avance de mis sesiones.", activities: [] },
						{
							id: "a",
							role: "assistant",
							text: "Aquí contigo. Puedes abrir una sesión para ver su avance y responder sus preguntas.",
							activities: [],
						},
					],
				});
		});
	});
	await page.goto("/");
	await expect(page.getByText("Revisa el avance de mis sesiones.", { exact: true })).toBeVisible();
	return {
		requests,
		state: (state: "idle" | "working" | "error") => sendEvent({ type: "agent_state", state }),
		disconnect: () => disconnect(),
		ask: () =>
			sendEvent({
				type: "ask",
				ask: {
					requestId: "capri-question",
					method: "confirm",
					title: "Pregunta de prueba",
					message: "¿Continuar con la tarea de prueba?",
				},
			}),
	};
}

test("plays different drawn frames and freezes the actual picture with reduced motion", async ({ page }) => {
	const fixture = await mount(page);
	await enable(page);
	fixture.state("error");
	const sprite = page.locator(".capri-float .capri-sprite");
	await expect(sprite).toHaveAttribute("data-animation", "crying");
	await expect(sprite).toHaveAttribute("data-playing", "true");
	const firstFrame = await sprite.getAttribute("data-frame");
	const first = await sprite.screenshot({ animations: "allow" });
	await expect.poll(() => sprite.getAttribute("data-frame")).not.toBe(firstFrame);
	const second = await sprite.screenshot({ animations: "allow" });
	expect(first.equals(second)).toBe(false);
	await expect(sprite).toHaveCSS("animation-name", "none");
	await page.emulateMedia({ reducedMotion: "reduce" });
	await expect(sprite).toHaveAttribute("data-playing", "false");
	const frozenFrame = await sprite.getAttribute("data-frame");
	if (frozenFrame === null) throw new Error("Missing frozen animation frame");
	const frozen = await sprite.screenshot({ animations: "allow" });
	await page.waitForTimeout(500);
	await expect(sprite).toHaveAttribute("data-frame", frozenFrame);
	expect(frozen.equals(await sprite.screenshot({ animations: "allow" }))).toBe(true);
});

test("follows real typing and sending, while pinning preserves the chosen place", async ({ page }) => {
	await mount(page);
	await enable(page);
	const editor = page.locator(".composer textarea");
	const overlay = page.locator(".capri-overlay");
	await editor.fill("Mensaje para probar la reacción de Capri");
	await expect(overlay).toHaveAttribute("data-activity", "typing");
	await expect(page.locator(".capri-float .capri-sprite")).toHaveAttribute("data-playing", "true");
	await expect
		.poll(async () => {
			const sprite = await page.locator(".capri-float").boundingBox();
			const input = await editor.boundingBox();
			return sprite && input ? input.y - (sprite.y + sprite.height) : 999;
		})
		.toBeLessThan(64);
	await page.getByRole("button", { name: "Enviar mensaje", exact: true }).click();
	await expect(overlay).toHaveAttribute("data-activity", "submitted");
	await expect(page.locator(".capri-float .capri-sprite")).toHaveAttribute(
		"data-animation",
		"follow-message",
	);
	await pause(page);
	const before = await page.locator(".capri-float").boundingBox();
	await editor.fill("Sigo escribiendo con Capri fija");
	await expect(overlay).toHaveAttribute("data-activity", "typing");
	const after = await page.locator(".capri-float").boundingBox();
	expect(Math.abs((before?.x ?? 0) - (after?.x ?? 0))).toBeLessThan(3);
	expect(Math.abs((before?.y ?? 0) - (after?.y ?? 0))).toBeLessThan(3);
	await page.screenshot({ path: ".cache/capri-context-mobile-typing.png" });
});

async function enable(page: Page) {
	await page.getByRole("button", { name: "Ajustes", exact: true }).click();
	await page.getByRole("switch", { name: "Modo Capri" }).click();
	await expect(page.locator(".chat")).toHaveAttribute("data-companion", "capri");
	await expect(page.locator(".capri-overlay")).toBeVisible();
	await expect(page.getByRole("button", { name: "Mover a Capri", exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Capri", exact: true }).click();
}

async function menu(page: Page) {
	const panel = page.locator(".capri-bubble-menu");
	if (!(await panel.isVisible()))
		await page.getByRole("button", { name: "Mover a Capri", exact: true }).click();
	await expect(panel).toBeVisible();
	return panel;
}

async function pause(page: Page) {
	const panel = await menu(page);
	const pin = panel.getByRole("button", { name: "Fijar aquí", exact: true });
	if (await pin.isVisible()) await pin.click();
	else await page.keyboard.press("Escape");
	await expect(page.locator(".capri-overlay")).toHaveAttribute("data-motion", "false");
}

async function center(locator: Locator) {
	const box = await locator.boundingBox();
	if (!box) throw new Error("The companion control has no visible bounds.");
	return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function drag(page: Page, x: number, y: number, touch = false) {
	const handle = page.getByRole("button", { name: "Mover a Capri", exact: true });
	const start = await center(handle);
	if (touch) {
		const input = await page.context().newCDPSession(page);
		try {
			await input.send("Input.dispatchTouchEvent", {
				type: "touchStart",
				touchPoints: [{ ...start, id: 1 }],
			});
			for (let step = 1; step <= 12; step++)
				await input.send("Input.dispatchTouchEvent", {
					type: "touchMove",
					touchPoints: [
						{ x: start.x + ((x - start.x) * step) / 12, y: start.y + ((y - start.y) * step) / 12, id: 1 },
					],
				});
			await input.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
		} finally {
			await input.detach();
		}
	} else {
		await page.mouse.move(start.x, start.y);
		await page.mouse.down();
		await page.mouse.move(x, y, { steps: 12 });
		await page.mouse.up();
	}
	await expect
		.poll(async () => {
			const point = await center(handle);
			return Math.hypot(point.x - start.x, point.y - start.y);
		})
		.toBeGreaterThan(30);
	await expect(page.locator(".capri-bubble-menu")).not.toBeVisible();
}

async function insideViewport(locator: Locator) {
	await expect
		.poll(async () =>
			locator.evaluate((element) => {
				const box = element.getBoundingClientRect();
				return (
					box.left >= -1 && box.top >= -1 && box.right <= innerWidth + 1 && box.bottom <= innerHeight + 1
				);
			}),
		)
		.toBe(true);
}

test("Capri floats without reserving a row, drags freely and lets exterior clicks reach the app", async ({
	page,
}) => {
	await page.setViewportSize({ width: 375, height: 740 });
	const { requests } = await mount(page);
	const transcript = page.locator(".chat-transcript");
	const composer = page.locator(".chat-composer");
	const before = { transcript: await transcript.boundingBox(), composer: await composer.boundingBox() };
	await enable(page);
	await expect(page.locator(".capri-stage, .companion-toolbar, .capri-gallery")).toHaveCount(0);
	expect(
		await page.locator(".capri-overlay").evaluate((element) => ({
			parent: element.parentElement?.className,
			root: element.parentElement?.parentElement?.tagName,
			position: getComputedStyle(element).position,
			pointerEvents: getComputedStyle(element).pointerEvents,
		})),
	).toEqual({ parent: "companion-layer", root: "BODY", position: "fixed", pointerEvents: "none" });
	await expect
		.poll(async () => ({
			transcript: await transcript.boundingBox(),
			composer: await composer.boundingBox(),
		}))
		.toEqual(before);
	await pause(page);
	const handle = page.getByRole("button", { name: "Mover a Capri", exact: true });
	const start = await center(handle);
	await drag(page, start.x > 187 ? 95 : 280, start.y > 370 ? 250 : 490);
	expect(
		await page.locator(".capri-float").evaluate((element) => getComputedStyle(element).transform),
	).not.toBe("none");
	await insideViewport(handle);

	const textarea = page.locator("textarea");
	const input = await center(textarea);
	expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName, input)).toBe("TEXTAREA");
	await page.mouse.click(input.x, input.y);
	await expect(textarea).toBeFocused();
	await page.keyboard.type("Este borrador se queda aquí");
	await expect(textarea).toHaveValue("Este borrador se queda aquí");
	await expect(page.locator(".capri-float .capri-sprite")).toHaveAttribute("data-pose", /^eyes(?:-blink)?$/);
	await page.screenshot({ path: ".cache/capri-floating-phone.png" });

	await menu(page);
	await page.mouse.click(input.x, input.y);
	await expect(page.locator(".capri-bubble-menu")).not.toBeVisible();
	await expect(textarea).toBeFocused();
	await page.getByRole("button", { name: "Ajustes", exact: true }).click();
	await page.getByRole("switch", { name: "Modo Capri" }).click();
	await expect(page.locator(".capri-overlay")).toHaveCount(0);
	await expect(page.locator(".chat")).toHaveAttribute("data-companion", "gentle");
	expect(requests.filter((path) => path === "/api/mobile/companion").length).toBeGreaterThanOrEqual(3);
});

test("Capri offers keyboard movement, pause, minimize and viewport bounds on resize", async ({ page }) => {
	await page.setViewportSize({ width: 375, height: 740 });
	await mount(page);
	await enable(page);
	await pause(page);
	await drag(page, 187, 300, true);
	const handle = page.getByRole("button", { name: "Mover a Capri", exact: true });
	for (const direction of [
		{ key: "ArrowUp", axis: "y", sign: -1 },
		{ key: "ArrowDown", axis: "y", sign: 1 },
		{ key: "ArrowLeft", axis: "x", sign: -1 },
		{ key: "ArrowRight", axis: "x", sign: 1 },
	] as const) {
		const start = await center(handle);
		await handle.focus();
		await expect(handle).toHaveCSS("outline-style", "none");
		await expect(handle).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
		await page.keyboard.press(direction.key);
		await expect
			.poll(async () => ((await center(handle))[direction.axis] - start[direction.axis]) * direction.sign)
			.toBeGreaterThan(2);
	}
	let panel = await menu(page);
	await panel.getByRole("button", { name: "Dejar pasear", exact: true }).click();
	panel = await menu(page);
	await panel.getByRole("button", { name: "Fijar aquí", exact: true }).click();
	panel = await menu(page);
	await panel.getByRole("button", { name: "Ocultar a Capri", exact: true }).click();
	await expect(handle).toHaveCount(0);
	const restore = page.getByRole("button", { name: "Mostrar a Capri", exact: true });
	await expect(restore).toBeVisible();
	await insideViewport(restore);
	await restore.click();
	await expect(handle).toBeVisible();
	for (const viewport of [
		{ width: 375, height: 740 },
		{ width: 820, height: 390 },
		{ width: 1280, height: 800 },
		{ width: 320, height: 568 },
	]) {
		await page.setViewportSize(viewport);
		await insideViewport(handle);
		await insideViewport(await menu(page));
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
		await page.keyboard.press("Escape");
		await expect(page.locator(".capri-bubble-menu")).not.toBeVisible();
	}
	await page.screenshot({ path: ".cache/capri-floating-small-phone.png" });
	await page.emulateMedia({ reducedMotion: "reduce" });
	await expect
		.poll(async () =>
			page
				.locator(".capri-float .capri-sprite")
				.evaluate((element) => getComputedStyle(element).animationName),
		)
		.toBe("none");
	expect(
		await page
			.locator(".capri-float")
			.evaluate((element) => parseFloat(getComputedStyle(element).transitionDuration)),
	).toBeLessThan(0.001);
});

test("one independent sprite persists across chat, sessions, settings and connection loss", async ({
	page,
}) => {
	await page.setViewportSize({ width: 375, height: 740 });
	const fixture = await mount(page);
	await enable(page);
	await pause(page);
	const handle = page.getByRole("button", { name: "Mover a Capri", exact: true });
	const original = await handle.elementHandle();
	const sameSprite = async () => {
		await expect(page.locator(".capri-overlay")).toHaveCount(1);
		expect(await handle.evaluate((element, original) => element === original, original)).toBe(true);
		const point = await center(handle);
		expect(
			await page.evaluate(
				({ x, y }) => document.elementFromPoint(x, y)?.closest(".capri-drag-handle") !== null,
				point,
			),
		).toBe(true);
	};
	await page.getByRole("button", { name: "Sesiones", exact: true }).click();
	await expect(page.locator(".sessions-screen")).toBeVisible();
	await sameSprite();
	await page.screenshot({ path: ".cache/capri-app-overlay-sessions.png" });
	await page.getByRole("button", { name: "Ajustes", exact: true }).click();
	await expect(page.getByRole("region", { name: "Capri en la app", exact: true })).toBeVisible();
	await sameSprite();
	await expect(page.locator(".capri-gallery, .companion-scene-preview")).toHaveCount(0);
	await expect(page.getByRole("combobox", { name: "Forma", exact: true })).toHaveCount(0);
	await page.getByText("Colores y animación", { exact: true }).click();
	await page.getByRole("combobox", { name: "Colores de la app", exact: true }).selectOption("afterlife");
	await expect(page.locator(".chat")).toHaveAttribute("data-ambience", "afterlife");
	await sameSprite();
	await page.getByRole("button", { name: "Capri", exact: true }).click();
	fixture.disconnect();
	await expect(page.getByText(/Reconectando con tu equipo|Conectando…/, { exact: true })).toBeVisible();
	await sameSprite();
	await expect(page.locator(".capri-overlay")).toContainText("Esperando conexión con tu equipo");
	await expect(page.locator(".capri-float .capri-sprite")).toHaveAttribute("data-pose", "sleep");
	await page.screenshot({ path: ".cache/capri-app-overlay-offline.png" });
});

test("Capri stays interactive above a real modal while outside touches still reach its controls", async ({
	page,
}) => {
	await page.setViewportSize({ width: 375, height: 740 });
	const fixture = await mount(page);
	await enable(page);
	await pause(page);
	await page.getByRole("button", { name: "Ajustes", exact: true }).click();
	await page.getByRole("radio", { name: "Ventana emergente con respuestas" }).check();
	await page.getByRole("button", { name: "Capri", exact: true }).click();
	const handle = page.getByRole("button", { name: "Mover a Capri", exact: true });
	const original = await handle.elementHandle();
	const beforeModal = await handle.boundingBox();
	fixture.ask();
	const dialog = page.getByRole("dialog", { name: "Solicitudes pendientes", exact: true });
	await expect(dialog).toBeVisible();
	await expect
		.poll(() =>
			page.locator("[data-companion-layer]").evaluate((element) => ({
				modal: element.parentElement?.matches("dialog:modal"),
				popover: element.matches(":popover-open"),
			})),
		)
		.toEqual({ modal: true, popover: true });
	const clearsQuestion = async () => {
		const sprite = await handle.boundingBox(),
			question = await dialog.boundingBox();
		if (!sprite || !question) return false;
		return (
			sprite.x + sprite.width <= question.x ||
			sprite.x >= question.x + question.width ||
			sprite.y + sprite.height <= question.y ||
			sprite.y >= question.y + question.height
		);
	};
	await expect.poll(clearsQuestion).toBe(true);
	await expect(page.locator(".capri-speech")).not.toBeVisible();
	expect(await handle.evaluate((element, original) => element === original, original)).toBe(true);
	const point = await center(handle);
	expect(
		await page.evaluate(
			({ x, y }) => document.elementFromPoint(x, y)?.closest(".capri-drag-handle") !== null,
			point,
		),
	).toBe(true);
	const panel = await menu(page);
	await page.keyboard.press("Escape");
	await expect(panel).not.toBeVisible();
	await expect(dialog).toBeVisible();
	await menu(page);
	await panel.getByRole("button", { name: "Hazte a un lado", exact: true }).click();
	await expect(panel).not.toBeVisible();
	await expect(dialog).toBeVisible();
	await expect.poll(clearsQuestion).toBe(true);
	await page.setViewportSize({ width: 375, height: 330 });
	await expect
		.poll(async () => {
			const sprite = await handle.boundingBox();
			return sprite ? sprite.width <= 80 && sprite.height <= 60 : false;
		})
		.toBe(true);
	await insideViewport(handle);
	await expect(page.locator(".capri-float .capri-sprite")).toHaveAttribute("data-pose", "eyes");
	await page.screenshot({ path: ".cache/capri-app-overlay-modal-compact.png" });
	await page.setViewportSize({ width: 375, height: 740 });
	await expect.poll(clearsQuestion).toBe(true);
	const close = dialog.getByRole("button", { name: "Cerrar sin responder", exact: true });
	const outside = await center(close);
	expect(
		await close.evaluate(
			(element, point) => element.contains(document.elementFromPoint(point.x, point.y)),
			outside,
		),
	).toBe(true);
	await page.screenshot({ path: ".cache/capri-app-overlay-modal.png" });
	await page.mouse.click(outside.x, outside.y);
	await expect(dialog).toHaveCount(0);
	await expect
		.poll(() => page.locator("[data-companion-layer]").evaluate((element) => element.parentElement?.tagName))
		.toBe("BODY");
	expect(await handle.evaluate((element, original) => element === original, original)).toBe(true);
	await expect
		.poll(async () => {
			const after = await handle.boundingBox();
			return after && beforeModal
				? Math.hypot(after.x - beforeModal.x, after.y - beforeModal.y)
				: Number.POSITIVE_INFINITY;
		})
		.toBeLessThan(2);
	await menu(page);
});

test("Capri clears the mobile composer and respects safe areas as the keyboard opens", async ({ page }) => {
	await page.setViewportSize({ width: 375, height: 740 });
	await mount(page);
	await page.addStyleTag({
		content: ":root { --safe-area-inset-top: 24px; --safe-area-inset-bottom: 16px; }",
	});
	await enable(page);
	await pause(page);
	const handle = page.getByRole("button", { name: "Mover a Capri", exact: true });
	const textarea = page.locator("textarea");
	const input = await center(textarea);
	await drag(page, input.x, input.y, true);
	const clearComposer = async () => {
		const sprite = await handle.boundingBox();
		const composer = await page.locator(".composer").boundingBox();
		if (!sprite || !composer) return false;
		return sprite.y >= 24 && sprite.y + sprite.height <= composer.y - 10;
	};
	await expect.poll(clearComposer).toBe(true);
	await textarea.fill("Mensaje privado mientras aparece el teclado");
	await page.setViewportSize({ width: 375, height: 330 });
	await expect(textarea).toBeFocused();
	await expect.poll(clearComposer).toBe(true);
	await insideViewport(handle);
	await expect(textarea).toHaveValue("Mensaje privado mientras aparece el teclado");
	const keyboardInput = await center(textarea);
	expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName, keyboardInput)).toBe(
		"TEXTAREA",
	);
	await page.screenshot({ path: ".cache/capri-app-overlay-keyboard.png" });
	await page.setViewportSize({ width: 740, height: 375 });
	await expect.poll(clearComposer).toBe(true);
	await insideViewport(handle);
});

test("Capri keeps text at 200% usable when the keyboard leaves a short viewport", async ({ page }) => {
	await page.setViewportSize({ width: 375, height: 740 });
	await mount(page);
	await enable(page);
	await pause(page);
	await page.setViewportSize({ width: 375, height: 330 });
	const handle = page.getByRole("button", { name: "Mover a Capri", exact: true });
	await insideViewport(handle);
	const panel = await menu(page);
	const minimize = panel.getByRole("button", { name: "Ocultar a Capri", exact: true });
	const originalSize = await minimize.evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
	// Chromium's shell fixture has no Android text-scale setting. Double the actual
	// computed text sizes, including px-based labels, without scaling control bounds.
	await panel.evaluate((element) => {
		const text = [element, ...element.querySelectorAll<HTMLElement>("button, p, strong")].map((node) => ({
			node,
			size: parseFloat(getComputedStyle(node).fontSize),
		}));
		for (const { node, size } of text)
			(node as HTMLElement).style.setProperty("font-size", `${size * 2}px`, "important");
	});
	expect(await minimize.evaluate((element) => parseFloat(getComputedStyle(element).fontSize))).toBe(
		originalSize * 2,
	);
	await insideViewport(panel);
	expect(await panel.evaluate((element) => getComputedStyle(element).overflowY)).toBe("auto");
	expect(await panel.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
	expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
	await minimize.scrollIntoViewIfNeeded();
	await expect(minimize).toBeInViewport({ ratio: 1 });
	expect(await panel.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
	await insideViewport(panel);
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
	await page.screenshot({ path: ".cache/capri-floating-large-text-keyboard.png" });
	await minimize.click();
	await expect(panel).not.toBeVisible();
	const restore = page.getByRole("button", { name: "Mostrar a Capri", exact: true });
	await expect(restore).toBeVisible();
	await insideViewport(restore);
	await restore.click();
	await expect(handle).toBeVisible();
	await insideViewport(handle);
});

test("a touch drag interrupts Capri's real automatic walk at its visible position", async ({ page }) => {
	test.setTimeout(35_000);
	await page.setViewportSize({ width: 375, height: 740 });
	await mount(page);
	await enable(page);
	const floating = page.locator(".capri-float");
	const input = await page.context().newCDPSession(page);
	try {
		// Wait for the real 20-second walking timer and its CSS transition. Neither
		// the clock nor the rendered transform is replaced by this test.
		await page.waitForFunction(
			() => document.querySelector<HTMLElement>(".capri-float")?.dataset.travelling === "true",
			undefined,
			{ timeout: 23_000 },
		);
		await page.waitForTimeout(250);
		const visual = await floating.evaluate((element) => {
			const box = element.getBoundingClientRect();
			const target = new DOMMatrixReadOnly((element as HTMLElement).style.transform);
			return {
				x: box.x,
				y: box.y,
				width: box.width,
				height: box.height,
				targetX: target.m41,
				targetY: target.m42,
			};
		});
		const remaining = Math.hypot(visual.targetX - visual.x, visual.targetY - visual.y);
		expect(remaining).toBeGreaterThan(25);
		const touch = { x: visual.x + visual.width / 2, y: visual.y + visual.height / 2, id: 1 };
		await input.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [touch] });
		await expect(floating).toHaveAttribute("data-travelling", "false");
		const held = await floating.boundingBox();
		if (!held) throw new Error("Capri disappeared when the walking sprite was touched.");
		expect(Math.hypot(held.x - visual.x, held.y - visual.y)).toBeLessThan(20);
		expect(Math.hypot(held.x - visual.targetX, held.y - visual.targetY)).toBeGreaterThan(remaining / 2);
		for (let step = 1; step <= 4; step++)
			await input.send("Input.dispatchTouchEvent", {
				type: "touchMove",
				touchPoints: [{ ...touch, x: touch.x + step * 10 }],
			});
		await input.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
		await expect
			.poll(async () => {
				const box = await floating.boundingBox();
				return box ? Math.hypot(box.x - held.x - 40, box.y - held.y) : Number.POSITIVE_INFINITY;
			})
			.toBeLessThan(3);
		await expect(page.locator(".capri-bubble-menu")).not.toBeVisible();
		await insideViewport(page.getByRole("button", { name: "Mover a Capri", exact: true }));
		await page.screenshot({ path: ".cache/capri-floating-drag-during-walk.png" });
	} finally {
		await input.detach();
	}
});

test("pinning keeps gestures alive and the chosen area survives reopening", async ({ page }) => {
	await page.setViewportSize({ width: 375, height: 740 });
	const fixture = await mount(page);
	await enable(page);
	fixture.state("error");
	await pause(page);
	const sprite = page.locator(".capri-float .capri-sprite");
	await expect(sprite).toHaveAttribute("data-animation", "crying");
	const frame = await sprite.getAttribute("data-frame");
	const box = await page.locator(".capri-float").boundingBox();
	await page.getByRole("button", { name: "Mover a Capri", exact: true }).hover();
	await expect.poll(() => sprite.getAttribute("data-frame")).not.toBe(frame);
	expect(await page.locator(".capri-float").boundingBox()).toEqual(box);
	await page.getByRole("button", { name: "Ajustes", exact: true }).click();
	await expect(page.getByRole("button", { name: "Fija aquí", exact: true })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await page.getByText("Área donde puede estar", { exact: true }).click();
	await page.getByRole("button", { name: "Derecha", exact: true }).click();
	await expect
		.poll(() =>
			page.evaluate(() => JSON.parse(localStorage.getItem("gentle-dot-companion-v1") ?? "{}").space),
		)
		.toEqual({ x: 0.5, y: 0, width: 0.5, height: 1 });
	await expect(page.getByRole("button", { name: "Derecha", exact: true })).toHaveCSS(
		"border-top-color",
		"rgb(188, 248, 106)",
	);
	await page.screenshot({ path: ".cache/capri-settings-phone-375.png" });
	await page.getByRole("button", { name: "Capri", exact: true }).click();
	await drag(page, 15, 250, true);
	const placed = await page.locator(".capri-float").boundingBox();
	expect(placed?.x).toBeGreaterThanOrEqual(187.5);
	await page.getByRole("button", { name: "Ajustes", exact: true }).click();
	await expect(page.getByRole("button", { name: "Fija aquí", exact: true })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
	await page.getByRole("button", { name: "Capri", exact: true }).click();
	fixture.state("idle");
	fixture.ask();
	const speech = page.locator(".capri-speech");
	await expect(speech).toBeVisible();
	await expect(speech).toContainText("Hay una pregunta para ti");
	await expect(speech).toHaveCSS("border-top-width", "0px");
	const askCard = page.locator(".ask-card");
	await expect(askCard).toBeVisible();
	const neutralLine = await askCard.evaluate((element) => {
		const probe = document.createElement("span");
		probe.style.color = "var(--line)";
		element.appendChild(probe);
		const color = getComputedStyle(probe).color;
		probe.remove();
		return color;
	});
	await expect(askCard).toHaveCSS("border-top-color", neutralLine);
	await expect(askCard).toHaveCSS("box-shadow", "none");
	const handle = page.getByRole("button", { name: "Mover a Capri", exact: true });
	await page.keyboard.press("Tab");
	await handle.focus();
	await expect(handle).toBeFocused();
	await expect(handle).toHaveCSS("outline-style", "none");
	await expect(sprite).toHaveCSS("filter", /drop-shadow\(rgb\(255, 242, 252\)/);
	await expect(handle).toHaveAccessibleDescription(/Hay una pregunta para ti/);
	await page.screenshot({ path: ".cache/capri-0.20.8-mobile-question.png" });
});
