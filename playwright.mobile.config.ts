import { defineConfig, devices } from "@playwright/test";

/** Exercise the actual APK shell. The ordinary E2E suite serves the shared web UI. */
export default defineConfig({
	testDir: "./e2e",
	testMatch: [
		"mobile-shell.mobile.ts",
		"mobile-rich.mobile.ts",
		"mobile-chat-scroll.mobile.ts",
		"mobile-usage.mobile.ts",
		"mobile-sessions.mobile.ts",
		"mobile-request-presentation.mobile.ts",
		"mobile-rdd-consent.mobile.ts",
		"agent-subagent-disclosure.spec.ts",
		"mobile-usage-badges.mobile.ts",
		"mobile-agent-attachments.mobile.ts",
		"mobile-agent-composer.mobile.ts",
	],
	outputDir: "./.cache/mobile-e2e",
	fullyParallel: false,
	workers: 1,
	timeout: 30_000,
	reporter: "list",
	use: {
		baseURL: "http://127.0.0.1:4394",
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
		...devices["Pixel 7"],
		deviceScaleFactor: 1,
	},
	projects: [{ name: "android-shell" }],
	webServer: {
		command:
			"pnpm --filter @gentle-dot/mobile exec vite --config ../../playwright.mobile.vite.config.ts --host 127.0.0.1 --port 4394 --strictPort",
		url: "http://127.0.0.1:4394",
		reuseExistingServer: false,
		timeout: 30_000,
	},
});
