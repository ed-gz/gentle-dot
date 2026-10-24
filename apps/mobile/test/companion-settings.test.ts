// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ state: vi.fn(), set: vi.fn(), permission: vi.fn() }));
vi.mock("../src/native.ts", () => ({
	nativeAndroid: true,
	GentleMobile: {
		companionState: native.state,
		setCompanion: native.set,
		requestCompanionPermission: native.permission,
	},
}));

import { CompanionSettings } from "../src/CompanionSettings.tsx";

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
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(async () => {
	await act(() => root.unmount());
	host.remove();
	vi.clearAllMocks();
});
async function render() {
	await act(() => root.render(createElement(CompanionSettings)));
}
async function click(index = 0) {
	await act(() => host.querySelectorAll<HTMLButtonElement>("button")[index]?.click());
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
});
