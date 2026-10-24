import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BrowserContext } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	BrowserController,
	type BrowserOptions,
	type BrowserSnapshot,
	browserExecutable,
} from "../src/browser.ts";
import { BrowserRequests } from "../src/browser-requests.ts";
import { registerBrowserTools } from "../src/extensions/dot-browser.ts";
import { SharedFileStore } from "../src/shared-files.ts";

const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function directory() {
	const path = mkdtempSync(join(tmpdir(), "dot-browser-test-"));
	cleanups.push(() => rmSync(path, { recursive: true, force: true }));
	return path;
}
function controller(options: Partial<BrowserOptions> = {}) {
	const browser = new BrowserController({
		dataDir: directory(),
		executablePath: process.execPath,
		...options,
	});
	cleanups.push(() => browser.close());
	return browser;
}
function context() {
	const fake = Object.assign(new EventEmitter(), {
		pages: () => [],
		setDefaultTimeout: vi.fn(),
		setDefaultNavigationTimeout: vi.fn(),
		route: vi.fn(async () => {}),
		close: vi.fn(async () => {
			fake.emit("close");
		}),
	});
	return fake;
}

describe("dedicated browser authority and lifecycle", () => {
	it("refuses agent activation, ungranted navigation and arbitrary code", async () => {
		const launch = vi.fn();
		const browser = controller({ launch });
		await expect(browser.action({ action: "start", minutes: 480 }, "agent")).rejects.toMatchObject({
			code: "HUMAN_REQUIRED",
		});
		await expect(
			browser.action({ action: "open", url: "https://example.com" }, "agent"),
		).rejects.toMatchObject({ code: "HUMAN_REQUIRED" });
		await expect(browser.action({ action: "evaluate", code: "process.env" }, "agent")).rejects.toMatchObject({
			code: "UNKNOWN_ACTION",
		});
		expect(launch).not.toHaveBeenCalled();
	});

	it("keeps disabled server mode closed without loading the browser", async () => {
		const launch = vi.fn();
		const browser = controller({ launch, disabledReason: "Modo servidor separado" });
		expect(browser.status()).toMatchObject({
			available: false,
			active: false,
			reason: "Modo servidor separado",
		});
		await expect(browser.action({ action: "start" }, "human")).rejects.toMatchObject({ code: "UNAVAILABLE" });
		expect(launch).not.toHaveBeenCalled();
	});

	it("creates only a private dedicated profile, bounds overnight grants, and closes on expiry", async () => {
		const dataDir = directory();
		const fake = context();
		const launch = vi.fn(async () => fake as unknown as BrowserContext);
		let now = Date.now();
		const browser = controller({ dataDir, launch, now: () => now });
		await expect(browser.action({ action: "start", minutes: 481 }, "human")).rejects.toMatchObject({
			code: "INVALID_INPUT",
		});
		await browser.action({ action: "start", minutes: 480 }, "human");
		expect(launch).toHaveBeenCalledWith(
			join(dataDir, "browser-profile"),
			expect.objectContaining({ chromiumSandbox: true, headless: true, acceptDownloads: false }),
		);
		expect(statSync(join(dataDir, "browser-profile")).mode & 0o777).toBe(0o700);
		expect(browser.status()).toMatchObject({
			active: true,
			running: true,
			expiresAt: new Date(now + 480 * 60_000).toISOString(),
		});
		expect(JSON.stringify(browser.status())).not.toContain(dataDir);
		now += 480 * 60_000 + 1;
		await expect(
			browser.action({ action: "open", url: "https://example.com" }, "agent"),
		).rejects.toMatchObject({ code: "HUMAN_REQUIRED" });
		expect(fake.close).toHaveBeenCalledOnce();
		expect(browser.status().active).toBe(false);
	});

	it("does not follow an existing profile symlink", async () => {
		const dataDir = directory();
		const target = directory();
		symlinkSync(target, join(dataDir, "browser-profile"));
		const launch = vi.fn();
		const browser = controller({ dataDir, launch });
		await expect(browser.action({ action: "start" }, "human")).rejects.toMatchObject({
			code: "PROFILE_INVALID",
		});
		expect(launch).not.toHaveBeenCalled();
	});
	it("keeps explicitly enabled access until revoked without a default timer", async () => {
		const fake = context();
		let now = Date.now();
		const browser = controller({ launch: async () => fake as unknown as BrowserContext, now: () => now });
		await browser.action({ action: "start" }, "human");
		now += 30 * 24 * 60 * 60_000;
		expect(browser.status()).toMatchObject({ active: true, running: true });
		expect(browser.status().expiresAt).toBeUndefined();
		await browser.action({ action: "stop" }, "human");
		expect(browser.status().active).toBe(false);
	});

	it("cancels an in-flight launch and every queued action immediately when stopped", async () => {
		const fake = context();
		let complete!: (value: BrowserContext) => void;
		const launch = vi.fn(
			() =>
				new Promise<BrowserContext>((resolve) => {
					complete = resolve;
				}),
		);
		const browser = controller({ launch });
		const starting = browser.action({ action: "start" }, "human");
		const opening = browser.action({ action: "open", url: "https://example.com" }, "agent");
		const failures = Promise.all([
			expect(starting).rejects.toMatchObject({ code: "STOPPED" }),
			expect(opening).rejects.toMatchObject({ code: "STOPPED" }),
		]);
		await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce());
		await browser.action({ action: "stop" }, "human");
		complete(fake as unknown as BrowserContext);
		await failures;
		expect(fake.close).toHaveBeenCalledOnce();
		expect(browser.status()).toMatchObject({ active: false, running: false });
	});

	it("rechecks phone revocation after waiting in the serialized queue", async () => {
		const fake = context();
		let complete!: (value: BrowserContext) => void;
		const launch = vi.fn(
			() =>
				new Promise<BrowserContext>((resolve) => {
					complete = resolve;
				}),
		);
		const browser = controller({ launch });
		let allowed = true;
		const starting = browser.action({ action: "start" }, "human");
		const queued = browser.action({ action: "tabs" }, "human", () => allowed);
		const rejected = expect(queued).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce());
		allowed = false;
		complete(fake as unknown as BrowserContext);
		await starting;
		await rejected;
	});

	it.each(["stop", "revoke"])(
		"does not install a stale expiry timer when %s happens during browser setup",
		async (change) => {
			const fake = context();
			let finish!: () => void;
			let entered!: () => void;
			const routing = new Promise<void>((resolve) => {
				entered = resolve;
			});
			fake.route.mockImplementation(async () => {
				entered();
				await new Promise<void>((resolve) => {
					finish = resolve;
				});
			});
			let allowed = true;
			const browser = controller({ launch: async () => fake as unknown as BrowserContext });
			const starting = browser.action({ action: "start" }, "human", () => allowed);
			const rejected = expect(starting).rejects.toMatchObject({ code: "STOPPED" });
			await routing;
			if (change === "stop") await browser.action({ action: "stop" }, "human");
			else allowed = false;
			const timers = vi.spyOn(globalThis, "setTimeout");
			try {
				finish();
				await rejected;
				expect(timers).not.toHaveBeenCalled();
				expect(browser.status()).toMatchObject({ active: false, running: false });
				expect(fake.close).toHaveBeenCalledOnce();
			} finally {
				timers.mockRestore();
			}
		},
	);
});

describe("browser tool", () => {
	it("exposes typed actions and image content, without an activation or JavaScript escape hatch", async () => {
		let tool!: Parameters<ExtensionAPI["registerTool"]>[0];
		const pi = {
			registerTool: (value: typeof tool) => {
				tool = value;
			},
		} as ExtensionAPI;
		const call = vi.fn(async () => ({ text: "Page", image: { mime: "image/jpeg", data: "base64" } }));
		registerBrowserTools(pi, call);
		expect(tool.name).toBe("dot_browser");
		const execute = tool.execute as unknown as (
			id: string,
			params: Record<string, unknown>,
		) => Promise<{ content: unknown[] }>;
		await expect(execute("1", { action: "start" })).rejects.toThrow("no está disponible");
		await expect(execute("2", { action: "evaluate" })).rejects.toThrow("no está disponible");
		const result = await execute("3", { action: "snapshot", tabId: "tab" });
		expect(result.content).toEqual([
			{ type: "text", text: '{"text":"Page"}' },
			{ type: "image", mimeType: "image/jpeg", data: "base64" },
		]);
		expect(call).toHaveBeenCalledOnce();
	});
});

describe("real Chromium against a local disposable page", () => {
	it.skipIf(!browserExecutable())(
		"navigates, fills, selects, checks, clicks, captures screenshots and rejects stale refs",
		async () => {
			const server = createServer((request, response) => {
				response.setHeader("content-type", "text/html; charset=utf-8");
				response.end(
					request.url === "/frame"
						? "<label>Dentro del marco<input></label>"
						: `<!doctype html><html><title>Prueba Gentle Dot</title><body><h1>Página de prueba local</h1><form onsubmit="event.preventDefault();document.querySelector('output').textContent='Recibido: '+document.querySelector('input').value"><label>Nombre<input></label><label>Opción<select><option value="one">Uno</option><option value="two">Dos</option></select></label><label>Acepto<input type="checkbox"></label><button>Enviar prueba</button></form><output></output><iframe title="Marco de prueba" src="/frame"></iframe><div style="height:1800px">Contenido</div></body></html>`,
				);
			});
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("No local fixture port");
			const browser = controller({ executablePath: browserExecutable() });
			await browser.action({ action: "start", minutes: 30 }, "human");
			await expect(
				browser.action({ action: "open", url: "file:///etc/passwd" }, "agent"),
			).rejects.toMatchObject({ code: "INVALID_URL" });
			let page = (await browser.action(
				{ action: "open", url: `http://127.0.0.1:${address.port}/?token=hidden-value` },
				"agent",
			)) as BrowserSnapshot;
			expect(page.title).toBe("Prueba Gentle Dot");
			expect(page.text).toContain("Página de prueba local");
			expect(page.url).not.toContain("hidden-value");
			expect(page.elements.some((element) => element.name === "Dentro del marco")).toBe(true);
			const initial = page;
			const perform = async (action: string, name: string, extra: Record<string, unknown> = {}) => {
				const element = page.elements.find((item) => item.name === name);
				expect(element, name).toBeDefined();
				page = (await browser.action(
					{ action, tabId: page.tabId, snapshotId: page.snapshotId, ref: element?.ref, ...extra },
					"agent",
				)) as BrowserSnapshot;
			};
			await perform("fill", "Nombre", { text: "Gentle Dot" });
			await expect(
				browser.action(
					{
						action: "click",
						tabId: initial.tabId,
						snapshotId: initial.snapshotId,
						ref: initial.elements[0]?.ref,
					},
					"agent",
				),
			).rejects.toMatchObject({ code: "STALE_SNAPSHOT" });
			await perform("select", "Opción", { values: ["two"] });
			await perform("check", "Acepto", { checked: true });
			await perform("click", "Enviar prueba");
			expect(page.text).toContain("Recibido: Gentle Dot");
			page = (await browser.action(
				{ action: "scroll", tabId: page.tabId, direction: "down", pixels: 600 },
				"agent",
			)) as BrowserSnapshot;
			page = (await browser.action(
				{ action: "snapshot", tabId: page.tabId, screenshot: true },
				"agent",
			)) as BrowserSnapshot;
			expect(page.image?.mime).toBe("image/jpeg");
			expect(Buffer.from(page.image?.data ?? "", "base64").byteLength).toBeGreaterThan(100);
			const files = new SharedFileStore(directory());
			const requests = new BrowserRequests({ browser, files, ask: vi.fn() });
			const shared = (await requests.action({ action: "share_screenshot", tabId: page.tabId }, "agent")) as {
				file: { id: string; markdown: string; image: boolean };
			};
			expect(shared.file.image).toBe(true);
			expect(shared.file.markdown).toBe(`![Captura del navegador](/api/files/${shared.file.id}/content)`);
			expect(files.read(shared.file.id).meta.mime).toBe("image/jpeg");
			await browser.action({ action: "close_tab", tabId: page.tabId }, "agent");
			expect(browser.status().tabs.some((tab) => tab.id === page.tabId)).toBe(false);
			await browser.action({ action: "stop" }, "human");
			expect(browser.status()).toMatchObject({ running: false, active: false, tabs: [] });
		},
		30_000,
	);
});
