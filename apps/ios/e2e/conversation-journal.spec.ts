import { expect, test } from './fixtures.ts';

test('a page exceeding the reservation limit leaves the original journal intact',async({page})=>{
 await page.goto('/');
 const result=await page.evaluate(async()=>{
  const {createConversationJournal}=await import('/src/conversation-journal.ts');
  const id=crypto.randomUUID(),journal=createConversationJournal({databaseName:`append-limit-${crypto.randomUUID()}`});
  const prefix='host:wss://example.test/ws|chat|';
  const pending=Array.from({length:10000},(_,index)=>({id:`${prefix}${index}`,engine:'gentle' as const,role:'assistant' as const,state:'complete' as const,text:'Mensaje',at:index}));
  const snapshot={entries:[],draft:'',revision:1},expected={id,baseRevision:0,snapshot,revision:1};
  await journal.begin({id,baseRevision:0,snapshot,pending});
  const rejected=await journal.appendOwnedPage(expected,[{...pending[0],id:`${prefix}extra`}],prefix,()=>true).then(()=>false,()=>true);
  const remaining=await journal.pending();return {rejected,count:remaining?.pending.length,last:remaining?.pending.at(-1)?.id};
 });
 expect(result).toEqual({rejected:true,count:10000,last:'host:wss://example.test/ws|chat|9999'});
});

test('an owned page extension fences a concurrent stale resume and preserves its reservation', async ({page})=>{
  await page.goto('/');
  const result=await page.evaluate(async()=>{
    const {createConversationJournal}=await import('/src/conversation-journal.ts');
    const {createConversationArchive}=await import('/src/conversation-archive.ts');
    const suffix=crypto.randomUUID(),archive=createConversationArchive({databaseName:`append-page-archive-${suffix}`});
    let start!:()=>void,release!:()=>void;
    const started=new Promise<void>(resolve=>{start=resolve;});const wait=new Promise<void>(resolve=>{release=resolve;});let once=true;
    const wrapped={verifyExactBatch:archive.verifyExactBatch,async upsert(...args:Parameters<typeof archive.upsert>){if(once){once=false;start();await wait;}return archive.upsert(...args);}};
    const journal=createConversationJournal({databaseName:`append-page-${suffix}`,archive:wrapped});
    const id=crypto.randomUUID(),original={id:'host:wss://example.test/ws|chat|old',engine:'gentle' as const,role:'assistant' as const,state:'complete' as const,text:'Anterior',at:1};
    const extra={id:'host:wss://example.test/ws|chat|new',engine:'gentle' as const,role:'assistant' as const,state:'complete' as const,text:'Página',at:2};
    const snapshot={entries:[original],draft:'Borrador',revision:1}, expected={id,baseRevision:0,snapshot,revision:1};
    await journal.begin({id,baseRevision:0,snapshot,pending:[original]});
    const stale=journal.resume(id).then(()=>({ok:true}),error=>({ok:false,error:String(error)}));await started;
    const added=await journal.appendOwnedPage(expected,[extra],'host:wss://example.test/ws|chat|',()=>true);
    const repeated=await journal.appendOwnedPage(expected,[extra],'host:wss://example.test/ws|chat|',()=>true);
    release();const old=await stale, pending=await journal.pending();
    const committed=await journal.resume(id), records=await archive.page();
    return {added,repeated,old,pending,committed,records:records.entries.map(entry=>entry.text)};
  });
  expect(result.added).toBe(true);expect(result.repeated).toBe(true);expect(result.old.ok).toBe(false);
  expect(result.pending?.pending.map(entry=>entry.text)).toEqual(['Anterior','Página']);
  expect(result.pending?.snapshot).toMatchObject({draft:'Borrador',revision:1});expect(result.committed.revision).toBe(1);
  expect(result.records).toEqual(expect.arrayContaining(['Anterior','Página']));
});

test('an owned page cannot alter identities, another reservation or a changed context',async({page})=>{
  await page.goto('/');
  const result=await page.evaluate(async()=>{
    const {createConversationJournal}=await import('/src/conversation-journal.ts');
    const {createConversationArchive}=await import('/src/conversation-archive.ts');
    const suffix=crypto.randomUUID(),journal=createConversationJournal({databaseName:`append-page-guard-${suffix}`,archive:createConversationArchive({databaseName:`append-page-guard-archive-${suffix}`})});
    const id=crypto.randomUUID(),original={id:'host:wss://example.test/ws|chat|old',engine:'gentle' as const,role:'user' as const,state:'complete' as const,text:'Original',at:1};
    const pageEntry={...original,id:'host:wss://example.test/ws|chat|new',text:'Página'}, snapshot={entries:[original],draft:'',revision:1};
    const expected={id,baseRevision:0,snapshot,revision:1}, prefix='host:wss://example.test/ws|chat|';
    await journal.begin({id,baseRevision:0,snapshot,pending:[original]});
    const attempts=await Promise.allSettled([
      journal.appendOwnedPage({...expected,id:crypto.randomUUID()},[pageEntry],prefix,()=>true),
      journal.appendOwnedPage(expected,[{...original,role:'assistant'}],prefix,()=>true),
      journal.appendOwnedPage(expected,[{...pageEntry,id:'host:wss://other.test/ws|chat|new'}],prefix,()=>true),
      journal.appendOwnedPage(expected,[pageEntry],prefix,()=>false),
    ]);
    const before=await journal.pending();await journal.resume(id);
    const after=await journal.appendOwnedPage(expected,[pageEntry],prefix,()=>true);
    return {attempts:attempts.map(value=>value.status),before,after};
  });
  expect(result.attempts).toEqual(['rejected','rejected','rejected','rejected']);
  expect(result.before?.pending.map(entry=>entry.text)).toEqual(['Original']);expect(result.after).toBe(false);
});

test('two windows racing from one durable base reserve only one snapshot before touching the archive', async ({ page, context }) => {
  await page.goto('/'); const other = await context.newPage(); await other.goto('/');
  const suffix = crypto.randomUUID(), databaseName = `journal-race-${suffix}`, archiveName = `journal-archive-${suffix}`;
  const run = (current: typeof page, text: string) => current.evaluate(async ({ databaseName, archiveName, text }) => {
    const path = '/src/conversation-journal.ts', archivePath = '/src/conversation-archive.ts';
    const { createConversationJournal } = await import(path), { createConversationArchive } = await import(archivePath);
    const journal = createConversationJournal({ databaseName, archive: createConversationArchive({ databaseName: archiveName }) });
    const entry = { id: crypto.randomUUID(), role: 'user', engine: 'iphone', state: 'complete', text, at: 1000 };
    const id = crypto.randomUUID();
    try { await journal.begin({ id, baseRevision: 0, snapshot: { entries: [entry], draft: text, revision: 1 }, pending: [entry] }); return { accepted: true, id }; }
    catch { return { accepted: false, id }; }
  }, { databaseName, archiveName, text });
  const outcomes = await Promise.all([run(page, 'primera'), run(other, 'segunda')]);
  expect(outcomes.filter(item => item.accepted)).toHaveLength(1);
  const winner = outcomes.find(item => item.accepted)!;
  const result = await page.evaluate(async ({ databaseName, archiveName, winner }) => {
    const path = '/src/conversation-journal.ts', archivePath = '/src/conversation-archive.ts';
    const { createConversationJournal } = await import(path), { createConversationArchive } = await import(archivePath);
    const archive = createConversationArchive({ databaseName: archiveName }); const journal = createConversationJournal({ databaseName, archive });
    const before = await archive.stats(), pending = await journal.pending(), committed = await journal.resume(winner.id), retry = await journal.resume(winner.id);
    const records = await archive.page();
    return { before, pending, committed, retry, records };
  }, { databaseName, archiveName, winner });
  expect(result.before.entries).toBe(0);
  expect(result.pending.id).toBe(winner.id);
  expect(result.committed).toMatchObject({ id: winner.id, revision: 1, alreadyCommitted: false });
  expect(result.retry).toMatchObject({ id: winner.id, revision: 1, alreadyCommitted: true });
  expect(result.records.entries).toHaveLength(1);
  await other.close();
});

test('a pending journal fences the existing window and voice writers until recovery commits', async ({ page }) => {
  await page.goto('/');
  // Finish the shell's initial restore before exercising the shared v1 store.
  await expect.poll(() => page.evaluate(async () => (await (await import('/src/conversation.ts')).loadConversation()).revision ?? 0)).toBeGreaterThanOrEqual(1);
  const result = await page.evaluate(async () => {
    const { loadConversation, saveConversation } = await import('/src/conversation.ts');
    const { createConversationJournal } = await import('/src/conversation-journal.ts');
    const { createConversationArchive } = await import('/src/conversation-archive.ts');
    const { createVoiceChatCommit } = await import('/src/voice-chat-commit.ts');
    const archive = createConversationArchive({ databaseName: `fenced-archive-${crypto.randomUUID()}` });
    const journal = createConversationJournal({ archive });
    const base = { entries: [], draft: 'Nota original', revision: 1000 };
    await saveConversation(base);
    const id = crypto.randomUUID(), snapshot = { ...base, draft: 'Nota reservada', revision: 1001 };
    await journal.begin({ id, baseRevision: 1000, base, snapshot, pending: [] });
    const input = { ownerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', destination: 'chat', audioSHA256: 'a'.repeat(64), audioBytes: 3,
      transcript: { sessionId: '12345678-1234-4234-8234-123456789012', text: 'Dictado', locale: 'es-MX', source: 'apple-speech-analyzer', durationSeconds: 2,
        segments: [{ text: 'Dictado', startSeconds: 0.1, endSeconds: 1.8 }] } };
    const writes = await Promise.allSettled([
      saveConversation({ ...base, draft: 'No sobrescribir', revision: 1002 }),
      createVoiceChatCommit().apply(input, { draft: base.draft, revision: base.revision }),
    ]);
    const during = await loadConversation(), pending = await journal.pending();
    const recovered = await journal.resume(id);
    await saveConversation({ ...snapshot, draft: 'Edición posterior', revision: 1002 });
    return { writes: writes.map(value => value.status), during, pending: pending?.id, recovered, after: await loadConversation() };
  });
  expect(result.writes).toEqual(['rejected', 'rejected']);
  expect(result.during).toMatchObject({ draft: 'Nota original', revision: 1000 });
  expect(result.pending).toBeTruthy();
  expect(result.recovered).toMatchObject({ revision: 1001, alreadyCommitted: false });
  expect(result.after).toMatchObject({ draft: 'Edición posterior', revision: 1002 });
});

test('a journal reservation racing the existing window writer never allows both to win', async ({ page }) => {
  await page.goto('/');
  await expect.poll(() => page.evaluate(async () => (await (await import('/src/conversation.ts')).loadConversation()).revision ?? 0)).toBeGreaterThanOrEqual(1);
  const result = await page.evaluate(async () => {
    const { loadConversation, saveConversation } = await import('/src/conversation.ts');
    const { createConversationJournal } = await import('/src/conversation-journal.ts');
    const { createConversationArchive } = await import('/src/conversation-archive.ts');
    const journal = createConversationJournal({ archive: createConversationArchive({ databaseName: `race-fence-${crypto.randomUUID()}` }) });
    const base = { entries: [], draft: 'Base', revision: 2000 };
    await saveConversation(base);
    const id = crypto.randomUUID();
    const outcomes = await Promise.allSettled([
      journal.begin({ id, baseRevision: 2000, base, snapshot: { ...base, draft: 'Reservado', revision: 2001 }, pending: [] }),
      saveConversation({ ...base, draft: 'Otra ventana', revision: 2001 }),
    ]);
    const pending = await journal.pending(), current = await loadConversation();
    if (pending) await journal.resume(id);
    return { outcomes: outcomes.map(value => value.status), pending: Boolean(pending), draft: current.draft };
  });
  expect(result.outcomes.sort()).toEqual(['fulfilled', 'rejected']);
  expect(result.draft).toBe(result.pending ? 'Base' : 'Otra ventana');
});

test('partial archive failure keeps the whole reservation and replay completes without duplicates', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const path = '/src/conversation-journal.ts', archivePath = '/src/conversation-archive.ts';
    const { createConversationJournal } = await import(path), { createConversationArchive } = await import(archivePath);
    const suffix = crypto.randomUUID(), databaseName = `journal-replay-${suffix}`, archiveName = `journal-archive-${suffix}`;
    const archive = createConversationArchive({ databaseName: archiveName }); let writes = 0, fail = true;
    const wrapper = { verifyExactBatch: archive.verifyExactBatch, async upsert(...args: any[]) { writes++; if (fail && writes === 2) throw new Error('simulated quota failure'); return archive.upsert(...args); } };
    const journal = createConversationJournal({ databaseName, archive: wrapper });
    const entries = Array.from({ length: 501 }, (_, index) => ({ id: `local-${index}`, role: 'user', engine: 'iphone', state: 'complete', text: `Entrada ${index}`, at: 1000 + index }));
    const id = crypto.randomUUID(); await journal.begin({ id, baseRevision: 0, snapshot: { entries: entries.slice(-120), draft: 'No perder', revision: 1 }, pending: entries });
    let failure = ''; try { await journal.resume(id); } catch (error) { failure = String(error); }
    const pending = await journal.pending(), partial = await archive.stats();
    const second = await Promise.allSettled([journal.begin({ id: crypto.randomUUID(), baseRevision: 0, snapshot: { entries: [], draft: '', revision: 1 }, pending: [] })]);
    fail = false; const committed = await journal.resume(id), final = await archive.stats();
    const restored = await archive.restoreState({ entries: [], revision: 0 });
    return { failure, pendingCount: pending.pending.length, partial: partial.entries, second: second[0].status, committed, final: final.entries, restored: restored.entries.length };
  });
  expect(result.failure).toContain('quota');
  expect(result.pendingCount).toBe(501);
  expect(result.partial).toBe(500);
  expect(result.second).toBe('rejected');
  expect(result.committed).toMatchObject({ revision: 1, alreadyCommitted: false });
  expect(result.final).toBe(501);
  expect(result.restored).toBe(120);
});

test('a non-cooperating window write after archive never removes the journal or overwrites the newer window', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const path = '/src/conversation-journal.ts', archivePath = '/src/conversation-archive.ts';
    const { createConversationJournal } = await import(path), { createConversationArchive } = await import(archivePath);
    const suffix = crypto.randomUUID(), databaseName = `journal-external-${suffix}`, archiveName = `journal-archive-${suffix}`;
    const archive = createConversationArchive({ databaseName: archiveName });
    const external = () => new Promise<void>((resolve, reject) => {
      const open = indexedDB.open(databaseName, 1); open.onerror = () => reject(open.error);
      open.onsuccess = () => { const db = open.result, tx = db.transaction('conversation', 'readwrite');
        tx.objectStore('conversation').put({ entries: [], draft: 'Edición externa', revision: 1 }, 'current');
        tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error); };
    });
    const wrapper = { verifyExactBatch: archive.verifyExactBatch, async upsert(...args: any[]) { const saved = await archive.upsert(...args); await external(); return saved; } };
    const journal = createConversationJournal({ databaseName, archive: wrapper }); const id = crypto.randomUUID();
    const entry = { id: crypto.randomUUID(), role: 'user', engine: 'iphone', state: 'complete', text: 'Reservado', at: 1000 };
    await journal.begin({ id, baseRevision: 0, snapshot: { entries: [entry], draft: 'Reservado', revision: 1 }, pending: [entry] });
    let error = ''; try { await journal.resume(id); } catch (caught) { error = String(caught); }
    const pending = await journal.pending();
    const current = await new Promise<unknown>((resolve, reject) => {
      const open = indexedDB.open(databaseName, 1); open.onerror = () => reject(open.error);
      open.onsuccess = () => { const db = open.result, tx = db.transaction('conversation', 'readonly'), request = tx.objectStore('conversation').get('current');
        request.onsuccess = () => resolve(request.result); tx.oncomplete = () => db.close(); tx.onerror = () => reject(tx.error); };
    });
    return { error, pending, current, archive: await archive.stats() };
  });
  expect(result.error).toContain('cambió durante el archivo');
  expect(result.pending.snapshot.draft).toBe('Reservado');
  expect(result.current).toMatchObject({ draft: 'Edición externa', revision: 1 });
  expect(result.archive.entries).toBe(1); // The partial archive remains visible and must be reviewed.
});

test('a failed reservation leaves the archive untouched and can be retried', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const path = '/src/conversation-journal.ts', archivePath = '/src/conversation-archive.ts';
    const { createConversationJournal } = await import(path), { createConversationArchive } = await import(archivePath);
    const suffix = crypto.randomUUID(), databaseName = `journal-abort-${suffix}`, archiveName = `journal-archive-${suffix}`;
    const archive = createConversationArchive({ databaseName: archiveName });
    const journal = createConversationJournal({ databaseName, archive });
    const entry = { id: crypto.randomUUID(), role: 'user', engine: 'iphone', state: 'complete', text: 'Conservar', at: 1000 };
    const id = crypto.randomUUID(), input = { id, baseRevision: 0, snapshot: { entries: [entry], draft: '', revision: 1 }, pending: [entry] };
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      const request = put.apply(this, args);
      if (this.transaction.db.name === databaseName) throw new Error('simulated reservation failure');
      return request;
    };
    let failed = false; try { await journal.begin(input); } catch { failed = true; } finally { IDBObjectStore.prototype.put = put; }
    const pending = await journal.pending(), before = await archive.stats();
    await journal.begin(input); const result = await journal.resume(id);
    return { failed, pending, before: before.entries, result, after: (await archive.stats()).entries };
  });
  expect(result.failed).toBe(true);
  expect(result.pending).toBeUndefined();
  expect(result.before).toBe(0);
  expect(result.result.revision).toBe(1);
  expect(result.after).toBe(1);
});

test('an old snapshot with an invented newer revision is rejected before archive changes', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const path = '/src/conversation-journal.ts', archivePath = '/src/conversation-archive.ts';
    const { createConversationJournal } = await import(path), { createConversationArchive } = await import(archivePath);
    const suffix = crypto.randomUUID(), databaseName = `journal-base-${suffix}`, archiveName = `journal-archive-${suffix}`;
    const archive = createConversationArchive({ databaseName: archiveName }); const journal = createConversationJournal({ databaseName, archive });
    const original = { id: crypto.randomUUID(), role: 'assistant', engine: 'iphone', state: 'complete', text: 'Respuesta confirmada', at: 1000 };
    const first = crypto.randomUUID(), current = { entries: [original], draft: '', revision: 1 };
    await journal.begin({ id: first, baseRevision: 0, snapshot: current, pending: [] }); await journal.resume(first);
    const stale = { entries: [{ ...original, state: 'pending', text: '' }], draft: '', revision: 1 };
    let error = '';
    try { await journal.begin({ id: crypto.randomUUID(), baseRevision: 1, base: stale, snapshot: { ...stale, revision: 2 }, pending: stale.entries }); }
    catch (caught) { error = String(caught); }
    return { error, pending: await journal.pending(), records: await archive.page() };
  });
  expect(result.error).toContain('conversación cambió');
  expect(result.pending).toBeUndefined();
  expect(result.records.entries[0]).toMatchObject({ state: 'complete', text: 'Respuesta confirmada' });
});

test('a recovered newer archive can advance while an exact visible base still guards the reservation', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { createConversationJournal } = await import('/src/conversation-journal.ts');
    const { createConversationArchive } = await import('/src/conversation-archive.ts');
    const suffix = crypto.randomUUID(), databaseName = `floor-journal-${suffix}`;
    const archive = createConversationArchive({ databaseName: `floor-archive-${suffix}` });
    const journal = createConversationJournal({ databaseName, archive });
    const entry = { id: crypto.randomUUID(), role: 'user', engine: 'iphone', state: 'complete', text: 'Solicitud', at: 1000 };
    const base = { entries: [entry], draft: 'Base', revision: 1 };
    await new Promise<void>((resolve, reject) => {
      const opening = indexedDB.open(databaseName, 1); opening.onupgradeneeded = () => opening.result.createObjectStore('conversation'); opening.onerror = () => reject(opening.error);
      opening.onsuccess = () => { const db = opening.result, tx = db.transaction('conversation', 'readwrite'); tx.objectStore('conversation').put(base, 'current'); tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error); };
    });
    await archive.upsert([entry], undefined, [entry], 4);
    const snapshot = { ...base, draft: 'Continuación', revision: 5 };
    const id = crypto.randomUUID();
    const stale = await Promise.allSettled([journal.begin({ id, baseRevision: 1, base: { ...base, draft: 'Obsoleto' }, nextRevision: 5, snapshot, pending: [] })]);
    await journal.begin({ id, baseRevision: 1, base, nextRevision: 5, snapshot, pending: [] });
    const committed = await journal.resume(id);
    const restored = await archive.restoreState(snapshot);
    return { stale: stale[0].status, committed, restored, pending: await journal.pending() };
  });
  expect(result.stale).toBe('rejected');
  expect(result.committed).toMatchObject({ revision: 5, alreadyCommitted: false });
  expect(result.restored.revision).toBe(5);
  expect(result.restored.entries).toHaveLength(1);
  expect(result.pending).toBeUndefined();
});

test('the reservation includes visible messages and refuses divergent copies before any write', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const path = '/src/conversation-journal.ts', archivePath = '/src/conversation-archive.ts';
    const { createConversationJournal } = await import(path), { createConversationArchive } = await import(archivePath);
    const suffix = crypto.randomUUID(), databaseName = `journal-visible-${suffix}`, archiveName = `journal-archive-${suffix}`;
    const archive = createConversationArchive({ databaseName: archiveName }); const journal = createConversationJournal({ databaseName, archive });
    const entry = { id: crypto.randomUUID(), role: 'user', engine: 'iphone', state: 'complete', text: 'Visible', at: 1000 };
    const id = crypto.randomUUID();
    let mismatch = '';
    try { await journal.begin({ id, baseRevision: 0, snapshot: { entries: [entry], draft: '', revision: 1 }, pending: [{ ...entry, text: 'Otro' }] }); }
    catch (error) { mismatch = String(error); }
    const before = await journal.pending();
    const reserved = await journal.begin({ id, baseRevision: 0, snapshot: { entries: [entry], draft: '', revision: 1 }, pending: [] });
    const commit = await journal.resume(id); const saved = await archive.load(JSON.stringify(['iphone', 'iphone:main', entry.id]));
    return { mismatch, before, reserved, commit, saved };
  });
  expect(result.mismatch).toContain('difieren');
  expect(result.before).toBeUndefined();
  expect(result.reserved.pending).toHaveLength(1);
  expect(result.saved.text).toBe('Visible');
  expect(result.commit.revision).toBe(1);
});

test('a same-revision external change also prevents finishing the reserved snapshot', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const path = '/src/conversation-journal.ts', archivePath = '/src/conversation-archive.ts';
    const { createConversationJournal } = await import(path), { createConversationArchive } = await import(archivePath);
    const suffix = crypto.randomUUID(), databaseName = `journal-equal-${suffix}`, archiveName = `journal-archive-${suffix}`;
    const archive = createConversationArchive({ databaseName: archiveName });
    const write = (value: unknown) => new Promise<void>((resolve, reject) => {
      const open = indexedDB.open(databaseName, 1); open.onupgradeneeded = () => open.result.createObjectStore('conversation'); open.onerror = () => reject(open.error);
      open.onsuccess = () => { const db = open.result, tx = db.transaction('conversation', 'readwrite'); tx.objectStore('conversation').put(value, 'current'); tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error); };
    });
    const base = { entries: [], draft: 'Base', revision: 3 }; await write(base);
    const journal = createConversationJournal({ databaseName, archive: { verifyExactBatch: archive.verifyExactBatch, async upsert(...args: any[]) { const value = await archive.upsert(...args); await write({ ...base, draft: 'Interferencia' }); return value; } } });
    const id = crypto.randomUUID(); await journal.begin({ id, baseRevision: 3, base, snapshot: { ...base, draft: 'Nuevo', revision: 4 }, pending: [] });
    let error = ''; try { await journal.resume(id); } catch (caught) { error = String(caught); }
    return { error, pending: await journal.pending() };
  });
  expect(result.error).toContain('cambió durante el archivo');
  expect(result.pending.snapshot.draft).toBe('Nuevo');
});

test('an external change before recovery is detected before the first archive batch', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const path = '/src/conversation-journal.ts', archivePath = '/src/conversation-archive.ts';
    const { createConversationJournal } = await import(path), { createConversationArchive } = await import(archivePath);
    const suffix = crypto.randomUUID(), databaseName = `journal-preflight-${suffix}`, archiveName = `journal-archive-${suffix}`;
    const archive = createConversationArchive({ databaseName: archiveName }); const journal = createConversationJournal({ databaseName, archive });
    const id = crypto.randomUUID(), entry = { id: crypto.randomUUID(), role: 'user', engine: 'iphone', state: 'complete', text: 'Pendiente', at: 1000 };
    await journal.begin({ id, baseRevision: 0, snapshot: { entries: [entry], draft: 'Pendiente', revision: 1 }, pending: [entry] });
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open(databaseName, 1); open.onerror = () => reject(open.error);
      open.onsuccess = () => { const db = open.result, tx = db.transaction('conversation', 'readwrite');
        tx.objectStore('conversation').put({ entries: [], draft: 'Externo', revision: 1 }, 'current');
        tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error); };
    });
    let error = ''; try { await journal.resume(id); } catch (caught) { error = String(caught); }
    return { error, pending: await journal.pending(), archive: await archive.stats() };
  });
  expect(result.error).toContain('cambió antes del archivo');
  expect(result.pending.snapshot.draft).toBe('Pendiente');
  expect(result.archive.entries).toBe(0);
});

test('pruning preserves an unarchived base message and rejects an older divergent pending copy', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const path = '/src/conversation-journal.ts', archivePath = '/src/conversation-archive.ts';
    const { createConversationJournal } = await import(path), { createConversationArchive } = await import(archivePath);
    const suffix = crypto.randomUUID(), databaseName = `journal-prune-${suffix}`, archiveName = `journal-archive-${suffix}`;
    const archive = createConversationArchive({ databaseName: archiveName });
    const entry = { id: crypto.randomUUID(), role: 'assistant', engine: 'iphone', state: 'complete', text: 'Respuesta completa', at: 1000 };
    const base = { entries: [entry], draft: '', revision: 1 };
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open(databaseName, 1); open.onupgradeneeded = () => open.result.createObjectStore('conversation'); open.onerror = () => reject(open.error);
      open.onsuccess = () => { const db = open.result, tx = db.transaction('conversation', 'readwrite'); tx.objectStore('conversation').put(base, 'current'); tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error); };
    });
    const journal = createConversationJournal({ databaseName, archive });
    let conflict = '';
    try { await journal.begin({ id: crypto.randomUUID(), baseRevision: 1, base, snapshot: { entries: [], draft: '', revision: 2 }, pending: [{ ...entry, state: 'pending', text: '' }] }); }
    catch (error) { conflict = String(error); }
    const afterConflict = await archive.stats(), id = crypto.randomUUID();
    const reserved = await journal.begin({ id, baseRevision: 1, base, snapshot: { entries: [], draft: '', revision: 2 }, pending: [] });
    await journal.resume(id);
    return { conflict, afterConflict: afterConflict.entries, reserved: reserved.pending.length, archived: await archive.load(JSON.stringify(['iphone', 'iphone:main', entry.id])) };
  });
  expect(result.conflict).toContain('podado difiere');
  expect(result.afterConflict).toBe(0);
  expect(result.reserved).toBe(1);
  expect(result.archived).toMatchObject({ state: 'complete', text: 'Respuesta completa' });
});

test('an archive timestamp mismatch retains the journal and the original window', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const path = '/src/conversation-journal.ts', archivePath = '/src/conversation-archive.ts';
    const { createConversationJournal } = await import(path), { createConversationArchive } = await import(archivePath);
    const suffix = crypto.randomUUID(), databaseName = `journal-timestamp-${suffix}`, archiveName = `journal-archive-${suffix}`;
    const archive = createConversationArchive({ databaseName: archiveName }); const journal = createConversationJournal({ databaseName, archive });
    const entry = { id: crypto.randomUUID(), role: 'assistant', engine: 'iphone', state: 'complete', text: 'Original', at: 1000 };
    const first = crypto.randomUUID(), base = { entries: [entry], draft: '', revision: 1 };
    await journal.begin({ id: first, baseRevision: 0, snapshot: base, pending: [entry] }); await journal.resume(first);
    const next = { ...entry, at: 2000, text: 'Actualización' }, id = crypto.randomUUID();
    await journal.begin({ id, baseRevision: 1, base, snapshot: { entries: [next], draft: '', revision: 2 }, pending: [next] });
    let error = ''; try { await journal.resume(id); } catch (caught) { error = String(caught); }
    return { error, pending: await journal.pending(), archived: await archive.load(JSON.stringify(['iphone', 'iphone:main', entry.id])) };
  });
  expect(result.error).toContain('no conservó exactamente');
  expect(result.pending.base.entries[0]).toMatchObject({ at: 1000, text: 'Original' });
  expect(result.pending.snapshot.entries[0]).toMatchObject({ at: 2000, text: 'Actualización' });
  expect(result.archived.at).toBe(1000);
});

test('finishing a streamed message keeps the archive timestamp and permits journal commit', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { createConversationJournal } = await import('/src/conversation-journal.ts');
    const { createConversationArchive } = await import('/src/conversation-archive.ts');
    const { updateEntry } = await import('/src/conversation.ts');
    const suffix = crypto.randomUUID();
    const archive = createConversationArchive({ databaseName: `stream-archive-${suffix}` });
    const journal = createConversationJournal({ databaseName: `stream-journal-${suffix}`, archive });
    const entry = { id: crypto.randomUUID(), role: 'assistant', engine: 'iphone', state: 'pending', text: 'Parcial', at: 1000 };
    const base = { entries: [entry], draft: '', revision: 1 };
    const first = crypto.randomUUID();
    await journal.begin({ id: first, baseRevision: 0, snapshot: base, pending: [entry] });
    await journal.resume(first);
    const completed = updateEntry(base.entries, { ...entry, state: 'complete', text: 'Resultado', at: 2000 })[0];
    const id = crypto.randomUUID();
    await journal.begin({ id, baseRevision: 1, base, snapshot: { entries: [completed], draft: '', revision: 2 }, pending: [completed] });
    const committed = await journal.resume(id);
    const stored = await archive.load(JSON.stringify(['iphone', 'iphone:main', entry.id]));
    return { completed, committed, stored, pending: await journal.pending() };
  });
  expect(result.completed.at).toBe(1000);
  expect(result.stored).toMatchObject({ at: 1000, state: 'complete', text: 'Resultado' });
  expect(result.committed).toMatchObject({ revision: 2, alreadyCommitted: false });
  expect(result.pending).toBeUndefined();
});

test('a pruned host transport alias is preserved privately by the archive before the journal is released', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const path = '/src/conversation-journal.ts', archivePath = '/src/conversation-archive.ts';
    const { createConversationJournal } = await import(path), { createConversationArchive } = await import(archivePath);
    const suffix = crypto.randomUUID(), databaseName = `journal-alias-${suffix}`, archiveName = `journal-archive-${suffix}`;
    const archive = createConversationArchive({ databaseName: archiveName });
    const entry = { id: 'host:wss://example.test/ws|main|123', role: 'user', engine: 'gentle', state: 'complete', text: 'Texto', transportText: 'Contexto más texto', at: 1000 };
    const base = { entries: [entry], draft: '', revision: 1 };
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open(databaseName, 1); open.onupgradeneeded = () => open.result.createObjectStore('conversation'); open.onerror = () => reject(open.error);
      open.onsuccess = () => { const db = open.result, tx = db.transaction('conversation', 'readwrite'); tx.objectStore('conversation').put(base, 'current'); tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error); };
    });
    const journal = createConversationJournal({ databaseName, archive }); const id = crypto.randomUUID();
    await journal.begin({ id, baseRevision: 1, base, snapshot: { entries: [], draft: '', revision: 2 }, pending: [] });
    await journal.resume(id);
    const rawAlias = await new Promise<unknown>((resolve, reject) => {
      const open = indexedDB.open(archiveName, 1); open.onerror = () => reject(open.error);
      open.onsuccess = () => { const db = open.result, tx = db.transaction('entries', 'readonly');
        const get = tx.objectStore('entries').get(JSON.stringify(['gentle', 'host:wss://example.test/ws|main', entry.id]));
        get.onsuccess = () => resolve(get.result?.transportText); tx.oncomplete = () => db.close(); tx.onerror = () => reject(tx.error); };
    });
    const exported = await archive.export();
    return { rawAlias, pending: await journal.pending(), count: (await archive.stats()).entries,
      visible: await archive.load(JSON.stringify(['gentle', 'host:wss://example.test/ws|main', entry.id])), exportText: await exported.blob.text() };
  });
  expect(result.rawAlias).toBe('Contexto más texto');
  expect(result.pending).toBeUndefined();
  expect(result.count).toBe(1);
  expect(result.visible).not.toHaveProperty('transportText');
  expect(result.exportText).not.toContain('Contexto más texto');
});

test('repeating a reservation checks the base again without erasing the pending copy', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const path = '/src/conversation-journal.ts', archivePath = '/src/conversation-archive.ts';
    const { createConversationJournal } = await import(path), { createConversationArchive } = await import(archivePath);
    const suffix = crypto.randomUUID(), databaseName = `journal-repeat-${suffix}`, archiveName = `journal-archive-${suffix}`;
    const archive = createConversationArchive({ databaseName: archiveName }), journal = createConversationJournal({ databaseName, archive });
    const id = crypto.randomUUID(), entry = { id: crypto.randomUUID(), role: 'user', engine: 'iphone', state: 'complete', text: 'Pendiente', at: 1000 };
    const input = { id, baseRevision: 0, snapshot: { entries: [entry], draft: 'Pendiente', revision: 1 }, pending: [entry] };
    await journal.begin(input);
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open(databaseName, 1); open.onerror = () => reject(open.error);
      open.onsuccess = () => { const db = open.result, tx = db.transaction('conversation', 'readwrite'); tx.objectStore('conversation').put({ entries: [], draft: 'Ajeno', revision: 1 }, 'current'); tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error); };
    });
    let error = ''; try { await journal.begin(input); } catch (caught) { error = String(caught); }
    return { error, pending: await journal.pending(), archive: await archive.stats() };
  });
  expect(result.error).toContain('cambió');
  expect(result.pending.snapshot.draft).toBe('Pendiente');
  expect(result.archive.entries).toBe(0);
});
