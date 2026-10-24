// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
	state: vi.fn(),
	set: vi.fn(),
	permission: vi.fn(),
	appSettings: vi.fn(),
	retryTheme: vi.fn(),
}));
vi.mock("../src/native.ts", () => ({
	nativeAndroid: true,
	GentleMobile: {
		companionState: native.state,
		setCompanion: native.set,
		requestCompanionPermission: native.permission,
		openCompanionAppSettings: native.appSettings,
	},
}));

import { CompanionSettings } from "../src/CompanionSettings.tsx";
import type { NativeCompanionThemeControls } from "../src/useNativeCompanionTheme.ts";

let host: HTMLDivElement, root: Root;
const initial = {
	supported: true,
	permission: false,
	enabled: false,
	active: false,
	pinned: false,
	theme: "gentle-dot",
	partialChat: false,
};
beforeEach(() => {
	(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	native.state.mockResolvedValue(initial);
	native.set.mockResolvedValue(undefined);
	native.permission.mockResolvedValue(undefined);
	native.appSettings.mockResolvedValue(undefined);
	native.retryTheme.mockResolvedValue(undefined);
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(async () => {
	await act(() => root.unmount());
	host.remove();
	vi.clearAllMocks();
});
async function render(overrides: Partial<NativeCompanionThemeControls> = {}) {
	await act(() =>
		root.render(
			createElement(CompanionSettings, {
				themeControls: {
					theme: "gentle-dot",
					error: "",
					pending: false,
					setCompanion: native.set,
					retry: native.retryTheme,
					...overrides,
				},
			}),
		),
	);
}
async function click(index = 0) {
	await act(() => host.querySelectorAll<HTMLButtonElement>("button")[index]?.click());
}
async function clickNamed(name: string) {
	const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) =>
		item.textContent?.includes(name),
	);
	expect(button).toBeDefined();
	await act(() => button?.click());
}
it("does not request permissions or start a service just by opening settings", async () => {
	await render();
	expect(native.set).not.toHaveBeenCalled();
	expect(native.permission).not.toHaveBeenCalled();
	expect(host.textContent).toContain("Android te pedirá");
});
it("opens the explicit special permission flow without starting an unpermitted overlay", async () => {
	await render();
	await click();
	expect(native.permission).toHaveBeenCalledOnce();
	expect(native.set).not.toHaveBeenCalled();
});
it("starts only after user action and reflects the confirmed active service", async () => {
	native.state
		.mockResolvedValueOnce({ ...initial, permission: true })
		.mockResolvedValue({ ...initial, permission: true, enabled: true, active: true });
	await render();
	await click();
	expect(native.set).toHaveBeenCalledWith({ enabled: true });
	expect(host.querySelector('button[role="switch"]')?.getAttribute("aria-checked")).toBe("true");
	await click(1);
	expect(native.set).toHaveBeenLastCalledWith({ pinned: true });
});
it("shows service errors and leaves an inactive switch instead of faking success", async () => {
	native.state.mockResolvedValue({ ...initial, permission: true });
	native.set.mockRejectedValueOnce(new Error("Android rechazó el inicio"));
	await render();
	await click();
	expect(host.querySelector('[role="alert"]')?.textContent).toContain("Android rechazó");
	expect(host.querySelector('button[role="switch"]')?.getAttribute("aria-checked")).toBe("false");
});
it("offers restart when Android stopped the service and keeps unsupported devices usable", async () => {
	native.state.mockResolvedValueOnce({ ...initial, permission: true, enabled: true, active: false });
	await render();
	await click();
	expect(native.set).toHaveBeenCalledWith({ enabled: true });
	native.state.mockResolvedValue({ ...initial, supported: false });
	await act(() => window.dispatchEvent(new Event("gentledot-resume")));
	expect(host.querySelector("section")).toBeNull();
});
it("continues the requested activation once after Android grants the special permission", async () => {
	await render();
	await click();
	native.state.mockResolvedValue({ ...initial, permission: true, enabled: true, active: true });
	await act(() => window.dispatchEvent(new Event("gentledot-resume")));
	await act(() => window.dispatchEvent(new Event("gentledot-resume")));
	expect(native.set).toHaveBeenCalledExactlyOnceWith({ enabled: true });
});
it("does not enable when the permission screen returns without a grant", async () => {
	await render();
	await click();
	await act(() => window.dispatchEvent(new Event("gentledot-resume")));
	expect(native.set).not.toHaveBeenCalled();
	expect(host.querySelector('[role="status"]')?.textContent).toContain("Falta el permiso");
	expect(host.textContent).toContain("Permitir ajustes restringidos");
	expect(host.querySelector('button[role="switch"]')?.getAttribute("aria-checked")).toBe("false");
});
it("offers recovery after a process restart without opening settings or enabling by itself", async () => {
	await render();
	await clickNamed("¿Android no te deja activarlo?");
	expect(host.textContent).toContain("Si aparece «A la app se le negó el acceso»");
	expect(native.appSettings).not.toHaveBeenCalled();
	expect(native.permission).not.toHaveBeenCalled();
	expect(native.set).not.toHaveBeenCalled();
});
it("opens app information only explicitly and retries the overlay permission without a resume loop", async () => {
	await render();
	await click();
	await act(() => window.dispatchEvent(new Event("gentledot-resume")));
	await clickNamed("Abrir información de la app");
	expect(native.appSettings).toHaveBeenCalledOnce();
	await act(() => window.dispatchEvent(new Event("gentledot-resume")));
	await act(() => window.dispatchEvent(new Event("gentledot-resume")));
	expect(native.permission).toHaveBeenCalledOnce();
	expect(native.set).not.toHaveBeenCalled();
	await clickNamed("Volver al permiso");
	native.state.mockResolvedValue({ ...initial, permission: true, enabled: true, active: true });
	await act(() => window.dispatchEvent(new Event("gentledot-resume")));
	expect(native.permission).toHaveBeenCalledTimes(2);
	expect(native.set).toHaveBeenCalledExactlyOnceWith({ enabled: true });
	expect(host.textContent).not.toContain("Permitir ajustes restringidos");
});
it("reports failed settings launches and clears the activation request", async () => {
	native.permission.mockRejectedValueOnce(new Error("No se pudo abrir el permiso"));
	await render();
	await click();
	expect(host.querySelector('[role="alert"]')?.textContent).toContain("No se pudo abrir el permiso");
	native.appSettings.mockRejectedValueOnce(new Error("Abre Ajustes → Aplicaciones → Gentle Dot"));
	await clickNamed("Abrir información de la app");
	expect(host.querySelector('[role="alert"]')?.textContent).toContain("Abre Ajustes");
	native.state.mockResolvedValue({ ...initial, permission: true });
	await act(() => window.dispatchEvent(new Event("gentledot-resume")));
	expect(native.set).not.toHaveBeenCalled();
});
it("does not restart a pending activation on repeated resume events", async () => {
	await render();
	await click();
	let finish!: () => void;
	native.set.mockImplementationOnce(
		() =>
			new Promise<void>((resolve) => {
				finish = resolve;
			}),
	);
	native.state.mockResolvedValue({ ...initial, permission: true, enabled: true, active: true });
	await act(() => window.dispatchEvent(new Event("gentledot-resume")));
	await act(() => window.dispatchEvent(new Event("gentledot-resume")));
	expect(native.set).toHaveBeenCalledExactlyOnceWith({ enabled: true });
	expect(host.querySelector<HTMLButtonElement>('button[role="switch"]')?.disabled).toBe(true);
	await act(() => finish());
	expect(host.querySelector<HTMLButtonElement>('button[role="switch"]')?.disabled).toBe(false);
});
it("ignores a stale denied read that finishes after activation", async () => {
	native.state.mockResolvedValue({ ...initial, permission: true });
	await render();
	let finish!: (state: typeof initial) => void;
	native.state.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	await act(() => window.dispatchEvent(new Event("gentledot-resume")));
	native.state.mockResolvedValue({ ...initial, permission: true, enabled: true, active: true });
	await click();
	await act(() => finish(initial));
	expect(host.querySelector('button[role="switch"]')?.getAttribute("aria-checked")).toBe("true");
});
it("rechecks a resume delivered before the permission launcher promise settles", async () => {
	let finish!: () => void;
	native.permission.mockImplementationOnce(
		() =>
			new Promise<void>((resolve) => {
				finish = resolve;
			}),
	);
	await render();
	await click();
	native.state.mockResolvedValue({ ...initial, permission: true, enabled: true, active: true });
	await act(() => window.dispatchEvent(new Event("gentledot-resume")));
	expect(native.set).not.toHaveBeenCalled();
	await act(() => finish());
	expect(native.set).toHaveBeenCalledExactlyOnceWith({ enabled: true });
	expect(host.querySelector('button[role="switch"]')?.getAttribute("aria-checked")).toBe("true");
});
it("keeps a failed initial read visible and allows retry without starting the overlay", async () => {
	native.state.mockRejectedValueOnce(new Error("Native bridge unavailable"));
	await render();
	expect(host.querySelector('[role="alert"]')?.textContent).toContain("No se pudo comprobar");
	await clickNamed("Comprobar de nuevo");
	expect(host.querySelector('[role="alert"]')).toBeNull();
	expect(host.querySelector('button[role="switch"]')).not.toBeNull();
	expect(native.set).not.toHaveBeenCalled();
	expect(native.permission).not.toHaveBeenCalled();
});
it("clears a failed refresh once Android answers again", async () => {
	await render();
	native.state.mockRejectedValueOnce(new Error("Temporary read failure"));
	await act(() => window.dispatchEvent(new Event("gentledot-resume")));
	expect(host.querySelector('[role="alert"]')).not.toBeNull();
	await act(() => window.dispatchEvent(new Event("gentledot-resume")));
	expect(host.querySelector('[role="alert"]')).toBeNull();
});

it("does not call a running service ready when its selected sprites failed to load", async () => {
	native.state.mockResolvedValue({
		...initial,
		permission: true,
		enabled: true,
		active: true,
		theme: "capri",
		renderReady: false,
		renderError: "No se pudieron cargar los sprites de Capri.",
	});
	await render({ theme: "capri" });
	expect(host.querySelector('button[role="switch"]')?.getAttribute("aria-checked")).toBe("false");
	expect(host.textContent).not.toContain("Capri está lista");
	expect(host.querySelector('[role="alert"]')?.textContent).toContain("sprites de Capri");
	await clickNamed("Reintentar personaje");
	expect(native.set).toHaveBeenCalledExactlyOnceWith({ enabled: true });
});

it("shows the confirmed character and reports synchronization failures beside the control", async () => {
	native.state.mockResolvedValue({
		...initial,
		permission: true,
		enabled: true,
		active: true,
		theme: "capri",
		appliedTheme: "capri",
		renderReady: true,
	});
	await render({ theme: "capri" });
	expect(host.textContent).toContain("Capri está lista");
	await render({ theme: "capri", error: "Android no confirmó el personaje seleccionado." });
	expect(host.textContent).not.toContain("Capri está lista");
	expect(host.querySelector('[role="alert"]')?.textContent).toContain("no confirmó");
});
