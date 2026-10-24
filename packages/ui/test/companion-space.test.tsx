import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { normalizeCompanionSpace } from "../src/companion-space.ts";
import { CompanionSpaceEditor } from "../src/components/CompanionSpaceEditor.tsx";

const rect = { x: 0.1, y: 0.2, width: 0.5, height: 0.4 };
beforeEach(() => {
	vi.stubGlobal(
		"PointerEvent",
		class extends MouseEvent {
			readonly pointerId: number;
			readonly isPrimary: boolean;
			constructor(type: string, init: PointerEventInit = {}) {
				super(type, init);
				this.pointerId = init.pointerId ?? 1;
				this.isPrimary = init.isPrimary ?? true;
			}
		},
	);
});
afterEach(() => vi.unstubAllGlobals());
function setup() {
	const onChange = vi.fn();
	const view = render(<CompanionSpaceEditor rect={rect} onChange={onChange} />);
	const map = view.container.querySelector<HTMLElement>(".companion-space-map");
	if (!map) throw new Error("Missing map");
	map.getBoundingClientRect = () => ({
		x: 10,
		y: 20,
		left: 10,
		top: 20,
		width: 300,
		height: 200,
		right: 310,
		bottom: 220,
		toJSON() {},
	});
	return {
		onChange,
		view,
		map,
		move: screen.getByRole("button", { name: "Mover la zona permitida" }),
		resize: screen.getByRole("button", { name: "Cambiar tamaño de la zona" }),
	};
}
it("keeps finite areas inside the screen without changing valid geometry", () => {
	expect(normalizeCompanionSpace(rect)).toEqual(rect);
	expect(normalizeCompanionSpace({ x: 4, y: -2, width: 0.5, height: 2 })).toEqual({
		x: 0.5,
		y: 0,
		width: 0.5,
		height: 1,
	});
	expect(normalizeCompanionSpace({ x: NaN, y: Infinity, width: NaN, height: -1 })).toEqual({
		x: 0,
		y: 0,
		width: 1,
		height: 0.2,
	});
});
it("previews pointer movement locally and commits exactly once on release", () => {
	const { onChange, view, move } = setup();
	fireEvent.pointerDown(move, { pointerId: 3, clientX: 60, clientY: 60 });
	fireEvent.pointerMove(move, { pointerId: 3, clientX: 120, clientY: 100 });
	expect(onChange).not.toHaveBeenCalled();
	expect(view.container.querySelector(".companion-space-selection")).toHaveStyle({
		left: "30.000000000000004%",
		top: "40%",
	});
	fireEvent.pointerUp(move, { pointerId: 3 });
	expect(onChange).toHaveBeenCalledOnce();
	expect(onChange.mock.calls[0]?.[0]).toMatchObject({
		x: expect.closeTo(0.3),
		y: 0.4,
		width: 0.5,
		height: 0.4,
	});
});
it("ignores secondary pointers and incidental taps, and cancels a touch gesture", () => {
	const { onChange, move } = setup();
	fireEvent.pointerDown(move, { pointerId: 1, clientX: 60, clientY: 60 });
	fireEvent.pointerMove(move, { pointerId: 1, clientX: 62, clientY: 61 });
	fireEvent.pointerUp(move, { pointerId: 1 });
	expect(onChange).not.toHaveBeenCalled();
	fireEvent.pointerDown(move, { pointerId: 2, clientX: 60, clientY: 60 });
	fireEvent.pointerMove(move, { pointerId: 2, clientX: 150, clientY: 120 });
	fireEvent.pointerUp(move, { pointerId: 3 });
	expect(onChange).not.toHaveBeenCalled();
	fireEvent.pointerCancel(move, { pointerId: 2 });
	fireEvent.pointerUp(move, { pointerId: 2 });
	expect(onChange).not.toHaveBeenCalled();
});
it("clamps resize to the selected screen and supports cancelling with Escape", () => {
	const { onChange, resize } = setup();
	fireEvent.pointerDown(resize, { clientX: 150, clientY: 100 });
	fireEvent.pointerMove(resize, { clientX: 999, clientY: 999 });
	fireEvent.pointerUp(resize);
	expect(onChange).toHaveBeenLastCalledWith({
		x: expect.closeTo(0.1),
		y: expect.closeTo(0.2),
		width: 0.9,
		height: 0.8,
	});
	fireEvent.pointerDown(resize, { clientX: 150, clientY: 100 });
	fireEvent.pointerMove(resize, { clientX: 160, clientY: 120 });
	fireEvent.keyDown(resize, { key: "Escape" });
	fireEvent.pointerUp(resize);
	expect(onChange).toHaveBeenCalledOnce();
});
it("offers keyboard, presets and tap alternatives without requiring drag", () => {
	const { onChange, move, resize } = setup();
	fireEvent.keyDown(move, { key: "ArrowRight" });
	expect(onChange).toHaveBeenLastCalledWith({ ...rect, x: 0.125 });
	fireEvent.keyDown(resize, { key: "ArrowDown", shiftKey: true });
	expect(onChange).toHaveBeenLastCalledWith({ ...rect, x: 0.125, height: 0.5 });
	fireEvent.click(screen.getByRole("button", { name: "Derecha" }));
	expect(onChange).toHaveBeenLastCalledWith({ x: 0.5, y: 0, width: 0.5, height: 1 });
	fireEvent.click(screen.getByRole("button", { name: "Reducir zona" }));
	expect(onChange).toHaveBeenLastCalledWith({ x: 0.55, y: expect.closeTo(0.05), width: 0.4, height: 0.9 });
	fireEvent.click(screen.getByRole("button", { name: "Situar zona en el mapa" }), {
		clientX: 70,
		clientY: 120,
		detail: 1,
	});
	expect(onChange).toHaveBeenLastCalledWith({ x: 0, y: expect.closeTo(0.05), width: 0.4, height: 0.9 });
});
it("cancels an in-progress edit when geometry changes or the owner disables it", () => {
	const { onChange, view, move } = setup();
	fireEvent.pointerDown(move, { clientX: 50, clientY: 50 });
	fireEvent.pointerMove(move, { clientX: 100, clientY: 100 });
	view.rerender(
		<CompanionSpaceEditor rect={{ x: 0, y: 0, width: 1, height: 1 }} onChange={onChange} disabled />,
	);
	fireEvent.pointerUp(move);
	expect(onChange).not.toHaveBeenCalled();
	expect(view.container.querySelector(".companion-space-selection")).toHaveStyle({
		left: "0%",
		width: "100%",
	});
	expect(screen.getAllByRole("button").every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
});
