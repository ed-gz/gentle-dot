import { expect, test } from './fixtures.ts';

test('rescue export remains available when journal and archive callbacks stall', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const state = globalThis as any;
    const { createJournalConversationPersistence } = await import('/src/journal-conversation-persistence.ts');
    const { mountMemoryView } = await import('/src/memory-view.ts');
    const { conversationArchive } = await import('/src/conversation-archive.ts');
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    state.releaseJournal = release;
    const writer = createJournalConversationPersistence({
      journal: { begin: async () => { state.beginReached = true; await held; throw new Error('lost callback'); },
        pending: async () => undefined, resume: async () => { throw new Error('not confirmed'); } },
      readBase: async () => undefined,
    });
    writer.bindBase(undefined);
    const snapshot = { entries: [], draft: 'Borrador que debe poder exportarse' };
    void writer.persist(snapshot);
    document.querySelector<HTMLElement>('#panel-chat')!.hidden = true;
    document.querySelector<HTMLElement>('#panel-inbox')!.hidden = false;
    conversationArchive.export = async () => await new Promise(() => {});
    const entry = { id: 'same-id', engine: 'iphone', role: 'user', state: 'complete', at: 1000, transportText: 'CONTEXTO_PRIVADO' };
    state.retryCalls = 0;
    mountMemoryView({ status: () => ({ pending: 1, blocked: true, conversationError: 'Sin confirmación' }),
      pending: () => [{ ...entry, text: 'Copia pendiente' }], visible: () => [{ ...entry, text: 'Copia visible distinta' }],
      draft: () => snapshot.draft, retry: () => { state.retryCalls++; return writer.persist(snapshot); } });
  });
  await expect.poll(() => page.evaluate(() => (globalThis as any).beginReached)).toBe(true);
  const root = page.locator('#conversation-memory').last();
  const button = root.getByRole('button', { name: 'Exportar historial' });
  const exported = page.waitForEvent('download', { timeout: 5000 });
  await button.click();
  const file = await exported;
  const bytes = await (await import('node:fs/promises')).readFile(await file.path(), 'utf8');
  expect(bytes).toContain('Borrador que debe poder exportarse');
  expect(bytes).toContain('Copia pendiente'); expect(bytes).toContain('Copia visible distinta');
  expect(bytes).not.toContain('CONTEXTO_PRIVADO'); expect(bytes).not.toContain('transportText');
  expect(await page.evaluate(() => (globalThis as any).retryCalls)).toBe(0);
  await expect(button).toBeEnabled();
  await page.evaluate(() => (globalThis as any).releaseJournal());
});

test('export captures distinct visible and pending copies before reading the archive', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const state = globalThis as any;
    const { mountMemoryView } = await import('/src/memory-view.ts');
    const { conversationArchive } = await import('/src/conversation-archive.ts');
    document.querySelector<HTMLElement>('#panel-chat')!.hidden = true;
    document.querySelector<HTMLElement>('#panel-inbox')!.hidden = false;
    const entry = { id: 'same-id', engine: 'iphone', role: 'user', state: 'complete', at: 1000, transportText: 'SECRETO_INTERNO' };
    state.pendingCopy = { ...entry, text: 'pendiente antes' };
    state.visibleCopy = { ...entry, text: 'visible antes' };
    conversationArchive.export = async () => {
      state.pendingCopy.text = 'pendiente después'; state.visibleCopy.text = 'visible después';
      return { blob: new Blob(['{"schema":"fixture-archive"}\n']), count: 0 } as any;
    };
    mountMemoryView({ status: () => ({ pending: 1, blocked: true }), pending: () => [state.pendingCopy], visible: () => [state.visibleCopy],
      draft: () => 'borrador', retry: async () => { throw new Error('no debe reintentarse'); } });
  });
  const root = page.locator('#conversation-memory').last();
  const download = page.waitForEvent('download'); await root.getByRole('button', { name: 'Exportar historial' }).click();
  const text = await (await import('node:fs/promises')).readFile(await (await download).path(), 'utf8');
  expect(text).toContain('pendiente antes'); expect(text).toContain('visible antes');
  expect(text).not.toContain('pendiente después'); expect(text).not.toContain('visible después');
  expect(text).not.toContain('SECRETO_INTERNO'); expect(text).not.toContain('transportText');
  const rows = text.trim().split('\n').map((line: string) => JSON.parse(line));
  expect(rows.find((row: any) => row.schema === 'capri-conversation-pending/v1')).toMatchObject({ committed: false, entries: 2 });
  await expect(root.locator('#memory-status')).toContainText('sin confirmar');
});

test('storage status changes cannot replace export progress while the export is pending', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const state = globalThis as any;
    const { mountMemoryView } = await import('/src/memory-view.ts');
    const { conversationArchive } = await import('/src/conversation-archive.ts');
    document.querySelector<HTMLElement>('#panel-chat')!.hidden = true;
    document.querySelector<HTMLElement>('#panel-inbox')!.hidden = false;
    conversationArchive.export = async () => await new Promise(resolve => { state.releaseArchive = () => resolve({ blob: new Blob(['{"schema":"fixture"}\n']), count: 0 }); });
    state.auditMemory = mountMemoryView({ status: () => ({ pending: 0, blocked: false }), pending: () => [], visible: () => [], draft: () => '', retry: async () => {} });
  });
  const root = page.locator('#conversation-memory').last(), status = root.locator('#memory-status');
  const download = page.waitForEvent('download');
  await root.getByRole('button', { name: 'Exportar historial' }).click();
  await expect.poll(() => page.evaluate(() => typeof (globalThis as any).releaseArchive)).toBe('function');
  await expect(status).toContainText('Preparando copia');
  await page.evaluate(() => (globalThis as any).auditMemory.updateStatus('Estado del archivo actualizado'));
  await expect(status).toContainText('Preparando copia');
  await expect(status).not.toContainText('guardada');
  await page.evaluate(() => (globalThis as any).releaseArchive());
  await download;
  await expect(status).toContainText('Exportación preparada');
  await page.evaluate(() => (globalThis as any).auditMemory.updateStatus());
  await expect(status).toContainText('Exportación preparada');
});
