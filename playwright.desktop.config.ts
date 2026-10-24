import { defineConfig, devices } from "@playwright/test";

/** Real desktop UI with a mocked native boundary; no local control or real accounts. */
export default defineConfig({
	testDir: "./e2e",
	testMatch: ["desktop-approvals.desktop.ts", "compact-history.desktop.ts"],
	outputDir: "./.cache/desktop-approvals-e2e",
	workers: 1,
	timeout: 30_000,
	reporter: "list",
	use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:4395", trace: "retain-on-failure" },
	webServer: {
		command: "pnpm --filter @gentle-dot/ui exec vite --host 127.0.0.1 --port 4395 --strictPort",
		url: "http://127.0.0.1:4395",
		reuseExistingServer: false,
		timeout: 30_000,
	},
});
