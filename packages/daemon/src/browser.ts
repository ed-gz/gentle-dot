import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserContext, BrowserType, ElementHandle, Page } from "playwright-core";
import { runtimeDir } from "./runtime.ts";

const runtime = runtimeDir();
export const BROWSER_EXTENSION_PATH = runtime
	? join(runtime, "daemon", "extensions", "dot-browser.ts")
	: fileURLToPath(new URL("./extensions/dot-browser.ts", import.meta.url));

export class BrowserError extends Error {
	readonly code: string;
	readonly status: number;
	constructor(code: string, message: string, status = 400) {
		super(message);
		this.code = code;
		this.status = status;
	}
}

export interface BrowserStatus {
	available: boolean;
	active: boolean;
	running: boolean;
	mode: "headless" | "window";
	expiresAt?: string;
	reason?: string;
	tabs: { id: string; title: string; url: string }[];
	/** Native whole-desktop input is provided by the desktop app, separately from this browser. */
	desktopControl: "native-app";
}

export interface BrowserSnapshot {
	tabId: string;
	snapshotId: string;
	url: string;
	title: string;
	text: string;
	elements: {
		ref: string;
		role: string;
		name: string;
		frame: string;
		disabled: boolean;
		options?: { label: string; value: string }[];
	}[];
	truncated: boolean;
	image?: { mime: "image/jpeg"; data: string };
}

export type BrowserAction =
	| { action: "status" | "tabs" | "stop" }
	| { action: "start"; minutes?: number; window?: boolean }
	| { action: "open"; url: string; tabId?: string }
	| { action: "snapshot"; tabId: string; screenshot?: boolean }
	| { action: "click"; tabId: string; snapshotId: string; ref: string }
	| { action: "fill"; tabId: string; snapshotId: string; ref: string; text: string }
	| { action: "select"; tabId: string; snapshotId: string; ref: string; values: string[] }
	| { action: "check"; tabId: string; snapshotId: string; ref: string; checked: boolean }
	| { action: "scroll"; tabId: string; direction: "up" | "down"; pixels?: number }
	| { action: "back" | "close_tab"; tabId: string };

export interface BrowserOptions {
	dataDir: string;
	executablePath?: string;
	disabledReason?: string;
	now?: () => number;
	/** Injection seam for deterministic lifecycle tests. Production uses a private persistent Chromium profile. */
	launch?: BrowserType["launchPersistentContext"];
}

interface Tab {
	id: string;
	page: Page;
	title: string;
	snapshotId?: string;
	navigation: number;
	refs: Map<string, { handle: ElementHandle; fingerprint: string }>;
}

const MAX_TABS = 8;
const MAX_ELEMENTS = 100;
const MAX_TEXT = 16_000;
const MAX_PENDING = 12;
const ACTION_TIMEOUT = 10_000;
const NAVIGATION_TIMEOUT = 20_000;

function string(value: unknown, name: string, max = 4096): string {
	if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0"))
		throw new BrowserError("INVALID_INPUT", `El campo ${name} no es válido.`);
	return value;
}

function website(value: unknown): string {
	const address = string(value, "url");
	let url: URL;
	try {
		url = new URL(address);
	} catch {
		throw new BrowserError("INVALID_URL", "Indica una dirección web HTTP o HTTPS completa.");
	}
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
		throw new BrowserError(
			"INVALID_URL",
			"Solo se admiten páginas HTTP o HTTPS sin contraseñas en la dirección.",
		);
	return url.href;
}

function publicUrl(address: string): string {
	try {
		const url = new URL(address);
		if (url.protocol === "about:") return "about:blank";
		if (!["https:", "http:"].includes(url.protocol)) return "Página no compatible";
		url.username = "";
		url.password = "";
		url.hash = "";
		for (const key of [...url.searchParams.keys()])
			if (/token|secret|password|api.?key|^code$/i.test(key)) url.searchParams.set(key, "[oculto]");
		return url.href;
	} catch {
		return "Página no compatible";
	}
}

/** Resolve a known installation; never run a command, install a browser, or use the user's profile. */
export function browserExecutable(explicit?: string): string | undefined {
	if (explicit) return isAbsolute(explicit) && existsSync(explicit) ? explicit : undefined;
	const candidates =
		process.platform === "darwin"
			? [
					"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
					"/Applications/Chromium.app/Contents/MacOS/Chromium",
				]
			: process.platform === "win32"
				? [
						join(
							process.env.PROGRAMFILES ?? "C:\\Program Files",
							"Google",
							"Chrome",
							"Application",
							"chrome.exe",
						),
						join(
							process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)",
							"Microsoft",
							"Edge",
							"Application",
							"msedge.exe",
						),
					]
				: [
						"/usr/bin/chromium",
						"/usr/bin/chromium-browser",
						"/usr/bin/google-chrome",
						"/usr/bin/google-chrome-stable",
					];
	return candidates.find((path) => existsSync(path));
}

/** A single dedicated browser. Human grants and cancellation are enforced outside the model process. */
export class BrowserController {
	private get executable(): string | undefined {
		return browserExecutable(this.options.executablePath ?? process.env.GENTLE_DOT_BROWSER_EXECUTABLE);
	}
	private readonly options: BrowserOptions;
	private readonly now: () => number;
	private context?: BrowserContext;
	private readonly tabs = new Map<string, Tab>();
	private queue: Promise<unknown> = Promise.resolve();
	private pending = 0;
	private generation = 0;
	private expires = 0;
	private timer?: ReturnType<typeof setTimeout>;
	private mode: BrowserStatus["mode"] = "headless";
	private closed = false;
	private failure?: string;

	constructor(options: BrowserOptions) {
		this.options = options;
		this.now = options.now ?? Date.now;
	}

	status(): BrowserStatus {
		const active = this.expires > this.now();
		const reason =
			this.options.disabledReason ??
			(!this.executable ? "No se encontró Chromium o Chrome en el equipo." : this.failure);
		return {
			available: !this.closed && Boolean(this.executable) && !this.options.disabledReason,
			active,
			running: Boolean(this.context),
			mode: this.mode,
			...(active && Number.isFinite(this.expires) ? { expiresAt: new Date(this.expires).toISOString() } : {}),
			...(reason ? { reason } : {}),
			tabs: [...this.tabs.values()]
				.filter((tab) => !tab.page.isClosed())
				.map((tab) => ({ id: tab.id, title: tab.title, url: publicUrl(tab.page.url()) })),
			desktopControl: "native-app",
		};
	}

	action(
		input: Record<string, unknown>,
		actor: "human" | "agent",
		authorize: () => boolean = () => true,
	): Promise<unknown> {
		if (input.action === "stop") {
			if (actor !== "human")
				return Promise.reject(
					new BrowserError("HUMAN_REQUIRED", "La persona puede detener el navegador desde la app.", 403),
				);
			if (!authorize())
				return Promise.reject(new BrowserError("UNAUTHORIZED", "El acceso fue revocado.", 401));
			return this.stop().then(() => this.status());
		}
		if (this.pending >= MAX_PENDING)
			return Promise.reject(
				new BrowserError("BUSY", "El navegador tiene demasiadas operaciones pendientes.", 429),
			);
		const generation = this.generation;
		this.pending += 1;
		const operation = this.queue
			.catch(() => {})
			.then(async () => {
				if (!authorize()) throw new BrowserError("UNAUTHORIZED", "El acceso fue revocado.", 401);
				if (this.closed) throw new BrowserError("CLOSED", "El navegador se está cerrando.", 503);
				if (generation !== this.generation)
					throw new BrowserError("STOPPED", "La operación se canceló al detener el navegador.", 409);
				return this.execute(input, actor, authorize).catch((error: unknown) => {
					if (error instanceof BrowserError) throw error;
					throw new BrowserError(
						"ACTION_FAILED",
						"La página no permitió completar la acción. Consulta su estado antes de volver a intentarlo.",
						409,
					);
				});
			})
			.finally(() => {
				this.pending -= 1;
			});
		this.queue = operation;
		return operation;
	}

	async close(): Promise<void> {
		this.closed = true;
		await this.stop();
		await this.queue.catch(() => {});
	}

	private async stop(): Promise<void> {
		this.generation += 1;
		this.expires = 0;
		clearTimeout(this.timer);
		this.timer = undefined;
		const context = this.context;
		this.context = undefined;
		this.tabs.clear();
		await context?.close().catch(() => {});
	}

	private requireGrant(authorize: () => boolean): BrowserContext {
		if (!authorize()) throw new BrowserError("UNAUTHORIZED", "El acceso fue revocado.", 401);
		if (this.expires <= this.now() || !this.context) {
			if (this.context) void this.stop();
			throw new BrowserError(
				"HUMAN_REQUIRED",
				"Solicita acceso con request_access; la persona puede aprobarlo desde el teléfono o el equipo.",
				403,
			);
		}
		return this.context;
	}

	private async start(input: Record<string, unknown>, authorize: () => boolean): Promise<BrowserStatus> {
		if (!this.status().available)
			throw new BrowserError("UNAVAILABLE", this.status().reason ?? "Navegador no disponible.", 503);
		const minutes = input.minutes;
		if (
			(minutes !== undefined && (typeof minutes !== "number" || ![30, 60, 480].includes(minutes))) ||
			(input.window !== undefined && typeof input.window !== "boolean")
		)
			throw new BrowserError("INVALID_INPUT", "El límite opcional debe ser de 30, 60 o 480 minutos.");
		if (this.context)
			throw new BrowserError("ALREADY_ACTIVE", "Detén el navegador antes de cambiar su permiso.", 409);
		const profile = join(this.options.dataDir, "browser-profile");
		if (existsSync(profile) && (lstatSync(profile).isSymbolicLink() || !lstatSync(profile).isDirectory()))
			throw new BrowserError(
				"PROFILE_INVALID",
				"El perfil dedicado del navegador no es una carpeta privada válida.",
			);
		mkdirSync(profile, { recursive: true, mode: 0o700 });
		chmodSync(profile, 0o700);
		const generation = this.generation;
		try {
			// Server/root mode rejects start before this import. Playwright's asynchronous filesystem
			// work must never coexist with the daemon's root-only engine identity brackets.
			const browser = this.options.launch ? undefined : (await import("playwright-core")).chromium;
			const launch = this.options.launch ?? browser?.launchPersistentContext.bind(browser);
			if (!launch) throw new BrowserError("UNAVAILABLE", "Navegador no disponible.", 503);
			if (generation !== this.generation || this.closed || !authorize())
				throw new BrowserError("STOPPED", "El permiso se canceló antes de abrir el navegador.", 409);
			const context = await launch(profile, {
				executablePath: this.executable,
				headless: input.window !== true,
				chromiumSandbox: true,
				acceptDownloads: false,
				viewport: { width: 1280, height: 800 },
				timeout: 25_000,
				serviceWorkers: "block",
			});
			if (generation !== this.generation || this.closed || !authorize()) {
				await context.close();
				throw new BrowserError("STOPPED", "El permiso se canceló antes de abrir el navegador.", 409);
			}
			this.context = context;
			this.mode = input.window === true ? "window" : "headless";
			this.expires = typeof minutes === "number" ? this.now() + minutes * 60_000 : Number.POSITIVE_INFINITY;
			this.failure = undefined;
			context.setDefaultTimeout(ACTION_TIMEOUT);
			context.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT);
			context.on("close", () => {
				if (this.context !== context) return;
				this.context = undefined;
				this.tabs.clear();
				this.expires = 0;
				clearTimeout(this.timer);
			});
			context.on("page", (page) => this.track(page));
			await context.route("**/*", (route) => {
				const url = new URL(route.request().url());
				return ["http:", "https:"].includes(url.protocol) ||
					(!route.request().isNavigationRequest() && ["data:", "blob:"].includes(url.protocol))
					? route.continue()
					: route.abort();
			});
			if (generation !== this.generation || this.context !== context || this.closed || !authorize()) {
				if (this.context === context) await this.stop();
				throw new BrowserError("STOPPED", "El permiso se canceló antes de abrir el navegador.", 409);
			}
			for (const page of context.pages()) this.track(page);
			if (typeof minutes === "number") {
				this.timer = setTimeout(() => {
					if (this.generation === generation && this.context === context) void this.stop();
				}, minutes * 60_000);
				this.timer.unref();
			}
			return this.status();
		} catch (error) {
			if (this.context) await this.stop();
			if (error instanceof BrowserError) throw error;
			this.failure =
				"No se pudo abrir Chromium. Comprueba su instalación y, para mostrar una ventana, la sesión gráfica del equipo.";
			throw new BrowserError("LAUNCH_FAILED", this.failure, 503);
		}
	}

	private track(page: Page): Tab | undefined {
		const existing = [...this.tabs.values()].find((tab) => tab.page === page);
		if (existing) return existing;
		if (this.tabs.size >= MAX_TABS) {
			void page.close().catch(() => {});
			return undefined;
		}
		const tab: Tab = { id: randomUUID(), page, title: "Nueva pestaña", refs: new Map(), navigation: 0 };
		this.tabs.set(tab.id, tab);
		page.on("close", () => {
			this.tabs.delete(tab.id);
		});
		page.on("framenavigated", (frame) => {
			tab.navigation += 1;
			this.invalidate(tab);
			if (frame !== page.mainFrame()) return;
			if (page.url() !== "about:blank" && !/^https?:/.test(page.url())) void page.close().catch(() => {});
		});
		page.on("dialog", (dialog) => {
			void dialog.dismiss().catch(() => {});
		});
		page.on("download", (download) => {
			void download.cancel().catch(() => {});
		});
		return tab;
	}

	private invalidate(tab: Tab): void {
		tab.snapshotId = undefined;
		for (const ref of tab.refs.values()) void ref.handle.dispose().catch(() => {});
		tab.refs.clear();
	}

	private tab(value: unknown): Tab {
		const tab = this.tabs.get(string(value, "tabId", 100));
		if (!tab || tab.page.isClosed())
			throw new BrowserError(
				"TAB_GONE",
				"Esta pestaña ya no está disponible. Consulta las pestañas de nuevo.",
				409,
			);
		return tab;
	}

	private async execute(
		input: Record<string, unknown>,
		actor: "human" | "agent",
		authorize: () => boolean,
	): Promise<unknown> {
		const action = string(input.action, "action", 32);
		if (action === "status" || action === "tabs") return this.status();
		if (action === "start") {
			if (actor !== "human")
				throw new BrowserError(
					"HUMAN_REQUIRED",
					"Solo la persona puede activar el navegador desde la app.",
					403,
				);
			return this.start(input, authorize);
		}
		if (
			!["open", "snapshot", "click", "fill", "select", "check", "scroll", "back", "close_tab"].includes(
				action,
			)
		)
			throw new BrowserError("UNKNOWN_ACTION", "Acción de navegador no admitida.");
		const context = this.requireGrant(authorize);
		if (action === "open") {
			const url = website(input.url);
			if (!input.tabId && this.tabs.size >= MAX_TABS)
				throw new BrowserError("TAB_LIMIT", "Cierra una pestaña antes de abrir otra.", 409);
			const tab = input.tabId ? this.tab(input.tabId) : this.track(await context.newPage());
			if (!tab) throw new BrowserError("TAB_LIMIT", "No se pudo abrir otra pestaña.", 409);
			this.requireGrant(authorize);
			this.invalidate(tab);
			await tab.page.goto(url, { waitUntil: "domcontentloaded" });
			return this.snapshot(tab, input.screenshot === true, authorize);
		}
		const tab = this.tab(input.tabId);
		if (action === "snapshot") return this.snapshot(tab, input.screenshot === true, authorize);
		if (action === "close_tab") {
			await tab.page.close();
			return this.status();
		}
		if (action === "back") {
			this.invalidate(tab);
			await tab.page.goBack({ waitUntil: "domcontentloaded" });
			return this.snapshot(tab, false, authorize);
		}
		if (action === "scroll") {
			if (!["up", "down"].includes(String(input.direction)))
				throw new BrowserError("INVALID_INPUT", "Indica arriba o abajo.");
			const pixels = input.pixels ?? 600;
			if (!Number.isInteger(pixels) || Number(pixels) < 1 || Number(pixels) > 1600)
				throw new BrowserError("INVALID_INPUT", "El desplazamiento debe ser de 1 a 1600 píxeles.");
			this.invalidate(tab);
			await tab.page.evaluate(
				(dy) => window.scrollBy({ top: dy, behavior: "instant" }),
				Number(pixels) * (input.direction === "up" ? -1 : 1),
			);
			return this.snapshot(tab, false, authorize);
		}
		if (string(input.snapshotId, "snapshotId", 100) !== tab.snapshotId)
			throw new BrowserError(
				"STALE_SNAPSHOT",
				"La página cambió. Toma una nueva instantánea antes de actuar.",
				409,
			);
		const ref = tab.refs.get(string(input.ref, "ref", 100));
		if (!ref) throw new BrowserError("UNKNOWN_REF", "El elemento no aparece en la instantánea actual.", 409);
		const current = await describeElement(ref.handle).catch(() => undefined);
		if (!current || fingerprint(current) !== ref.fingerprint || !(await ref.handle.isVisible()))
			throw new BrowserError("STALE_ELEMENT", "El elemento cambió. Toma una nueva instantánea.", 409);
		this.requireGrant(authorize);
		if (action === "click") await ref.handle.click();
		else if (action === "fill") {
			if (typeof input.text !== "string" || input.text.length > 16_000 || input.text.includes("\0"))
				throw new BrowserError("INVALID_INPUT", "El texto del campo no es válido.");
			await ref.handle.fill(input.text);
		} else if (action === "select") {
			if (
				!Array.isArray(input.values) ||
				input.values.length > 20 ||
				input.values.some((v) => typeof v !== "string" || v.length > 1000)
			)
				throw new BrowserError("INVALID_INPUT", "Las opciones no son válidas.");
			await ref.handle.selectOption(input.values);
		} else if (action === "check") {
			if (typeof input.checked !== "boolean")
				throw new BrowserError("INVALID_INPUT", "Falta indicar si se debe marcar el campo.");
			await ref.handle.setChecked(input.checked);
		}
		this.invalidate(tab);
		return this.snapshot(tab, false, authorize);
	}

	private async snapshot(
		tab: Tab,
		screenshot: boolean,
		authorize: () => boolean,
		attempt = 0,
	): Promise<BrowserSnapshot> {
		this.requireGrant(authorize);
		this.invalidate(tab);
		const snapshotId = randomUUID();
		const navigation = tab.navigation;
		const frames = tab.page.frames().slice(0, 8);
		const elements: BrowserSnapshot["elements"] = [];
		let text = "";
		let truncated = tab.page.frames().length > frames.length;
		for (const frame of frames) {
			if (frame.url() !== "about:blank" && !/^https?:/.test(frame.url())) continue;
			const body = await frame
				.locator("body")
				.evaluate((node) => (node as HTMLElement).innerText.slice(0, 16_001), undefined, { timeout: 2000 })
				.catch(() => "");
			text += `${text ? "\n\n" : ""}${body}`;
			const candidates = frame.locator(
				"a, button, input, textarea, select, summary, [role=button], [role=link], [role=checkbox], [role=radio], [role=combobox], [contenteditable=true]",
			);
			const count = await candidates.count();
			if (count > 300) truncated = true;
			for (let index = 0; index < Math.min(count, 300); index += 1) {
				if (elements.length >= MAX_ELEMENTS) {
					truncated = true;
					break;
				}
				const handle = await candidates.nth(index).elementHandle({ timeout: 1000 });
				if (!handle) continue;
				const description = await describeElement(handle).catch(() => undefined);
				if (!description || !(await handle.isVisible().catch(() => false))) {
					await handle.dispose();
					continue;
				}
				const ref = `e${elements.length + 1}`;
				tab.refs.set(ref, { handle, fingerprint: fingerprint(description) });
				elements.push({
					ref,
					role: description.role,
					name: description.name,
					disabled: description.disabled,
					frame: publicUrl(frame.url()),
					...(description.options ? { options: description.options } : {}),
				});
			}
		}
		this.requireGrant(authorize);
		tab.title = (await tab.page.title()).slice(0, 200);
		if (navigation !== tab.navigation) {
			this.invalidate(tab);
			// A child frame may finish its initial navigation during inspection. Retry only this
			// read, once; never repeat the click, fill or navigation that requested it.
			if (attempt === 0) return this.snapshot(tab, screenshot, authorize, 1);
			throw new BrowserError(
				"STALE_SNAPSHOT",
				"La página cambió mientras se leía. Toma una nueva instantánea.",
				409,
			);
		}
		tab.snapshotId = snapshotId;
		const result: BrowserSnapshot = {
			tabId: tab.id,
			snapshotId,
			url: publicUrl(tab.page.url()),
			title: tab.title,
			text: text.slice(0, MAX_TEXT),
			elements,
			truncated: truncated || text.length > MAX_TEXT,
		};
		if (screenshot) {
			const bytes = await tab.page.screenshot({
				type: "jpeg",
				quality: 60,
				// Do not send editable form values (including revealed passwords) to the model or phone.
				mask: tab.page.frames().map((frame) => frame.locator("input, textarea, [contenteditable]")),
				fullPage: false,
				timeout: ACTION_TIMEOUT,
			});
			if (bytes.byteLength <= 2 * 1024 * 1024)
				result.image = { mime: "image/jpeg", data: bytes.toString("base64") };
		}
		this.requireGrant(authorize);
		if (navigation !== tab.navigation) {
			this.invalidate(tab);
			throw new BrowserError(
				"STALE_SNAPSHOT",
				"La página cambió durante la captura. Toma una nueva instantánea.",
				409,
			);
		}
		return result;
	}
}

/** Fixed DOM inspection owned by the application; arbitrary model-provided JS is never evaluated. */
async function describeElement(handle: ElementHandle) {
	return handle.evaluate((node) => {
		if (!(node instanceof HTMLElement) || !node.isConnected) return undefined;
		const tag = node.tagName.toLowerCase();
		const labelled = node
			.getAttribute("aria-labelledby")
			?.split(/\s+/)
			.map((id) => node.ownerDocument.getElementById(id)?.textContent ?? "")
			.join(" ");
		const labels =
			"labels" in node
				? Array.from((node as HTMLInputElement).labels ?? [])
						.map((label) => {
							const copy = label.cloneNode(true) as HTMLElement;
							for (const field of copy.querySelectorAll("input, select, textarea, button")) field.remove();
							return copy.textContent ?? "";
						})
						.join(" ")
				: "";
		const name = (
			node.getAttribute("aria-label") ||
			labelled ||
			labels ||
			node.innerText ||
			node.getAttribute("alt") ||
			node.getAttribute("title") ||
			node.getAttribute("placeholder") ||
			tag
		)
			.trim()
			.replace(/\s+/g, " ")
			.slice(0, 240);
		const type = node.getAttribute("type") ?? "";
		const role =
			node.getAttribute("role") ||
			(
				{ a: "link", button: "button", textarea: "textbox", select: "combobox", summary: "button" } as Record<
					string,
					string
				>
			)[tag] ||
			(tag === "input"
				? ["checkbox", "radio"].includes(type)
					? type
					: ["submit", "button", "reset"].includes(type)
						? "button"
						: "textbox"
				: node.isContentEditable
					? "textbox"
					: tag);
		const disabled =
			node.getAttribute("aria-disabled") === "true" || ("disabled" in node && Boolean(node.disabled));
		const options =
			tag === "select"
				? Array.from((node as HTMLSelectElement).options)
						.slice(0, 50)
						.map((option) => ({ value: option.value.slice(0, 1000), label: option.label.slice(0, 200) }))
				: undefined;
		return { tag, type, role, name, disabled, href: node.getAttribute("href"), options };
	});
}

function fingerprint(value: Awaited<ReturnType<typeof describeElement>>): string {
	return JSON.stringify(value);
}
