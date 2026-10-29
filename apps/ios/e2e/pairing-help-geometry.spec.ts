import { expect, test } from './fixtures.ts';

test('pairing help works in real settings at 320px and large text', async ({ page }, info) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.addInitScript(() => {
    const state = globalThis as any; state.isTauri = true; state.pairCalls = 0;
    state.__TAURI_INTERNALS__ = { invoke: async (command: string) => {
      if (command.endsWith('|pair_device')) { state.pairCalls++; throw Error('Unexpected pairing'); }
      if (command.endsWith('results_list') || command.endsWith('|share_list') || command.endsWith('|documents_list')) return { ok: true, items: [] };
      return { ok: true };
    } };
  });
  await page.goto('/'); await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  await page.locator('[data-panel="settings"]').click();
  const disclosure = page.getByText('¿Dónde está el QR?', { exact: true });
  await disclosure.scrollIntoViewIfNeeded(); await disclosure.focus(); await expect(disclosure).toBeFocused();
  await page.keyboard.press('Enter'); await expect(page.getByText('pnpm mobile:connect', { exact: true })).toBeVisible();
  const metrics = await page.evaluate(() => { const panel = document.querySelector<HTMLElement>('#panel-settings')!, summary = document.querySelector<HTMLElement>('.pairing-instructions summary')!; const r = summary.getBoundingClientRect(); return { scrollWidth: panel.scrollWidth, width: panel.clientWidth, height: r.height, left: r.left, right: r.right }; });
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.width); expect(metrics.height).toBeGreaterThanOrEqual(44); expect(metrics.left).toBeGreaterThanOrEqual(0); expect(metrics.right).toBeLessThanOrEqual(320);
  expect(await page.evaluate(() => (globalThis as any).pairCalls)).toBe(0);
  await page.screenshot({ path: info.outputPath('pairing-help.png') });
});
