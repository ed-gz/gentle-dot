/** Native boundary fixture, imported only by playwright.mobile.vite.config.ts.
 * The APK entry point, storage validation, pairing, and shared UI remain real.
 */
interface NativeFixture {
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
		addListener: (name: string, callback: (value: unknown) => void) => App.addListener(name, callback),
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
			if (fixture().deferSpeech) return new Promise<{ text: string }>(resolve => { window.__resolveMobileSpeech = resolve; });
			return { text: "Revisa el avance de mis tareas" };
		},
	};
}

export const SecureStorage = {
	async get(key: string) {
		record("storage.get", key);
		return fixture().connection;
	},
	async set(key: string, value: unknown) {
		record("storage.set", key);
		fixture().connection = value;
	},
	async remove(key: string) {
		record("storage.remove", key);
		delete fixture().connection;
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
