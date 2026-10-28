import { expect, test, type Page } from './fixtures.ts';

type Fixture = { enabled?: boolean; authorization?: string; deny?: boolean; hold?: boolean };
async function nativeNotifications(page: Page, fixture: Fixture = {}) {
  await page.addInitScript((initial: Fixture) => {
    const state = globalThis as any;
    state.isTauri = true; state.notificationCalls = []; state.nativeRevision = 0;
    state.notificationState = { enabled: initial.enabled ?? false, authorization: initial.authorization ?? 'not_determined' };
    state.__TAURI_INTERNALS__ = { invoke: async (command: string, args: any) => {
      if (command.endsWith('notification_status')) {
        state.notificationCalls.push({ command: 'status' });
        return { ok: true, ...state.notificationState };
      }
      if (command.endsWith('notification_configure')) {
        state.notificationCalls.push({ command: 'configure', enabled: args.enabled });
        const revision = ++state.nativeRevision;
        if (initial.hold && !state.heldNotification) {
          state.heldNotification = true;
          await new Promise<void>(resolve => { state.finishNotification = resolve; });
        }
        // The native preference has its own revision guard as in
        // CompletionNotifications.configure; a stale reply cannot undo a later choice.
        if (revision !== state.nativeRevision) { state.staleNotificationReply = true; return { ok: true, ...state.notificationState }; }
        if (args.enabled && initial.deny) state.notificationState = { enabled: false, authorization: 'denied' };
        else state.notificationState = { enabled: args.enabled, authorization: 'authorized' };
        return { ok: true, ...state.notificationState };
      }
      if (command.endsWith('results_list') || command.endsWith('share_list') || command.endsWith('documents_list')) return { ok: true, items: [] };
      if (command.endsWith('check_availability')) return { available: true, status: 'available', supportsSpanish: true };
      return { ok: true };
    } };
  }, fixture);
  await page.goto('/');
  await page.locator('[data-panel="settings"]').click();
  await page.locator('#settings-intelligence > summary').click();
  await expect(page.locator('#completion-notifications input')).toBeEnabled();
}

const checkbox = '#completion-notifications input';
const message = '#completion-notifications [role="status"]';

test('startup checks settings without asking permission; enable and disable require a person', async ({ page }) => {
  await nativeNotifications(page);
  await expect(page.locator(checkbox)).not.toBeChecked();
  await expect(page.locator(message)).toContainText('Desactivados');
  let calls = await page.evaluate(() => (globalThis as any).notificationCalls);
  expect(calls.some((call: any) => call.command === 'status')).toBe(true);
  expect(calls.filter((call: any) => call.command === 'configure')).toEqual([]);

  await page.getByLabel('Avísame cuando termine').check();
  await expect(page.locator(checkbox)).toBeChecked();
  await expect(page.locator(message)).toContainText('sin mostrar su contenido');
  calls = await page.evaluate(() => (globalThis as any).notificationCalls.filter((call: any) => call.command === 'configure'));
  expect(calls).toEqual([{ command: 'configure', enabled: true }]);

  await page.getByLabel('Avísame cuando termine').uncheck();
  await expect(page.locator(checkbox)).not.toBeChecked();
  await expect(page.locator(message)).toContainText('Desactivados');
  calls = await page.evaluate(() => (globalThis as any).notificationCalls.filter((call: any) => call.command === 'configure'));
  expect(calls).toEqual([{ command: 'configure', enabled: true }, { command: 'configure', enabled: false }]);
});

test('denied permission restores the unchecked control and explains the iPhone setting', async ({ page }) => {
  await nativeNotifications(page, { deny: true });
  await page.getByLabel('Avísame cuando termine').click();
  await expect(page.locator(checkbox)).not.toBeChecked();
  await expect(page.locator(message)).toContainText('desactivados en Ajustes del iPhone');
  expect(await page.evaluate(() => (globalThis as any).notificationCalls.filter((call: any) => call.command === 'configure'))).toEqual([{ command: 'configure', enabled: true }]);
});

test('a saved preference may be disabled without asking to enable it again', async ({ page }) => {
  await nativeNotifications(page, { enabled: true, authorization: 'authorized' });
  await expect(page.locator(checkbox)).toBeChecked();
  expect(await page.evaluate(() => (globalThis as any).notificationCalls.filter((call: any) => call.command === 'configure'))).toEqual([]);
  await page.getByLabel('Avísame cuando termine').uncheck();
  await expect(page.locator(message)).toContainText('Desactivados');
  expect(await page.evaluate(() => (globalThis as any).notificationCalls.filter((call: any) => call.command === 'configure'))).toEqual([{ command: 'configure', enabled: false }]);
});

test('browser preview explains the limitation and cannot enable alerts', async ({ page }) => {
  await page.goto('/'); await page.locator('[data-panel="settings"]').click();
  await page.locator('#settings-intelligence > summary').click();
  await expect(page.locator(checkbox)).toBeDisabled();
  await expect(page.locator(message)).toContainText('app instalada en el iPhone');
  await expect(page.locator(checkbox)).not.toBeChecked();
});

test('foreground refresh during permission dialog cannot overwrite the user choice', async ({ page }) => {
  await nativeNotifications(page, { hold: true });
  await page.getByLabel('Avísame cuando termine').click();
  await expect.poll(() => page.evaluate(() => typeof (globalThis as any).finishNotification)).toBe('function');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.evaluate(() => (globalThis as any).finishNotification());
  await expect(page.locator(checkbox)).toBeChecked();
  await expect(page.locator(message)).toContainText('sin mostrar su contenido');
});

test('a permission sheet that outlives the deadline is reconciled from the real native status', async ({ page }) => {
  await nativeNotifications(page, { hold: true });
  await page.clock.install();
  await page.getByLabel('Avísame cuando termine').click();
  await expect.poll(() => page.evaluate(() => typeof (globalThis as any).finishNotification)).toBe('function');
  await page.clock.fastForward(8001);
  await expect(page.locator(checkbox)).not.toBeChecked();
  await expect(page.locator(message)).toContainText('No pude confirmar el cambio');
  const before = await page.evaluate(() => (globalThis as any).notificationCalls.filter((call: any) => call.command === 'status').length);
  await page.evaluate(() => (globalThis as any).finishNotification());
  await expect(page.locator(checkbox)).toBeChecked();
  await expect(page.locator(message)).toContainText('sin mostrar su contenido');
  expect(await page.evaluate(() => (globalThis as any).notificationCalls.filter((call: any) => call.command === 'status').length)).toBe(before + 1);
});

test('a later explicit choice wins over a permission reply that exceeded the deadline', async ({ page }) => {
  await nativeNotifications(page, { hold: true });
  await page.clock.install();
  await page.getByLabel('Avísame cuando termine').click();
  await expect.poll(() => page.evaluate(() => typeof (globalThis as any).finishNotification)).toBe('function');
  await page.clock.fastForward(8001);
  await expect(page.locator(message)).toContainText('No pude confirmar el cambio');
  await expect(page.locator(checkbox)).not.toBeChecked();
  await page.getByLabel('Avísame cuando termine').check();
  await expect(page.locator(checkbox)).toBeChecked();
  await page.getByLabel('Avísame cuando termine').uncheck();
  await expect(page.locator(message)).toContainText('Desactivados');
  const before = await page.evaluate(() => (globalThis as any).notificationCalls.filter((call: any) => call.command === 'status').length);
  await page.evaluate(async () => { (globalThis as any).finishNotification(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  await expect.poll(() => page.evaluate(() => (globalThis as any).staleNotificationReply)).toBe(true);
  await expect(page.locator(checkbox)).not.toBeChecked();
  await expect(page.locator(message)).toContainText('Desactivados');
  const result = await page.evaluate(() => ({ state: (globalThis as any).notificationState, calls: (globalThis as any).notificationCalls }));
  expect(result.state.enabled).toBe(false);
  expect(result.calls.filter((call: any) => call.command === 'status')).toHaveLength(before);
  expect(result.calls.filter((call: any) => call.command === 'configure').map((call: any) => call.enabled)).toEqual([true, true, false]);
});
