import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_DESKTOP_COMPANION, parseDesktopCompanion } from "../src/desktop-companion.ts";

describe("native transient context contract", () => {
	it("keeps bounded notification text and exact session binding separate from music", () => {
		const state = parseDesktopCompanion({
			...DEFAULT_DESKTOP_COMPANION,
			context: {
				musicPlaying: true,
				musicAvailable: true,
				notificationsAvailable: true,
				notificationService: "quickshell",
				notification: {
					id: "qs-1",
					kind: "notification",
					summary: "Notice",
					body: "x".repeat(800),
					expiresAt: 1234,
				},
				cue: {
					id: "q-1",
					kind: "question",
					summary: "Question",
					sessionId: "session-1",
					paneId: "w1:p2",
					expiresAt: 4567,
				},
			},
		});
		expect(state.context?.musicPlaying).toBe(true);
		expect(state.context?.notification?.body).toHaveLength(480);
		expect(state.context?.cue).toMatchObject({ sessionId: "session-1", paneId: "w1:p2" });
		expect(state.pinned).toBe(false);
	});
	it("ignores invalid transient cues without breaking existing desktop preferences", () => {
		const state = parseDesktopCompanion({
			...DEFAULT_DESKTOP_COMPANION,
			pinned: true,
			context: {
				musicPlaying: "yes",
				notification: { id: "n", kind: "unsafe", expiresAt: 1 },
				cue: { id: "q", kind: "question", expiresAt: Number.NaN },
			},
		});
		expect(state.context?.musicPlaying).toBe(false);
		expect(state.context?.cue).toBeUndefined();
		expect(state.context?.notification).toBeUndefined();
		expect(state.pinned).toBe(true);
	});
});

// An unavailable native command otherwise silently sends every visual event to the OS fallback.
describe("native notification receipt capability", () => {
	it("allows only the traveler and speech surface to confirm presentation", () => {
		const config = JSON.parse(
			readFileSync(
				join(
					dirname(fileURLToPath(import.meta.url)),
					"../../../apps/desktop/src-tauri/capabilities/default.json",
				),
				"utf8",
			),
		);
		const allowed = new Set<string>();
		for (const capability of config.capabilities) {
			if (capability.permissions.includes("allow-desktop-companion-context-ready")) {
				for (const window of capability.windows) allowed.add(window);
			}
		}
		expect([...allowed].sort()).toEqual(["companion-bubble", "dot"]);
	});
});
