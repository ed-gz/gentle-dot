import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ImageViewer } from "../src/components/ImageViewer.tsx";

const disconnect = vi.fn();
beforeEach(() => {
	vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(600);
	vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(400);
	Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
		configurable: true,
		value() {
			this.open = true;
		},
	});
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			disconnect = disconnect;
		},
	);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	disconnect.mockClear();
	Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
});

it("offers labelled zoom controls bounded between fit and 5x, with keyboard alternatives", async () => {
	render(<ImageViewer name="Captura" url="blob:fixture" close={vi.fn()} />);
	const area = screen.getByRole("region", { name: "Área de imagen" });
	const zoom = screen.getByRole("group", { name: "Zoom de imagen" });
	expect(within(zoom).getByRole("button", { name: "Reducir imagen" })).toBeDisabled();
	await userEvent.click(within(zoom).getByRole("button", { name: "Ampliar imagen" }));
	expect(within(zoom).getByText("150%")).toBeVisible();
	expect(area.scrollLeft).toBe(0);
	expect(area.scrollTop).toBe(100);
	for (let n = 0; n < 15; n++) fireEvent.keyDown(area, { key: "+" });
	expect(within(zoom).getByText("500%")).toBeVisible();
	expect(within(zoom).getByRole("button", { name: "Ampliar imagen" })).toBeDisabled();
	fireEvent.keyDown(area, { key: "0" });
	expect(within(zoom).getByText("100%")).toBeVisible();
	for (let n = 0; n < 3; n++) fireEvent.keyDown(area, { key: "-" });
	expect(within(zoom).getByText("100%")).toBeVisible();
});
it("keeps transfer actions in the viewer, disables duplicate transfers, and exposes errors locally", async () => {
	const save = vi.fn(),
		share = vi.fn(),
		close = vi.fn(),
		cancel = vi.fn();
	const view = render(
		<ImageViewer name="Captura" url="blob:fixture" save={save} share={share} close={close} />,
	);
	await userEvent.click(screen.getByRole("button", { name: "Descargar imagen" }));
	expect(save).toHaveBeenCalledOnce();
	await userEvent.click(screen.getByRole("button", { name: "Compartir imagen" }));
	expect(share).toHaveBeenCalledOnce();
	view.rerender(
		<ImageViewer
			name="Captura"
			url="blob:fixture"
			save={save}
			share={share}
			close={close}
			busy
			cancelTransfer={cancel}
			status="Recibiendo…"
		/>,
	);
	expect(screen.getByRole("button", { name: "Descargar imagen" })).toBeDisabled();
	expect(screen.getByRole("button", { name: "Compartir imagen" })).toBeDisabled();
	await userEvent.click(screen.getByRole("button", { name: "Cancelar descarga" }));
	expect(cancel).toHaveBeenCalledOnce();
	view.rerender(<ImageViewer name="Captura" close={close} save={save} error="Sin conexión" />);
	expect(screen.getByRole("alert")).toHaveTextContent("Sin conexión");
	expect(screen.getByRole("button", { name: "Descargar imagen" })).toBeEnabled();
	expect(screen.getByRole("button", { name: "Ampliar imagen" })).toBeDisabled();
});
it("closes on Android Back or native cancel, restores the trigger without scrolling and disconnects observers", () => {
	const trigger = document.createElement("button");
	document.body.append(trigger);
	trigger.focus();
	const focus = vi.spyOn(trigger, "focus");
	const close = vi.fn();
	const view = render(<ImageViewer name="Captura" url="blob:fixture" close={close} />);
	const back = new Event("gentledot-back", { cancelable: true });
	act(() => window.dispatchEvent(back));
	expect(back.defaultPrevented).toBe(true);
	expect(close).toHaveBeenCalledOnce();
	fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
	expect(close).toHaveBeenCalledTimes(2);
	view.unmount();
	expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
	expect(disconnect).toHaveBeenCalledOnce();
	act(() => window.dispatchEvent(new Event("gentledot-back", { cancelable: true })));
	expect(close).toHaveBeenCalledTimes(2);
	trigger.remove();
});

it("consumes Escape before the desktop window can hide the entire panel", () => {
	const close = vi.fn(),
		panelEscape = vi.fn();
	window.addEventListener("keydown", panelEscape);
	try {
		render(<ImageViewer name="Captura" url="blob:fixture" close={close} />);
		const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
		fireEvent(screen.getByRole("button", { name: "Cerrar imagen" }), event);
		expect(event.defaultPrevented).toBe(true);
		expect(close).toHaveBeenCalledOnce();
		expect(panelEscape).not.toHaveBeenCalled();
	} finally {
		window.removeEventListener("keydown", panelEscape);
	}
});
