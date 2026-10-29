import { expect, test } from './fixtures.ts';

async function mountFixture(page: import('@playwright/test').Page) {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('/');
  await expect(page.locator('#history-loading')).toBeHidden();
  await page.evaluate(async () => {
    const { mountNativeVoiceRecovery } = await import('/src/native-voice-recovery-view.ts');
    const state = globalThis as any;
    state.voiceFixture = [];
    state.voiceAppended = [];
    const root = document.createElement('section'); root.id = 'voice-recovery-ui-fixture';
    document.querySelector('#conversation-scroll')!.prepend(root);
    const store = {
      list: async () => { if (state.failVoiceList) throw new Error('Consulta simulada'); return structuredClone(state.voiceFixture); },
      get: async (id: string) => structuredClone(state.voiceFixture.find((item: any) => item.receipt.audio.id === id)),
      release: async () => {}, discard: async () => {},
    };
    state.voiceView = mountNativeVoiceRecovery(root, { store, isDelivered: async () => state.voiceDelivered === true,
      append: async (receipt: any) => state.voiceAppended.push(receipt.transcript.text), confirmRelease: () => false, confirmDiscard: () => false });
    await state.voiceView.refresh();
  });
}

const record = {
  receipt: { audio: { id: 'fixture-audio', destination: 'chat' }, transcript: { text: 'Dictado conservado. '.repeat(30) } },
  releaseState: 'retained',
};

test('voice recovery adds no normal-state controls and displays only with a chat record', async ({ page }) => {
  await mountFixture(page);
  const root = page.locator('#voice-recovery-ui-fixture');
  await expect(root).toBeHidden();
  await expect(page.getByText('Dictado guardado')).toHaveCount(0);
  await page.evaluate(async item => { (globalThis as any).voiceFixture = [item]; await (globalThis as any).voiceView.refresh(); }, record);
  await expect(root).toBeVisible();
  await expect(root.getByText('Dictado guardado')).toBeVisible();
  expect(await page.evaluate(() => (globalThis as any).voiceAppended)).toEqual([]);
  await page.evaluate(async () => { (globalThis as any).voiceFixture = []; await (globalThis as any).voiceView.refresh(); });
  await expect(root).toBeHidden();
});

test('a delivered and released receipt is hidden while retained audio still has an action', async ({ page }) => {
  await mountFixture(page);
  const root = page.locator('#voice-recovery-ui-fixture');
  await page.evaluate(async item => { const state = globalThis as any; state.voiceDelivered = true; state.voiceFixture = [item]; await state.voiceView.refresh(); }, record);
  await expect(root).toBeVisible();
  await root.locator('summary').click();
  await expect(root.getByRole('button', { name: 'Añadir al mensaje' })).toBeHidden();
  await expect(root.getByRole('button', { name: 'Eliminar audio' })).toBeVisible();
  await page.evaluate(async () => { const state = globalThis as any; state.voiceFixture[0].releaseState = 'released'; await state.voiceView.refresh(); });
  await expect(root).toBeHidden();
});

test('a temporary listing failure offers a retry and multiple dictations have distinct labels', async ({ page }) => {
  await mountFixture(page);
  const root = page.locator('#voice-recovery-ui-fixture');
  await page.evaluate(async item => {
    const state = globalThis as any;
    state.voiceFixture = [item, { ...item, receipt: { ...item.receipt, audio: { ...item.receipt.audio, id: 'fixture-second' } } }];
    state.failVoiceList = true; await state.voiceView.refresh();
  }, record);
  await expect(root).toContainText('No pude consultar');
  const retry = root.getByRole('button', { name: /Reintentar/ });
  await expect(retry).toBeVisible();
  await page.evaluate(() => { (globalThis as any).failVoiceList = false; });
  await retry.click();
  await expect(root.getByText('Dictado guardado 1', { exact: true })).toBeVisible();
  await expect(root.getByText('Dictado guardado 2', { exact: true })).toBeVisible();
});

test('retained dictation remains keyboard reachable without horizontal overflow at 200% text', async ({ page }) => {
  await mountFixture(page);
  await page.evaluate(async item => { document.documentElement.style.fontSize = '200%'; (globalThis as any).voiceFixture = [item]; await (globalThis as any).voiceView.refresh(); }, record);
  const root = page.locator('#voice-recovery-ui-fixture');
  const summary = root.locator('summary');
  await summary.focus(); await expect(summary).toBeFocused(); await page.keyboard.press('Enter');
  await expect(root.locator('.voice-receipt-text')).toHaveText(record.receipt.transcript.text);
  const append = root.getByRole('button', { name: 'Añadir al mensaje' });
  await append.focus(); await expect(append).toBeFocused();
  await page.locator('#prompt').focus();
  await page.evaluate(() => {
    const viewport = window.visualViewport!;
    Object.defineProperties(viewport, { height: { configurable: true, value: 360 }, pageTop: { configurable: true, value: 0 }, scale: { configurable: true, value: 1 } });
    viewport.dispatchEvent(new Event('resize'));
  });
  await expect(page.locator('html')).toHaveAttribute('data-keyboard', 'true');
  await append.focus(); await expect(append).toBeFocused();
  const focus = await append.evaluate(element => {
    const rect = element.getBoundingClientRect(), scroll = document.querySelector('#conversation-scroll')!.getBoundingClientRect(), composer = document.querySelector('#composer')!.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, scrollTop: scroll.top, scrollBottom: scroll.bottom, composerTop: composer.top };
  });
  expect(focus.bottom).toBeGreaterThan(focus.scrollTop);
  expect(focus.top).toBeLessThan(focus.scrollBottom);
  expect(focus.top).toBeLessThan(focus.composerTop);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  const height = await append.evaluate(element => element.getBoundingClientRect().height);
  expect(height).toBeGreaterThanOrEqual(44);
  await expect(root.getByRole('button', { name: 'Eliminar copia' })).toBeDisabled();
  expect(await page.evaluate(() => (globalThis as any).voiceAppended)).toEqual([]);
  await page.keyboard.press('Enter');
  await expect(root.getByRole('status')).toContainText('Revísalo antes de enviar');
  expect(await page.evaluate(() => (globalThis as any).voiceAppended)).toEqual([record.receipt.transcript.text]);
});
