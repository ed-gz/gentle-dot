// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationSettings } from "../src/NotificationSettings.tsx";
import { defaultNotificationPreferences } from "../src/notifications.ts";

const native = vi.hoisted(() => ({ read: vi.fn(), save: vi.fn(), android: vi.fn(), state: vi.fn() }));
vi.mock("../src/native.ts", () => ({
	nativeAndroid: true,
	readNotificationPreferences: native.read,
	saveNotificationPreferences: native.save,
	GentleMobile: { openNotificationSettings: native.android, monitorState: native.state },
}));
const connection = {
	url: "https://computer.example.ts.net",
	token: "test",
	deviceId: "phone",
	name: "Phone",
};
let root: Root;
let host: HTMLDivElement;
let saved = { ...defaultNotificationPreferences };
const toggleMonitor = vi.fn();
async function render() {
	await act(async () =>
		root.render(
			createElement(NotificationSettings, {
				connection,
				monitoring: false,
				monitorBusy: false,
				onToggleMonitor: toggleMonitor,
			}),
		),
	);
}
function button(label: string): HTMLButtonElement {
	const result = host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
	if (!result) throw new Error(`Missing ${label}`);
	return result;
}
beforeEach(async () => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	saved = { ...defaultNotificationPreferences };
	native.read.mockReset().mockImplementation(async () => saved);
	native.state.mockReset().mockResolvedValue({ active: false, connected: false, notificationsEnabled: true });
	native.save.mockReset().mockImplementation(async (value) => {
		saved = value;
		return saved;
	});
	toggleMonitor.mockClear();
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(JSON.stringify({ enabled: false }))),
	);
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await render();
});
afterEach(async () => {
	await act(async () => root.unmount());
	host.remove();
	vi.unstubAllGlobals();
});

describe("mobile alert settings", () => {
	it("explains when Android blocks alerts instead of reporting successful delivery", async () => {
		native.state.mockResolvedValue({ active: true, connected: true, notificationsEnabled: false });
		await act(async () => root.unmount());
		root = createRoot(host);
		await render();
		expect(host.textContent).toContain("Android tiene bloqueadas las notificaciones");
	});
	it("persists independent switches while leaving system authorization untouched", async () => {
		expect(button("Cambios de disponibilidad").getAttribute("aria-checked")).toBe("false");
		await act(async () => button("Solicitudes de permiso").click());
		expect(saved.permissions).toBe(false);
		expect(saved.dotReplies).toBe(true);
		expect(native.save).toHaveBeenCalledTimes(1);
		expect(fetch).toHaveBeenCalledTimes(1);
		await act(async () => root.unmount());
		root = createRoot(host);
		await render();
		expect(button("Solicitudes de permiso").getAttribute("aria-checked")).toBe("false");
	});
	it("keeps background delivery and foreground banners independent", async () => {
		await act(async () => button("Con la app cerrada").click());
		expect(toggleMonitor).toHaveBeenCalledOnce();
		expect(native.save).not.toHaveBeenCalled();
		await act(async () => button("Mientras uso Dot").click());
		expect(saved.inApp).toBe(false);
		expect(saved.permissions).toBe(true);
	});
	it("keeps the saved state when persistence fails and explains the retry", async () => {
		native.save.mockRejectedValueOnce(new Error("storage unavailable"));
		await act(async () => button("Respuestas de Dot").click());
		expect(button("Respuestas de Dot").getAttribute("aria-checked")).toBe("true");
		expect(host.querySelector('[role="alert"]')?.textContent).toContain("No se pudo guardar");
		expect(button("Respuestas de Dot").disabled).toBe(false);
	});
	it("waits for a pending preference save before retrying a failed report load", async () => {
		vi.mocked(fetch).mockRejectedValueOnce(new Error("Connection unavailable"));
		await act(async () => root.unmount());
		root = createRoot(host);
		await render();
		const retry = Array.from(host.querySelectorAll("button")).find(value => value.textContent === "Reintentar");
		if (!retry) throw new Error("Missing report retry");
		let finishSave: () => void = () => {};
		native.save.mockImplementationOnce(value => new Promise(resolve => {
			finishSave = () => { saved = value; resolve(value); };
		}));
		await act(async () => button("Respuestas de Dot").click());
		expect(button("Respuestas de Dot").disabled).toBe(true);
		expect(retry.disabled).toBe(true);
		const reads = native.read.mock.calls.length;
		const requests = vi.mocked(fetch).mock.calls.length;
		await act(async () => retry.click());
		expect(native.read).toHaveBeenCalledTimes(reads);
		expect(fetch).toHaveBeenCalledTimes(requests);
		await act(async () => finishSave());
		expect(button("Respuestas de Dot").disabled).toBe(false);
		expect(button("Respuestas de Dot").getAttribute("aria-checked")).toBe("false");
		expect(retry.disabled).toBe(false);
		await act(async () => retry.click());
		expect(fetch).toHaveBeenCalledTimes(requests + 1);
		expect(button("Respuestas de Dot").disabled).toBe(false);
		expect(button("Respuestas de Dot").getAttribute("aria-checked")).toBe("false");
	});
});
