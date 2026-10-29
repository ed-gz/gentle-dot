import { expect, test } from './fixtures.ts';

test('native import resumes durable chunks after interruption and lost ACK without duplicating work', async ({ page }) => {
  await page.goto('/');
  const first = await page.evaluate(async () => {
    const inbox = await import('/src/work-inbox.ts');
    const data = new Uint8Array(700_123); for (let i = 0; i < data.length; i++) data[i] = (i * 37 + (i >>> 8)) & 255;
    const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map(b => b.toString(16).padStart(2, '0')).join('');
    const file = { id: 'b706ebda-e0b0-4a97-957d-15a9d3048229', name: 'meeting.m4a', type: 'audio/mp4', size: data.length, sha256 };
    const input = { title: 'Reunión', kind: 'meeting' as const, instruction: 'Revisar', files: [file] };
    const source = 'share:9e5658dd-bbc1-46f9-b1fd-3c7db419c33e';
    let calls = 0;
    try { await inbox.createStreamedImportedWork(source, input, async (_f, offset, length) => { if (++calls === 2) throw Error('interrupted'); return data.slice(offset, offset + length); }); } catch { /* native original remains available */ }
    return { source, input, count: (await inbox.listWork()).length, calls };
  });
  expect(first).toMatchObject({ count: 0, calls: 2 });
  await page.reload();
  const recovered = await page.evaluate(async ({ source, input }) => {
    const inbox = await import('/src/work-inbox.ts'); const bridge = await import('/src/device-bridge.ts');
    const bytes = new Uint8Array(input.files[0].size); for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37 + (i >>> 8)) & 255;
    const id = source.slice(6); const f = input.files[0];
    const item = { schemaVersion: 1, id, createdAt: 1, title: input.title, notes: input.instruction, files: [{ id: f.id, name: f.name, mime: f.type, size: f.size, sha256: f.sha256 }] };
    let acknowledgements = 0; let savedId = '';
    const call = async (command: string, request: any) => {
      if (command === 'share_ack') { acknowledgements++; if (acknowledgements === 1) throw Error('lost ACK'); return { ok: true }; }
      const chunk = bytes.subarray(request.offset, request.offset + request.length); let s = ''; for (const b of chunk) s += String.fromCharCode(b);
      return { ok: true, data: btoa(s) };
    };
    const run = () => bridge.importSharedItemStreamed(item, async ({ sourceId, read }) => {
      const work = await inbox.createStreamedImportedWork(sourceId, input, (file, offset, length) => read(item.files.find(x => x.id === file.id)!, offset, length)); savedId = work.id;
    }, call);
    try { await run(); } catch { /* callback lost after durable publication */ }
    const afterLoss = await inbox.listWork(); await run(); const all = await inbox.listWork();
    const stored = await inbox.readWorkFile(savedId, all[0].files[0].id);
    const actual = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await stored!.arrayBuffer()))].map(b => b.toString(16).padStart(2, '0')).join('');
    const range = await inbox.readWorkFileSlice(savedId, all[0].files[0].id, 256 * 1024 - 7, 20);
    const legacy = await inbox.createWork({ title: 'Anterior', kind: 'task', instruction: '', files: [new File(['legacy'], 'file.txt', { type: 'text/plain' })] });
    const legacyBlob = await inbox.readWorkFile(legacy.id, legacy.files[0].id);
    return { afterLoss: afterLoss.length, count: all.length, ids: [afterLoss[0].id, savedId], acknowledgements, actual, range: [...range], expected: [...bytes.slice(256 * 1024 - 7, 256 * 1024 + 13)], legacy: await legacyBlob!.text() };
  }, first);
  expect(recovered).toMatchObject({ afterLoss: 1, count: 1, acknowledgements: 2, actual: first.input.files[0].sha256, legacy: 'legacy' });
  expect(recovered.ids[0]).toBe(recovered.ids[1]); expect(recovered.range).toEqual(recovered.expected);
});

test('quota errors, cancellation and damaged staged chunks never publish or acknowledge the source', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const inbox = await import('/src/work-inbox.ts'); const bridge = await import('/src/device-bridge.ts');
    const bytes = new Uint8Array(300_001).fill(47);
    const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
    const item = { schemaVersion: 1, id: 'cc0224c4-96cc-4d2a-bb36-912a52e88261', createdAt: 1, title: 'Reunión', notes: '', files: [{ id: 'b706ebda-e0b0-4a97-957d-15a9d3048229', name: 'meeting.m4a', mime: 'audio/mp4', size: bytes.length, sha256 }] };
    const input = { title: item.title, kind: 'meeting' as const, instruction: '', files: item.files.map(f => ({ id: f.id, name: f.name, type: f.mime, size: f.size, sha256: f.sha256 })) };
    let ack = 0; const call = async (command: string, request: any) => { if (command === 'share_ack') { ack++; return { ok: true }; } let s = ''; for (const b of bytes.subarray(request.offset, request.offset + request.length)) s += String.fromCharCode(b); return { ok: true, data: btoa(s) }; };
    const run = (signal?: AbortSignal) => bridge.importSharedItemStreamed(item, async ({ sourceId, read }) => { await inbox.createStreamedImportedWork(sourceId, input, (file, offset, length) => read(item.files.find(f => f.id === file.id)!, offset, length), signal); }, call);
    const add = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function(value: any, key?: IDBValidKey) { if (Array.isArray(key) && key[0] === 'chunk') throw new DOMException('Full', 'QuotaExceededError'); return add.call(this, value, key); };
    let quota = false, quotaMessage = ''; try { await run(); } catch (error) { quota = true; quotaMessage = (error as Error).message; } finally { IDBObjectStore.prototype.add = add; }
    const cancelled = new AbortController(); cancelled.abort(); let aborted = false; try { await run(cancelled.signal); } catch { aborted = true; }
    let interrupted = false; try { await inbox.createStreamedImportedWork(`share:${item.id}`, input, async (_f, off, len) => { if (off) throw Error('stop'); return bytes.slice(off, off + len); }); } catch { interrupted = true; }
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const req = indexedDB.open('capri-ios-work-inbox', 1); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
    await new Promise<void>((resolve, reject) => { const tx = db.transaction('files', 'readwrite'); tx.objectStore('files').put(new Uint8Array(256 * 1024).fill(48), ['chunk', `share:${item.id}`, item.files[0].id, 0]); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); }); db.close();
    let damaged = false; try { await run(); } catch { damaged = true; }
    return { quota, quotaMessage, aborted, interrupted, damaged, ack, count: (await inbox.listWork()).length };
  });
  expect(result).toEqual({ quota: true, quotaMessage: 'No hay espacio suficiente en este iPhone. Libera espacio y vuelve a intentarlo; los originales se conservan.', aborted: true, interrupted: true, damaged: true, ack: 0, count: 0 });
});

test('explicit cancellation fences an in-flight writer, retains the source, and allows a later retry', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const inbox = await import('/src/work-inbox.ts'); const bytes = new Uint8Array([1, 2, 3]);
    const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
    const source = 'share:f5b1ab81-51f3-420b-9eb3-2cd580e0001a';
    const input = { title: 'Audio', kind: 'meeting' as const, instruction: '', files: [{ id: 'b706ebda-e0b0-4a97-957d-15a9d3048229', name: 'audio.m4a', type: 'audio/mp4', size: bytes.length, sha256 }] };
    let release!: () => void, started!: () => void;
    const startedPromise = new Promise<void>(r => { started = r; }), barrier = new Promise<void>(r => { release = r; });
    const inFlight = inbox.createStreamedImportedWork(source, input, async () => { started(); await barrier; return bytes; });
    await startedPromise; await inbox.cancelStreamedImport(source);
    const blocked = await inbox.createStreamedImportedWork(source, input, async () => bytes).then(() => false, () => true);
    const count = (await inbox.listWork()).length; await inbox.resumeStreamedImport(source);
    release();
    const rejected = await inFlight.then(() => false, () => true);
    const saved = await inbox.createStreamedImportedWork(source, input, async () => bytes);
    const publishedCancelRejected = await inbox.cancelStreamedImport(source).then(() => false, () => true);
    return { rejected, blocked, count, saved: (await inbox.readWorkFile(saved.id, saved.files[0].id))?.size, publishedCancelRejected };
  });
  expect(result).toEqual({ rejected: true, blocked: true, count: 0, saved: 3, publishedCancelRejected: true });
});

test('range transfer, minute correction and deletion retain shared chunks until the last work is removed', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const inbox = await import('/src/work-inbox.ts'); const sync = await import('/src/work-sync.ts');
    const bytes = new Uint8Array(350_000); for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
    const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
    const source = 'share:d85a372e-a807-40a9-bda4-bc9564ef0e4b';
    const f = { id: 'b706ebda-e0b0-4a97-957d-15a9d3048229', name: 'audio.m4a', type: 'audio/mp4', size: bytes.length, sha256 };
    let work = await inbox.createStreamedImportedWork(source, { title: 'Audio', kind: 'meeting', instruction: '', files: [f] }, async (_f, offset, length) => bytes.slice(offset, offset + length));
    work = await inbox.transitionWork(work.id, work.revision, 'prepared'); work = await inbox.transitionWork(work.id, work.revision, 'approved');
    let manifest: any, manifestHash = '', offset = 0; const received: number[] = [];
    const dispatcher = sync.createWorkDispatcher(async (req: any) => {
      const base = { type: 'work_sync_reply', requestId: req.requestId, transferId: req.transferId };
      if (req.operation === 'begin') { manifest = req.manifest; manifestHash = req.manifestHash; }
      if (req.operation === 'chunk') { const chunk = atob(req.data); for (const char of chunk) received.push(char.charCodeAt(0)); offset += chunk.length; }
      if (req.operation === 'commit') return { ...base, state: 'committed', receipt: { transferId: req.transferId, workId: manifest.workId, revision: manifest.revision, manifestHash, committedAt: 1 } };
      return { ...base, state: 'uploading', manifestHash, offsets: { [manifest.files[0].id]: offset } };
    }, 'wss://host/ws');
    work = await dispatcher.send(work.id, work.revision);
    const correctBytes = received.length === bytes.length && received.every((v, i) => v === bytes[i]);
    const result = { schema: 1, manifestHash, createdAt: 1, model: 'test', minutes: { title: 'Reunión', summary: 'Borrador', items: [] }, evidence: [], transcriptComparison: '', requiresReview: true };
    work = await inbox.saveWorkResult(work.id, work.transfer!.transferId, result);
    const correction = await inbox.createWorkFromResult(work.id, work.revision);
    const setRefs = async (refs: number) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => { const req = indexedDB.open('capri-ios-work-inbox', 1); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
      await new Promise<void>((resolve, reject) => { const tx = db.transaction('files', 'readwrite'), store = tx.objectStore('files'), key = ['stage', source, f.id], request = store.get(key); request.onsuccess = () => store.put({ ...request.result, refs }, key); tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); }); db.close();
    };
    await setRefs(1);
    const corruptedRefRejected = await inbox.deleteWork(work.id, work.revision).then(() => false, () => true);
    await setRefs(2);
    await inbox.deleteWork(work.id, work.revision);
    const stillThere = await inbox.readWorkFileSlice(correction.id, correction.files[0].id, 250_000, 100);
    await inbox.deleteWork(correction.id, correction.revision);
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const req = indexedDB.open('capri-ios-work-inbox', 1); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
    const keys = await new Promise<IDBValidKey[]>((resolve, reject) => { const tx = db.transaction('files'); const req = tx.objectStore('files').getAllKeys(); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); }); db.close();
    return { correctBytes, corruptedRefRejected, preserved: stillThere.every((v, i) => v === bytes[250_000 + i]), chunksRemain: keys.some(key => Array.isArray(key) && (key[0] === 'chunk' || key[0] === 'stage') && key[1] === source) };
  });
  expect(result).toEqual({ correctBytes: true, corruptedRefRejected: true, preserved: true, chunksRemain: false });
});

test('competing windows publish the same source once and conflicting bytes cannot overwrite a staged chunk', async ({ context }) => {
  const one = await context.newPage(); const two = await context.newPage();
  await Promise.all([one.goto('/'), two.goto('/')]);
  const run = (page: typeof one) => page.evaluate(async () => {
    const inbox = await import('/src/work-inbox.ts'); const bytes = new Uint8Array(280_000).fill(82);
    const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
    const input = { title: 'Misma reunión', kind: 'meeting' as const, instruction: '', files: [{ id: 'b706ebda-e0b0-4a97-957d-15a9d3048229', name: 'audio.m4a', type: 'audio/mp4', size: bytes.length, sha256 }] };
    const work = await inbox.createStreamedImportedWork('share:ea499afa-182e-468b-bc53-a6f1b0e0e4df', input, async (_f, offset, length) => bytes.slice(offset, offset + length)); return work.id;
  });
  const ids = await Promise.all([run(one), run(two)]);
  expect(ids[0]).toBe(ids[1]);
  expect(await one.evaluate(async () => (await (await import('/src/work-inbox.ts')).listWork()).length)).toBe(1);
  const conflictingRejected = await one.evaluate(async () => {
    const inbox = await import('/src/work-inbox.ts'); const bytes = new Uint8Array(280_000).fill(82);
    const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
    const input = { title: 'Misma reunión', kind: 'meeting' as const, instruction: '', files: [{ id: 'b706ebda-e0b0-4a97-957d-15a9d3048229', name: 'audio.m4a', type: 'audio/mp4', size: bytes.length, sha256 }] };
    return inbox.createStreamedImportedWork('share:ea499afa-182e-468b-bc53-a6f1b0e0e4df', input, async (_f, _offset, length) => new Uint8Array(length).fill(83)).then(() => false, () => true);
  });
  expect(conflictingRejected).toBe(true);
});

test('a 26 MiB audio survives reload, refuses a legacy host, and reaches a capable host by bounded ranges', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  const created = await page.evaluate(async () => {
    const inbox = await import('/src/work-inbox.ts'); const size = 26 * 1024 * 1024 + 17; const bytes = new Uint8Array(size);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 13 + (i >>> 11)) & 255;
    const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
    const file = { id: 'b706ebda-e0b0-4a97-957d-15a9d3048229', name: 'reunion.m4a', type: 'audio/mp4', size, sha256 };
    let maxRead = 0;
    let work = await inbox.createStreamedImportedWork('share:cca902f9-9c01-4d2b-b942-d535ec8a4fc0', { title: 'Reunión larga', kind: 'meeting', instruction: '', files: [file] }, async (_file, offset, length) => { maxRead = Math.max(maxRead, length); return bytes.slice(offset, offset + length); });
    work = await inbox.transitionWork(work.id, work.revision, 'prepared'); work = await inbox.transitionWork(work.id, work.revision, 'approved');
    return { id: work.id, revision: work.revision, size, sha256, maxRead };
  });
  expect(created.maxRead).toBeLessThanOrEqual(256 * 1024);
  await page.reload();
  const sent = await page.evaluate(async input => {
    const inbox = await import('/src/work-inbox.ts'); const sync = await import('/src/work-sync.ts'); let legacyCalls = 0;
    const legacy = sync.createWorkDispatcher(async () => { legacyCalls++; throw Error('unexpected network'); }, 'wss://host/ws');
    const rejection = await legacy.send(input.id, input.revision).then(() => '', e => e.message);
    const after = await inbox.readWork(input.id);
    const output = new Uint8Array(input.size); let offset = 0, maxChunk = 0, manifest: any, manifestHash = '';
    const modern = sync.createWorkDispatcher(async (request: any) => {
      const base = { type: 'work_sync_reply', requestId: request.requestId, transferId: request.transferId };
      if (request.operation === 'begin') { manifest = request.manifest; manifestHash = request.manifestHash; }
      if (request.operation === 'chunk') { const chunk = atob(request.data); maxChunk = Math.max(maxChunk, chunk.length); for (let i = 0; i < chunk.length; i++) output[offset + i] = chunk.charCodeAt(i); offset += chunk.length; }
      if (request.operation === 'commit') return { ...base, state: 'committed', receipt: { transferId: request.transferId, workId: manifest.workId, revision: manifest.revision, manifestHash, committedAt: 1 } };
      return { ...base, state: 'uploading', manifestHash, offsets: { [manifest.files[0].id]: offset } };
    }, 'wss://host/ws', { audioBytes: 128 * 1024 * 1024, attachmentBytes: 256 * 1024 * 1024 });
    const final = await modern.send(input.id, input.revision);
    const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', output))].map(b => b.toString(16).padStart(2, '0')).join('');
    return { rejection, legacyCalls, legacyStatus: after.status, status: final.status, size: offset, sha256, maxChunk };
  }, created);
  expect(sent.rejection).toContain('Actualiza Gentle Dot'); expect(sent.legacyCalls).toBe(0); expect(sent.legacyStatus).toBe('approved');
  expect(sent).toMatchObject({ status: 'sent', size: created.size, sha256: created.sha256 }); expect(sent.maxChunk).toBeLessThanOrEqual(64 * 1024);
});
