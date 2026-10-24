import { describe, expect, it } from "vitest";
import { DEFAULT_NOTIFICATION_PREFERENCES } from "../../../packages/ui/src/mobile.ts";
import { defaultNotificationPreferences, normalizeNotificationPreferences } from "../src/notifications.ts";

describe("phone notification preferences", () => {
	it("shares the foreground defaults and keeps status chatter and lock-screen previews quiet", () => {
		expect(defaultNotificationPreferences).toEqual(DEFAULT_NOTIFICATION_PREFERENCES);
		expect(normalizeNotificationPreferences(undefined)).toMatchObject({
			agentAvailable: false,
			preview: false,
			sound: false,
			permissions: true,
			inApp: true,
		});
	});
	it("migrates source choices without reenabling a previously silenced source", () => {
		expect(normalizeNotificationPreferences(undefined, "dot")).toMatchObject({
			dotReplies: true,
			dotErrors: true,
			agentCompleted: false,
			agentErrors: false,
			agentAttention: false,
			permissions: true,
		});
		expect(normalizeNotificationPreferences(undefined, "agents")).toMatchObject({
			dotReplies: false,
			dotErrors: false,
			agentCompleted: true,
			agentErrors: true,
			agentAttention: true,
		});
	});
	it("preserves granular choices independently of old presets", () => {
		expect(
			normalizeNotificationPreferences(
				{ dotReplies: false, permissions: false, agentAvailable: true, inApp: false, sound: true },
				"all",
			),
		).toMatchObject({
			dotReplies: false,
			permissions: false,
			agentAvailable: true,
			inApp: false,
			sound: true,
			agentCompleted: true,
		});
	});
	it("rejects malformed and inherited values rather than enabling alerts", () => {
		const value = Object.assign(Object.create({ agentAvailable: true }), {
			permissions: "false",
			sound: 1,
			arbitrary: true,
		});
		expect(normalizeNotificationPreferences(value)).toEqual(defaultNotificationPreferences);
		expect(normalizeNotificationPreferences(null)).toEqual(defaultNotificationPreferences);
	});
});
