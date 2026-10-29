import { expect, test } from './fixtures.ts';

async function fixture(page: import('@playwright/test').Page, size = 20, state: 'retained' | 'released' = 'released') {
  await page.goto('/');
  await page.evaluate(async ({ size, state }) => {
    const { mountNativeVoiceRecovery } = await import('/src/native-voice-recovery-view.ts');
    const id = 'ABCDEF01-ABCD-4BCD-8BCD-ABCDEF012345', text = 'x'.repeat(size);
    const receipt = { schema: 'capri-native-voice-receipt/v1', audio: { id, owner: 'abcdef02-abcd-4bcd-8bcd-abcdef012345', destination: 'chat', locale: 'es-MX', kind: 'speech', createdAt: 1, state: 'ready', byteCount: 10, sha256: 'a'.repeat(64) },
      transcript: { sessionId: id, text, segments: [{ text, startSeconds: 0, endSeconds: 1 }], durationSeconds: 1, locale: 'es-MX', source: 'apple-speech-analyzer' } };
    const globals = globalThis as any;
    globals.voiceFixture = { item: { receipt, releaseState: state }, appended: [], exported: [], exportCancelled: false, releases: 0, discards: 0, failRelease: false, confirm: true };
    const root = document.createElement('section'); root.id = 'native-voice-fixture'; document.body.append(root);
    globals.voiceRecovery = mountNativeVoiceRecovery(root, { store: {
      list: async () => globals.voiceFixture.item ? [structuredClone(globals.voiceFixture.item)] : [],
      get: async () => globals.voiceFixture.item ? structuredClone(globals.voiceFixture.item) : undefined,
      release: async () => { if (globals.voiceFixture.failRelease) throw new Error('fail'); globals.voiceFixture.releases++; globals.voiceFixture.item.releaseState = 'released'; },
      discard: async () => { globals.voiceFixture.discards++; globals.voiceFixture.item = undefined; },
    }, isDelivered: async () => false, append: (r: any) => { globals.voiceFixture.appended.push(r.transcript.text); }, exportTranscript: async (r: any) => { globals.voiceFixture.exported.push(r.transcript.text); return globals.voiceFixture.exportCancelled ? 'cancelled' : 'exported'; }, confirmRelease: () => globals.voiceFixture.confirm, confirmDiscard: () => globals.voiceFixture.confirm });
    await globals.voiceRecovery.refresh();
  }, { size, state });
  return page.locator('#native-voice-fixture');
}

test('a long transcript remains complete and selectable without attempting to insert', async ({ page }) => {
  const root = await fixture(page, 12000); await root.locator('summary').click();
  await expect(root.locator('.voice-receipt-text')).toHaveText('x'.repeat(12000));
  await expect(root.getByRole('button', { name: 'Añadir al mensaje' })).toBeDisabled();
  await expect(root.getByRole('status')).toContainText('Selecciona y copia fragmentos');
  expect(await page.evaluate(() => (globalThis as any).voiceFixture.appended)).toEqual([]);
});

test('another session can be reviewed and exported without insertion, including cancellation', async ({ page }) => {
  const root = await fixture(page, 12000, 'retained');
  await page.evaluate(async () => { const state = globalThis as any; state.voiceFixture.item.receipt.audio.destination = `session:${'a'.repeat(64)}`; await state.voiceRecovery.refresh(); });
  await root.getByText('Dictado de otra sesión').click();
  await expect(root).toContainText('No se añadirá a esta conversación');
  await expect(root.locator('.voice-receipt-text')).toHaveText('x'.repeat(12000));
  await expect(root.getByRole('button', { name: 'Añadir al mensaje' })).toBeHidden();
  const exportButton = root.getByRole('button', { name: 'Exportar texto' });
  await exportButton.focus();
  await page.evaluate(async () => { await (globalThis as any).voiceRecovery.refresh(); });
  await expect(exportButton).toBeFocused();
  await expect(root.locator('details')).toHaveAttribute('open', '');
  await page.evaluate(() => { (globalThis as any).voiceFixture.exportCancelled = true; });
  await exportButton.click();
  await expect(root.getByRole('status')).toContainText('Exportación cancelada');
  await page.evaluate(() => { (globalThis as any).voiceFixture.exportCancelled = false; });
  await exportButton.click();
  await expect(root.getByRole('status')).toContainText('Texto exportado');
  expect(await page.evaluate(() => ({ exported: (globalThis as any).voiceFixture.exported, appended: (globalThis as any).voiceFixture.appended, releases: (globalThis as any).voiceFixture.releases }))).toEqual({ exported: ['x'.repeat(12000), 'x'.repeat(12000)], appended: [], releases: 0 });
});

test('a synthetic click cannot insert another session into this conversation', async ({ page }) => {
  const root = await fixture(page, 20, 'retained');
  await page.evaluate(async () => { const state = globalThis as any; state.voiceFixture.item.receipt.audio.destination = `session:${'a'.repeat(64)}`; await state.voiceRecovery.refresh(); });
  await root.getByText('Dictado de otra sesión').click();
  await root.getByRole('button', { name: 'Añadir al mensaje', includeHidden: true }).evaluate(node => node.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  expect(await page.evaluate(() => (globalThis as any).voiceFixture.appended)).toEqual([]);
});

test('a retained audio is released only on its explicit action; failures remain retryable', async ({ page }) => {
  const root = await fixture(page, 20, 'retained'); await root.locator('summary').click();
  const release = root.getByRole('button', { name: 'Eliminar audio' });
  await expect(root.getByRole('button', { name: 'Eliminar copia' })).toBeDisabled();
  await page.evaluate(() => { (globalThis as any).voiceFixture.confirm = false; });
  await release.click();
  expect(await page.evaluate(() => (globalThis as any).voiceFixture.releases)).toBe(0);
  await expect(release).toBeEnabled();
  await page.evaluate(() => { (globalThis as any).voiceFixture.confirm = true; });
  await page.evaluate(() => { (globalThis as any).voiceFixture.failRelease = true; });
  await release.click(); await expect(root.getByRole('status')).toContainText('No pude confirmar'); await expect(release).toBeEnabled();
  await page.evaluate(() => { (globalThis as any).voiceFixture.failRelease = false; });
  await release.click(); await root.locator('summary').click();
  await expect(root.getByRole('button', { name: 'Eliminar copia' })).toBeEnabled();
  expect(await page.evaluate(() => (globalThis as any).voiceFixture.releases)).toBe(1);
});

test('changed receipts never insert or delete, and insertion needs an explicit gesture', async ({ page }) => {
  const root = await fixture(page); await root.locator('summary').click();
  await page.evaluate(() => { (globalThis as any).voiceFixture.item.receipt.transcript.text = 'otro'; });
  await root.getByRole('button', { name: 'Añadir al mensaje' }).click();
  await expect(root.getByRole('status')).toContainText('No pude añadirlo');
  await root.getByRole('button', { name: 'Eliminar copia' }).click();
  expect(await page.evaluate(() => ({ appended: (globalThis as any).voiceFixture.appended, discards: (globalThis as any).voiceFixture.discards }))).toEqual({ appended: [], discards: 0 });
});

test('one invalid delivery marker does not hide the other saved dictations', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const { mountNativeVoiceRecovery } = await import('/src/native-voice-recovery-view.ts');
    const { createNativeVoiceDelivery, NATIVE_VOICE_DELIVERY_PREFIX } = await import('/src/native-voice-delivery.ts');
    const name = `voice-invalid-marker-${crypto.randomUUID()}`;
    const ids = ['abcdef01-abcd-4bcd-8bcd-abcdef012345', 'abcdef02-abcd-4bcd-8bcd-abcdef012345'];
    const items = ids.map((id, index) => ({ receipt: { schema: 'capri-native-voice-receipt/v1', audio: { id, owner: 'abcdef03-abcd-4bcd-8bcd-abcdef012345', destination: 'chat', locale: 'es-MX', kind: 'speech', createdAt: 1, state: 'ready', byteCount: 10, sha256: 'a'.repeat(64) }, transcript: { sessionId: id, text: `Dictado ${index + 1}`, segments: [{ text: `Dictado ${index + 1}`, startSeconds: 0, endSeconds: 1 }], durationSeconds: 1, locale: 'es-MX', source: 'apple-speech-analyzer' } }, releaseState: 'released' }));
    await new Promise<void>((resolve, reject) => { const req = indexedDB.open(name, 1); req.onupgradeneeded = () => req.result.createObjectStore('conversation'); req.onerror = () => reject(req.error); req.onsuccess = () => { const db = req.result, tx = db.transaction('conversation', 'readwrite'); tx.objectStore('conversation').put({ corrupt: true }, NATIVE_VOICE_DELIVERY_PREFIX + ids[0]); tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => reject(tx.error); }; });
    const root = document.createElement('section'); root.id = 'voice-marker-audit'; document.body.append(root);
    const state = globalThis as any; state.voiceAudit = { appended: [], discarded: 0, name, id: ids[0] };
    const view = mountNativeVoiceRecovery(root, { store: { list: async () => items as any, get: async id => items.find(item => item.receipt.audio.id === id) as any, release: async () => {}, discard: async () => { state.voiceAudit.discarded++; } }, isDelivered: createNativeVoiceDelivery({ databaseName: name }).delivered, append: async receipt => { state.voiceAudit.appended.push(receipt.transcript.text); }, confirmRelease: () => false, confirmDiscard: () => false });
    await view.refresh();
  });
  const root = page.locator('#voice-marker-audit');
  await expect(root.locator('summary')).toHaveCount(2);
  const first = root.locator('details').nth(0), second = root.locator('details').nth(1);
  await first.locator('summary').click(); await second.locator('summary').click();
  await expect(first).toContainText('Dictado 1');
  await expect(first).toContainText('No pude verificar');
  await first.getByRole('button', { name: 'Añadir al mensaje', includeHidden: true }).evaluate(node => node.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await second.getByRole('button', { name: 'Añadir al mensaje' }).click();
  await expect.poll(() => page.evaluate(() => (globalThis as any).voiceAudit.appended)).toEqual(['Dictado 2']);
  expect(await page.evaluate(() => (globalThis as any).voiceAudit.discarded)).toBe(0);
  await page.evaluate(async () => { const { name, id } = (globalThis as any).voiceAudit; await new Promise<void>((resolve, reject) => { const req = indexedDB.open(name, 1); req.onerror = () => reject(req.error); req.onsuccess = () => { const db = req.result, tx = db.transaction('conversation', 'readwrite'); tx.objectStore('conversation').delete(`native-voice-delivery:v1:${id}`); tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => reject(tx.error); }; }); });
  await first.getByRole('button', { name: 'Revisar estado' }).click();
  await root.locator('details').nth(0).locator('summary').click();
  await expect(root.locator('details').nth(0).getByRole('button', { name: 'Añadir al mensaje' })).toBeVisible();
  expect(await page.evaluate(() => (globalThis as any).voiceAudit.appended)).toEqual(['Dictado 2']);
});

test('capacity cleanup keeps unverifiable receipts and only admits capture after space is available', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { prepareNativeVoiceCapacity } = await import('/src/protected-voice.ts');
    let values = Array.from({ length: 100 }, (_, index) => ({ receipt: { audio: { destination: 'chat', id: String(index) } }, releaseState: 'released' }));
    const removed: string[] = [], eligible = (receipt: any) => receipt.audio.destination === 'chat';
    const list = async () => values as any;
    const blocked = await Promise.allSettled([prepareNativeVoiceCapacity({ list, eligible, cleanup: async () => { throw new Error('unverified'); } })]);
    await prepareNativeVoiceCapacity({ list, eligible, cleanup: async (receipt: any) => { if (receipt.audio.id === '0') throw new Error('unverified'); if (receipt.audio.id === '1') { removed.push(receipt.audio.id); values = values.filter(item => item.receipt.audio.id !== receipt.audio.id); } } });
    return { blocked: blocked[0].status, remaining: values.length, untouched: values.some(item => item.receipt.audio.id === '0'), removed };
  });
  expect(result).toEqual({ blocked: 'rejected', remaining: 99, untouched: true, removed: ['1'] });
});
