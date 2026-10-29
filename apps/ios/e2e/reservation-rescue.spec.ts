import { expect, test } from './fixtures.ts';

test('blocked reservation export preserves draft and messages without private transport alias', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const { createConversationJournal } = await import('/src/conversation-journal.ts');
    const { createConversationArchive } = await import('/src/conversation-archive.ts');
    const { mountReservationRescue } = await import('/src/reservation-rescue-view.ts');
    const suffix = crypto.randomUUID(), journal = createConversationJournal({ databaseName: `rescue-window-${suffix}`,
      archive: createConversationArchive({ databaseName: `rescue-archive-${suffix}` }) });
    const id = crypto.randomUUID(), entry = { id: 'host:wss://fixture.example/ws|main|turn-1', engine: 'gentle', role: 'user', state: 'complete', text: 'Solicitud visible', transportText: 'ALIAS PRIVADO TOKEN_SECRETO_DE_PRUEBA', branchUnverified: true, at: 1000 };
    const reservation = await journal.begin({ id, baseRevision: 0, snapshot: { entries: [entry], draft: 'Borrador pendiente', attachedWork: 'work_a', revision: 1 }, pending: [entry] });
    const root = document.createElement('section'); root.id = 'reservation-rescue-fixture'; document.body.append(root);
    const state = globalThis as any; state.reservationRescue = mountReservationRescue(root, { pending: journal.pending,
      deliver: async (blob: Blob) => { state.rescueBlob = await blob.text(); return 'exported'; } });
    state.reservationJournal = journal; state.reservationRescue.show(reservation);
  });
  const root = page.locator('#reservation-rescue-fixture');
  await root.getByRole('button', { name: 'Exportar reserva pendiente' }).click();
  await expect(root.getByRole('status')).toContainText('Copia guardada');
  const result = await page.evaluate(async () => ({ text: (globalThis as any).rescueBlob, pending: await (globalThis as any).reservationJournal.pending() }));
  const rows = result.text.trim().split('\n').map((line: string) => JSON.parse(line));
  expect(rows[0]).toMatchObject({ schema: 'capri-conversation-reservation-rescue/v1', committed: false, visibleEntries: 1, pendingEntries: 1 });
  expect(rows[1]).toMatchObject({ text: 'Borrador pendiente', attachedWork: 'work_a', submitted: false });
  expect(rows.filter((row: any) => row.text === 'Solicitud visible')).toHaveLength(2);
  expect(rows.filter((row: any) => row.text === 'Solicitud visible').every((row: any) => row.branchUnverified === true)).toBe(true);
  expect(result.text).not.toContain('ALIAS PRIVADO');
  expect(result.text).not.toContain('TOKEN_SECRETO_DE_PRUEBA');
  expect(result.text).not.toContain('transportText');
  expect(result.pending.snapshot.draft).toBe('Borrador pendiente');
});

test('failed or stale export stays visible and never deletes the reservation', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const { createConversationJournal } = await import('/src/conversation-journal.ts');
    const { createConversationArchive } = await import('/src/conversation-archive.ts');
    const { mountReservationRescue } = await import('/src/reservation-rescue-view.ts');
    const suffix = crypto.randomUUID(), journal = createConversationJournal({ databaseName: `rescue-failed-${suffix}`,
      archive: createConversationArchive({ databaseName: `rescue-failed-archive-${suffix}` }) });
    const reservation = await journal.begin({ id: crypto.randomUUID(), baseRevision: 0, snapshot: { entries: [], draft: 'Se conserva', revision: 1 }, pending: [] });
    const root = document.createElement('section'); root.id = 'reservation-rescue-fixture'; document.body.append(root);
    const state = globalThis as any; state.deliveryCalls = 0;
    state.reservationRescue = mountReservationRescue(root, { pending: async () => state.stale ? undefined : journal.pending(),
      deliver: async () => { state.deliveryCalls++; throw new Error('picker no disponible'); } });
    state.reservationJournal = journal; state.reservationRescue.show(reservation);
  });
  const root = page.locator('#reservation-rescue-fixture'), button = root.getByRole('button', { name: 'Exportar reserva pendiente' });
  await button.click();
  await expect(root.getByRole('status')).toContainText('No pude confirmar');
  await expect(button).toBeEnabled();
  await page.evaluate(() => { (globalThis as any).stale = true; });
  await button.click();
  await expect(root.getByRole('status')).toContainText('La reserva cambió');
  await expect(root).toBeVisible();
  expect(await page.evaluate(() => (globalThis as any).deliveryCalls)).toBe(1);
  expect((await page.evaluate(async () => (globalThis as any).reservationJournal.pending())).snapshot.draft).toBe('Se conserva');
});

test('the chat shows reservation rescue only while a blocked save needs review', async ({ page }) => {
  await page.addInitScript(() => {
    const state = globalThis as any; state.isTauri = true;
    state.__TAURI_INTERNALS__ = { invoke: async (command: string) => {
      if (command.endsWith('results_list')) return { ok: true, items: [] };
      if (command.endsWith('share_list') || command.endsWith('documents_list')) return { ok: true, items: [] };
      if (command.endsWith('check_availability')) return { available: true, status: 'available', supportsSpanish: true };
      if (command.endsWith('agent_step')) throw new Error('must not infer without a checkpoint');
      return { ok: true };
    } };
  });
  await page.goto('/'); await expect(page.locator('#send')).toBeEnabled();
  const button = page.getByRole('button', { name: 'Exportar reserva pendiente' });
  await expect(button).toBeHidden();
  await page.evaluate(async () => {
    const { conversationArchive } = await import('/src/conversation-archive.ts');
    conversationArchive.upsert = async () => { throw new Error('Cuota simulada'); };
  });
  await page.locator('#prompt').fill('Instrucción que debo recuperar');
  await page.locator('#send').click();
  await expect(button).toBeVisible();
  await button.click();
  await expect(page.getByText('No pude confirmar la exportación. La reserva se conserva.')).toBeVisible();
  await expect(button).toBeEnabled();
  await page.evaluate(() => { (globalThis as any).isTauri = false; });
  const download = page.waitForEvent('download'); await button.click();
  const file = await download;
  const text = (await import('node:fs/promises')).readFile(await file.path(), 'utf8');
  expect(await text).toContain('Instrucción que debo recuperar');
  expect(await text).not.toContain('transportText');
  await expect(button).toBeVisible();
  const pending = await page.evaluate(async () => (await (await import('/src/conversation-journal.ts')).createConversationJournal().pending()));
  expect(pending?.pending.some(entry => entry.text === 'Instrucción que debo recuperar')).toBe(true);
});

test('a reservation blocked during startup stays exportable without opening Archivo', async ({ page }) => {
  await page.addInitScript(() => {
    const original = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (names: string | string[], mode?: IDBTransactionMode, options?: IDBTransactionOptions) {
      if (sessionStorage.getItem('archive-unavailable') === 'yes' && this.name === 'capri-ios-conversation-archive' && mode === 'readwrite') throw new DOMException('Cuota simulada', 'QuotaExceededError');
      return Reflect.apply(original, this, options ? [names, mode, options] : mode ? [names, mode] : [names]);
    };
  });
  await page.goto('/'); await expect(page.locator('#history-loading')).toBeHidden();
  await expect.poll(() => page.evaluate(async () => (await (await import('/src/conversation.ts')).loadConversationBase())?.revision ?? 0)).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(async () => Boolean(await (await import('/src/conversation-journal.ts')).createConversationJournal().pending()))).toBe(false);
  await page.evaluate(async () => {
    const { loadConversationBase } = await import('/src/conversation.ts');
    const { createConversationJournal } = await import('/src/conversation-journal.ts');
    const base = await loadConversationBase(); if (!base) throw new Error('No base');
    const revision = (base.revision ?? 0) + 1;
    await createConversationJournal().begin({ id: crypto.randomUUID(), baseRevision: base.revision ?? 0, base,
      snapshot: { ...base, draft: 'Borrador de reserva pendiente', revision }, pending: [] });
    sessionStorage.setItem('archive-unavailable', 'yes');
    window.addEventListener('pagehide', event => event.stopImmediatePropagation(), true);
  });
  await page.reload();
  const button = page.getByRole('button', { name: 'Exportar reserva pendiente' });
  await expect(button).toBeVisible();
  await expect(page.locator('#send')).toBeDisabled();
  const download = page.waitForEvent('download'); await button.click();
  const text = await (await import('node:fs/promises')).readFile(await (await download).path(), 'utf8');
  expect(text).toContain('Borrador de reserva pendiente');
  await expect(button).toBeVisible();
  const pending = await page.evaluate(async () => (await (await import('/src/conversation-journal.ts')).createConversationJournal().pending()));
  expect(pending?.snapshot.draft).toBe('Borrador de reserva pendiente');
});
