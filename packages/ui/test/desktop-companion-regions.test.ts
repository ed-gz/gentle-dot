import { describe, expect, it } from "vitest";
import { DEFAULT_DESKTOP_COMPANION, parseDesktopCompanion } from "../src/desktop-companion.ts";

const full = { x: 0, y: 0, width: 1, height: 1 };
const screen = { name: "eDP-1", x: -1920, y: 32, width: 1920, height: 1048 };
describe("native desktop region contract", () => {
	it("migrates older native state without sharing mobile preferences", () => {
		const { pinned: _pin, areas: _areas, monitors: _monitors, ...old } = DEFAULT_DESKTOP_COMPANION;
		expect(parseDesktopCompanion(old)).toEqual(DEFAULT_DESKTOP_COMPANION);
	});
	it("preserves fixed position independently from gesture and interaction flags", () => {
		const state = parseDesktopCompanion({
			...DEFAULT_DESKTOP_COMPANION,
			pinned: true,
			motion: true,
			paused: false,
			areas: [
				{ monitor: "eDP-1", enabled: true, rect: full },
				{ monitor: "DP-1", enabled: false, rect: full },
			],
			monitors: [screen],
		});
		expect(state).toMatchObject({ pinned: true, motion: true, paused: false, monitors: [screen] });
		expect(state.areas[1]).toMatchObject({ monitor: "DP-1", enabled: false });
	});
	it("accepts no allowed monitors without inventing a fallback", () => {
		const state = parseDesktopCompanion({
			...DEFAULT_DESKTOP_COMPANION,
			areas: [{ monitor: "eDP-1", enabled: false, rect: full }],
			monitors: [screen],
		});
		expect(state.areas.every((area) => !area.enabled)).toBe(true);
	});
	it("rejects duplicate, malformed and nonfinite native geometry", () => {
		const area = { monitor: "DP-1", enabled: true, rect: full };
		for (const areas of [
			[area, area],
			[{ ...area, rect: { ...full, width: 0 } }],
			[{ ...area, rect: { ...full, x: Number.NaN } }],
			[{ ...area, rect: { ...full, x: 0.5 } }],
			[{ ...area, monitor: "" }],
		]) {
			expect(() => parseDesktopCompanion({ ...DEFAULT_DESKTOP_COMPANION, areas })).toThrow();
		}
		for (const monitors of [
			[screen, screen],
			[{ ...screen, height: -1 }],
			[{ ...screen, x: Number.POSITIVE_INFINITY }],
		]) {
			expect(() => parseDesktopCompanion({ ...DEFAULT_DESKTOP_COMPANION, monitors })).toThrow();
		}
		expect(() => parseDesktopCompanion({ ...DEFAULT_DESKTOP_COMPANION, pinned: "yes" })).toThrow();
	});
});
