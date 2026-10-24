import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";

export const CHAT_APPEARANCE_KEY = "gentle-dot-chat-appearance-v1";
export interface ChatAppearanceSettings {
	version: 1;
	theme: "dark" | "light" | "system";
	accent: "gentle" | "blue" | "green" | "amber";
	fontSize: 14 | 16 | 18 | 20;
	density: "comfortable" | "compact";
	layout: "bubbles" | "reading";
	background: "plain" | "rose" | "dots";
}
export const DEFAULT_CHAT_APPEARANCE: Readonly<ChatAppearanceSettings> = {
	version: 1,
	theme: "dark",
	accent: "gentle",
	fontSize: 16,
	density: "comfortable",
	layout: "bubbles",
	background: "plain",
};

/** Persisted values are untrusted: only known options can become CSS tokens. */
export function parseChatAppearance(value: unknown): ChatAppearanceSettings {
	const defaults = { ...DEFAULT_CHAT_APPEARANCE };
	if (!value || typeof value !== "object" || Array.isArray(value)) return defaults;
	const item = value as Record<string, unknown>;
	if (item.version !== 1) return defaults;
	return {
		version: 1,
		theme: item.theme === "light" || item.theme === "system" ? item.theme : "dark",
		accent:
			item.accent === "blue" || item.accent === "green" || item.accent === "amber" ? item.accent : "gentle",
		fontSize: item.fontSize === 14 || item.fontSize === 18 || item.fontSize === 20 ? item.fontSize : 16,
		density: item.density === "compact" ? "compact" : "comfortable",
		layout: item.layout === "reading" ? "reading" : "bubbles",
		background: item.background === "rose" || item.background === "dots" ? item.background : "plain",
	};
}

function loadAppearance(): ChatAppearanceSettings {
	try {
		return parseChatAppearance(JSON.parse(window.localStorage.getItem(CHAT_APPEARANCE_KEY) ?? "null"));
	} catch {
		return { ...DEFAULT_CHAT_APPEARANCE };
	}
}

const ACCENTS = {
	gentle: { dark: "#ff91b9", light: "#aa1b55", action: "#ff2d7a", soft: "255,45,122" },
	blue: { dark: "#8abfff", light: "#145bb7", action: "#8abfff", soft: "74,144,226" },
	green: { dark: "#7ddeaf", light: "#08734c", action: "#7ddeaf", soft: "24,158,108" },
	amber: { dark: "#f4c776", light: "#885200", action: "#f4c776", soft: "195,132,26" },
} as const;

type AppearanceStyle = CSSProperties & Record<`--${string}`, string>;
export function chatAppearanceStyle(settings: ChatAppearanceSettings, dark: boolean): AppearanceStyle {
	const accent = ACCENTS[settings.accent];
	return {
		colorScheme: dark ? "dark" : "light",
		"--bg": dark ? "#101114" : "#faf8fa",
		"--bg-glass": dark ? "#101114" : "#faf8fa",
		"--surface": dark ? "#191b22" : "#ffffff",
		"--surface-2": dark ? "#23252e" : "#f0edf1",
		"--line": dark ? "#353742" : "#cdc6cf",
		"--text": dark ? "#f7f5f7" : "#211d23",
		"--muted": dark ? "#b2adb9" : "#625b67",
		"--accent": dark ? accent.dark : accent.light,
		"--accent-ink": dark ? "#27121c" : "#ffffff",
		"--accent-soft": `rgba(${accent.soft},${dark ? "0.12" : "0.08"})`,
		"--accent-line": dark ? accent.dark : accent.light,
		"--accent-shadow": "none",
		"--chat-action": dark ? accent.action : accent.light,
		"--chat-action-ink": dark ? "#27121c" : "#ffffff",
		"--chat-error": dark ? "#ffc1cf" : "#a91839",
		"--chat-error-soft": dark ? "#391e25" : "#ffe9ee",
		"--chat-success": dark ? "#b4e7c7" : "#136c3e",
		"--red": dark ? "#ffc1cf" : "#a91839",
		"--green": dark ? "#b4e7c7" : "#136c3e",
		"--yellow": dark ? "#e0c27a" : "#775000",
		"--mobile-bg": "var(--bg)",
		"--mobile-card": "var(--surface)",
		"--mobile-text": "var(--text)",
		"--mobile-muted": "var(--muted)",
		"--mobile-accent": "var(--accent)",
		"--mobile-error": "var(--chat-error)",
		"--mobile-border": dark ? "#737681" : "#8a818e",
		"--chat-font-size": `${settings.fontSize}px`,
		"--chat-line-height": "1.6",
		"--chat-message-gap": settings.density === "compact" ? "14px" : "24px",
		"--chat-bubble-padding": settings.density === "compact" ? "8px 12px" : "12px 16px",
		"--chat-gutter": settings.density === "compact" ? "12px" : "16px",
		"--chat-rose-wash": dark ? "rgba(255,45,122,0.035)" : "rgba(255,45,122,0.025)",
		"--chat-dot": dark ? "rgba(247,245,247,0.05)" : "rgba(33,29,35,0.065)",
	};
}

export function useChatAppearance(enabled: boolean) {
	const [settings, setSettings] = useState<ChatAppearanceSettings>(() =>
		enabled ? loadAppearance() : { ...DEFAULT_CHAT_APPEARANCE },
	);
	const [systemDark, setSystemDark] = useState(() =>
		enabled && typeof window.matchMedia === "function"
			? window.matchMedia("(prefers-color-scheme: dark)").matches
			: true,
	);
	const [storageFailed, setStorageFailed] = useState(false);
	const wasEnabled = useRef(enabled);
	useEffect(() => {
		if (enabled && !wasEnabled.current) setSettings(loadAppearance());
		wasEnabled.current = enabled;
		if (!enabled || typeof window.matchMedia !== "function") return;
		const media = window.matchMedia("(prefers-color-scheme: dark)");
		const update = () => setSystemDark(media.matches);
		update();
		media.addEventListener("change", update);
		return () => media.removeEventListener("change", update);
	}, [enabled]);
	const change = useCallback(
		(next: ChatAppearanceSettings) => {
			if (!enabled) return;
			const clean = parseChatAppearance(next);
			setSettings(clean);
			try {
				window.localStorage.setItem(CHAT_APPEARANCE_KEY, JSON.stringify(clean));
				setStorageFailed(false);
			} catch {
				setStorageFailed(true);
			}
		},
		[enabled],
	);
	const reset = () => change({ ...DEFAULT_CHAT_APPEARANCE });
	const dark = settings.theme === "dark" || (settings.theme === "system" && systemDark);
	const style = useMemo(() => chatAppearanceStyle(settings, dark), [settings, dark]);
	return {
		settings,
		change,
		reset,
		style,
		resolvedTheme: dark ? ("dark" as const) : ("light" as const),
		storageFailed,
	};
}
export type ChatAppearanceControls = ReturnType<typeof useChatAppearance>;
