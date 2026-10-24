import type { NotificationPreferences } from "../../../packages/ui/src/mobile.ts";

export type NotificationMode = "dot" | "agents" | "all";

/** Keep these defaults aligned with Android NotificationPreferences. */
export const defaultNotificationPreferences: NotificationPreferences = {
	dotReplies: true,
	dotErrors: true,
	agentCompleted: true,
	agentAttention: true,
	agentErrors: true,
	agentAvailable: false,
	permissions: true,
	inApp: true,
	preview: false,
	sound: false,
	vibration: true,
};

export function normalizeNotificationPreferences(
	value: unknown,
	mode: NotificationMode = "all",
): NotificationPreferences {
	const preferences = {
		...defaultNotificationPreferences,
		dotReplies: mode !== "agents",
		dotErrors: mode !== "agents",
		agentCompleted: mode !== "dot",
		agentAttention: mode !== "dot",
		agentErrors: mode !== "dot",
	};
	if (typeof value !== "object" || value === null) return preferences;
	for (const key of Object.keys(preferences) as Array<keyof NotificationPreferences>) {
		if (Object.hasOwn(value, key) && typeof (value as Record<string, unknown>)[key] === "boolean") {
			preferences[key] = (value as Record<string, boolean>)[key] as boolean;
		}
	}
	return preferences;
}
