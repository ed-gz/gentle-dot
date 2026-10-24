import { act, renderHook } from "@testing-library/react";
import type { KeyboardEvent, MouseEvent, PointerEvent } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clampFloat, normalizeFloat, useCapriFloat } from "../src/useCapriFloat.ts";

const originalWidth = window.innerWidth,
	originalHeight = window.innerHeight;
const originalVisual = Object.getOwnPropertyDescriptor(window, "visualViewport");
beforeEach(() => {
	vi.useFakeTimers();
	Object.defineProperty(window, "innerWidth", { configurable: true, value: 400 });
	Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
	Object.defineProperty(window, "visualViewport", { configurable: true, value: undefined });
	vi.spyOn(document, "hidden", "get").mockReturnValue(false);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
	Object.defineProperty(window, "innerHeight", { configurable: true, value: originalHeight });
	if (originalVisual) Object.defineProperty(window, "visualViewport", originalVisual);
	else Reflect.deleteProperty(window, "visualViewport");
	document.querySelectorAll("[data-float-test]").forEach((element) => {
		element.remove();
	});
});
function settings(extra: Partial<Parameters<typeof useCapriFloat>[0]> = {}) {
	return {
		enabled: true,
		moving: false,
		side: "auto" as const,
		size: { width: 100, height: 100 },
		position: null,
		onPosition: vi.fn(),
		...extra,
	};
}
function target() {
	const element = document.createElement("button");
	element.setPointerCapture = vi.fn();
	element.hasPointerCapture = vi.fn().mockReturnValue(true);
	element.releasePointerCapture = vi.fn();
	return element;
}
function pointer(element: HTMLElement, x: number, y: number, extra: Record<string, unknown> = {}) {
	return {
		currentTarget: element,
		clientX: x,
		clientY: y,
		pointerId: 1,
		isPrimary: true,
		button: 0,
		preventDefault: vi.fn(),
		...extra,
	} as unknown as PointerEvent<HTMLElement>;
}
function keyboard(key: string, shiftKey = false) {
	return {
		key,
		shiftKey,
		preventDefault: vi.fn(),
		stopPropagation: vi.fn(),
	} as unknown as KeyboardEvent<HTMLElement>;
}
const frame = () => act(() => vi.advanceTimersByTime(20));

it("never moves on a timer without an activity target", () => {
 const { result } = renderHook(() => useCapriFloat(settings({ moving: true })));
 const before = { ...result.current.point };
 act(() => vi.advanceTimersByTime(60_000));
 expect(result.current.point).toEqual(before);
});

it("approaches the composer when typing provides a target", () => {
 const { result, rerender } = renderHook(({ target }) => useCapriFloat(settings({ moving: true, target })), { initialProps: { target: undefined as { x: number; y: number; width: number; height: number } | undefined } });
 const before = { ...result.current.point };
 rerender({ target: { x: 40, y: 650, width: 300, height: 80 } });
 frame();
 expect(result.current.point).not.toEqual(before);
 expect(result.current.point.y).toBeLessThan(650 - 100);
});

it("ends a target-driven walk at arrival even without transitionend", () => {
	const options = settings({ moving: true });
	const hook = renderHook((props) => useCapriFloat(props), { initialProps: options });
	hook.rerender({ ...options, target: { x: 0, y: 650, width: 100, height: 60 } });
	frame();
	expect(hook.result.current.travelling).toBe(true);
	const destination = hook.result.current.point;
	act(() => vi.advanceTimersByTime(1500));
	expect(hook.result.current.travelling).toBe(false);
	expect(hook.result.current.point).toEqual(destination);
	expect(options.onPosition).not.toHaveBeenCalled();
	act(() => vi.advanceTimersByTime(60_000));
	expect(hook.result.current.travelling).toBe(false);
	hook.unmount();
	expect(vi.getTimerCount()).toBe(0);
});

function modalFixture(rect: { x: number; y: number; width: number; height: number }) {
	const dialog = document.createElement("dialog");
	dialog.dataset.floatTest = "true";
	document.body.append(dialog);
	const matches = dialog.matches.bind(dialog);
	vi.spyOn(dialog, "matches").mockImplementation((selector) =>
		selector === ":modal" ? dialog.open : matches(selector),
	);
	vi.spyOn(dialog, "getBoundingClientRect").mockReturnValue({
		...rect,
		left: rect.x,
		top: rect.y,
		right: rect.x + rect.width,
		bottom: rect.y + rect.height,
		toJSON() {},
	});
	return dialog;
}

describe("float geometry", () => {
	it("clamps layout viewport offsets and round-trips normalized positions", () => {
		const viewport = { left: 40, top: 100, width: 300, height: 400 },
			size = { width: 100, height: 100 };
		expect(clampFloat({ x: -100, y: 999 }, viewport, size)).toEqual({ x: 40, y: 400 });
		expect(normalizeFloat({ x: 140, y: 175 }, viewport, size)).toEqual({ x: 0.5, y: 0.25 });
		expect(clampFloat({ x: Number.NaN, y: Number.POSITIVE_INFINITY }, viewport, size)).toEqual({
			x: 40,
			y: 100,
		});
	});
	it("keeps oversized sprites reachable in very short viewports", () => {
		const viewport = { left: 8, top: 8, width: 40, height: 30 },
			size = { width: 100, height: 100 };
		expect(clampFloat({ x: 500, y: 500 }, viewport, size)).toEqual({ x: 8, y: 8 });
		expect(normalizeFloat({ x: 500, y: 500 }, viewport, size)).toEqual({ x: 0, y: 0 });
	});
});

it("distinguishes a tap from a six-pixel drag and saves only on drop", () => {
	const options = settings();
	const hook = renderHook(() => useCapriFloat(options));
	frame();
	const button = target(),
		start = hook.result.current.point;
	act(() => hook.result.current.dragProps.onPointerDown(pointer(button, 100, 100)));
	act(() => hook.result.current.dragProps.onPointerMove(pointer(button, 104, 100)));
	frame();
	expect(hook.result.current.dragging).toBe(false);
	expect(hook.result.current.point).toEqual(start);
	act(() => hook.result.current.dragProps.onPointerUp(pointer(button, 104, 100)));
	expect(options.onPosition).not.toHaveBeenCalled();
	act(() => hook.result.current.dragProps.onPointerDown(pointer(button, 100, 100)));
	act(() => hook.result.current.dragProps.onPointerMove(pointer(button, 94, 100)));
	expect(hook.result.current.dragging).toBe(true);
	expect(hook.result.current.point).toEqual(start);
	frame();
	expect(hook.result.current.point.x).toBe(start.x - 6);
	expect(options.onPosition).not.toHaveBeenCalled();
	act(() => hook.result.current.dragProps.onPointerUp(pointer(button, 40, 150)));
	expect(hook.result.current.point).toEqual({ x: start.x - 60, y: start.y + 50 });
	expect(options.onPosition).toHaveBeenCalledTimes(1);
	expect(options.onPosition).toHaveBeenLastCalledWith(
		normalizeFloat(hook.result.current.point, hook.result.current.viewport, options.size),
	);
	expect(button.releasePointerCapture).toHaveBeenCalledWith(1);
});

it("suppresses the synthetic click after a drag but allows the next genuine tap", () => {
	const hook = renderHook(() => useCapriFloat(settings()));
	const button = target();
	act(() => hook.result.current.dragProps.onPointerDown(pointer(button, 100, 100)));
	act(() => hook.result.current.dragProps.onPointerUp(pointer(button, 50, 100)));
	const click = {
		detail: 1,
		preventDefault: vi.fn(),
		stopPropagation: vi.fn(),
	} as unknown as MouseEvent<HTMLElement>;
	hook.result.current.dragProps.onClickCapture(click);
	expect(click.preventDefault).toHaveBeenCalledOnce();
	act(() => hook.result.current.dragProps.onPointerDown(pointer(button, 100, 100)));
	act(() => hook.result.current.dragProps.onPointerUp(pointer(button, 100, 100)));
	hook.result.current.dragProps.onClickCapture(click);
	expect(click.preventDefault).toHaveBeenCalledOnce();
});

it.each(["onPointerCancel", "onLostPointerCapture"] as const)(
	"%s restores the starting point without persisting",
	(method) => {
		const options = settings();
		const hook = renderHook(() => useCapriFloat(options));
		frame();
		const button = target(),
			start = hook.result.current.point;
		act(() => hook.result.current.dragProps.onPointerDown(pointer(button, 100, 100)));
		act(() => hook.result.current.dragProps.onPointerMove(pointer(button, 40, 180)));
		frame();
		act(() => hook.result.current.dragProps[method](pointer(button, 40, 180)));
		expect(hook.result.current.point).toEqual(start);
		expect(hook.result.current.dragging).toBe(false);
		expect(options.onPosition).not.toHaveBeenCalled();
	},
);

it("ignores secondary pointers and clamps free drags to the visible area", () => {
	const options = settings();
	const hook = renderHook(() => useCapriFloat(options));
	frame();
	const button = target(),
		start = hook.result.current.point;
	act(() => hook.result.current.dragProps.onPointerDown(pointer(button, 100, 100, { isPrimary: false })));
	act(() => hook.result.current.dragProps.onPointerMove(pointer(button, 0, 900)));
	frame();
	expect(hook.result.current.point).toEqual(start);
	act(() => hook.result.current.dragProps.onPointerDown(pointer(button, 100, 100)));
	act(() => hook.result.current.dragProps.onPointerMove(pointer(button, -1000, 2000, { pointerId: 2 })));
	frame();
	expect(hook.result.current.point).toEqual(start);
	act(() => hook.result.current.dragProps.onPointerUp(pointer(button, -1000, 2000)));
	expect(hook.result.current.point).toEqual({ x: 8, y: 692 });
});

it("coalesces pointer paints and clears scheduled work on unmount", () => {
	const options = settings();
	const hook = renderHook(() => useCapriFloat(options));
	frame();
	const schedule = vi.spyOn(window, "requestAnimationFrame"),
		button = target();
	act(() => {
		hook.result.current.dragProps.onPointerDown(pointer(button, 100, 100));
		for (let x = 80; x >= 10; x -= 10) hook.result.current.dragProps.onPointerMove(pointer(button, x, 100));
	});
	expect(schedule).toHaveBeenCalledOnce();
	hook.unmount();
	expect(vi.getTimerCount()).toBe(0);
	expect(options.onPosition).not.toHaveBeenCalled();
});

it("uses visualViewport offsets, reclamps for keyboard resize, and restores the normalized anchor", () => {
	const visual = Object.assign(new EventTarget(), { offsetLeft: 20, offsetTop: 50, width: 360, height: 600 });
	Object.defineProperty(window, "visualViewport", { configurable: true, value: visual });
	const options = settings({ position: { x: 1, y: 1 } });
	const hook = renderHook(() => useCapriFloat(options));
	frame();
	expect(hook.result.current.viewport).toEqual({ left: 28, top: 58, width: 344, height: 584 });
	expect(hook.result.current.point).toEqual({ x: 272, y: 542 });
	act(() => {
		visual.height = 300;
		visual.offsetTop = 120;
		visual.dispatchEvent(new Event("resize"));
	});
	frame();
	expect(hook.result.current.point).toEqual({ x: 272, y: 312 });
	act(() => {
		visual.height = 600;
		visual.offsetTop = 50;
		visual.dispatchEvent(new Event("scroll"));
	});
	frame();
	expect(hook.result.current.point).toEqual({ x: 272, y: 542 });
	expect(options.onPosition).not.toHaveBeenCalled();
});

it("reclamps when a duo sprite becomes wider", () => {
	const options = settings({ position: { x: 1, y: 0.5 } });
	const hook = renderHook((props) => useCapriFloat(props), { initialProps: options });
	frame();
	hook.rerender({ ...options, size: { width: 180, height: 100 } });
	frame();
	expect(hook.result.current.point.x).toBe(212);
	expect(options.onPosition).not.toHaveBeenCalled();
});

it("keeps the composer clear before focus and after dropping without reading its draft", () => {
	const composer = document.createElement("div");
	composer.className = "agent-composer";
	composer.dataset.floatTest = "true";
	const input = document.createElement("textarea");
	composer.append(input);
	document.body.append(composer);
	vi.spyOn(composer, "getBoundingClientRect").mockReturnValue({
		x: 0,
		y: 650,
		top: 650,
		left: 0,
		right: 400,
		bottom: 800,
		width: 400,
		height: 150,
		toJSON() {},
	});
	const value = vi.spyOn(input, "value", "get");
	const options = settings({ position: { x: 1, y: 1 } });
	const hook = renderHook(() => useCapriFloat(options));
	frame();
	expect(hook.result.current.point.y + 100).toBeLessThanOrEqual(638);
	act(() => input.focus());
	frame();
	expect(hook.result.current.point.y + 100).toBeLessThanOrEqual(638);
	expect(document.activeElement).toBe(input);
	const button = target();
	act(() => hook.result.current.dragProps.onPointerDown(pointer(button, 100, 100)));
	act(() => hook.result.current.dragProps.onPointerUp(pointer(button, 100, 250)));
	expect(hook.result.current.point.y + 100).toBeLessThanOrEqual(638);
	act(() => input.dispatchEvent(new Event("input", { bubbles: true })));
	frame();
	expect(hook.result.current.point.y + 100).toBeLessThanOrEqual(638);
	expect(value).not.toHaveBeenCalled();
});

it("steps outside a modal without saving, stops roaming, and restores the prior position on close", async () => {
	const options = settings({ moving: true });
	const hook = renderHook(() => useCapriFloat(options));
	const previous = hook.result.current.point;
	const dialog = modalFixture({ x: 16, y: 180, width: 368, height: 400 });
	await act(async () => dialog.setAttribute("open", ""));
	expect(hook.result.current.modalOpen).toBe(true);
	expect(hook.result.current.compact).toBe(false);
	const sheltered = hook.result.current.point;
	expect(sheltered.y + hook.result.current.size.height <= 168 || sheltered.y >= 592).toBe(true);
	act(() => vi.advanceTimersByTime(40_000));
	frame();
	expect(hook.result.current.point).toEqual(sheltered);
	act(() => hook.result.current.nudge(-300, 0));
	const button = target();
	act(() => hook.result.current.dragProps.onPointerDown(pointer(button, 100, 100)));
	act(() => hook.result.current.dragProps.onPointerUp(pointer(button, 180, 100)));
	expect(options.onPosition).not.toHaveBeenCalled();
	await act(async () => dialog.removeAttribute("open"));
	expect(hook.result.current.modalOpen).toBe(false);
	expect(hook.result.current.point).toEqual(previous);
});

it("compacts against the natural size without oscillation and clears a narrow modal margin", async () => {
	const options = settings();
	const hook = renderHook((props) => useCapriFloat(props), {
		initialProps: { ...options, naturalSize: options.size },
	});
	const previous = hook.result.current.point;
	const dialog = modalFixture({ x: 0, y: 80, width: 400, height: 640 });
	await act(async () => dialog.setAttribute("open", ""));
	expect(hook.result.current.compact).toBe(true);
	expect(hook.result.current.size).toEqual({ width: 80, height: 60 });
	expect(hook.result.current.point.y + 60 <= 68 || hook.result.current.point.y >= 732).toBe(true);
	hook.rerender({ ...options, size: { width: 80, height: 60 }, naturalSize: options.size });
	act(() => window.dispatchEvent(new Event("resize")));
	expect(hook.result.current.compact).toBe(true);
	await act(async () => dialog.remove());
	expect(hook.result.current.compact).toBe(false);
	expect(hook.result.current.size).toEqual(options.size);
	expect(hook.result.current.point).toEqual(previous);
	expect(options.onPosition).not.toHaveBeenCalled();
});

it.each([
	{ size: { width: 100, height: 100 } },
	{ size: { width: 80, height: 60 }, naturalSize: { width: 140, height: 108 } },
])("pins the chosen modal position for its normal size without jumping on persistence: %j", async (sizes) => {
	const persist = vi.fn();
	const initial = settings({ ...sizes, onPosition: persist });
	const hook = renderHook((options) => useCapriFloat(options), { initialProps: initial });
	const previous = hook.result.current.point;
	const normalSize = hook.result.current.size;
	const dialog = modalFixture({ x: 0, y: 80, width: 400, height: 640 });
	await act(async () => dialog.setAttribute("open", ""));
	expect(hook.result.current.compact).toBe(true);
	act(() => hook.result.current.nudge(-70, 0));
	const chosen = hook.result.current.point;
	expect(persist).not.toHaveBeenCalled();
	hook.rerender({ ...initial, pinned: true });
	expect(hook.result.current.point).toEqual(chosen);
	expect(persist).toHaveBeenCalledOnce();
	const position = persist.mock.calls[0]?.[0];
	if (!position) throw new Error("Pin did not persist a position");
	const restored = clampFloat(chosen, hook.result.current.viewport, normalSize);
	expect(position).toEqual(normalizeFloat(restored, hook.result.current.viewport, normalSize));
	// The settings owner echoes the persisted position into the hook while the modal is still open.
	hook.rerender({ ...initial, pinned: true, position });
	expect(hook.result.current.point).toEqual(chosen);
	expect(hook.result.current.compact).toBe(true);
	await act(async () => dialog.removeAttribute("open"));
	expect(hook.result.current.point).toEqual(restored);
	expect(hook.result.current.point).not.toEqual(previous);
	expect(hook.result.current.size).toEqual(normalSize);
	expect(persist).toHaveBeenCalledOnce();
	hook.unmount();
	const reopened = renderHook(() => useCapriFloat({ ...initial, pinned: true, position }));
	expect(reopened.result.current.point).toEqual(restored);
});

it("uses a quiet edge for a full-screen modal instead of obscuring its central text or decisions", async () => {
	const hook = renderHook(() => useCapriFloat(settings()));
	const dialog = modalFixture({ x: 0, y: 0, width: 400, height: 800 });
	const heading = document.createElement("p");
	const decision = document.createElement("button");
	dialog.append(heading, decision);
	vi.spyOn(heading, "getBoundingClientRect").mockReturnValue({
		x: 90,
		y: 90,
		top: 90,
		left: 90,
		right: 310,
		bottom: 650,
		width: 220,
		height: 560,
		toJSON() {},
	});
	vi.spyOn(decision, "getBoundingClientRect").mockReturnValue({
		x: 275,
		y: 15,
		top: 15,
		left: 275,
		right: 390,
		bottom: 65,
		width: 115,
		height: 50,
		toJSON() {},
	});
	await act(async () => dialog.setAttribute("open", ""));
	const { point, size, compact } = hook.result.current;
	expect(compact).toBe(true);
	expect(point.x <= 8 || point.y <= 8 || point.x + size.width >= 392 || point.y + size.height >= 792).toBe(
		true,
	);
	expect(point.y + size.height <= 78 || point.y >= 662 || point.x + size.width <= 78 || point.x >= 322).toBe(
		true,
	);
	expect(point.y >= 77 || point.x + size.width <= 263).toBe(true);
});

it.each(["button", "a", "select", "div"])("avoids an external focused %s without stealing focus", (tag) => {
	const element = document.createElement(tag);
	element.dataset.floatTest = "true";
	element.tabIndex = 0;
	if (element instanceof HTMLAnchorElement) element.href = "#example";
	document.body.append(element);
	vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
		x: 270,
		y: 600,
		top: 600,
		left: 270,
		right: 400,
		bottom: 800,
		width: 130,
		height: 200,
		toJSON() {},
	});
	const hook = renderHook(() => useCapriFloat(settings({ position: { x: 1, y: 1 } })));
	frame();
	act(() => element.focus());
	frame();
	const point = hook.result.current.point;
	expect(point.x + 100 <= 258 || point.y + 100 <= 588).toBe(true);
	expect(document.activeElement).toBe(element);
});

it("does not flee its own keyboard controls", () => {
	const overlay = document.createElement("div");
	overlay.className = "capri-overlay";
	overlay.dataset.floatTest = "true";
	const button = document.createElement("button");
	overlay.append(button);
	document.body.append(overlay);
	vi.spyOn(button, "getBoundingClientRect").mockReturnValue({
		x: 270,
		y: 600,
		top: 600,
		left: 270,
		right: 400,
		bottom: 800,
		width: 130,
		height: 200,
		toJSON() {},
	});
	const hook = renderHook(() => useCapriFloat(settings({ position: { x: 1, y: 1 } })));
	frame();
	const before = hook.result.current.point;
	act(() => button.focus());
	frame();
	expect(hook.result.current.point).toEqual(before);
});

it("moves for a target without persisting and respects the drag cooldown", () => {
	const options = settings({ moving: true });
	const hook = renderHook((props) => useCapriFloat(props), { initialProps: options });
	frame();
	hook.rerender({ ...options, target: { x: 0, y: 650, width: 100, height: 60 } });
	frame();
	expect(hook.result.current.point.x).toBe(8);
	expect(options.onPosition).not.toHaveBeenCalled();
	const button = target();
	act(() => hook.result.current.dragProps.onPointerDown(pointer(button, 0, 0)));
	act(() => hook.result.current.dragProps.onPointerUp(pointer(button, 120, 100)));
	const dropped = hook.result.current.point;
	act(() => vi.advanceTimersByTime(59_000));
	hook.rerender({ ...options, target: { x: 220, y: 600, width: 100, height: 60 } });
	frame();
	expect(hook.result.current.point).toEqual(dropped);
	act(() => vi.advanceTimersByTime(21_000));
	frame();
	expect(hook.result.current.point).toEqual(dropped);
	hook.rerender({ ...options, target: { x: 220, y: 650, width: 100, height: 60 } });
	frame();
	expect(hook.result.current.point).not.toEqual(dropped);
	expect(options.onPosition).toHaveBeenCalledOnce();
});

it("stops walks while motion is paused or the document is hidden", () => {
	const options = settings({ moving: true });
	const hook = renderHook((props) => useCapriFloat(props), { initialProps: options });
	frame();
	hook.rerender({ ...options, moving: false });
	const paused = hook.result.current.point;
	act(() => vi.advanceTimersByTime(60_000));
	expect(hook.result.current.point).toEqual(paused);
	hook.rerender(options);
	const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
	act(() => document.dispatchEvent(new Event("visibilitychange")));
	expect(vi.getTimerCount()).toBe(0);
	act(() => vi.advanceTimersByTime(60_000));
	expect(hook.result.current.point).toEqual(paused);
	hidden.mockReturnValue(false);
	act(() => document.dispatchEvent(new Event("visibilitychange")));
	frame();
	act(() => vi.advanceTimersByTime(60_000));
	frame();
	expect(hook.result.current.point).toEqual(paused);
});

it("keeps a chosen side during automatic walks and persists accessible keyboard moves", () => {
	const options = settings({ moving: true, side: "left" });
	const hook = renderHook(() => useCapriFloat(options));
	frame();
	act(() => vi.advanceTimersByTime(40_000));
	frame();
	expect(hook.result.current.point.x).toBe(8);
	const right = keyboard("ArrowRight");
	act(() => hook.result.current.handleKeyDown(right));
	expect(hook.result.current.point.x).toBe(32);
	expect(right.preventDefault).toHaveBeenCalledOnce();
	act(() => hook.result.current.handleKeyDown(keyboard("ArrowRight", true)));
	expect(hook.result.current.point.x).toBe(96);
	act(() => hook.result.current.handleKeyDown(keyboard("Home")));
	expect(hook.result.current.point.x).toBe(8);
	expect(options.onPosition).toHaveBeenCalledTimes(3);
});

it("does not persist or leave a dragging flag after being disabled", () => {
	const options = settings();
	const hook = renderHook((props) => useCapriFloat(props), { initialProps: options });
	frame();
	const button = target();
	act(() => hook.result.current.dragProps.onPointerDown(pointer(button, 100, 100)));
	act(() => hook.result.current.dragProps.onPointerMove(pointer(button, 30, 100)));
	frame();
	hook.rerender({ ...options, enabled: false });
	expect(hook.result.current.dragging).toBe(false);
	expect(options.onPosition).not.toHaveBeenCalled();
	expect(vi.getTimerCount()).toBe(0);
});

it("starts a drag at the rendered position during a target-driven transition", () => {
	const options = settings({ moving: true });
	const hook = renderHook((props) => useCapriFloat(props), { initialProps: options });
	frame();
	const element = document.createElement("div");
	vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
		x: 180,
		y: 300,
		top: 300,
		left: 180,
		right: 280,
		bottom: 400,
		width: 100,
		height: 100,
		toJSON() {},
	});
	hook.result.current.floatRef.current = element;
	hook.rerender({ ...options, target: { x: 0, y: 650, width: 100, height: 60 } });
	frame();
	expect(hook.result.current.travelling).toBe(true);
	expect(hook.result.current.point.x).toBe(8);
	const button = target();
	act(() => hook.result.current.dragProps.onPointerDown(pointer(button, 200, 320)));
	expect(hook.result.current.point).toEqual({ x: 180, y: 300 });
	expect(hook.result.current.travelling).toBe(false);
	expect(options.onPosition).not.toHaveBeenCalled();
	act(() => hook.result.current.dragProps.onPointerMove(pointer(button, 170, 340)));
	frame();
	expect(hook.result.current.point).toEqual({ x: 150, y: 320 });
	act(() => hook.result.current.dragProps.onPointerUp(pointer(button, 170, 340)));
	expect(options.onPosition).toHaveBeenCalledWith(
		normalizeFloat({ x: 150, y: 320 }, hook.result.current.viewport, options.size),
	);
});

it("freezes the actual CSS position when movement is paused without saving it", () => {
	const options = settings({ moving: true });
	const hook = renderHook((props) => useCapriFloat(props), { initialProps: options });
	frame();
	const element = document.createElement("div");
	vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
		x: 160,
		y: 280,
		top: 280,
		left: 160,
		right: 260,
		bottom: 380,
		width: 100,
		height: 100,
		toJSON() {},
	});
	hook.result.current.floatRef.current = element;
	hook.rerender({ ...options, target: { x: 0, y: 650, width: 100, height: 60 } });
	frame();
	expect(hook.result.current.travelling).toBe(true);
	hook.rerender({ ...options, moving: false });
	expect(hook.result.current.point).toEqual({ x: 160, y: 280 });
	expect(hook.result.current.travelling).toBe(false);
	expect(options.onPosition).not.toHaveBeenCalled();
	act(() => vi.advanceTimersByTime(60_000));
	expect(hook.result.current.point).toEqual({ x: 160, y: 280 });
});

it("cancels to the grabbed visual position and freezes travel while hidden", () => {
	const options = settings({ moving: true });
	const hook = renderHook((props) => useCapriFloat(props), { initialProps: options });
	frame();
	const element = document.createElement("div");
	vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
		x: 120,
		y: 260,
		top: 260,
		left: 120,
		right: 220,
		bottom: 360,
		width: 100,
		height: 100,
		toJSON() {},
	});
	hook.result.current.floatRef.current = element;
	act(() => vi.advanceTimersByTime(20_000));
	frame();
	const button = target();
	act(() => hook.result.current.dragProps.onPointerDown(pointer(button, 120, 260)));
	act(() => hook.result.current.dragProps.onPointerMove(pointer(button, 170, 280)));
	frame();
	act(() => hook.result.current.dragProps.onPointerCancel(pointer(button, 170, 280)));
	expect(hook.result.current.point).toEqual({ x: 120, y: 260 });
	expect(hook.result.current.travelling).toBe(false);
	act(() => vi.advanceTimersByTime(80_000));
	hook.rerender({ ...options, target: { x: 0, y: 650, width: 100, height: 60 } });
	frame();
	expect(hook.result.current.travelling).toBe(true);
	vi.spyOn(document, "hidden", "get").mockReturnValue(true);
	act(() => document.dispatchEvent(new Event("visibilitychange")));
	expect(hook.result.current.point).toEqual({ x: 120, y: 260 });
	expect(hook.result.current.travelling).toBe(false);
	expect(vi.getTimerCount()).toBe(0);
	expect(options.onPosition).not.toHaveBeenCalled();
});

it("pins the current position, preserves gestures' size changes and stays within the allowed area", () => {
	const initial = settings({ moving: true, space: { x: 0.5, y: 0, width: 0.5, height: 0.5 } });
	const hook = renderHook((options) => useCapriFloat(options), { initialProps: initial });
	act(() => vi.advanceTimersByTime(20_020));
	hook.rerender({ ...initial, pinned: true });
	const pinned = hook.result.current.point;
	expect(initial.onPosition).toHaveBeenCalledOnce();
	act(() => vi.advanceTimersByTime(60_000));
	expect(hook.result.current.point).toEqual(pinned);
	hook.rerender({ ...initial, pinned: true, size: { width: 70, height: 60 } });
	expect(hook.result.current.point).toEqual(pinned);
	act(() => hook.result.current.nudge(-1000, 1000));
	frame();
	const { point, size } = hook.result.current;
	expect(point.x).toBeGreaterThanOrEqual(200);
	expect(point.x + size.width).toBeLessThanOrEqual(392.001);
	expect(point.y + size.height).toBeLessThanOrEqual(400);
});
it("fits the complete sprite inside a small permitted area after viewport resizing", () => {
	const hook = renderHook(() =>
		useCapriFloat(settings({ space: { x: 0.8, y: 0.8, width: 0.2, height: 0.2 } })),
	);
	expect(hook.result.current.point.x + hook.result.current.size.width).toBeLessThanOrEqual(392.001);
	Object.defineProperty(window, "innerWidth", { configurable: true, value: 220 });
	act(() => window.dispatchEvent(new Event("resize")));
	const { point, size } = hook.result.current;
	expect(point.x).toBeGreaterThanOrEqual(171.2);
	expect(point.x + size.width).toBeLessThanOrEqual(212.001);
});
