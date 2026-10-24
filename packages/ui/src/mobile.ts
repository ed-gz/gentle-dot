/** Installed by the Android shell before mounting the shared chat. */
export type NotificationEvent =
	| "dotReply"
	| "dotError"
	| "agentCompleted"
	| "agentAttention"
	| "agentError"
	| "agentAvailable"
	| "permission";
export function isNotificationEvent(value: unknown): value is NotificationEvent {
	return typeof value === "string" && ["dotReply", "dotError", "agentCompleted", "agentAttention", "agentError", "agentAvailable", "permission"].includes(value);
}
export interface NotificationPreferences {
	dotReplies: boolean;
	dotErrors: boolean;
	agentCompleted: boolean;
	agentAttention: boolean;
	agentErrors: boolean;
	agentAvailable: boolean;
	permissions: boolean;
	inApp: boolean;
	preview: boolean;
	sound: boolean;
	vibration: boolean;
}
export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
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
export interface MobileNotification {
	id: string;
	title: string;
	body: string;
	event?: NotificationEvent;
	session?: { paneId: string; sessionId?: string };
}
export interface ReceiveFileOptions {
	url: string;
	token: string;
	name: string;
	mime: string;
	action: "save" | "share";
}

export interface ReceiveFileResult {
	/** shared confirms the Android chooser opened, not that another app delivered the file. */
	status: "saved" | "shared" | "cancelled";
}

export interface MobileDraftSnapshot {
	text: string;
	/** Opaque native storage revision, shared by both Android WebViews. */
	revision: string;
}
export interface MobileDraftSaveResult extends MobileDraftSnapshot {
	applied: boolean;
}

export interface GentleMobileBridge {
	/** Encrypted local text drafts, scoped by the paired device and conversation. */
	readDraft?(key: string): Promise<MobileDraftSnapshot>;
	/** Compare-and-set prevents a suspended WebView from restoring an older draft. */
	saveDraft?(key: string, text: string, expectedRevision: string): Promise<MobileDraftSaveResult>;
	transcribe(options: { language: string }): Promise<{ text: string }>;
	notify?(options: {
		title: string;
		body: string;
		id: string;
		source?: "dot" | "agents" | "permission";
		event?: NotificationEvent;
	}): Promise<void>;
	notificationPreferences?(): Promise<NotificationPreferences>;
	subscribeNotificationPreferences?(listener: (preferences: NotificationPreferences) => void): () => void;
	receiveFile?(options: ReceiveFileOptions): Promise<ReceiveFileResult>;
	cancelReceiveFile?(): Promise<void>;
}

declare global {
	interface Window {
		__GENTLE_MOBILE__?: GentleMobileBridge;
	}
}

export function mobileBridge(): GentleMobileBridge | undefined {
	return window.__GENTLE_MOBILE__;
}
