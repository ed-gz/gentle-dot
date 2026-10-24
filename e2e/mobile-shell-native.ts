/** Native boundary fixture, imported only by playwright.mobile.vite.config.ts.
 * The APK entry point, storage validation, pairing, and shared UI remain real.
 */
interface NativeFixture {
	companionStateError?: string;
	companion?: {
		permission?: boolean;
		enabled?: boolean;
		active?: boolean;
		pinned?: boolean;
		partialChat?: boolean;
		theme?: string;
		appliedTheme?: string;
		renderReady?: boolean;
		renderError?: string;
	};
	connection?: unknown;
	monitoring: boolean;
	mode?: "all" | "dot" | "agents";
	preferences?: Record<string, boolean>;
	deferSpeech?: boolean;
	calls: { method: string; options?: unknown }[];
}

declare global {
	interface Window {
		__mobileShellFixture: NativeFixture;
		__resolveMobileSpeech?: (result: { text: string }) => void;
		__mobileShellNativeEvent: (name: string, value?: unknown) => void;
	}
}

const listeners = new Map<string, Set<(value: unknown) => void>>();
const fixture = () => window.__mobileShellFixture;
const record = (method: string, options?: unknown) => fixture().calls.push({ method, options });

export const Capacitor = {
	isNativePlatform: () => true,
	getPlatform: () => "android",
};

export function registerPlugin() {
	return {
		async readDraft({ scope }: { scope: string }) {
			record("readDraft");
			return draftValues.get(scope) ?? { text: "", revision: "0" };
		},
		async saveDraft({
			scope,
			text,
			expectedRevision,
		}: {
			scope: string;
			text: string;
			expectedRevision: string;
		}) {
			record("saveDraft");
			const previous = draftValues.get(scope) ?? { text: "", revision: "0" };
			if (previous.revision !== expectedRevision) return { ...previous, applied: false };
			const next = { text, revision: String(nextDraftRevision++) };
			draftValues.set(scope, next);
			return { ...next, applied: true };
		},
		addListener: (name: string, callback: (value: unknown) => void) => App.addListener(name, callback),
		async companionState() {
			if (fixture().companionStateError) throw new Error(fixture().companionStateError);
			return {
				supported: true,
				permission: true,
				enabled: false,
				active: false,
				pinned: false,
				theme: "gentle-dot",
				partialChat: false,
				...fixture().companion,
			};
		},
		async setCompanion(options: { enabled?: boolean; pinned?: boolean; theme?: string }) {
			record("setCompanion", options);
			const active = options.enabled ?? fixture().companion?.active ?? false;
			fixture().companion = {
				...fixture().companion,
				...options,
				...(options.enabled !== undefined ? { active: options.enabled } : {}),
				renderReady: active,
				appliedTheme: active ? (options.theme ?? fixture().companion?.theme ?? "gentle-dot") : undefined,
			};
		},
		async requestCompanionPermission() {
			record("requestCompanionPermission");
		},
		async openCompanionAppSettings() {
			record("openCompanionAppSettings");
		},
		async closeCompanionChat() {
			record("closeCompanionChat");
		},
		async companionLaunchContext() {
			return {};
		},
		async setNotificationPreferences(options: { preferences: Record<string, boolean> }) {
			record("setNotificationPreferences", options);
			fixture().preferences = options.preferences;
			return { preferences: options.preferences };
		},
		async openNotificationSettings() {
			record("openNotificationSettings");
		},
		async monitorState() {
			return {
				active: fixture().monitoring,
				mode: fixture().mode ?? "all",
				preferences: fixture().preferences,
			};
		},
		async setNotificationMode(options: { mode: "all" | "dot" | "agents" }) {
			record("setNotificationMode", options);
			fixture().mode = options.mode;
		},
		async receiveFile(options: { action: "save" | "share" }) {
			record("receiveFile", options);
			return { status: options.action === "share" ? "shared" : "saved" };
		},
		async cancelReceiveFile() {
			record("cancelReceiveFile");
		},
		async startMonitor(options: unknown) {
			record("startMonitor", options);
			fixture().monitoring = true;
		},
		async stopMonitor() {
			record("stopMonitor");
			fixture().monitoring = false;
		},
		async notify(options: unknown) {
			record("notify", options);
		},
		async transcribe(options: unknown) {
			record("transcribe", options);
			if (fixture().deferSpeech)
				return new Promise<{ text: string }>((resolve) => {
					window.__resolveMobileSpeech = resolve;
				});
			return { text: "Revisa el avance de mis tareas" };
		},
	};
}

const draftValues = new Map<string, { text: string; revision: string }>();
let nextDraftRevision = 1;
const secureValues = new Map<string, unknown>();
export const SecureStorage = {
	async get(key: string) {
		record("storage.get", key);
		return key === "gentledot.mobile.connection.v1" ? fixture().connection : secureValues.get(key);
	},
	async set(key: string, value: unknown) {
		record("storage.set", key);
		if (key === "gentledot.mobile.connection.v1") fixture().connection = value;
		else secureValues.set(key, value);
	},
	async remove(key: string) {
		record("storage.remove", key);
		if (key === "gentledot.mobile.connection.v1") delete fixture().connection;
		else secureValues.delete(key);
	},
};

export const App = {
	async getLaunchUrl() {
		return undefined;
	},
	async getState() {
		return { isActive: true };
	},
	async minimizeApp() {
		record("minimizeApp");
	},
	async addListener(name: string, callback: (value: unknown) => void) {
		const callbacks = listeners.get(name) ?? new Set();
		listeners.set(name, callbacks);
		callbacks.add(callback);
		return {
			remove: async () => {
				callbacks.delete(callback);
			},
		};
	},
};
window.__mobileShellNativeEvent = (name, value) => {
	for (const callback of listeners.get(name) ?? []) callback(value);
};

export const BarcodeFormat = { QrCode: "QR_CODE" };
export const LensFacing = { Back: "BACK" };
export const Resolution = { "1280x720": "1280x720" };
export const BarcodeScanner = {
	async isSupported() {
		return { supported: true };
	},
	async checkPermissions() {
		return { camera: "granted" };
	},
	async requestPermissions() {
		return { camera: "granted" };
	},
	async isTorchAvailable() {
		return { available: false };
	},
	async toggleTorch() {},
	async startScan() {
		record("startScan");
	},
	async stopScan() {
		record("stopScan");
	},
	addListener: App.addListener,
};

export const SystemBarsStyle = { Light: "LIGHT", Dark: "DARK", Default: "DEFAULT" };
export const SystemBars = {
	async setStyle(options: unknown) {
		record("systemBars.setStyle", options);
	},
};
