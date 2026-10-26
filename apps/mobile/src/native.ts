import {
	Capacitor,
	type PluginListenerHandle,
	registerPlugin,
	SystemBars,
	SystemBarsStyle,
} from "@capacitor/core";
import type {
	MobileNotification,
	NotificationPreferences,
	ReceiveFileOptions,
	ReceiveFileResult,
} from "../../../packages/ui/src/mobile.ts";
import { isNotificationEvent } from "../../../packages/ui/src/mobile.ts";
import { foregroundNotification } from "../../../packages/ui/src/notifications.ts";
import { readMobileDraft, saveMobileDraft } from "./drafts.ts";
import { type NotificationMode, normalizeNotificationPreferences } from "./notifications.ts";

export type { NotificationMode } from "./notifications.ts";

export interface NativeCompanionState {
	supported: boolean;
	permission: boolean;
	enabled: boolean;
	active: boolean;
	pinned: boolean;
	theme: "gentle-dot" | "capri";
	appliedTheme?: "gentle-dot" | "capri";
	renderReady?: boolean;
	renderError?: string;
	motionPausedReason?: "battery" | "system";
	partialChat: boolean;
}
interface NativePlugin {
	setAppIcon(options: { theme: "gentle-dot" | "capri" }): Promise<void>;
	companionState(): Promise<NativeCompanionState>;
	setCompanion(options: {
		enabled?: boolean;
		pinned?: boolean;
		theme?: "gentle-dot" | "capri";
	}): Promise<void>;
	requestCompanionPermission(): Promise<void>;
	openCompanionAppSettings(): Promise<void>;
	closeCompanionChat(): Promise<void>;
	companionLaunchContext(): Promise<{
		openChat?: boolean;
		eventId?: string;
		title?: string;
		body?: string;
		paneId?: string;
		sessionId?: string;
		conversationId?: string;
	}>;

	addListener(
		eventName: "foregroundNotification",
		listener: (event: MobileNotification) => void,
	): Promise<PluginListenerHandle>;
	transcribe(options: { language: string }): Promise<{ text: string }>;
	notify(options: {
		id: string;
		title: string;
		body: string;
		source?: "dot" | "agents" | "permission";
		event?:
			| "dotReply"
			| "dotError"
			| "agentCompleted"
			| "agentAttention"
			| "agentError"
			| "agentAvailable"
			| "permission";
	}): Promise<void>;
	startMonitor(options: { url: string; token: string; mode?: NotificationMode }): Promise<void>;
	stopMonitor(): Promise<void>;
	monitorState(): Promise<{
		/** Single display state; disconnected includes a rejected or pending service start. */
		status: "on" | "needs_permission" | "not_paired" | "disconnected";
		active: boolean;
		connected?: boolean;
		notificationsEnabled?: boolean;
		mode: NotificationMode;
		preferences: NotificationPreferences;
	}>;
	setNotificationPreferences(options: {
		preferences: NotificationPreferences;
	}): Promise<{ preferences: NotificationPreferences }>;
	openNotificationSettings(): Promise<void>;
	setNotificationMode(options: { mode: NotificationMode }): Promise<void>;
	receiveFile(options: ReceiveFileOptions): Promise<ReceiveFileResult>;
	cancelReceiveFile(): Promise<void>;
}
export const GentleMobile = registerPlugin<NativePlugin>("GentleMobile");
export const nativeAndroid = Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";
/** Background notices are on by default for a paired phone; only an explicit switch-off keeps them off. */
export const MONITOR_OPT_OUT = "gentledot-monitor-opt-out";
export async function ensureMonitor(connection: { url: string; token: string }): Promise<boolean> {
	if (!nativeAndroid || localStorage.getItem(MONITOR_OPT_OUT) === "1") return false;
	const state = await GentleMobile.monitorState();
	if (state.status !== "not_paired" && state.status !== "disconnected") return false;
	await GentleMobile.startMonitor({ url: connection.url, token: connection.token });
	return true;
}
const preferenceListeners = new Set<(preferences: NotificationPreferences) => void>();
export async function readNotificationPreferences(): Promise<NotificationPreferences> {
	if (!nativeAndroid) return normalizeNotificationPreferences(undefined);
	const state = await GentleMobile.monitorState();
	return normalizeNotificationPreferences(state.preferences, state.mode);
}
export async function saveNotificationPreferences(
	preferences: NotificationPreferences,
): Promise<NotificationPreferences> {
	const result = await GentleMobile.setNotificationPreferences({ preferences });
	const saved = normalizeNotificationPreferences(result.preferences);
	for (const listener of preferenceListeners) {
		try {
			listener(saved);
		} catch {
			/* Delivery listeners cannot turn a saved setting into a failed write. */
		}
	}
	return saved;
}
let themeObserver: MutationObserver | undefined;

function syncSystemBars(): void {
	let previous = "";
	const update = () => {
		const theme =
			document.querySelector(".chat-mobile[data-chat-theme]")?.getAttribute("data-chat-theme") ?? "dark";
		if (theme === previous) return;
		previous = theme;
		void SystemBars.setStyle({
			style: theme === "light" ? SystemBarsStyle.Light : SystemBarsStyle.Dark,
		}).catch(() => {});
	};
	themeObserver?.disconnect();
	themeObserver = new MutationObserver(update);
	themeObserver.observe(document.documentElement, {
		childList: true,
		subtree: true,
		attributes: true,
		attributeFilter: ["data-chat-theme"],
	});
	update();
}

export function setupNative(): void {
	if (!nativeAndroid) return;
	syncSystemBars();
	void GentleMobile.addListener("foregroundNotification", (event) => {
		if (
			!event ||
			typeof event.id !== "string" ||
			typeof event.title !== "string" ||
			typeof event.body !== "string" ||
			!isNotificationEvent(event.event)
		)
			return;
		if (
			event.session !== undefined &&
			(typeof event.session?.paneId !== "string" ||
				(event.session.sessionId !== undefined && typeof event.session.sessionId !== "string"))
		)
			return;
		// Copy only the public notice contract, never opaque native payload/credential fields.
		const detail: MobileNotification = {
			id: event.id,
			title: event.title,
			body: event.body,
			event: event.event,
			...(event.session
				? {
						session: {
							paneId: event.session.paneId,
							...(event.session.sessionId !== undefined ? { sessionId: event.session.sessionId } : {}),
						},
					}
				: {}),
		};
		window.dispatchEvent(new CustomEvent("gentledot-notification", { detail: foregroundNotification(detail) }));
	}).catch(() => {});
	window.__GENTLE_MOBILE__ = {
		readDraft: readMobileDraft,
		saveDraft: saveMobileDraft,
		notificationPreferences: readNotificationPreferences,
		subscribeNotificationPreferences: (listener) => {
			preferenceListeners.add(listener);
			return () => {
				preferenceListeners.delete(listener);
			};
		},
		transcribe: (options) => GentleMobile.transcribe(options),
		receiveFile: (options) => GentleMobile.receiveFile(options),
		cancelReceiveFile: () => GentleMobile.cancelReceiveFile(),
		notify: async (options) => {
			// The background monitor owns deduplication when enabled.
			if (!(await GentleMobile.monitorState()).active) await GentleMobile.notify(foregroundNotification(options));
		},
	};
}
