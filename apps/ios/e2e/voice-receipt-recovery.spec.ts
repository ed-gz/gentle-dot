import { expect, test } from './fixtures.ts';

const input = (destination = 'chat', suffix = '1') => ({
  ownerId: `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa${suffix}`,
  destination, audioSHA256: 'a'.repeat(64), audioBytes: 3,
  transcript: { sessionId: `12345678-1234-4234-8234-12345678901${suffix}`, text: 'Revisar <b>error</b>\ny continuar.',
    locale: 'es-MX', source: 'apple-speech-analyzer', durationSeconds: 2,
    segments: [{ text: 'Revisar <b>error</b>\ny continuar.', startSeconds: .1, endSeconds: 1.8 }] },
});

async function setup(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.locator('[data-panel="inbox"]').click();
  await page.evaluate(async () => {
    const state = globalThis as any;
    const storePath = '/src/voice-receipt-store.ts', viewPath = '/src/voice-receipt-recovery.ts';
    const { createVoiceReceiptStore } = await import(storePath);
    const { createVoiceReceiptRecovery } = await import(viewPath);
    const root = document.createElement('section'); root.id = 'voice-recovery-fixture';
    document.querySelector('#panel-inbox')!.prepend(root);
    state.voiceRecoveryStore = createVoiceReceiptStore({ databaseName: `voice-view-${crypto.randomUUID()}` });
    state.voiceRecoveryUses = [];
    state.voiceRecoveryErrors = [];
    state.voiceRecoveryView = createVoiceReceiptRecovery(root, {
      store: state.voiceRecoveryStore,
      useInChat: async (receipt: unknown) => {
        state.voiceRecoveryUses.push(receipt);
        if (state.blockVoiceUse) await new Promise<void>(resolve => { state.finishVoiceUse = resolve; });
        if (state.failVoiceUse) throw new Error('fixture failure');
      },
      onError: (message: string) => state.voiceRecoveryErrors.push(message),
    });
    await state.voiceRecoveryView.refresh();
  });
}

test('only pending chat receipts are visible and nothing is inserted without a gesture', async ({ page }) => {
  await setup(page);
  const root = page.locator('#voice-recovery-fixture');
  await expect(root).toBeHidden();
  await page.evaluate(async ({ chat, session }) => {
    const state = globalThis as any;
    await state.voiceRecoveryStore.put(session); await state.voiceRecoveryView.refresh();
    await state.voiceRecoveryStore.put(chat); await state.voiceRecoveryView.refresh();
  }, { chat: input(), session: input(`session:${'b'.repeat(64)}`, '2') });
  await expect(root).toBeVisible();
  await expect(root.locator('summary')).toHaveCount(1);
  expect(await page.evaluate(() => (globalThis as any).voiceRecoveryUses)).toEqual([]);
  await root.locator('summary').click();
  await expect(root).toContainText('Revisar <b>error</b>');
  await expect(root.locator('b')).toHaveCount(0);
  await page.evaluate(() => { (globalThis as any).blockVoiceUse = true; });
  const button = root.getByRole('button', { name: 'Usar en conversación' });
  await button.click(); await expect(button).toBeDisabled();
  await button.evaluate(element => (element as HTMLButtonElement).click());
  expect(await page.evaluate(() => (globalThis as any).voiceRecoveryUses.length)).toBe(1);
  await page.evaluate(() => (globalThis as any).finishVoiceUse());
  await expect(root.getByRole('status')).toHaveText('Texto listo para revisar en la conversación.');
  await expect(button).toBeHidden();
  await page.evaluate(() => (globalThis as any).voiceRecoveryView.refresh());
  await root.locator('summary').click();
  await expect(root.locator('button')).toBeHidden();
  expect(await page.evaluate(() => (globalThis as any).voiceRecoveryUses.length)).toBe(1);
  expect(await page.evaluate(async () => (await (globalThis as any).voiceRecoveryStore.get('12345678-1234-4234-8234-123456789011')).state)).toBe('pending');
});

test('a discarded or changed receipt is never sent to the insertion callback', async ({ page }) => {
  await setup(page);
  await page.evaluate(async data => {
    const state = globalThis as any; state.voiceReceipt = await state.voiceRecoveryStore.put(data);
    await state.voiceRecoveryView.refresh();
  }, input());
  const root = page.locator('#voice-recovery-fixture');
  await root.locator('summary').click();
  await page.evaluate(async () => { const state = globalThis as any; await state.voiceRecoveryStore.discard(state.voiceReceipt); });
  await root.getByRole('button', { name: 'Usar en conversación' }).click();
  await expect(root.getByRole('status')).toContainText('El dictado cambió');
  expect(await page.evaluate(() => (globalThis as any).voiceRecoveryUses)).toEqual([]);
  await page.evaluate(() => (globalThis as any).voiceRecoveryView.refresh());
  await expect(root).toBeHidden();
});

test('a receipt applied only to an isolated draft remains recoverable; discarded records stay hidden', async ({ page }) => {
  await setup(page);
  await page.evaluate(async ({ applied, discarded }) => {
    const state = globalThis as any, store = state.voiceRecoveryStore;
    const first = await store.put(applied), second = await store.put(discarded);
    await store.apply(first, await store.readDraft('chat')); await store.discard(second);
    await state.voiceRecoveryView.refresh();
  }, { applied: input('chat', '1'), discarded: input('chat', '2') });
  const root = page.locator('#voice-recovery-fixture');
  await expect(root).toBeVisible(); await expect(root.locator('summary')).toHaveCount(1);
  await root.locator('summary').click();
  await root.getByRole('button', { name: 'Usar en conversación' }).click();
  await expect.poll(() => page.evaluate(() => (globalThis as any).voiceRecoveryUses[0]?.state)).toBe('applied');
});

test('failed insertion preserves the receipt and exposes an accessible retry', async ({ page }) => {
  await setup(page);
  await page.evaluate(async data => {
    const state = globalThis as any; await state.voiceRecoveryStore.put(data);
    await state.voiceRecoveryView.refresh(); state.failVoiceUse = true;
  }, input());
  const root = page.locator('#voice-recovery-fixture'); await root.locator('summary').click();
  const action = root.getByRole('button', { name: 'Usar en conversación' });
  await action.click(); await expect(root.getByRole('status')).toContainText('No pude confirmar que se guardó');
  await expect(action).toBeEnabled();
  expect(await page.evaluate(async () => (await (globalThis as any).voiceRecoveryStore.list('chat'))[0].state)).toBe('pending');
});

test('refresh during a pending use never enables a second insertion', async ({ page }) => {
  await setup(page);
  await page.evaluate(async data => {
    const state = globalThis as any; await state.voiceRecoveryStore.put(data);
    await state.voiceRecoveryView.refresh(); state.blockVoiceUse = true;
  }, input());
  const root = page.locator('#voice-recovery-fixture'); await root.locator('summary').click();
  await root.getByRole('button', { name: 'Usar en conversación' }).click();
  await expect.poll(() => page.evaluate(() => (globalThis as any).voiceRecoveryUses.length)).toBe(1);
  await page.evaluate(() => (globalThis as any).voiceRecoveryView.refresh());
  await root.locator('summary').click();
  const action = root.getByRole('button', { name: 'Usar en conversación' });
  await expect(action).toBeDisabled();
  await page.evaluate(() => (globalThis as any).finishVoiceUse());
  await expect(root.locator('button')).toBeHidden();
  expect(await page.evaluate(() => (globalThis as any).voiceRecoveryUses.length)).toBe(1);
});

test('an unreadable store reports an error instead of claiming no pending dictations', async ({ page }) => {
  await setup(page);
  await page.evaluate(async data => {
    const state = globalThis as any, viewPath = '/src/voice-receipt-recovery.ts';
    const { createVoiceReceiptRecovery } = await import(viewPath);
    await state.voiceRecoveryStore.put(data);
    const root = document.createElement('section'); root.id = 'voice-unreadable-fixture';
    document.querySelector('#panel-inbox')!.prepend(root);
    const view = createVoiceReceiptRecovery(root, {
      store: { list: async (destination: string) => {
        if (state.failVoiceRead) throw new Error('fixture error');
        return state.voiceRecoveryStore.list(destination);
      }, get: async (id: string) => state.voiceRecoveryStore.get(id) },
      useInChat: async () => { throw new Error('must not be called'); },
      onError: (message: string) => state.voiceRecoveryErrors.push(message),
    });
    await view.refresh();
    if (root.hidden || !root.textContent?.includes('Dictado')) throw new Error('fixture did not show a receipt');
    state.failVoiceRead = true; await view.refresh();
  }, input());
  await expect(page.locator('#voice-unreadable-fixture')).toBeHidden();
  await expect(page.locator('#voice-unreadable-fixture')).toBeEmpty();
  expect(await page.evaluate(() => (globalThis as any).voiceRecoveryErrors)).toEqual(['No pude comprobar los dictados guardados.']);
});

test('pending text stays usable in small and landscape layouts with enlarged type', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await setup(page);
  await page.evaluate(async data => {
    const state = globalThis as any; await state.voiceRecoveryStore.put(data); await state.voiceRecoveryView.refresh();
    document.documentElement.style.fontSize = '200%';
  }, input());
  const root = page.locator('#voice-recovery-fixture'); await root.locator('summary').click();
  const button = root.getByRole('button', { name: 'Usar en conversación' });
  for (const viewport of [{ width: 375, height: 812 }, { width: 812, height: 375 }]) {
    await page.setViewportSize(viewport); await button.scrollIntoViewIfNeeded();
    const geometry = await button.boundingBox();
    expect(geometry!.height).toBeGreaterThanOrEqual(44); expect(geometry!.width).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});
