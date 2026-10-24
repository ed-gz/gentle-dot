// @vitest-environment jsdom
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ state: vi.fn(), set: vi.fn() }));
vi.mock("../src/native.ts", () => ({
	nativeAndroid: true,
	GentleMobile: { companionState: native.state, setCompanion: native.set },
}));

import { COMPANION_KEY, useCompanion } from "../../../packages/ui/src/useCompanion.ts";
import type { NativeCompanionState } from "../src/native.ts";
import {
	type NativeCompanionThemeControls,
	useNativeCompanionTheme,
} from "../src/useNativeCompanionTheme.ts";

let host: HTMLDivElement;
let root: Root;
let controls: NativeCompanionThemeControls;
let state: NativeCompanionState;
let mounted: boolean;
const CHANGED = "gentle-dot-companion-change";

function Fixture() {
	controls = useNativeCompanionTheme();
	return createElement("p", { role: "status" }, controls.error);
}
function select(mode: "gentle" | "capri", persist = true) {
	const value = { mode, persona: "gentle" };
	if (persist) localStorage.setItem(COMPANION_KEY, JSON.stringify(value));
	window.dispatchEvent(new CustomEvent(CHANGED, { detail: value }));
}
async function render(strict = false) {
	await act(() =>
		root.render(strict ? createElement(StrictMode, null, createElement(Fixture)) : createElement(Fixture)),
	);
}
beforeEach(() => {
	(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	localStorage.clear();
	vi.spyOn(document, "hidden", "get").mockReturnValue(false);
	state = {
		supported: true,
		permission: true,
		enabled: false,
		active: false,
		pinned: false,
		theme: "gentle-dot",
		partialChat: false,
	};
	native.state.mockImplementation(async () => ({ ...state }));
	native.set.mockImplementation(async (options) => {
		state = { ...state, ...options, active: options.enabled ?? state.active };
	});
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	mounted = true;
});
afterEach(async () => {
	if (mounted) await act(() => root.unmount());
	host.remove();
	localStorage.clear();
	vi.restoreAllMocks();
	vi.resetAllMocks();
});

it("restores the native appearance without enabling the overlay or opting into a persona", async () => {
	state.theme = "capri";
	localStorage.setItem(COMPANION_KEY, JSON.stringify({ motion: false, position: { x: 0.2, y: 0.8 } }));
	await render();
	expect(controls.theme).toBe("capri");
	expect(native.set).not.toHaveBeenCalled();
	expect(JSON.parse(localStorage.getItem(COMPANION_KEY) ?? "null")).toMatchObject({
		mode: "capri",
		persona: "gentle",
		motion: false,
		position: { x: 0.2, y: 0.8 },
	});
	localStorage.removeItem(COMPANION_KEY);
	await act(() => window.dispatchEvent(new Event("gentledot-resume")));
	expect(controls.theme).toBe("capri");
	expect(native.set).not.toHaveBeenCalled();
});

it("preserves an explicit persona while hydrating missing appearance", async () => {
	localStorage.setItem(COMPANION_KEY, JSON.stringify({ persona: "capri", pinned: true }));
	await render();
	expect(JSON.parse(localStorage.getItem(COMPANION_KEY) ?? "null")).toMatchObject({
		mode: "gentle",
		persona: "capri",
		pinned: true,
	});
});

it("uses the current event even when storage still contains Gentle and survives resume", async () => {
	localStorage.setItem(COMPANION_KEY, JSON.stringify({ mode: "gentle" }));
	await render();
	vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
		throw new Error("Storage blocked");
	});
	await act(() => select("capri", false));
	expect(native.set).toHaveBeenLastCalledWith({ theme: "capri" });
	expect(controls.theme).toBe("capri");
	await act(() => window.dispatchEvent(new Event("gentledot-resume")));
	expect(state.theme).toBe("capri");
	expect(controls.error).toBe("");
});

it("restores memory-only Capri to a late-mounted companion before an immediate persona refresh can save Gentle", async () => {
	state.theme = "capri";
	vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
		throw new Error("Storage blocked");
	});
	const client = { read: vi.fn().mockResolvedValue("gentle"), set: vi.fn() };
	function Companion() {
		const { settings } = useCompanion(client);
		return createElement("p", { "data-mode": settings.mode, "data-persona": settings.persona });
	}
	function DelayedApp({ ready }: { ready: boolean }) {
		controls = useNativeCompanionTheme(ready);
		return ready && controls.theme ? createElement(Companion) : null;
	}
	await act(() => root.render(createElement(DelayedApp, { ready: false })));
	expect(controls.theme).toBe("capri");
	expect(client.read).not.toHaveBeenCalled();
	expect(localStorage.getItem(COMPANION_KEY)).toBeNull();
	await act(() => root.render(createElement(DelayedApp, { ready: true })));
	expect(client.read).toHaveBeenCalledOnce();
	expect(host.querySelector("p")?.dataset).toMatchObject({ mode: "capri", persona: "gentle" });
	expect(controls.theme).toBe("capri");
	expect(state.theme).toBe("capri");
	expect(native.set).not.toHaveBeenCalled();
	expect(client.set).not.toHaveBeenCalled();
});

it("synchronizes a preference received from another WebView and ignores unrelated keys", async () => {
	await render();
	localStorage.setItem(COMPANION_KEY, JSON.stringify({ mode: "capri" }));
	await act(() => window.dispatchEvent(new StorageEvent("storage", { key: "unrelated" })));
	expect(native.set).not.toHaveBeenCalled();
	await act(() => window.dispatchEvent(new StorageEvent("storage", { key: COMPANION_KEY })));
	expect(native.set).toHaveBeenLastCalledWith({ theme: "capri" });
	expect(controls.theme).toBe("capri");
});

it("does not enqueue native reads for position or persona changes that keep the same appearance", async () => {
	localStorage.setItem(COMPANION_KEY, JSON.stringify({ mode: "capri" }));
	await render();
	const reads = native.state.mock.calls.length;
	const writes = native.set.mock.calls.length;
	await act(() => {
		for (let i = 0; i < 30; i++) {
			const value = { mode: "capri", persona: i % 2 ? "capri" : "gentle", position: { x: i / 30, y: 0.5 } };
			localStorage.setItem(COMPANION_KEY, JSON.stringify(value));
			window.dispatchEvent(new CustomEvent(CHANGED, { detail: value }));
			window.dispatchEvent(new StorageEvent("storage", { key: COMPANION_KEY }));
		}
		window.dispatchEvent(new CustomEvent(CHANGED, { detail: { mode: "unknown" } }));
	});
	expect(native.state).toHaveBeenCalledTimes(reads);
	expect(native.set).toHaveBeenCalledTimes(writes);
});

it("does not let a paused WebView write its stale theme and reads the shared preference on resume", async () => {
	await render();
	await act(() => window.dispatchEvent(new Event("gentledot-pause")));
	await act(() => select("gentle", false));
	state.theme = "capri";
	localStorage.setItem(COMPANION_KEY, JSON.stringify({ mode: "capri" }));
	await act(() => window.dispatchEvent(new StorageEvent("storage", { key: COMPANION_KEY })));
	expect(native.set).not.toHaveBeenCalled();
	await act(() => window.dispatchEvent(new Event("gentledot-resume")));
	expect(controls.theme).toBe("capri");
	expect(native.set).not.toHaveBeenCalled();
});

it("serializes rapid changes and enables with the most recent appearance in one native call", async () => {
	await render();
	let finish!: () => void;
	native.set.mockImplementationOnce(
		(options) =>
			new Promise<void>((resolve) => {
				finish = () => {
					state = { ...state, ...options };
					resolve();
				};
			}),
	);
	await act(() => select("capri"));
	expect(controls.pending).toBe(true);
	let enable!: Promise<void>;
	await act(() => {
		select("gentle");
		enable = controls.setCompanion({ enabled: true });
	});
	expect(native.set).toHaveBeenCalledTimes(1);
	await act(async () => {
		finish();
		await enable;
	});
	expect(native.set.mock.calls.map(([options]) => options)).toEqual([
		{ theme: "capri" },
		{ theme: "gentle-dot" },
		{ enabled: true, theme: "gentle-dot" },
	]);
	expect(state.active).toBe(true);
	expect(controls.pending).toBe(false);
	await act(() => controls.setCompanion({ pinned: true }));
	expect(native.set).toHaveBeenLastCalledWith({ pinned: true, theme: "gentle-dot" });
});

it("does not overwrite a selection that arrives during the initial native read", async () => {
	let finish!: (value: NativeCompanionState) => void;
	native.state.mockImplementationOnce(
		() =>
			new Promise<NativeCompanionState>((resolve) => {
				finish = resolve;
			}),
	);
	await render();
	await act(() => select("capri"));
	await act(() => finish({ ...state }));
	expect(state.theme).toBe("capri");
	expect(controls.theme).toBe("capri");
});

it("reports a rejected automatic write and retries without starting the overlay", async () => {
	await render();
	native.set.mockRejectedValueOnce(new Error("No se pudo guardar el acompañante."));
	await act(() => select("capri"));
	expect(controls.error).toContain("No se pudo guardar");
	expect(controls.pending).toBe(false);
	await act(() => controls.retry());
	expect(state.theme).toBe("capri");
	expect(state.active).toBe(false);
	expect(controls.error).toBe("");
});

it("reports an initial read failure and recovers with an explicit retry", async () => {
	native.state.mockRejectedValueOnce(new Error("No se pudo consultar Android."));
	await render();
	expect(controls.error).toBe("No se pudo consultar Android.");
	expect(controls.pending).toBe(false);
	state.theme = "capri";
	await act(() => controls.retry());
	expect(controls.theme).toBe("capri");
	expect(controls.error).toBe("");
	expect(native.set).not.toHaveBeenCalled();
});

it("requires readback confirmation and exposes explicit activation failures to its caller", async () => {
	await render();
	native.set.mockResolvedValueOnce(undefined);
	await act(() => select("capri"));
	expect(controls.error).toContain("Android no confirmó el tema");
	native.set.mockRejectedValueOnce(new Error("Sin permiso"));
	await act(async () => {
		await expect(controls.setCompanion({ enabled: true })).rejects.toThrow("Sin permiso");
	});
	expect(controls.error).toBe("Sin permiso");
});

it("reports native sprite failures even when the saved preference matches", async () => {
	state = { ...state, theme: "capri", active: true, enabled: true };
	Object.assign(state, {
		appliedTheme: "gentle-dot",
		renderReady: false,
		renderError: "No se pudo cargar Capri.",
	});
	await render();
	expect(controls.error).toBe("No se pudo cargar Capri.");
	expect(native.set).toHaveBeenLastCalledWith({ theme: "capri" });
	Object.assign(state, { appliedTheme: "capri", renderReady: true, renderError: "" });
	await act(() => controls.retry());
	expect(controls.error).toBe("");
});

it("does not require a rendered sprite when the service is inactive", async () => {
	Object.assign(state, { renderReady: false });
	await render();
	expect(controls.error).toBe("");
	expect(native.set).not.toHaveBeenCalled();
});

it("keeps a fatal rendering error visible after Android stops the service without restarting it", async () => {
	Object.assign(state, { theme: "capri", renderReady: false, renderError: "No se pudo cargar Capri." });
	await render();
	expect(controls.error).toBe("No se pudo cargar Capri.");
	expect(native.set).not.toHaveBeenCalled();
	await act(async () => {
		await expect(controls.retry()).rejects.toThrow("No se pudo cargar Capri.");
	});
	expect(native.set).not.toHaveBeenCalled();
	expect(state.active).toBe(false);
});

it("is safe under StrictMode replay and ignores callbacks after unmount", async () => {
	await render(true);
	expect(native.set).not.toHaveBeenCalled();
	let finish!: (value: NativeCompanionState) => void;
	native.state.mockImplementationOnce(
		() =>
			new Promise<NativeCompanionState>((resolve) => {
				finish = resolve;
			}),
	);
	await act(() => select("capri"));
	await act(() => root.unmount());
	mounted = false;
	await act(() => finish({ ...state }));
	expect(native.set).not.toHaveBeenCalled();
	expect(JSON.parse(localStorage.getItem(COMPANION_KEY) ?? "null")).toMatchObject({ mode: "capri" });
});
