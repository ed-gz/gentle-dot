import { useMemo, useSyncExternalStore } from "react";

export type BadgeWindow = "5h" | "weekly";
export type BadgeProvider = "codex" | "claude";
export interface UsageBadgePreferences {
	version: 1;
	visible: boolean;
	providers: Record<BadgeProvider, { visible: boolean; fiveHour: boolean; weekly: boolean; priority: BadgeWindow }>;
}
export const USAGE_BADGE_KEY = "gentle-dot-usage-badges-v1";
const EVENT = "gentle-dot-usage-badges";
export const defaultUsageBadges = (): UsageBadgePreferences => ({
	version: 1,
	visible: true,
	providers: {
		codex: { visible: true, fiveHour: true, weekly: true, priority: "5h" },
		claude: { visible: true, fiveHour: true, weekly: true, priority: "5h" },
	},
});

/** Preferences never contain account identifiers or quota readings. Reject malformed versions as a unit. */
export function parseUsageBadgePreferences(raw: string | null): UsageBadgePreferences {
	try {
		const value = JSON.parse(raw ?? "null");
		if (value?.version !== 1 || typeof value.visible !== "boolean") return defaultUsageBadges();
		for (const id of ["codex", "claude"] as const) {
			const provider = value.providers?.[id];
			if (!provider || ["visible", "fiveHour", "weekly"].some((key) => typeof provider[key] !== "boolean") ||
				!["5h", "weekly"].includes(provider.priority)) return defaultUsageBadges();
		}
		return {
			version: 1, visible: value.visible,
			providers: Object.fromEntries((["codex", "claude"] as const).map((id) => {
				const { visible, fiveHour, weekly, priority } = value.providers[id];
				return [id, { visible, fiveHour, weekly, priority }];
			})) as UsageBadgePreferences["providers"],
		};
	} catch { return defaultUsageBadges(); }
}
let fallback: string | undefined;
function read() {
	try { return fallback ?? localStorage.getItem(USAGE_BADGE_KEY); }
	catch { return fallback ?? null; }
}
function subscribe(listener: () => void) {
	window.addEventListener("storage", listener);
	window.addEventListener(EVENT, listener);
	return () => {
		window.removeEventListener("storage", listener);
		window.removeEventListener(EVENT, listener);
	};
}
export function useUsageBadges() {
	const raw = useSyncExternalStore(subscribe, read, () => null);
	const preferences = useMemo(() => parseUsageBadgePreferences(raw), [raw]);
	return [preferences, (next: UsageBadgePreferences) => {
		const serialized = JSON.stringify(next);
		try { localStorage.setItem(USAGE_BADGE_KEY, serialized); fallback = undefined; }
		catch { fallback = serialized; }
		window.dispatchEvent(new Event(EVENT));
	}] as const;
}
