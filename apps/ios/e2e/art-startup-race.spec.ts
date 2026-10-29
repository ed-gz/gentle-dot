import { expect, test } from './fixtures.ts';

test('startup cannot replace artwork selected before startup begins', async ({ page }) => {
  test.slow();
  await page.addInitScript(() => {
    const state = globalThis as any;
    const schedule = globalThis.queueMicrotask;
    globalThis.queueMicrotask = callback => {
      if (callback.toString().includes('initialize()')) state.startCapriInitialization = callback;
      else schedule(callback);
    };
    const transaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (names: string | string[], mode?: IDBTransactionMode, options?: IDBTransactionOptions) {
      const result = Reflect.apply(transaction, this, options ? [names, mode, options] : mode ? [names, mode] : [names]) as IDBTransaction;
      if (this.name === 'capri-ios-local' && mode === 'readwrite') {
        Object.defineProperty(result, 'oncomplete', { configurable: true, set(handler: (event: Event) => void) {
          result.addEventListener('complete', event => { state.finishArtworkSave = () => handler.call(result, event); });
        } });
      }
      return result;
    };
  });
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => typeof (globalThis as any).startCapriInitialization)).toBe('function');
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 240; canvas.height = 420;
    const context = canvas.getContext('2d')!; context.fillStyle = '#ff408e'; context.fillRect(10, 10, 220, 400);
    return canvas.toDataURL().split(',')[1]!;
  });
  await page.locator('[data-panel="settings"]').click();
  await expect(page.locator('#panel-settings')).toBeVisible();
  await page.locator('#art').setInputFiles({ name: 'capri-test.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await expect.poll(() => page.evaluate(() => typeof (globalThis as any).finishArtworkSave), { timeout: 15000 }).toBe('function');
  // The bytes are committed, but their completion callback has not reached
  // the selection handler when initialization starts.
  await page.evaluate(() => (globalThis as any).startCapriInitialization());
  await expect.poll(() => page.evaluate(async () => (await (await import('/src/conversation.ts' as string)).loadConversation()).revision ?? 0), { timeout: 15000 }).toBeGreaterThan(0);
  await page.evaluate(() => (globalThis as any).finishArtworkSave());
  await expect(page.locator('#settings-status')).toHaveText('Arte guardado en este dispositivo.');
  await expect.poll(() => page.evaluate(async () => (await (await import('/src/local-state.ts' as string)).loadArtwork())?.size)).toBeGreaterThan(0);
  await expect(page.locator('#rig-handle')).toHaveAttribute('data-ready', 'true', { timeout: 15000 });
});
