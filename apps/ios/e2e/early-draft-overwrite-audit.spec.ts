import { expect, test } from './fixtures.ts';

for (const failBackup of [false, true]) test(`early edits preserve the previous draft${failBackup ? ' when its backup initially fails' : ''}`, async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#history-loading')).toBeHidden();
  await expect.poll(async () => page.evaluate(async () => !(await (await import('/src/conversation-journal.ts')).createConversationJournal().pending()))).toBe(true);
  await expect.poll(async () => page.evaluate(async () => {
    try {
      const conversation = await import('/src/conversation.ts');
      const base = await conversation.loadConversationBase();
      await conversation.saveConversation({ entries: base?.entries ?? [], draft: 'Borrador anterior', revision: (base?.revision ?? 0) + 1 });
      return true;
    } catch { return false; }
  })).toBe(true);
  await page.evaluate(() => {
    sessionStorage.setItem('hold-conversation-read', 'yes');
    window.addEventListener('pagehide', event => event.stopImmediatePropagation(), true);
  });
  await page.addInitScript(() => {
    const state = globalThis as any; const original = IDBFactory.prototype.open;
    const originalTransaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (names: string | string[], mode?: IDBTransactionMode, options?: IDBTransactionOptions) {
      if (this.name === 'capri-ios-conversation' && mode === 'readwrite' && state.failBackup) throw new DOMException('Cuota simulada', 'QuotaExceededError');
      return Reflect.apply(originalTransaction, this, options ? [names, mode, options] : mode ? [names, mode] : [names]);
    };
    IDBFactory.prototype.open = function (name: string, version?: number) {
      const request = Reflect.apply(original, this, version === undefined ? [name] : [name, version]);
      if (name === 'capri-ios-conversation' && sessionStorage.getItem('hold-conversation-read') === 'yes') {
        sessionStorage.removeItem('hold-conversation-read');
        let callback: ((event: Event) => void) | null = null;
        Object.defineProperty(request, 'onsuccess', { configurable: true, get: () => callback, set: value => { callback = value; } });
        request.addEventListener('success', (event: Event) => { state.restoreReadHeld = true; state.releaseRestore = () => callback?.call(request, event); });
      }
      return request;
    };
  });
  await page.reload(); await expect.poll(() => page.evaluate(() => (globalThis as any).restoreReadHeld)).toBe(true);
  await page.locator('#prompt').fill('Texto nuevo durante recuperación');
  await expect.poll(() => page.evaluate(async () => (await (await import('/src/conversation-draft-rescue.ts')).createConversationDraftRescue().list()).some(item => item.draft === 'Texto nuevo durante recuperación'))).toBe(true);
  if (failBackup) await page.evaluate(() => { (globalThis as any).failBackup = true; });
  await page.evaluate(() => (globalThis as any).releaseRestore());
  if (failBackup) {
    await expect(page.locator('#retry-conversation')).toBeVisible();
    await expect(page.locator('#prompt')).toHaveValue('Texto nuevo durante recuperación');
    expect(await page.evaluate(async () => (await (await import('/src/conversation.ts')).loadConversation()).draft)).toBe('Borrador anterior');
    await page.evaluate(() => { (globalThis as any).failBackup = false; });
    await page.locator('#retry-conversation').click();
  }
  await expect.poll(() => page.evaluate(async () => (await (await import('/src/conversation.ts')).loadConversation()).draft)).toBe('Texto nuevo durante recuperación');
  await expect.poll(() => page.evaluate(async () => (await (await import('/src/conversation-draft-rescue.ts')).createConversationDraftRescue().list()).map(item => item.draft)))
    .toContain('Borrador anterior');
});
