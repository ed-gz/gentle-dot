import { expect, test as base, type Page } from '@playwright/test';
export { expect } from '@playwright/test';
export type { Page, WebSocketRoute } from '@playwright/test';

// Exercises the internal rescue screen independently of the error gate. This is
// deliberately a test harness, not a user-visible navigation route; separate
// tests verify the gate becomes visible when durable storage really fails.
export async function openRecoveryHarness(page: Page) {
  const rescue = page.locator('#rescue-history');
  await expect(rescue).toBeAttached();
  await rescue.evaluate((button: HTMLButtonElement) => button.click());
  await expect(page.locator('#panel-inbox')).toBeVisible();
}

// A developer's ignored personal PNG must not silently change every test into
// a software-GPU stress test. Character tests supply their own bounded artwork
// with a later route (or import an image), and still execute the real PC rig.
export const test = base.extend<{ isolatePersonalArtwork: void }>({
  isolatePersonalArtwork: [async ({ page }, use) => {
    await page.route('**/personal-art/**', route => route.fulfill({ status: 404, body: '' }));
    await use();
  }, { auto: true }],
});
