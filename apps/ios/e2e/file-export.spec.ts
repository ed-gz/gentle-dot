import { expect, test, openRecoveryHarness, type Page } from './fixtures.ts';

async function nativeExporter(page: Page) {
  await page.addInitScript(() => {
    const state = globalThis as any; state.isTauri = true; state.exportCalls = []; state.exportedPayloads = [];
    let hashChunks: Uint8Array[] = [], outputChunks: Uint8Array[] = [], outputSize = 0, metadata: any;
    const bytes = (base64: string) => Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const digest = async (parts: Uint8Array[]) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await new Blob(parts as BlobPart[]).arrayBuffer()))).map(value => value.toString(16).padStart(2, '0')).join('');
    state.__TAURI_INTERNALS__ = { invoke: async (command: string, args: any) => {
      if (command.endsWith('results_list')) return { ok: true, items: [] };
      const name = command.split('|').at(-1)!; const request = args?.request ?? {};
      if (name.startsWith('crypto_hash_') || name.startsWith('export_')) state.exportCalls.push({ name, ...(name === 'export_write' ? { offset: request.offset, bytes: bytes(request.data).length } : {}) });
      if (name === 'share_list' || name === 'documents_list') return { ok: true, items: [] };
      if (name === 'check_availability') return { available: false, status: 'device_not_eligible', supportsSpanish: false };
      if (name === 'crypto_hash_begin') { hashChunks = []; return { ok: true, id: '00000000-0000-0000-0000-000000000001' }; }
      if (name === 'crypto_hash_update') { hashChunks.push(bytes(request.data)); return { ok: true }; }
      if (name === 'crypto_hash_finish') return { ok: true, hex: await digest(hashChunks) };
      if (name === 'export_begin') { metadata = request; outputChunks = []; outputSize = 0; return { ok: true, id: '00000000-0000-0000-0000-000000000002' }; }
      if (name === 'export_write') {
        if (request.offset !== outputSize) throw new Error('Offset mismatch'); const chunk = bytes(request.data); outputChunks.push(chunk); outputSize += chunk.length;
        return { ok: true, written: outputSize };
      }
      if (name === 'export_present') {
        if (outputSize !== metadata.size || await digest(outputChunks) !== metadata.sha256) throw new Error('Digest mismatch');
        state.exportedPayloads.push({ name: metadata.name, size: outputSize, sha256: metadata.sha256, text: await new Blob(outputChunks as BlobPart[]).text() });
        state.exportPending = true;
        return new Promise(resolve => { state.finishFileExport = (reply: unknown) => { state.exportPending = false; resolve(reply); }; });
      }
      return { ok: true };
    } };
  });
}
async function finish(page: Page, result: 'success' | 'cancel' | 'error') {
  await expect.poll(() => page.evaluate(() => (globalThis as any).exportPending)).toBe(true);
  await page.evaluate(result => (globalThis as any).finishFileExport(result === 'success'
    ? { ok: true, exported: true, cancelled: false } : result === 'cancel' ? { ok: true, exported: false, cancelled: true }
      : { ok: false, message: 'El selector no pudo guardar la copia.' }), result);
}

test('native history export waits for a real callback, preserves content on cancellation/error and never downloads through the browser', async ({ page }) => {
  const downloads: string[] = []; page.on('download', file => downloads.push(file.suggestedFilename()));
  await nativeExporter(page); await page.goto('/'); await page.locator('#prompt').fill('Borrador que no se envió.');
  await openRecoveryHarness(page);
  const button = page.locator('#memory-export'), status = page.locator('#memory-status');
  await button.click(); await expect.poll(() => page.evaluate(() => (globalThis as any).exportPending)).toBe(true);
  await expect(button).toBeDisabled(); await expect(status).toContainText('Preparando copia'); await expect(status).not.toContainText('guardada');
  await finish(page, 'success'); await expect(status).toContainText('Copia del historial guardada en Archivos'); await expect(button).toBeEnabled();
  const first = await page.evaluate(() => (globalThis as any).exportedPayloads[0]);
  expect(first.name).toMatch(/^capri-conversacion-.*\.ndjson$/);
  expect(first.text.split('\n').filter(Boolean).map((line: string) => JSON.parse(line))).toContainEqual({ schema: 'capri-conversation-draft/v1', source: 'visible-draft', submitted: false, text: 'Borrador que no se envió.' });
  await button.click(); await finish(page, 'cancel'); await expect(status).toContainText('Exportación cancelada'); await expect(button).toBeEnabled();
  await button.click(); await finish(page, 'error'); await expect(status).toContainText('No se confirmó la exportación'); await expect(button).toBeEnabled();
  await page.locator('[data-panel="chat"]').click(); await expect(page.locator('#prompt')).toHaveValue('Borrador que no se envió.');
  expect(downloads).toEqual([]);
  expect(await page.evaluate(() => (globalThis as any).exportCalls.filter((item: any) => item.name === 'export_present').length)).toBe(3);
});

test('native attachment export copies exact bytes in chunks and cancellation retains the original Blob', async ({ page }) => {
  const downloads: string[] = []; page.on('download', file => downloads.push(file.suggestedFilename()));
  await nativeExporter(page); await page.goto('/');
  await page.evaluate(async () => {
    const { createWork } = await import('/src/work-inbox.ts');
    const bytes = new Uint8Array(700000); for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
    const work = await createWork({ title: 'Audio original', kind: 'meeting', instruction: 'Conservar los bytes originales.', files: [new File([bytes], 'reunion.m4a', { type: 'audio/mp4' })] });
    (globalThis as any).exportWork = { id: work.id, fileId: work.files[0].id };
  });
  await openRecoveryHarness(page);
  const item = page.locator('#work-list .work-item'); await item.locator('summary').filter({ hasText: 'Archivos (1)' }).click();
  const button = item.getByRole('button', { name: 'Descargar reunion.m4a' }), status = page.locator('#work-status');
  await button.click(); await expect.poll(() => page.evaluate(() => (globalThis as any).exportPending)).toBe(true);
  await expect(button).toBeDisabled(); await expect(status).not.toContainText('Copia guardada');
  await finish(page, 'cancel'); await expect(status).toContainText('Exportación cancelada'); await expect(button).toBeEnabled();
  await button.click(); await finish(page, 'success'); await expect(status).toContainText('Copia guardada en Archivos'); await expect(button).toBeEnabled();
  const result = await page.evaluate(async () => {
    const state = globalThis as any; const { readWorkFile } = await import('/src/work-inbox.ts');
    const blob = await readWorkFile(state.exportWork.id, state.exportWork.fileId); const bytes = new Uint8Array(await blob!.arrayBuffer());
    return { size: bytes.length, unchanged: bytes.every((byte, index) => byte === index % 251), writes: state.exportCalls.filter((item: any) => item.name === 'export_write').map((item: any) => item.bytes), names: state.exportedPayloads.map((item: any) => item.name) };
  });
  expect(result).toEqual({ size: 700000, unchanged: true, writes: [262144,262144,175712,262144,262144,175712], names: ['reunion.m4a','reunion.m4a'] });
  expect(downloads).toEqual([]);
});

test('corrupted chunk-backed attachment is rejected before export or transfer approval', async ({ page }) => {
  await nativeExporter(page); await page.goto('/');
  const id = await page.evaluate(async () => {
    const inbox = await import('/src/work-inbox.ts'); const bytes = new TextEncoder().encode('original');
    const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
    const source = 'share:739e894c-5c98-4f72-9f40-1a831d05bc01', fileId = 'b706ebda-e0b0-4a97-957d-15a9d3048229';
    const work = await inbox.createStreamedImportedWork(source, { title: 'Reunión', kind: 'meeting', instruction: '', files: [{ id: fileId, name: 'audio.m4a', type: 'audio/mp4', size: bytes.length, sha256 }] }, async () => bytes);
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const req = indexedDB.open('capri-ios-work-inbox', 1); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
    await new Promise<void>((resolve, reject) => { const tx = db.transaction('files', 'readwrite'); tx.objectStore('files').put(new TextEncoder().encode('alterado'), ['chunk', source, fileId, 0]); tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); }); db.close();
    let approved = await inbox.transitionWork(work.id, work.revision, 'prepared'); approved = await inbox.transitionWork(work.id, approved.revision, 'approved');
    const sync = await import('/src/work-sync.ts'); const transferRejected = await sync.prepareWorkTransfer(approved, 'wss://host/ws').then(() => false, () => true);
    return { id: work.id, transferRejected };
  });
  expect(id.transferRejected).toBe(true);
  await openRecoveryHarness(page);
  const item = page.locator(`[data-work-id="${id.id}"]`); await item.locator('summary').filter({ hasText: 'Archivos (1)' }).click();
  await item.getByRole('button', { name: 'Descargar audio.m4a' }).click();
  await expect(page.locator('#work-status')).toContainText('No se pudo recuperar');
  expect(await page.evaluate(() => (globalThis as any).exportCalls.some((call: any) => call.name === 'export_begin'))).toBe(false);
});
