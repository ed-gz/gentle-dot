import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopCompanionSettings } from "../src/components/DesktopCompanionSettings.tsx";
import { DEFAULT_DESKTOP_COMPANION, parseDesktopCompanion } from "../src/desktop-companion.ts";
import { useDesktopCompanion } from "../src/useDesktopCompanion.ts";

const h = vi.hoisted(() => ({
	tauri: true,
	invoke: vi.fn(),
	useDot: vi.fn(),
	listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));
vi.mock("@tauri-apps/api/core", () => ({
	isTauri: () => h.tauri,
	invoke: (...args: unknown[]) => h.invoke(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
	listen: async (name: string, callback: (event: { payload: unknown }) => void) => {
		h.listeners.set(name, callback);
		return () => h.listeners.delete(name);
	},
}));
vi.mock("../src/useDot.ts", () => ({ useDot: () => h.useDot() }));

const off = { ...DEFAULT_DESKTOP_COMPANION, available: true };
const on = { ...off, enabled: true, visible: true };
const event = (value: unknown) => h.listeners.get("dot://desktop-companion")?.({ payload: value });
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
beforeEach(() => {
	h.tauri = true;
	h.listeners.clear();
	h.invoke.mockReset().mockResolvedValue(off);
	h.useDot.mockReset().mockImplementation(() => {
		throw new Error("The launcher must not connect to the assistant");
	});
	localStorage.clear();
});
afterEach(() => {
	window.history.replaceState(null, "", "/");
});

describe("independent desktop companion controls", () => {
	it("makes no native requests in the browser or mobile surface", async () => {
		h.tauri = false;
		const { result } = renderHook(() => useDesktopCompanion(true));
		await act(async () => {
			await result.current.change({ enabled: true });
			await result.current.interact(true);
		});
		expect(h.invoke).not.toHaveBeenCalled();
		expect(h.listeners.size).toBe(0);
		expect(result.current.state.enabled).toBe(false);
	});
	it("keeps a newer native event when the initial read arrives late", async () => {
		const initial = deferred<unknown>();
		h.invoke.mockReturnValueOnce(initial.promise);
		const { result } = renderHook(() => useDesktopCompanion(true));
		await waitFor(() => expect(h.invoke).toHaveBeenCalledWith("desktop_companion_get"));
		act(() => event(on));
		await act(async () => initial.resolve(off));
		expect(result.current.state).toEqual(on);
	});
	it("shows only confirmed preferences and preserves the last state after a failed change", async () => {
		const mutation = deferred<unknown>();
		const { result } = renderHook(() => useDesktopCompanion(true));
		await waitFor(() => expect(result.current.state.available).toBe(true));
		h.invoke.mockReturnValueOnce(mutation.promise);
		let request!: Promise<void>;
		act(() => {
			request = result.current.change({ enabled: true });
		});
		expect(result.current.pending).toBe(true);
		expect(result.current.state.enabled).toBe(false);
		await act(async () => {
			mutation.reject(new Error("No se pudo mostrar la ventana"));
			await request;
		});
		expect(result.current.state.enabled).toBe(false);
		expect(result.current.pending).toBe(false);
		expect(result.current.error).toBe("No se pudo mostrar la ventana");
	});
	it("synchronizes other windows without changing the shared assistant preferences", async () => {
		localStorage.setItem("gentle-dot-companion", "gentle");
		const before = { ...localStorage };
		const { result } = renderHook(() => useDesktopCompanion(true));
		await waitFor(() => expect(result.current.state.available).toBe(true));
		act(() => event(on));
		expect(result.current.state.enabled).toBe(true);
		expect({ ...localStorage }).toEqual(before);
		expect(h.invoke.mock.calls.map(([name]) => name)).toEqual(["desktop_companion_get"]);
	});
	it("serializes pause and resume so a late hover cannot keep the companion paused", async () => {
		const paused = deferred<unknown>();
		const { result } = renderHook(() => useDesktopCompanion(true));
		await waitFor(() => expect(result.current.state.available).toBe(true));
		h.invoke.mockImplementation((name: string, args?: { active: boolean }) =>
			name === "desktop_companion_interaction" && args?.active ? paused.promise : Promise.resolve(on),
		);
		act(() => {
			void result.current.interact(true);
		});
		await waitFor(() =>
			expect(h.invoke).toHaveBeenCalledWith("desktop_companion_interaction", { active: true }),
		);
		let resume!: Promise<void>;
		act(() => {
			resume = result.current.interact(false);
		});
		expect(h.invoke).not.toHaveBeenCalledWith("desktop_companion_interaction", { active: false });
		await act(async () => {
			paused.resolve({ ...on, paused: true });
			await resume;
		});
		expect(h.invoke).toHaveBeenLastCalledWith("desktop_companion_interaction", { active: false });
		expect(result.current.state.paused).toBe(false);
	});
	it("does not let a request from a previous surface lifetime overwrite a fresh one", async () => {
		const old = deferred<unknown>();
		const fresh = deferred<unknown>();
		const { result, rerender } = renderHook(({ enabled }) => useDesktopCompanion(enabled), {
			initialProps: { enabled: true },
		});
		await waitFor(() => expect(result.current.state.available).toBe(true));
		h.invoke.mockReturnValueOnce(old.promise);
		act(() => {
			void result.current.change({ enabled: true });
		});
		rerender({ enabled: false });
		rerender({ enabled: true });
		await waitFor(() =>
			expect(h.invoke.mock.calls.filter(([name]) => name === "desktop_companion_get")).toHaveLength(2),
		);
		h.invoke.mockReturnValueOnce(fresh.promise);
		act(() => {
			void result.current.change({ enabled: true });
		});
		await act(async () => old.reject(new Error("old failure")));
		expect(result.current.error).toBeUndefined();
		expect(result.current.pending).toBe(true);
		await act(async () => fresh.resolve(on));
		expect(result.current.state.enabled).toBe(true);
		expect(result.current.pending).toBe(false);
	});
	it("exposes separate desktop settings that call only native preference commands", async () => {
		h.invoke.mockImplementation(async (name: string, args?: { patch?: { enabled?: boolean } }) =>
			name === "desktop_companion_set" && args?.patch?.enabled ? on : off,
		);
		function Settings() {
			const controls = useDesktopCompanion(true);
			return <DesktopCompanionSettings controls={controls} />;
		}
		render(<Settings />);
		const control = screen.getByRole("switch", { name: "Capri en el escritorio" });
		await waitFor(() => expect(control).toBeEnabled());
		fireEvent.click(control);
		await waitFor(() => expect(control).toHaveAttribute("aria-checked", "true"));
		expect(h.invoke).toHaveBeenCalledWith("desktop_companion_set", { patch: { enabled: true } });
		expect(screen.getByRole("button", { name: "Libre" })).toHaveAttribute("aria-pressed", "true");
	});
	it("rejects incomplete native state rather than inventing successful activation", () => {
		expect(() => parseDesktopCompanion({ enabled: true })).toThrow();
	});
	it("the fixed launcher opens the conversation without connecting to the assistant", async () => {
		window.history.replaceState(null, "", "/?surface=companion-launcher");
		const { App } = await import("../src/App.tsx");
		render(<App />);
		expect(h.useDot).not.toHaveBeenCalled();
		expect(h.invoke).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Abrir conversación con Capri" }));
		expect(h.invoke.mock.calls).toEqual([["toggle_panel"]]);
		expect(document.documentElement.dataset.surface).toBe("companion-launcher");
	});
});
