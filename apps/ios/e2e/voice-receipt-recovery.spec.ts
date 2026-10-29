import { expect, test, openRecoveryHarness } from './fixtures.ts';

const input = (suffix = '1') => ({
  ownerId: `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa${suffix}`,
  destination: 'chat', audioSHA256: 'a'.repeat(64), audioBytes: 3,
  transcript: { sessionId: `12345678-1234-4234-8234-12345678901${suffix}`, text: 'Revisar <b>error</b>\ny continuar.',
    locale: 'es-MX', source: 'apple-speech-analyzer', durationSeconds: 2,
    segments: [{ text: 'Revisar <b>error</b>\ny continuar.', startSeconds: .1, endSeconds: 1.8 }] },
});

async function setup(page: import('@playwright/test').Page) {
  await page.goto('/');
  await openRecoveryHarness(page);
  await page.evaluate(async () => {
    const state = globalThis as any;
    const storePath = '/src/voice-chat-commit.ts', viewPath = '/src/voice-receipt-recovery.ts';
    const { createVoiceChatCommit } = await import(storePath);
    const { prepareVoiceReceiptArchive } = await import(viewPath);
    state.voiceChatDB = `voice-chat-view-${crypto.randomUUID()}`;
    state.voiceRecoveryStore = createVoiceChatCommit({ databaseName: state.voiceChatDB });
    state.voiceCopies = []; state.voiceErrors = [];
    const archive = document.querySelector<HTMLElement>('#panel-inbox')!;
    state.voiceRecoveryView = prepareVoiceReceiptArchive(archive, {
      store: state.voiceRecoveryStore,
      isRecoverable: async () => state.voiceRecoverable !== false,
      copyText: async (text: string) => {
        state.voiceCopies.push(text);
        if (state.blockVoiceCopy) await new Promise<void>(resolve => { state.finishVoiceCopy = resolve; });
        if (state.failVoiceCopy) throw new Error('fixture failure');
      },
      onError: (message: string) => state.voiceErrors.push(message),
    }, document.querySelector('#work-list')!);
    state.voiceRecoveryView.root.id = 'voice-recovery-fixture';
    await state.voiceRecoveryView.refresh();
  });
}

test('the archive mounts only for classified chat dictations and copies only after a gesture', async ({ page }) => {
  await setup(page);
  const root = page.locator('#voice-recovery-fixture'); await expect(root).toHaveCount(0);
  await page.evaluate(async data => {
    const state = globalThis as any;
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open(state.voiceChatDB, 1);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result, tx = db.transaction('conversation', 'readwrite');
        tx.objectStore('conversation').put({ entries: [], draft: 'Nota previa', revision: 0 }, 'current');
        tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => reject(tx.error);
      };
    });
    state.voiceApplied = await state.voiceRecoveryStore.apply(data, { draft: 'Nota previa', revision: 0 });
    await state.voiceRecoveryView.refresh();
  }, input());
  await expect(root).toBeVisible(); await expect(root.locator('summary')).toHaveCount(1);
  expect(await page.evaluate(() => (globalThis as any).voiceCopies)).toEqual([]);
  await root.locator('summary').click();
  await expect(root).toContainText('Revisar <b>error</b>');
  await expect(root.locator('b')).toHaveCount(0);
  await root.getByRole('button', { name: 'Copiar texto' }).click();
  await expect(root.getByRole('status')).toHaveText('Texto copiado.');
  expect(await page.evaluate(() => (globalThis as any).voiceCopies)).toEqual(['Revisar <b>error</b>\ny continuar.']);
  const persisted = await page.evaluate(async () => {
    const state = globalThis as any;
    return await new Promise<any>((resolve, reject) => {
      const opening = indexedDB.open(state.voiceChatDB, 1);
      opening.onerror = () => reject(opening.error);
      opening.onsuccess = () => {
        const db = opening.result, tx = db.transaction('conversation', 'readonly'), get = tx.objectStore('conversation').get('current');
        get.onsuccess = () => { resolve(get.result); db.close(); };
        get.onerror = () => reject(get.error);
      };
    });
  });
  expect(persisted.draft).toBe('Nota previa\nRevisar <b>error</b>\ny continuar.');
  expect(persisted.revision).toBe(1);
});

test('a removed receipt cannot be copied from a stale view', async ({ page }) => {
  await setup(page);
  await page.evaluate(async data => {
    const state = globalThis as any; await state.voiceRecoveryStore.apply(data, { draft: '', revision: 0 });
    await state.voiceRecoveryView.refresh();
  }, input());
  const root = page.locator('#voice-recovery-fixture'); await root.locator('summary').click();
  await page.evaluate(async () => {
    const state = globalThis as any;
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open(state.voiceChatDB, 1);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result, tx = db.transaction('conversation', 'readwrite');
        tx.objectStore('conversation').delete('voice-receipt:12345678-1234-4234-8234-123456789011');
        tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => reject(tx.error);
      };
    });
  });
  await root.getByRole('button', { name: 'Copiar texto' }).click();
  await expect(root.getByRole('status')).toContainText('El dictado cambió');
  expect(await page.evaluate(() => (globalThis as any).voiceCopies)).toEqual([]);
  await page.evaluate(() => (globalThis as any).voiceRecoveryView.refresh());
  await expect(root).toHaveCount(0);
});

test('unclassified records stay hidden and classification is checked again before copying', async ({ page }) => {
  await setup(page);
  await page.evaluate(async data => {
    const state = globalThis as any; state.voiceRecoverable = false;
    await state.voiceRecoveryStore.apply(data, { draft: '', revision: 0 }); await state.voiceRecoveryView.refresh();
  }, input());
  const root = page.locator('#voice-recovery-fixture'); await expect(root).toHaveCount(0);
  await page.evaluate(async () => { const state = globalThis as any; state.voiceRecoverable = true; await state.voiceRecoveryView.refresh(); });
  await expect(root).toBeVisible(); await root.locator('summary').click();
  await page.evaluate(() => { (globalThis as any).voiceRecoverable = false; });
  await root.getByRole('button', { name: 'Copiar texto' }).click();
  await expect(root.getByRole('status')).toContainText('El dictado cambió');
  expect(await page.evaluate(() => (globalThis as any).voiceCopies)).toEqual([]);
});

test('copy failure is reported without changing the saved draft or receipt', async ({ page }) => {
  await setup(page);
  await page.evaluate(async data => {
    const state = globalThis as any; await state.voiceRecoveryStore.apply(data, { draft: '', revision: 0 });
    await state.voiceRecoveryView.refresh(); state.failVoiceCopy = true;
  }, input());
  const root = page.locator('#voice-recovery-fixture'); await root.locator('summary').click();
  const action = root.getByRole('button', { name: 'Copiar texto' });
  await action.click(); await expect(root.getByRole('status')).toContainText('No pude confirmar la copia');
  await expect(action).toBeEnabled();
  expect(await page.evaluate(async () => (await (globalThis as any).voiceRecoveryStore.list()).length)).toBe(1);
});

test('without a confirmed clipboard provider the text remains selectable and no dead button appears', async ({ page }) => {
  await setup(page);
  await page.evaluate(async data => {
    const state = globalThis as any, viewPath = '/src/voice-receipt-recovery.ts';
    const { prepareVoiceReceiptArchive } = await import(viewPath);
    await state.voiceRecoveryStore.apply(data, { draft: '', revision: 0 });
    const view = prepareVoiceReceiptArchive(document.querySelector<HTMLElement>('#panel-inbox')!, {
      store: state.voiceRecoveryStore,
      isRecoverable: async () => true,
      onError: (message: string) => state.voiceErrors.push(message),
    });
    view.root.id = 'voice-select-fixture'; await view.refresh();
  }, input());
  const root = page.locator('#voice-select-fixture'); await root.locator('summary').click();
  await expect(root.getByRole('button')).toHaveCount(0);
  expect(await root.locator('.voice-receipt-text').evaluate(element => {
    const selection = window.getSelection()!, range = document.createRange();
    range.selectNodeContents(element); selection.removeAllRanges(); selection.addRange(range);
    return selection.toString();
  })).toBe('Revisar <b>error</b>\ny continuar.');
});

test('refresh during a copy never permits concurrent duplicate callbacks', async ({ page }) => {
  await setup(page);
  await page.evaluate(async data => {
    const state = globalThis as any; await state.voiceRecoveryStore.apply(data, { draft: '', revision: 0 });
    await state.voiceRecoveryView.refresh(); state.blockVoiceCopy = true;
  }, input());
  const root = page.locator('#voice-recovery-fixture'); await root.locator('summary').click();
  await root.getByRole('button', { name: 'Copiar texto' }).click();
  await expect.poll(() => page.evaluate(() => (globalThis as any).voiceCopies.length)).toBe(1);
  await page.evaluate(() => (globalThis as any).voiceRecoveryView.refresh());
  await root.locator('summary').click();
  const action = root.getByRole('button', { name: 'Copiar texto' }); await expect(action).toBeDisabled();
  await page.evaluate(() => (globalThis as any).finishVoiceCopy());
  await expect(action).toBeEnabled();
  expect(await page.evaluate(() => (globalThis as any).voiceCopies.length)).toBe(1);
});

test('an unreadable store removes stale text and reports an error', async ({ page }) => {
  await setup(page);
  await page.evaluate(async data => {
    const state = globalThis as any, viewPath = '/src/voice-receipt-recovery.ts';
    const { prepareVoiceReceiptArchive } = await import(viewPath);
    await state.voiceRecoveryStore.apply(data, { draft: '', revision: 0 });
    const view = prepareVoiceReceiptArchive(document.querySelector<HTMLElement>('#panel-inbox')!, {
      store: { list: async () => { if (state.failVoiceRead) throw new Error('fixture'); return state.voiceRecoveryStore.list(); },
        inspect: async (id: string) => state.voiceRecoveryStore.inspect(id) },
      isRecoverable: async () => true,
      copyText: async () => { throw new Error('must not be called'); },
      onError: (message: string) => state.voiceErrors.push(message),
    });
    view.root.id = 'voice-unreadable-fixture'; await view.refresh();
    if (!view.root.isConnected) throw new Error('fixture did not show a receipt');
    state.failVoiceRead = true; await view.refresh();
  }, input());
  await expect(page.locator('#voice-unreadable-fixture')).toHaveCount(0);
  expect(await page.evaluate(() => (globalThis as any).voiceErrors)).toEqual(['No pude comprobar los dictados guardados.']);
});

test('an unknown recovery classification cannot expose a saved dictation', async ({ page }) => {
  await setup(page);
  await page.evaluate(async data => {
    const state = globalThis as any, viewPath = '/src/voice-receipt-recovery.ts';
    const { prepareVoiceReceiptArchive } = await import(viewPath);
    await state.voiceRecoveryStore.apply(data, { draft: '', revision: 0 });
    const view = prepareVoiceReceiptArchive(document.querySelector<HTMLElement>('#panel-inbox')!, {
      store: state.voiceRecoveryStore, isRecoverable: async () => undefined as any,
      onError: (message: string) => state.voiceErrors.push(message),
    });
    view.root.id = 'voice-unknown-fixture'; await view.refresh();
  }, input());
  await expect(page.locator('#voice-unknown-fixture')).toHaveCount(0);
  expect(await page.evaluate(() => (globalThis as any).voiceErrors)).toEqual(['No pude comprobar los dictados guardados.']);
});

test('a receipt removed between listing and inspection is never rendered', async ({ page }) => {
  await setup(page);
  await page.evaluate(async data => {
    const state = globalThis as any, viewPath = '/src/voice-receipt-recovery.ts';
    const { prepareVoiceReceiptArchive } = await import(viewPath);
    await state.voiceRecoveryStore.apply(data, { draft: '', revision: 0 });
    const view = prepareVoiceReceiptArchive(document.querySelector<HTMLElement>('#panel-inbox')!, {
      store: { list: async () => state.voiceRecoveryStore.list(), inspect: async () => undefined },
      isRecoverable: async () => true,
      onError: (message: string) => state.voiceErrors.push(message),
    });
    view.root.id = 'voice-disappeared-fixture'; await view.refresh();
  }, input());
  await expect(page.locator('#voice-disappeared-fixture')).toHaveCount(0);
  expect(await page.evaluate(() => (globalThis as any).voiceErrors)).toEqual(['No pude comprobar los dictados guardados.']);
});

test('saved text stays usable in small and landscape layouts with enlarged type', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ reducedMotion: 'reduce' }); await setup(page);
  await page.evaluate(async data => {
    const state = globalThis as any; await state.voiceRecoveryStore.apply(data, { draft: '', revision: 0 });
    await state.voiceRecoveryView.refresh(); document.documentElement.style.fontSize = '200%';
  }, input());
  const root = page.locator('#voice-recovery-fixture'); await root.locator('summary').click();
  const action = root.getByRole('button', { name: 'Copiar texto' });
  for (const viewport of [{ width: 375, height: 812 }, { width: 812, height: 375 }]) {
    await page.setViewportSize(viewport); await action.scrollIntoViewIfNeeded();
    const geometry = await action.boundingBox();
    expect(geometry!.height).toBeGreaterThanOrEqual(44); expect(geometry!.width).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});
