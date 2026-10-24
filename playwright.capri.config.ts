import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
	webServer: { command: "node packages/ui/node_modules/vite/bin/vite.js --config playwright.mobile.vite.config.ts --host 127.0.0.1 --port 4396 --strictPort", url: "http://127.0.0.1:4396", timeout: 30_000, reuseExistingServer: false },
	testDir: "./e2e", testMatch: "capri.mobile.ts", workers: 1, timeout: 30_000,
	outputDir: ".cache/capri-e2e", reporter: "list",
	use: { baseURL: "http://127.0.0.1:4396", ...devices["Pixel 7"], deviceScaleFactor: 1, screenshot: "only-on-failure" },
});
