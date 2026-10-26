import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.tsx";

const h = vi.hoisted(() => ({
	desktop: true,
	visible: vi.fn<() => Promise<boolean>>(),
	connectionInfo: vi.fn(),
	connect: vi.fn(),
	stop: vi.fn(),
	listeners: new Map<string, Set<() => void>>(),
}));
vi.mock("../src/desktop.ts", async (original) => ({
	...(await original<typeof import("../src/desktop.ts")>()),
	inDesktop: () => h.desktop,
	connectionInfo: () => h.connectionInfo(),
	panelVisible: () => h.visible(),
	onDesktopEvent: async (name: string, handler: () => void) => {
		const listeners = h.listeners.get(name) ?? new Set();
		listeners.add(handler);
		h.listeners.set(name, listeners);
		return () => listeners.delete(handler);
	},
}));
vi.mock("../src/client.ts", async (original) => ({
	...(await original<typeof import("../src/client.ts")>()),
	DotClient: class {
		start() {
			h.connect();
		}
		stop() {
			h.stop();
		}
		send() {
			return false;
		}
		resume() {}
	},
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("../src/useDesktopCompanion.ts", () => ({
	useDesktopCompanion: () => ({ state: { enabled: false } }),
}));
vi.mock("../src/useComputer.ts", () => ({
	useComputerState: () => ({}),
	useComputerAvailable: () => false,
}));
vi.mock("../src/usePanelWindow.ts", () => ({
	usePanelWindow: () => ({ fullscreenNow: { current: false }, controls: { setFullscreen: () => {} } }),
}));

beforeEach(() => {
	h.desktop = true;
	h.listeners.clear();
	h.visible.mockReset().mockResolvedValue(false);
	h.connectionInfo.mockReset().mockResolvedValue({ url: "ws://localhost:2345/ws", token: "fixture" });
	h.connect.mockReset();
	h.stop.mockReset();
	window.history.replaceState(null, "", "/?surface=panel");
});
afterEach(() => {
	vi.restoreAllMocks();
	window.history.replaceState(null, "", "/");
});
async function shown() {
	await act(async () => {
		for (const handler of h.listeners.get("dot://panel-shown") ?? []) handler();
	});
}

describe("desktop panel visibility capability", () => {
	it("grants only the panel the exact read-only visibility permission without broad defaults", () => {
		const relative = "../../../apps/desktop/src-tauri/capabilities/default.json";
		const { capabilities } = JSON.parse(
			readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8"),
		) as { capabilities: { identifier: string; windows: string[]; permissions: string[] }[] };
		expect(capabilities.filter(({ permissions }) => permissions.includes("core:window:allow-is-visible")))
			.toEqual([expect.objectContaining({
				identifier: "panel-visibility",
				windows: ["panel"],
				permissions: ["core:window:allow-is-visible"],
			})]);
		for (const { permissions } of capabilities) {
			expect(permissions).not.toContain("core:default");
			expect(permissions).not.toContain("core:window:default");
			expect(permissions.some((permission) => permission.includes("*"))).toBe(false);
		}
	});
});

describe("desktop panel host lifecycle", () => {
	it("does not start the hidden assistant; opens once and retains it through hide/show", async () => {
		const view = render(<App />);
		expect(h.connectionInfo).not.toHaveBeenCalled();
		await waitFor(() => expect(h.visible).toHaveBeenCalledOnce());
		expect(h.connect).not.toHaveBeenCalled();
		// A real root child lets the structural native startup probe certify the dormant host.
		expect(view.container.childElementCount).toBe(1);
		expect(view.container.querySelector(".chat")).toBeNull();
		await shown();
		await waitFor(() => expect(h.connect).toHaveBeenCalledOnce());
		const chat = view.container.querySelector(".chat");
		// Native hide keeps the WebView document; WebKit reports document visibility separately.
		const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
		act(() => document.dispatchEvent(new Event("visibilitychange")));
		view.rerender(<App />);
		visibility.mockReturnValue("visible");
		act(() => document.dispatchEvent(new Event("visibilitychange")));
		await shown();
		await shown();
		expect(view.container.querySelector(".chat")).toBe(chat);
		expect(h.stop).not.toHaveBeenCalled();
		expect(h.connectionInfo).toHaveBeenCalledOnce();
		expect(h.connect).toHaveBeenCalledOnce();
	});

	it("starts when the panel was already visible before listener registration", async () => {
		h.visible.mockResolvedValue(true);
		render(<App />);
		await waitFor(() => expect(h.connect).toHaveBeenCalledOnce());
		expect(h.connectionInfo).toHaveBeenCalledOnce();
	});

	it("subscribes before querying and a late hidden result cannot undo a show event", async () => {
		let resolve!: (visible: boolean) => void;
		h.visible.mockImplementation(() => {
			expect(h.listeners.get("dot://panel-shown")?.size).toBe(1);
			return new Promise((done) => {
				resolve = done;
			});
		});
		render(<App />);
		await waitFor(() => expect(h.visible).toHaveBeenCalledOnce());
		await shown();
		await waitFor(() => expect(h.connect).toHaveBeenCalledOnce());
		await act(async () => resolve(false));
		await shown();
		expect(h.connectionInfo).toHaveBeenCalledOnce();
		expect(h.connect).toHaveBeenCalledOnce();
	});

	it("ignores late visibility work after the host unmounts", async () => {
		let resolve!: (visible: boolean) => void;
		h.visible.mockImplementation(
			() => new Promise((done) => {
				resolve = done;
			}),
		);
		const view = render(<App />);
		await waitFor(() => expect(h.visible).toHaveBeenCalledOnce());
		view.unmount();
		await act(async () => resolve(true));
		expect(h.connectionInfo).not.toHaveBeenCalled();
		expect(h.listeners.get("dot://panel-shown")?.size).toBe(0);
	});

	it("keeps the panel usable if the visibility bridge rejects", async () => {
		h.visible.mockRejectedValue(new Error("window bridge unavailable"));
		render(<App />);
		await waitFor(() => expect(h.connect).toHaveBeenCalledOnce());
		await shown();
		expect(h.connect).toHaveBeenCalledOnce();
	});

	it.each(["web", "dot"])("keeps desktop %s startup eager", async (surface) => {
		window.history.replaceState(null, "", `/?surface=${surface}`);
		render(<App />);
		await waitFor(() => expect(h.connect).toHaveBeenCalledOnce());
		expect(h.visible).not.toHaveBeenCalled();
	});

	it("keeps browser/mobile startup eager even with a panel URL", async () => {
		h.desktop = false;
		render(<App connection={{ url: "ws://localhost:2345/ws", token: "fixture" }} />);
		await waitFor(() => expect(h.connect).toHaveBeenCalledOnce());
		expect(h.visible).not.toHaveBeenCalled();
	});
});
