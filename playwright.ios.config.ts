import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './apps/ios/e2e',
  fullyParallel: true,
  use: {
    baseURL: 'http://127.0.0.1:1420',
    viewport: { width: 390, height: 844 },
    launchOptions: { executablePath: process.env.CAPRI_BROWSER_PATH },
  },
  webServer: {
    command: 'node_modules/.bin/vite --config apps/ios/vite.config.ts apps/ios',
    url: 'http://127.0.0.1:1420', reuseExistingServer: !process.env.CI,
  },
});
