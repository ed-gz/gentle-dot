import { expect, test } from './fixtures.ts';

test('background inference requires an explicit reversible choice and applies to future turns', async ({ page }) => {
  await page.addInitScript(() => {
    const state = globalThis as any;
    state.isTauri = true; state.backgroundRequests = [];
    state.__TAURI_INTERNALS__ = { invoke: async (command: string, args: any) => {
      if (command.endsWith('results_list')) return { ok: true, items: [] };
      if (command.endsWith('check_availability')) return { available: true, status: 'available', supportsSpanish: true };
      if (command.endsWith('share_list') || command.endsWith('documents_list')) return { ok: true, items: [] };
      if (command.endsWith('agent_step')) {
        state.backgroundRequests.push(args.allowBackground);
        return { ok: true, decision: { kind: 'answer', text: 'Lista.', toolName: '', argumentsJSON: '{}' } };
      }
      return { ok: true };
    } };
  });
  await page.goto('/');
  await page.locator('#prompt').fill('Primera pregunta');
  await page.locator('#send').click();
  await expect(page.locator('.chat-card[data-role="assistant"]')).toContainText('Lista.');
  expect(await page.evaluate(() => (globalThis as any).backgroundRequests)).toEqual([false]);
  await page.locator('[data-panel="settings"]').click();
  await page.locator('#settings-intelligence summary').click();
  const setting = page.getByRole('checkbox', { name: 'Intentar continuar el análisis al salir' });
  await expect(setting).not.toBeChecked();
  await expect(page.locator('#continued-inference-settings [role="status"]')).toContainText('desactivado');
  await setting.check();
  await expect(page.locator('#continued-inference-settings [role="status"]')).toContainText('iOS puede continuar');
  await page.reload();
  await page.locator('[data-panel="settings"]').click();
  await page.locator('#settings-intelligence summary').click();
  await expect(setting).toBeChecked();
  await expect(page.locator('#continued-inference-settings [role="status"]')).toContainText('iOS puede continuar');
  await page.locator('[data-panel="chat"]').click();
  await page.locator('#prompt').fill('Segunda pregunta');
  await page.locator('#send').click();
  await expect.poll(() => page.evaluate(() => (globalThis as any).backgroundRequests)).toEqual([true]);
  await page.locator('[data-panel="settings"]').click();
  if (!await setting.isVisible()) await page.locator('#settings-intelligence summary').click();
  await setting.uncheck();
  await expect(page.locator('#continued-inference-settings [role="status"]')).toContainText('desactivado');
  await page.locator('[data-panel="chat"]').click();
  await page.locator('#prompt').fill('Tercera pregunta');
  await page.locator('#send').click();
  await expect.poll(() => page.evaluate(() => (globalThis as any).backgroundRequests)).toEqual([true, false]);
});
