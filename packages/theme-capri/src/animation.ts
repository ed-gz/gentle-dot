import type { CapriPose } from "./art.ts";
import actions from "./assets/capri-motion-actions-v1.json" with { type: "json" };
import context from "./assets/capri-motion-context-v1.json" with { type: "json" };
import core from "./assets/capri-motion-core-v1.json" with { type: "json" };
import friends from "./assets/capri-motion-friends-v1.json" with { type: "json" };
import glimpses from "./assets/capri-motion-glimpses-v1.json" with { type: "json" };
import life from "./assets/capri-motion-life-v1.json" with { type: "json" };
import reactions from "./assets/capri-motion-reactions-v1.json" with { type: "json" };

export const CAPRI_ACTIONS = [
	"idle",
	"walk",
	"greeting",
	"working",
	"coffee",
	"chill",
	"crying",
	"angry",
	"duo-watch",
	"duo-coffee",
	"duo-couch",
	"duo-high-five",
	"snack",
	"stretch",
	"curious",
	"attentive",
	"eyes",
	"face",
	"point-left",
	"point-right",
	"headphones",
	"dancing",
	"capture",
	"follow-message",
	"file-away",
	"perch",
	"step-aside",
] as const;
export type CapriAction = (typeof CAPRI_ACTIONS)[number];
/** Anchor within the registered animation canvas; include SVG letterboxing when positioning. */
export const CAPRI_PERCH_ANCHOR = {
	...actions.animations.perch.seatAnchor,
	canvas: actions.animations.perch.canvas,
} as const;
export interface CapriAnimationFrame {
	x: number;
	y: number;
	width: number;
	height: number;
	durationMs: number;
	offsetX?: number;
	offsetY?: number;
	clip?: readonly (readonly [number, number])[];
}
export interface CapriAnimationClip {
	action: CapriAction;
	href: string;
	width: number;
	height: number;
	frames: readonly CapriAnimationFrame[];
	canvas?: { width: number; height: number };
	playback: "loop" | "once";
	holdFrame?: number;
}
const record = (value: unknown): Record<string, unknown> | undefined =>
	value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
const positive = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value) && value > 0;
const nonnegative = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value) && value >= 0;

/** Invalid or unfinished art stays static rather than starting a broken/zero-duration timer. */
export function readAnimationSheet(
	value: unknown,
	href: string,
): Partial<Record<CapriAction, CapriAnimationClip>> {
	const sheet = record(value);
	if (!sheet || !positive(sheet.width) || !positive(sheet.height)) return {};
	const animations = record(sheet.animations);
	if (!animations) return {};
	const result: Partial<Record<CapriAction, CapriAnimationClip>> = {};
	for (const action of CAPRI_ACTIONS) {
		const candidate = record(animations[action]);
		if (
			!candidate ||
			!["loop", "once"].includes(String(candidate.playback)) ||
			!Array.isArray(candidate.frames) ||
			candidate.frames.length < 2 ||
			candidate.frames.length > 240
		)
			continue;
		const sourceCanvas = record(candidate.canvas);
		if (
			candidate.canvas !== undefined &&
			(!sourceCanvas || !positive(sourceCanvas.width) || !positive(sourceCanvas.height))
		)
			continue;
		const canvas = sourceCanvas
			? { width: sourceCanvas.width as number, height: sourceCanvas.height as number }
			: undefined;
		const frames: CapriAnimationFrame[] = [];
		for (const value of candidate.frames) {
			const frame = record(value);
			if (
				!frame ||
				!nonnegative(frame.x) ||
				!nonnegative(frame.y) ||
				!positive(frame.width) ||
				!positive(frame.height) ||
				frame.x + frame.width > sheet.width ||
				frame.y + frame.height > sheet.height ||
				!positive(frame.durationMs) ||
				frame.durationMs < 16 ||
				frame.durationMs > 60_000
			)
				break;
			const offsetX = frame.offsetX ?? 0;
			const offsetY = frame.offsetY ?? 0;
			if (
				!nonnegative(offsetX) ||
				!nonnegative(offsetY) ||
				(canvas
					? offsetX + frame.width > canvas.width || offsetY + frame.height > canvas.height
					: frame.offsetX !== undefined || frame.offsetY !== undefined)
			)
				break;
			const clip = frame.clip;
			if (
				clip !== undefined &&
				(!Array.isArray(clip) ||
					clip.length < 3 ||
					!clip.every(
						(point) =>
							Array.isArray(point) &&
							point.length === 2 &&
							nonnegative(point[0]) &&
							nonnegative(point[1]) &&
							point[0] <= (sheet.width as number) &&
							point[1] <= (sheet.height as number),
					))
			)
				break;
			frames.push({
				x: frame.x,
				y: frame.y,
				width: frame.width,
				height: frame.height,
				durationMs: frame.durationMs,
				...(canvas ? { offsetX, offsetY } : {}),
				...(clip ? { clip: clip as [number, number][] } : {}),
			});
		}
		if (
			frames.length !== candidate.frames.length ||
			new Set(frames.map((frame) => `${frame.x}:${frame.y}`)).size < 2
		)
			continue;
		const holdFrame = candidate.holdFrame;
		if (
			holdFrame !== undefined &&
			(typeof holdFrame !== "number" ||
				!Number.isSafeInteger(holdFrame) ||
				holdFrame < 0 ||
				holdFrame >= frames.length)
		)
			continue;
		result[action] = {
			action,
			href,
			width: sheet.width,
			height: sheet.height,
			frames,
			...(canvas ? { canvas } : {}),
			playback: candidate.playback as "loop" | "once",
			...(typeof holdFrame === "number" ? { holdFrame } : {}),
		};
	}
	return result;
}

export const CAPRI_ANIMATIONS: Partial<Record<CapriAction, CapriAnimationClip>> = {
	...readAnimationSheet(actions, new URL("./assets/capri-motion-actions-v1.png", import.meta.url).href),
	...readAnimationSheet(context, new URL("./assets/capri-motion-context-v1.png", import.meta.url).href),
	...readAnimationSheet(life, new URL("./assets/capri-motion-life-v1.png", import.meta.url).href),
	...readAnimationSheet(glimpses, new URL("./assets/capri-motion-glimpses-v1.png", import.meta.url).href),
	...readAnimationSheet(core, new URL("./assets/capri-motion-core-v1.png", import.meta.url).href),
	...readAnimationSheet(reactions, new URL("./assets/capri-motion-reactions-v1.png", import.meta.url).href),
	...readAnimationSheet(friends, new URL("./assets/capri-motion-friends-v1.png", import.meta.url).href),
};

const ACTION_FOR_POSE: Partial<Record<CapriPose, CapriAction>> = {
	"file-away": "file-away",
	perch: "perch",
	"step-aside": "step-aside",
	headphones: "headphones",
	dancing: "dancing",
	capture: "capture",
	"follow-message": "follow-message",
	idle: "idle",
	greeting: "greeting",
	success: "greeting",
	victory: "greeting",
	typing: "working",
	working: "working",
	hacker: "working",
	thinking: "curious",
	confused: "curious",
	alert: "attentive",
	snack: "snack",
	eyes: "eyes",
	"eyes-blink": "eyes",
	face: "face",
	"face-talk": "face",
	"point-left": "point-left",
	"point-right": "point-right",
	reading: "working",
	coffee: "coffee",
	"sleepy-coffee": "coffee",
	chill: "chill",
	lounging: "chill",
	sleep: "chill",
	stretch: "stretch",
	peek: "curious",
	crying: "crying",
	angry: "angry",
	stressed: "angry",
	"invite-rebecca": "duo-watch",
	"duo-watch": "duo-watch",
	"duo-debug": "duo-watch",
	"duo-coffee": "duo-coffee",
	"duo-couch": "duo-couch",
	"duo-sleep": "duo-couch",
	"duo-laugh": "duo-high-five",
	"duo-high-five": "duo-high-five",
};

export function capriAction(pose: CapriPose, walking = false): CapriAction | undefined {
	if (pose.startsWith("rebecca-")) return undefined;
	const compact = pose.startsWith("eyes") || pose.startsWith("face") || pose.startsWith("point-");
	const eventGesture = pose === "file-away" || pose === "step-aside";
	return walking && !compact && !eventGesture ? "walk" : ACTION_FOR_POSE[pose];
}

// A companion remains alive between scene decisions; event gestures repeat after a calm hold.
// Filing and giving space finish once; repeating them would falsely suggest another action.
const liveClips: Partial<Record<CapriAction, CapriAnimationClip>> = Object.fromEntries(
	Object.entries(CAPRI_ANIMATIONS).map(([action, clip]) => [
		action,
		clip.playback === "loop" || action === "file-away" || action === "step-aside"
			? clip
			: {
					...clip,
					playback: "loop",
					frames: clip.frames.map((frame, index) =>
						index === clip.frames.length - 1
							? { ...frame, durationMs: Math.max(1600, frame.durationMs) }
							: frame,
					),
				},
	]),
);
export function capriAnimation(pose: CapriPose, walking = false): CapriAnimationClip | undefined {
	const action = capriAction(pose, walking);
	return action ? liveClips[action] : undefined;
}

export function nextAnimationFrame(
	clip: CapriAnimationClip,
	index: number,
): { index: number; complete: boolean } {
	if (index + 1 < clip.frames.length) return { index: index + 1, complete: false };
	return clip.playback === "loop"
		? { index: 0, complete: false }
		: { index: clip.holdFrame ?? clip.frames.length - 1, complete: true };
}
