import { expect, test } from './fixtures.ts';

async function personalBuild(page: import('@playwright/test').Page) {
  await page.goto('/');
  const asset = await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 240; c.height = 420;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#ff408e'; ctx.fillRect(60, 10, 120, 170); ctx.fillStyle = '#baff67'; ctx.fillRect(85, 180, 70, 220);
    const b64 = c.toDataURL().split(',')[1]!;
    const bytes = Uint8Array.from(atob(b64), char => char.charCodeAt(0));
    return { b64, size: bytes.length, sha256: [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('') };
  });
  await page.route('**/personal-art/manifest.json', route => route.fulfill({ json: { schemaVersion: 1, file: 'capri-full.png', sha256: asset.sha256, size: asset.size, width: 240, height: 420 } }));
  await page.route('**/personal-art/capri-full.png', route => route.fulfill({ contentType: 'image/png', body: Buffer.from(asset.b64, 'base64') }));
  await page.addInitScript(() => {
    const state = globalThis as any; state.isTauri = true;
    state.__TAURI_INTERNALS__ = { invoke: async (command: string) => {
      if (command.endsWith('results_list')) return { ok: true, items: [] };
      if (command.endsWith('share_list') || command.endsWith('documents_list')) return { ok: true, items: [] };
      if (command.endsWith('list_voice_receipts')) return { ok: true, receipts: [] };
      if (command.endsWith('inspect_retained_voice')) return { ok: true };
      if (command.endsWith('check_voice')) return { ok: true, available: true, status: 'available', assetsInstalled: true, microphonePermission: 'granted' };
      if (command.endsWith('check_availability')) return { available: true, status: 'available', supportsSpanish: true };
      if (command.endsWith('agent_step')) return { ok: true, decision: { kind: 'answer', text: 'Voy contigo.', toolName: '', argumentsJSON: '{}' } };
      return { ok: true };
    } };
  });
  await page.reload();
  await expect(page.locator('#rig-handle')).toHaveAttribute('data-ready', 'true', { timeout: 15000 });
  await expect(page.locator('#history-loading')).toBeHidden({ timeout: 20000 });
  await expect(page.locator('#send')).toBeEnabled({ timeout: 20000 });
}

async function history(page: import('@playwright/test').Page) {
  await personalBuild(page);
  await page.locator('#prompt').fill('Continuemos con las tareas.');
  await page.locator('#send').click();
  await expect(page.locator('#panel-chat')).toHaveAttribute('data-empty', 'false');
  await expect(page.getByText('Voy contigo.', { exact: true })).toBeVisible();
}

test('rail con historial es visible y no cubre navegación ni compositor', async ({ page }) => {
  test.slow();
  await history(page);
  await page.locator('#prompt').blur();
  const rig = page.locator('#rig-handle');
  await expect.poll(async () => (await rig.boundingBox())?.width).toBeGreaterThanOrEqual(110);
  expect((await rig.boundingBox())!.height).toBeGreaterThanOrEqual(155);
  await expect.poll(() => page.evaluate(() => {
    const rig = document.querySelector<HTMLElement>('#rig-handle')!.getBoundingClientRect();
    const intersects = (box: DOMRect) => box.width > 0 && box.height > 0 && rig.left < box.right + 5 && rig.right + 5 > box.left && rig.top < box.bottom + 5 && rig.bottom + 5 > box.top;
    return [...document.querySelectorAll<HTMLElement>('.navigation button, #composer')].filter(el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden' && intersects(el.getBoundingClientRect())).map(el => el.id || el.textContent);
  })).toEqual([]);
});

test('reaparición explícita reproduce intro con historial', async ({ page }) => {
  test.slow();
  await history(page);
  await page.locator('[data-panel="settings"]').click();
  await page.locator('#settings-character > summary').click();
  await page.getByText('Gestos y presencia', { exact: true }).click();
  await page.locator('#appear').click();
  await page.locator('#appear').click();
  await page.locator('[data-panel="chat"]').click();
  await expect(page.locator('.capri-theater[data-capri-theater="intro"]')).toHaveCount(1, { timeout: 15000 });
});

test('teclado simulado conserva un rig visible', async ({ page }) => {
  test.slow();
  await history(page);
  await page.locator('#prompt').focus();
  await page.evaluate(() => {
    Object.defineProperties(window.visualViewport!, { height: { configurable: true, value: 300 }, pageTop: { configurable: true, value: 0 }, scale: { configurable: true, value: 1 } });
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  await expect(page.locator('html')).toHaveAttribute('data-keyboard', 'true');
  await expect.poll(async () => (await page.locator('#rig-handle').boundingBox())?.width).toBeGreaterThanOrEqual(70);
});
