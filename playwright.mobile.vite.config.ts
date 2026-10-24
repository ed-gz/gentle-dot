import { fileURLToPath } from "node:url";
import mobileConfig from "./apps/mobile/vite.config.ts";

// Isolated test build: these aliases never enter the Android production build.
const nativeFixture = fileURLToPath(new URL("./e2e/mobile-shell-native.ts", import.meta.url));
export default {
	...mobileConfig,
	root: fileURLToPath(new URL("./apps/mobile", import.meta.url)),
	server: { host: "127.0.0.1", hmr: false },
	resolve: {
		alias: Object.fromEntries(
			[
				"@capacitor/core",
				"@capacitor/app",
				"@aparajita/capacitor-secure-storage",
				"@capacitor-mlkit/barcode-scanning",
			].map((name) => [name, nativeFixture]),
		),
	},
};
