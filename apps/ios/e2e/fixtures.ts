import { test as base } from '@playwright/test';
export { expect } from '@playwright/test';
export type { Page, WebSocketRoute } from '@playwright/test';

// A developer's ignored personal PNG must not silently change every test into
// a software-GPU stress test. Character tests supply their own bounded artwork
// with a later route (or import an image), and still execute the real PC rig.
export const test = base.extend<{ isolatePersonalArtwork: void }>({
  isolatePersonalArtwork: [async ({ page }, use) => {
    await page.route('**/personal-art/**', route => route.fulfill({ status: 404, body: '' }));
    await use();
  }, { auto: true }],
});
