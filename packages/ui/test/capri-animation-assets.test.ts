import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import {
	CAPRI_ACTIONS,
	CAPRI_ANIMATIONS,
	CAPRI_PERCH_ANCHOR,
	capriAnimation,
} from "../src/capri-animation.ts";
import { CONTEXT_POSES, capriFrame } from "../src/capri-art.ts";

const directory = join(dirname(fileURLToPath(import.meta.url)), "../src/assets/capri");
const sheets = [
	["capri-motion-core-v1", ["idle", "walk", "greeting", "working"]],
	["capri-motion-reactions-v1", ["coffee", "chill", "crying", "angry"]],
	["capri-motion-friends-v1", ["duo-watch", "duo-coffee", "duo-couch", "duo-high-five"]],
	["capri-motion-life-v1", ["snack", "stretch", "curious", "attentive"]],
	["capri-motion-glimpses-v1", ["eyes", "face", "point-left", "point-right"]],
	["capri-motion-context-v1", ["headphones", "dancing", "capture", "follow-message"]],
	["capri-motion-actions-v1", ["file-away", "perch", "step-aside"]],
] as const;

it("ships twenty-seven complete six-frame actions connected to real transparent PNG atlases", () => {
	expect(Object.keys(CAPRI_ANIMATIONS).sort()).toEqual([...CAPRI_ACTIONS].sort());
	for (const [name, actions] of sheets) {
		const manifest = JSON.parse(readFileSync(join(directory, `${name}.json`), "utf8"));
		const png = readFileSync(join(directory, `${name}.png`));
		expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
		expect(png.toString("ascii", 12, 16)).toBe("IHDR");
		expect(png.readUInt32BE(16)).toBe(manifest.width);
		expect(png.readUInt32BE(20)).toBe(manifest.height);
		expect(png[25]).toBe(6); // RGBA; no CSS background or flattened opaque replacement.
		expect(manifest.image).toBe(`${name}.png`);
		expect(Object.keys(manifest.animations).sort()).toEqual([...actions].sort());
		for (const action of actions) {
			const clip = CAPRI_ANIMATIONS[action];
			if (!clip) throw new Error(`Missing animation: ${action}`);
			expect(new URL(clip.href).pathname).toContain(`/${manifest.image}`);
			expect(clip.frames).toHaveLength(6);
			expect(new Set(clip.frames.map((frame) => `${frame.x}:${frame.y}`)).size).toBe(6);
			// Registered crops share a canvas; unregistered crops must have the same size.
			if (clip.canvas) {
				for (const frame of clip.frames) {
					expect((frame.offsetX ?? 0) + frame.width).toBeLessThanOrEqual(clip.canvas.width);
					expect((frame.offsetY ?? 0) + frame.height).toBeLessThanOrEqual(clip.canvas.height);
				}
			} else expect(new Set(clip.frames.map((frame) => `${frame.width}:${frame.height}`)).size).toBe(1);
			expect(clip.width).toBe(manifest.width);
			expect(clip.height).toBe(manifest.height);
		}
	}
});

it("keeps every autonomous solo pose on a continuing drawn cycle", () => {
	for (const pose of [
		"snack",
		"stretch",
		"confused",
		"alert",
		"eyes",
		"face",
		"point-left",
		"point-right",
		"greeting",
		"angry",
		"duo-high-five",
		...CONTEXT_POSES,
	] as const) {
		if (pose === "file-away" || pose === "step-aside") continue;
		const clip = capriAnimation(pose);
		expect(clip, pose).toBeDefined();
		expect(clip?.playback, pose).toBe("loop");
		expect(clip?.frames.length, pose).toBeGreaterThan(1);
	}
});

it("files once and steps aside once while keeping the seated gesture alive", () => {
	for (const pose of ["file-away", "step-aside"] as const) {
		const clip = capriAnimation(pose);
		expect(clip?.playback).toBe("once");
		expect(clip?.holdFrame).toBe(5);
		expect(capriAnimation(pose, true)?.action).toBe(pose);
	}
	expect(capriAnimation("perch")?.playback).toBe("loop");
	const clip = CAPRI_ANIMATIONS.perch;
	expect(CAPRI_PERCH_ANCHOR.canvas).toEqual(clip?.canvas);
	expect(CAPRI_PERCH_ANCHOR.x).toBeGreaterThan(0.45);
	expect(CAPRI_PERCH_ANCHOR.x).toBeLessThan(0.6);
	expect(CAPRI_PERCH_ANCHOR.y).toBeGreaterThan(0.65);
	expect(CAPRI_PERCH_ANCHOR.y).toBeLessThan(0.8);
});

it("uses matching contextual artwork while its animation is loading or disabled", () => {
	for (const pose of CONTEXT_POSES) {
		const clip = capriAnimation(pose);
		const still = capriFrame(pose);
		expect(clip?.action).toBe(pose);
		expect(still.href).toBe(clip?.href);
		expect(still.frame.clip?.length).toBeGreaterThanOrEqual(3);
		expect(
			clip?.frames.some(
				(frame) =>
					frame.x === still.frame.x &&
					frame.y === still.frame.y &&
					frame.width === still.frame.width &&
					frame.height === still.frame.height,
			),
		).toBe(true);
	}
});
