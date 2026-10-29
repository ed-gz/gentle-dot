import { expect, test } from './fixtures.ts';

test('navigation remains visible and inert until its handlers are installed', async ({ page }) => {
  let release!: () => void;
  const waitForMain = new Promise<void>(resolve => { release = resolve; });
  let requested = false;
  await page.route('**/src/main.ts', async route => {
    requested = true;
    await waitForMain;
    await route.continue();
  });
  await page.goto('/', { waitUntil: 'commit' });
  await expect.poll(() => requested).toBe(true);
  const navigation = page.locator('.navigation');
  await expect(navigation).toBeVisible();
  await expect(navigation).toHaveAttribute('inert', '');
  await expect(navigation).toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('#navigation-loading')).toHaveText('Preparando navegación…');
  await expect(navigation.locator('button')).toHaveCount(3);
  release();
  await expect(navigation).not.toHaveAttribute('inert', '', { timeout: 15000 });
  await expect(navigation).not.toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('#navigation-loading')).toBeHidden();
  await page.locator('[data-panel="settings"]').click();
  await expect(page.locator('#panel-settings')).toBeVisible();
  await page.locator('[data-panel="agents"]').click();
  await expect(page.locator('#panel-agents')).toBeVisible();
  await page.locator('[data-panel="chat"]').click();
  await expect(page.locator('#panel-chat')).toBeVisible();
});
