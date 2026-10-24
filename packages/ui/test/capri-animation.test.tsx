import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CapriAnimationClip, capriAction, readAnimationSheet } from "../src/capri-animation.ts";
import { CapriAnimatedSprite } from "../src/components/CapriAnimatedSprite.tsx";
import { CapriSprite } from "../src/components/CapriCompanion.tsx";
import { useCapriAnimation } from "../src/useCapriAnimation.ts";

const frames = [100, 200, 300].map((durationMs, index) => ({
	x: index * 100,
	y: 0,
	width: 100,
	height: 100,
	durationMs,
}));
const loop: CapriAnimationClip = {
	action: "idle",
	href: "/fixture-atlas.png",
	width: 300,
	height: 100,
	frames,
	playback: "loop",
};
const once: CapriAnimationClip = { ...loop, action: "greeting", playback: "once", holdFrame: 1 };
const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));
let hidden = false;
let motion: EventTarget & { matches: boolean };
let images: FakeImage[];
class FakeImage {
	src = "";
	complete = false;
	naturalWidth = 0;
	onload: (() => void) | null = null;
	onerror: (() => void) | null = null;
	constructor() {
		images.push(this);
	}
	load() {
		this.complete = true;
		this.naturalWidth = 300;
		this.onload?.();
	}
	fail() {
		this.complete = true;
		this.onerror?.();
	}
}
beforeEach(() => {
	vi.useFakeTimers();
	hidden = false;
	images = [];
	motion = Object.assign(new EventTarget(), { matches: false });
	vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
	vi.stubGlobal("matchMedia", () => motion);
	vi.stubGlobal("Image", FakeImage);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("animation manifest", () => {
	it("accepts per-frame durations and alpha masks, while refusing unfinished or unsafe clips", () => {
		const sheet = { width: 300, height: 100, animations: { idle: { frames, playback: "loop" } } };
		expect(readAnimationSheet(sheet, "/atlas.png").idle).toMatchObject({
			action: "idle",
			href: "/atlas.png",
			frames,
		});
		expect(readAnimationSheet({ ...sheet, animations: {} }, "/atlas.png")).toEqual({});
		for (const invalid of [
			[{ ...frames[0], durationMs: 0 }, frames[1]],
			[{ ...frames[0], width: 301 }, frames[1]],
			[
				{
					...frames[0],
					clip: [
						[0, 0],
						[10, 10],
						[400, 20],
					],
				},
				frames[1],
			],
			[frames[0], frames[0]],
		])
			expect(
				readAnimationSheet(
					{ ...sheet, animations: { idle: { frames: invalid, playback: "loop" } } },
					"/atlas.png",
				),
			).toEqual({});
		expect(
			readAnimationSheet(
				{ ...sheet, animations: { idle: { frames, playback: "once", holdFrame: 9 } } },
				"/atlas.png",
			),
		).toEqual({});
	});
	it("selects actual action cycles without replacing compact shapes or Rebecca's identity", () => {
		expect(capriAction("hacker")).toBe("working");
		expect(capriAction("sleepy-coffee")).toBe("coffee");
		expect(capriAction("stressed")).toBe("angry");
		expect(capriAction("duo-debug")).toBe("duo-watch");
		expect(capriAction("duo-sleep")).toBe("duo-couch");
		expect(capriAction("duo-laugh")).toBe("duo-high-five");
		expect(capriAction("idle", true)).toBe("walk");
		for (const [pose, action] of [
			["eyes", "eyes"],
			["eyes-blink", "eyes"],
			["face", "face"],
			["face-talk", "face"],
			["point-left", "point-left"],
			["point-right", "point-right"],
		] as const)
			expect(capriAction(pose, true)).toBe(action);
		expect(capriAction("rebecca-wave", true)).toBeUndefined();
	});
	it("registers varying crop sizes on one canvas and rejects crops that cannot fit", () => {
		const candidate = {
			canvas: { width: 120, height: 100 },
			frames: frames.map((frame, index) => ({ ...frame, width: 100 - index * 10, offsetX: index * 10 })),
			playback: "loop",
		};
		const sheet = { width: 300, height: 100, animations: { idle: candidate } };
		expect(readAnimationSheet(sheet, "/atlas.png").idle).toMatchObject({
			canvas: candidate.canvas,
			frames: candidate.frames.map((frame) => ({ ...frame, offsetY: 0 })),
		});
		for (const invalid of [
			{ ...candidate, canvas: { width: 50, height: 100 } },
			{ ...candidate, canvas: undefined },
			{ ...candidate, frames: [{ ...frames[0], offsetX: -1 }, frames[1]] },
		])
			expect(readAnimationSheet({ ...sheet, animations: { idle: invalid } }, "/atlas.png")).toEqual({});
	});
});

it("advances distinct frames at their own duration and wraps only after the final duration", () => {
	const hook = renderHook(() => useCapriAnimation(loop, true));
	expect(hook.result.current).toMatchObject({ index: 0, playing: true, complete: false });
	advance(99);
	expect(hook.result.current.index).toBe(0);
	advance(1);
	expect(hook.result.current.index).toBe(1);
	advance(199);
	expect(hook.result.current.index).toBe(1);
	advance(1);
	expect(hook.result.current.index).toBe(2);
	advance(300);
	expect(hook.result.current.index).toBe(0);
});

it("holds a one-shot's chosen final pose and resets when a different action starts", () => {
	const hook = renderHook(({ clip }) => useCapriAnimation(clip, true), { initialProps: { clip: once } });
	advance(599);
	expect(hook.result.current).toMatchObject({ index: 2, complete: false });
	advance(1);
	expect(hook.result.current).toEqual({ index: 1, complete: true, playing: false });
	expect(vi.getTimerCount()).toBe(0);
	advance(60_000);
	expect(hook.result.current.index).toBe(1);
	hook.rerender({ clip: loop });
	expect(hook.result.current).toEqual({ index: 0, complete: false, playing: true });
	advance(100);
	expect(hook.result.current.index).toBe(1);
});

it("pauses the remaining frame duration while disabled, hidden or reduced, with no catch-up", () => {
	const hook = renderHook(({ enabled }) => useCapriAnimation(loop, enabled), {
		initialProps: { enabled: true },
	});
	advance(40);
	hook.rerender({ enabled: false });
	expect(hook.result.current.playing).toBe(false);
	expect(vi.getTimerCount()).toBe(0);
	advance(2000);
	hook.rerender({ enabled: true });
	advance(59);
	expect(hook.result.current.index).toBe(0);
	advance(1);
	expect(hook.result.current.index).toBe(1);
	advance(75);
	act(() => {
		hidden = true;
		document.dispatchEvent(new Event("visibilitychange"));
	});
	expect(hook.result.current.playing).toBe(false);
	expect(vi.getTimerCount()).toBe(0);
	advance(10_000);
	act(() => {
		hidden = false;
		document.dispatchEvent(new Event("visibilitychange"));
	});
	advance(124);
	expect(hook.result.current.index).toBe(1);
	advance(1);
	expect(hook.result.current.index).toBe(2);
	act(() => {
		motion.matches = true;
		motion.dispatchEvent(new Event("change"));
	});
	expect(hook.result.current.playing).toBe(false);
	expect(vi.getTimerCount()).toBe(0);
	advance(10_000);
	expect(hook.result.current.index).toBe(2);
	act(() => {
		motion.matches = false;
		motion.dispatchEvent(new Event("change"));
	});
	advance(300);
	expect(hook.result.current.index).toBe(0);
});

it("never starts a clock under initial reduced motion and clears timers/listeners on unmount", () => {
	motion.matches = true;
	const removeDocument = vi.spyOn(document, "removeEventListener");
	const removeMotion = vi.spyOn(motion, "removeEventListener");
	const hook = renderHook(() => useCapriAnimation(loop, true));
	expect(vi.getTimerCount()).toBe(0);
	act(() => {
		motion.matches = false;
		motion.dispatchEvent(new Event("change"));
	});
	expect(vi.getTimerCount()).toBe(1);
	hook.unmount();
	expect(vi.getTimerCount()).toBe(0);
	expect(removeDocument).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
	expect(removeMotion).toHaveBeenCalledWith("change", expect.any(Function));
});

it("changes the rendered crop only inside the sprite after its image loads", () => {
	let parentRenders = 0;
	function Parent() {
		parentRenders++;
		return <CapriAnimatedSprite clip={loop} pose="idle" fallback={<span data-testid="still" />} />;
	}
	const fixture = render(<Parent />);
	expect(screen.getByTestId("still")).toBeInTheDocument();
	advance(5000);
	expect(vi.getTimerCount()).toBe(0);
	act(() => images[0]?.load());
	const sprite = () => fixture.container.querySelector(".capri-sprite");
	expect(sprite()).toHaveAttribute("data-frame", "0");
	expect(fixture.container.querySelector("svg")).toHaveAttribute("viewBox", "0 0 100 100");
	advance(100);
	expect(sprite()).toHaveAttribute("data-frame", "1");
	expect(fixture.container.querySelector("svg")).toHaveAttribute("viewBox", "100 0 100 100");
	advance(200);
	expect(sprite()).toHaveAttribute("data-frame", "2");
	expect(fixture.container.querySelector("svg")).toHaveAttribute("viewBox", "200 0 100 100");
	expect(parentRenders).toBe(1);
	expect(fixture.container.querySelectorAll("image")).toHaveLength(1);
});

it("reports a visual reaction only after its asset and two paint frames, never a loading fallback", () => {
	const presented = vi.fn();
	const fixture = render(
		<CapriAnimatedSprite clip={loop} pose="idle" fallback={<span />} onPresented={presented} />,
	);
	advance(1000);
	expect(presented).not.toHaveBeenCalled();
	act(() => images[0]?.load());
	expect(presented).not.toHaveBeenCalled();
	advance(40);
	expect(presented).toHaveBeenCalledExactlyOnceWith("idle");
	fixture.rerender(
		<CapriAnimatedSprite
			clip={{ ...loop, href: "/missing.png" }}
			pose="idle"
			fallback={<span />}
			onPresented={presented}
		/>,
	);
	act(() => images[1]?.fail());
	advance(500);
	expect(presented).toHaveBeenCalledTimes(1);
});

it("cancels a reaction receipt when its scene is removed before painting", () => {
	const presented = vi.fn();
	const fixture = render(
		<CapriAnimatedSprite clip={loop} pose="idle" fallback={<span />} onPresented={presented} />,
	);
	act(() => images[0]?.load());
	fixture.unmount();
	advance(100);
	expect(presented).not.toHaveBeenCalled();
});

it("falls back safely for a broken atlas and ignores a superseded image load", () => {
	const next = { ...loop, href: "/next-atlas.png" };
	const fixture = render(
		<CapriAnimatedSprite clip={loop} pose="idle" fallback={<span data-testid="still" />} />,
	);
	const stale = images[0]?.onload;
	fixture.rerender(<CapriAnimatedSprite clip={next} pose="idle" fallback={<span data-testid="still" />} />);
	act(() => stale?.());
	expect(screen.getByTestId("still")).toBeInTheDocument();
	act(() => images[1]?.fail());
	expect(screen.getByTestId("still")).toBeInTheDocument();
	expect(vi.getTimerCount()).toBe(0);
	fixture.rerender(<CapriAnimatedSprite clip={loop} pose="idle" fallback={<span data-testid="still" />} />);
	act(() => images[2]?.load());
	const image = fixture.container.querySelector("image");
	if (!image) throw new Error("Animation image did not load");
	fireEvent.error(image);
	expect(screen.getByTestId("still")).toBeInTheDocument();
	expect(vi.getTimerCount()).toBe(0);
	fixture.unmount();
	expect(images.every((image) => image.onload === null && image.onerror === null)).toBe(true);
});

it("keeps a registered character at the same scale while translating distinct atlas crops", () => {
	const registered: CapriAnimationClip = {
		...loop,
		canvas: { width: 120, height: 100 },
		frames: frames.map((frame, index) => ({ ...frame, width: 100 - index * 10, offsetX: index * 10 })),
	};
	const fixture = render(
		<CapriAnimatedSprite clip={registered} pose="idle" fallback={<span data-testid="still" />} />,
	);
	act(() => images[0]?.load());
	expect(fixture.container.querySelector("svg")).toHaveAttribute("viewBox", "0 0 120 100");
	expect(fixture.container.querySelector("g")).toHaveAttribute("transform", "translate(0 0)");
	advance(100);
	expect(fixture.container.querySelector("svg")).toHaveAttribute("viewBox", "0 0 120 100");
	expect(fixture.container.querySelector("g")).toHaveAttribute("transform", "translate(-90 0)");
	expect(fixture.container.querySelector("clipPath rect")).toHaveAttribute("width", "90");
	advance(200);
	expect(fixture.container.querySelector("g")).toHaveAttribute("transform", "translate(-180 0)");
	expect(fixture.container.querySelector("clipPath rect")).toHaveAttribute("width", "80");
});

it("keeps the launcher static and animates compact forms with their own drawn cycle", () => {
	const fixture = render(<CapriSprite pose="idle" />);
	expect(fixture.container.querySelector(".capri-sprite")).toHaveAttribute("data-animation", "static");
	expect(images).toHaveLength(0);
	fixture.rerender(<CapriSprite pose="eyes" animated walking />);
	expect(fixture.container.querySelector(".capri-sprite")).toHaveAttribute("data-animation", "static");
	expect(images).toHaveLength(1);
	act(() => images[0]?.load());
	expect(fixture.container.querySelector(".capri-sprite")).toHaveAttribute("data-animation", "eyes");
	const first = fixture.container.querySelector(".capri-sprite")?.getAttribute("data-frame");
	advance(1900);
	expect(fixture.container.querySelector(".capri-sprite")?.getAttribute("data-frame")).not.toBe(first);
});
