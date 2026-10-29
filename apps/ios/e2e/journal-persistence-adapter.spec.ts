import { expect, test } from './fixtures.ts';

test('a lost draft backup callback leaves the copy and can retry with a newer sequence', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { createJournalConversationPersistence } = await import('/src/journal-conversation-persistence.ts');
    const { createConversationJournal } = await import('/src/conversation-journal.ts');
    const { createConversationArchive } = await import('/src/conversation-archive.ts');
    const { createConversationDraftRescue } = await import('/src/conversation-draft-rescue.ts');
    const suffix = crypto.randomUUID(), name = `adapter-draft-lost-${suffix}`, owner = crypto.randomUUID();
    const archive = createConversationArchive({ databaseName: `adapter-draft-lost-archive-${suffix}` });
    const journal = createConversationJournal({ databaseName: name, archive }), store = createConversationDraftRescue({ databaseName: name });
    const readBase = () => new Promise<any>((resolve, reject) => {
      const open = indexedDB.open(name, 1); open.onupgradeneeded = () => open.result.createObjectStore('conversation'); open.onerror = () => reject(open.error);
      open.onsuccess = () => { const db = open.result, tx = db.transaction('conversation', 'readonly'), get = tx.objectStore('conversation').get('current'); get.onsuccess = () => resolve(get.result); tx.oncomplete = () => db.close(); tx.onabort = () => reject(tx.error); };
    });
    let lost = true;
    const draftRescue = { save: async (input: unknown) => { const saved = await store.save(input); if (lost) { lost = false; throw new Error('callback perdido'); } return saved; } };
    const writer = createJournalConversationPersistence({ journal, readBase, draftRescue, rescueOwner: owner }); writer.bindBase(undefined);
    await writer.persist({ entries: [], draft: 'Primera copia' });
    const blocked = writer.status(), afterLost = await store.list(), pending = await journal.pending();
    await writer.persist({ entries: [], draft: 'Texto más reciente' });
    return { blocked, afterLost, pending, final: writer.status(), saved: await readBase(), backups: await store.list() };
  });
  expect(result.blocked).toMatchObject({ blocked: true, conversationError: 'callback perdido' });
  expect(result.afterLost[0]).toMatchObject({ sequence: 1, draft: 'Primera copia' });
  expect(result.pending).toBeUndefined();
  expect(result.final.blocked).toBe(false);
  expect(result.saved.draft).toBe('Texto más reciente');
  expect(result.backups[0]).toMatchObject({ sequence: 2, draft: 'Texto más reciente' });
});

test('a blocked archive preserves a later draft separately and completes it after recovery', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { createJournalConversationPersistence } = await import('/src/journal-conversation-persistence.ts');
    const { createConversationJournal } = await import('/src/conversation-journal.ts');
    const { createConversationArchive } = await import('/src/conversation-archive.ts');
    const { createConversationDraftRescue } = await import('/src/conversation-draft-rescue.ts');
    const suffix = crypto.randomUUID(), name = `adapter-draft-${suffix}`, rescueOwner = crypto.randomUUID();
    const actual = createConversationArchive({ databaseName: `adapter-draft-archive-${suffix}` });
    let quota = true;
    const archive = { upsert: async (...args: Parameters<typeof actual.upsert>) => { if (quota) throw new Error('Cuota agotada'); return actual.upsert(...args); }, verifyExactBatch: actual.verifyExactBatch };
    const journal = createConversationJournal({ databaseName: name, archive });
    const rescue = createConversationDraftRescue({ databaseName: name });
    const readBase = () => new Promise<any>((resolve, reject) => {
      const open = indexedDB.open(name, 1); open.onupgradeneeded = () => open.result.createObjectStore('conversation'); open.onerror = () => reject(open.error);
      open.onsuccess = () => { const db = open.result, tx = db.transaction('conversation', 'readonly'), get = tx.objectStore('conversation').get('current'); get.onsuccess = () => resolve(get.result); tx.oncomplete = () => db.close(); tx.onabort = () => reject(tx.error); };
    });
    const writer = createJournalConversationPersistence({ journal, readBase, draftRescue: rescue, rescueOwner });
    writer.bindBase(undefined);
    const entry = { id: crypto.randomUUID(), engine: 'iphone', role: 'user', state: 'complete', text: 'Conservar turno', at: 1000 };
    await writer.persist({ entries: [entry], draft: 'Primero', attachedWork: 'work_a' });
    const first = await journal.pending();
    await writer.persist({ entries: [entry], draft: 'Escrito después de la cuota', attachedWork: 'work_b' });
    const blocked = writer.status(), unchanged = await journal.pending(), backups = await rescue.list();
    quota = false;
    await writer.persist({ entries: [entry], draft: 'Escrito después de la cuota', attachedWork: 'work_b' });
    return { first, unchanged, blocked, backups, saved: await readBase(), remaining: await rescue.list(), final: writer.status() };
  });
  expect(result.blocked).toMatchObject({ blocked: true, conversationError: 'Cuota agotada' });
  expect(result.unchanged.id).toBe(result.first.id);
  expect(result.unchanged.snapshot.draft).toBe('Primero');
  expect(result.backups).toHaveLength(1);
  expect(result.backups[0]).toMatchObject({ sequence: 2, draft: 'Escrito después de la cuota', attachedWork: 'work_b' });
  expect(result.saved).toMatchObject({ draft: 'Escrito después de la cuota', attachedWork: 'work_b' });
  expect(result.final.blocked).toBe(false);
  expect(result.remaining).toHaveLength(1);
  expect(result.remaining[0]).toMatchObject({ sequence: 3, draft: 'Escrito después de la cuota', attachedWork: 'work_b' });
});

test('competing writers cannot replace the same archived message before winning a reservation', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { createJournalConversationPersistence } = await import('/src/journal-conversation-persistence.ts');
    const { createConversationJournal } = await import('/src/conversation-journal.ts');
    const { createConversationArchive } = await import('/src/conversation-archive.ts');
    const suffix = crypto.randomUUID(), name = `adapter-same-id-${suffix}`;
    const archive = createConversationArchive({ databaseName: `adapter-same-id-archive-${suffix}` });
    const journal = createConversationJournal({ databaseName: name, archive });
    const readBase = () => new Promise<any>((resolve, reject) => {
      const open = indexedDB.open(name, 1); open.onupgradeneeded = () => open.result.createObjectStore('conversation'); open.onerror = () => reject(open.error);
      open.onsuccess = () => { const db = open.result, tx = db.transaction('conversation', 'readonly'), get = tx.objectStore('conversation').get('current'); get.onsuccess = () => resolve(get.result); tx.oncomplete = () => db.close(); tx.onabort = () => reject(tx.error); };
    });
    const first = createJournalConversationPersistence({ journal, readBase });
    const second = createJournalConversationPersistence({ journal, readBase });
    first.bindBase(undefined); second.bindBase(undefined);
    const sharedId = crypto.randomUUID(), base = { id: sharedId, engine: 'iphone', role: 'user', state: 'complete', at: 1000 };
    const a = { ...base, text: 'Contenido A' }, b = { ...base, text: 'Contenido B' };
    await Promise.all([first.persist({ entries: [a], draft: 'A' }), second.persist({ entries: [b], draft: 'B' })]);
    const current = await readBase(), archived = await archive.load(JSON.stringify(['iphone', 'iphone:main', sharedId]));
    return { first: first.status(), second: second.status(), current, archived, pendingA: first.pending(), pendingB: second.pending() };
  });
  expect([result.first.blocked, result.second.blocked].sort()).toEqual([false, true]);
  expect(result.archived.text).toBe(result.current.entries[0].text);
  const loser = result.first.blocked ? result.pendingA : result.pendingB;
  expect(loser[0].id).toBe(result.current.entries[0].id);
  expect(loser[0].text).not.toBe(result.archived.text);
});

test('two journal writers preserve the losing window and never overwrite its base', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { createJournalConversationPersistence } = await import('/src/journal-conversation-persistence.ts');
    const { createConversationJournal } = await import('/src/conversation-journal.ts');
    const { createConversationArchive } = await import('/src/conversation-archive.ts');
    const suffix = crypto.randomUUID(), name = `adapter-race-${suffix}`;
    const archive = createConversationArchive({ databaseName: `adapter-archive-${suffix}` });
    const journal = createConversationJournal({ databaseName: name, archive });
    const readBase = () => new Promise<any>((resolve, reject) => {
      const opening = indexedDB.open(name, 1); opening.onupgradeneeded = () => opening.result.createObjectStore('conversation'); opening.onerror = () => reject(opening.error);
      opening.onsuccess = () => { const db = opening.result, tx = db.transaction('conversation', 'readonly'), get = tx.objectStore('conversation').get('current'); get.onsuccess = () => resolve(get.result); tx.oncomplete = () => db.close(); tx.onabort = () => reject(tx.error); };
    });
    const a = createJournalConversationPersistence({ journal, readBase });
    const b = createJournalConversationPersistence({ journal, readBase });
    a.bindBase(undefined); b.bindBase(undefined);
    const first = { id: crypto.randomUUID(), engine: 'iphone', role: 'user', state: 'complete', text: 'Primera', at: 1000 };
    const second = { ...first, id: crypto.randomUUID(), text: 'Segunda' };
    await Promise.all([a.persist({ entries: [first], draft: 'A', attachedWork: undefined }), b.persist({ entries: [second], draft: 'B', attachedWork: undefined })]);
    return { a: a.status(), b: b.status(), saved: await readBase(), pendingA: a.pending(), pendingB: b.pending(), archived: (await archive.page()).entries };
  });
  expect([result.a.blocked, result.b.blocked].sort()).toEqual([false, true]);
  expect(result.archived).toHaveLength(1);
  const failed = result.a.blocked ? result.pendingA : result.pendingB;
  expect(failed).toHaveLength(1);
  expect(result.saved.entries[0].id).not.toBe(failed[0].id);
  expect(result.saved.draft).toBe(result.a.blocked ? 'B' : 'A');
});

test('a failed partial archive keeps the full reserved snapshot through recovery and replay', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { createJournalConversationPersistence, recoverConversationReservation } = await import('/src/journal-conversation-persistence.ts');
    const { createConversationJournal } = await import('/src/conversation-journal.ts');
    const { createConversationArchive } = await import('/src/conversation-archive.ts');
    const suffix = crypto.randomUUID(), name = `adapter-quota-${suffix}`;
    const archive = createConversationArchive({ databaseName: `adapter-archive-${suffix}` });
    let calls = 0, fail = true;
    const wrapped = { upsert: async (...args: Parameters<typeof archive.upsert>) => { if (fail && ++calls === 2) throw new Error('Cuota de prueba'); return archive.upsert(...args); }, verifyExactBatch: archive.verifyExactBatch };
    const journal = createConversationJournal({ databaseName: name, archive: wrapped });
    const readBase = () => new Promise<any>((resolve, reject) => {
      const open = indexedDB.open(name, 1); open.onupgradeneeded = () => open.result.createObjectStore('conversation'); open.onerror = () => reject(open.error);
      open.onsuccess = () => { const db = open.result, tx = db.transaction('conversation', 'readonly'), get = tx.objectStore('conversation').get('current'); get.onsuccess = () => resolve(get.result); tx.oncomplete = () => db.close(); tx.onabort = () => reject(tx.error); };
    });
    const writer = createJournalConversationPersistence({ journal, readBase }); writer.bindBase(undefined);
    const entries = Array.from({ length: 501 }, (_, index) => ({ id: `entry-${index}`, role: 'user', engine: 'iphone', state: 'complete', text: `Dato ${index}`, at: 1000 + index }));
    writer.enqueue(entries);
    await writer.persist({ entries: entries.slice(-120), draft: 'Borrador protegido' });
    const failed = writer.status(), firstArchive = (await archive.stats()).entries;
    calls = 0; const blocked = await recoverConversationReservation(journal);
    const before = await readBase();
    fail = false; const recovered = await recoverConversationReservation(journal);
    return { failed, firstArchive, blocked, before, recovered, after: await readBase(), finalArchive: (await archive.stats()).entries };
  });
  expect(result.failed).toMatchObject({ blocked: true, pending: 501 });
  expect(result.firstArchive).toBe(500);
  expect(result.blocked.state).toBe('blocked');
  if (result.blocked.state !== 'blocked') throw new Error('Recovery unexpectedly committed');
  expect(result.blocked.journal.snapshot.draft).toBe('Borrador protegido');
  expect(result.blocked.journal.pending).toHaveLength(501);
  expect(result.before).toBeUndefined();
  expect(result.recovered.state).toBe('committed');
  expect(result.after.draft).toBe('Borrador protegido');
  expect(result.finalArchive).toBe(501);
});

test('queued snapshots remain ordered and a newer update survives an earlier commit', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { createJournalConversationPersistence } = await import('/src/journal-conversation-persistence.ts');
    const { createConversationJournal } = await import('/src/conversation-journal.ts');
    const { createConversationArchive } = await import('/src/conversation-archive.ts');
    const suffix = crypto.randomUUID(), name = `adapter-queue-${suffix}`;
    const archive = createConversationArchive({ databaseName: `adapter-archive-${suffix}` });
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); let first = true;
    const wrapped = { upsert: async (...args: Parameters<typeof archive.upsert>) => { if (first) { first = false; await gate; } return archive.upsert(...args); }, verifyExactBatch: archive.verifyExactBatch };
    const journal = createConversationJournal({ databaseName: name, archive: wrapped });
    const readBase = () => new Promise<any>((resolve, reject) => {
      const open = indexedDB.open(name, 1); open.onupgradeneeded = () => open.result.createObjectStore('conversation'); open.onerror = () => reject(open.error);
      open.onsuccess = () => { const db = open.result, tx = db.transaction('conversation', 'readonly'), get = tx.objectStore('conversation').get('current'); get.onsuccess = () => resolve(get.result); tx.oncomplete = () => db.close(); tx.onabort = () => reject(tx.error); };
    });
    const writer = createJournalConversationPersistence({ journal, readBase }); writer.bindBase(undefined);
    const pending = { id: crypto.randomUUID(), role: 'assistant', engine: 'iphone', state: 'pending', text: 'Parcial', at: 1000 };
    const firstWrite = writer.persist({ entries: [pending], draft: 'A' });
    while (!await journal.pending()) await new Promise(resolve => setTimeout(resolve, 5));
    const complete = { ...pending, state: 'complete', text: 'Completa' };
    const secondWrite = writer.persist({ entries: [complete], draft: 'AB' }); release();
    await Promise.all([firstWrite, secondWrite]);
    return { status: writer.status(), saved: await readBase(), archived: await archive.load(JSON.stringify(['iphone', 'iphone:main', pending.id])) };
  });
  expect(result.status).toMatchObject({ blocked: false, pending: 0 });
  expect(result.saved).toMatchObject({ draft: 'AB', revision: 2, entries: [{ text: 'Completa', state: 'complete' }] });
  expect(result.archived).toMatchObject({ text: 'Completa', state: 'complete' });
});

test('a lost commit callback resumes the same reservation without duplicating an entry', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { createJournalConversationPersistence } = await import('/src/journal-conversation-persistence.ts');
    const { createConversationJournal } = await import('/src/conversation-journal.ts');
    const { createConversationArchive } = await import('/src/conversation-archive.ts');
    const suffix = crypto.randomUUID(), name = `adapter-lost-${suffix}`;
    const archive = createConversationArchive({ databaseName: `adapter-archive-${suffix}` });
    const real = createConversationJournal({ databaseName: name, archive }); let lost = true;
    const journal = { pending: real.pending, begin: real.begin, async resume(id: string) { const result = await real.resume(id); if (lost) { lost = false; throw new Error('Callback perdido'); } return result; } };
    const readBase = () => new Promise<any>((resolve, reject) => {
      const open = indexedDB.open(name, 1); open.onupgradeneeded = () => open.result.createObjectStore('conversation'); open.onerror = () => reject(open.error);
      open.onsuccess = () => { const db = open.result, tx = db.transaction('conversation', 'readonly'), get = tx.objectStore('conversation').get('current'); get.onsuccess = () => resolve(get.result); tx.oncomplete = () => db.close(); tx.onabort = () => reject(tx.error); };
    });
    const writer = createJournalConversationPersistence({ journal, readBase }); writer.bindBase(undefined);
    const entry = { id: crypto.randomUUID(), role: 'user', engine: 'iphone', state: 'complete', text: 'Una vez', at: 1000 };
    await writer.persist({ entries: [entry], draft: 'A' }); const uncertain = writer.status();
    await writer.persist({ entries: [entry], draft: 'AB' });
    return { uncertain, status: writer.status(), saved: await readBase(), count: (await archive.stats()).entries };
  });
  expect(result.uncertain.blocked).toBe(true);
  expect(result.status).toMatchObject({ blocked: false, pending: 0 });
  expect(result.saved).toMatchObject({ draft: 'AB', revision: 2 });
  expect(result.count).toBe(1);
});

test('a confirmed pre-reservation conflict does not strand an uncreated operation ID', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { createJournalConversationPersistence } = await import('/src/journal-conversation-persistence.ts');
    const { createConversationJournal, JournalReservationConflict } = await import('/src/conversation-journal.ts');
    const { createConversationArchive } = await import('/src/conversation-archive.ts');
    const suffix = crypto.randomUUID(), name = `adapter-confirmed-${suffix}`;
    const archive = createConversationArchive({ databaseName: `adapter-archive-${suffix}` });
    const real = createConversationJournal({ databaseName: name, archive }); let first = true, begins = 0;
    const journal = { pending: real.pending, resume: real.resume, async begin(input: Parameters<typeof real.begin>[0]) {
      begins++; if (first) { first = false; throw new JournalReservationConflict('Conflicto confirmado'); } return real.begin(input);
    } };
    const readBase = () => new Promise<any>((resolve, reject) => {
      const open = indexedDB.open(name, 1); open.onupgradeneeded = () => open.result.createObjectStore('conversation'); open.onerror = () => reject(open.error);
      open.onsuccess = () => { const db = open.result, tx = db.transaction('conversation', 'readonly'), get = tx.objectStore('conversation').get('current'); get.onsuccess = () => resolve(get.result); tx.oncomplete = () => db.close(); tx.onabort = () => reject(tx.error); };
    });
    const writer = createJournalConversationPersistence({ journal, readBase }); writer.bindBase(undefined);
    const entry = { id: crypto.randomUUID(), role: 'user', engine: 'iphone', state: 'complete', text: 'Conservar', at: 1000 };
    await writer.persist({ entries: [entry], draft: 'A' }); const blocked = writer.status(), noReservation = await real.pending();
    await writer.persist({ entries: [entry], draft: 'A' });
    return { blocked, noReservation, final: writer.status(), saved: await readBase(), count: (await archive.stats()).entries, begins };
  });
  expect(result.blocked).toMatchObject({ blocked: true, pending: 1, conversationError: 'Conflicto confirmado' });
  expect(result.noReservation).toBeUndefined();
  expect(result.final).toMatchObject({ blocked: false, pending: 0 });
  expect(result.saved).toMatchObject({ draft: 'A', revision: 1 });
  expect(result.count).toBe(1);
  expect(result.begins).toBe(2);
});

test('a temporarily unreadable journal can recheck a proven rejected reservation on retry', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { createJournalConversationPersistence } = await import('/src/journal-conversation-persistence.ts');
    const { createConversationJournal, JournalReservationConflict } = await import('/src/conversation-journal.ts');
    const { createConversationArchive } = await import('/src/conversation-archive.ts');
    const suffix = crypto.randomUUID(), name = `adapter-read-failure-${suffix}`;
    const archive = createConversationArchive({ databaseName: `adapter-archive-${suffix}` });
    const real = createConversationJournal({ databaseName: name, archive }); let first = true, reads = 0, begins = 0;
    const journal = { resume: real.resume, async pending() { if (++reads === 2) throw new Error('No se pudo leer la reserva'); return real.pending(); },
      async begin(input: Parameters<typeof real.begin>[0]) { begins++; if (first) { first = false; throw new JournalReservationConflict('Conflicto confirmado'); } return real.begin(input); } };
    const readBase = () => new Promise<any>((resolve, reject) => {
      const open = indexedDB.open(name, 1); open.onupgradeneeded = () => open.result.createObjectStore('conversation'); open.onerror = () => reject(open.error);
      open.onsuccess = () => { const db = open.result, tx = db.transaction('conversation', 'readonly'), get = tx.objectStore('conversation').get('current'); get.onsuccess = () => resolve(get.result); tx.oncomplete = () => db.close(); tx.onabort = () => reject(tx.error); };
    });
    const writer = createJournalConversationPersistence({ journal, readBase }); writer.bindBase(undefined);
    const entry = { id: crypto.randomUUID(), role: 'user', engine: 'iphone', state: 'complete', text: 'Conservar', at: 1000 };
    await writer.persist({ entries: [entry], draft: 'A' }); const blocked = writer.status();
    await writer.persist({ entries: [entry], draft: 'A' });
    return { blocked, final: writer.status(), saved: await readBase(), begins, count: (await archive.stats()).entries };
  });
  expect(result.blocked).toMatchObject({ blocked: true, pending: 1, conversationError: 'No se pudo leer la reserva' });
  expect(result.final).toMatchObject({ blocked: false, pending: 0 });
  expect(result.saved).toMatchObject({ draft: 'A', revision: 1 });
  expect(result.begins).toBe(2);
  expect(result.count).toBe(1);
});

test('invalid schema and quota rejections can be corrected without stranding an operation ID', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { createJournalConversationPersistence } = await import('/src/journal-conversation-persistence.ts');
    const { createConversationJournal } = await import('/src/conversation-journal.ts');
    const { createConversationArchive } = await import('/src/conversation-archive.ts');
    const suffix = crypto.randomUUID(), name = `adapter-invalid-${suffix}`;
    const archive = createConversationArchive({ databaseName: `adapter-archive-${suffix}` });
    const journal = createConversationJournal({ databaseName: name, archive });
    const readBase = () => new Promise<any>((resolve, reject) => {
      const open = indexedDB.open(name, 1); open.onupgradeneeded = () => open.result.createObjectStore('conversation'); open.onerror = () => reject(open.error);
      open.onsuccess = () => { const db = open.result, tx = db.transaction('conversation', 'readonly'), get = tx.objectStore('conversation').get('current'); get.onsuccess = () => resolve(get.result); tx.oncomplete = () => db.close(); tx.onabort = () => reject(tx.error); };
    });
    const writer = createJournalConversationPersistence({ journal, readBase }); writer.bindBase(undefined);
    const entry = { id: crypto.randomUUID(), role: 'user', engine: 'iphone', state: 'complete', text: 'Conservar', at: 1000 };
    await writer.persist({ entries: [entry], draft: 'x'.repeat(8001) }); const quota = writer.status();
    await writer.persist({ entries: [entry], draft: 'A', unknownField: 'no descartar' } as any); const schema = writer.status();
    const before = await journal.pending(), countBefore = (await archive.stats()).entries;
    await writer.persist({ entries: [entry], draft: 'A', attachedWork: undefined });
    return { quota, schema, before, countBefore, final: writer.status(), saved: await readBase(), count: (await archive.stats()).entries };
  });
  expect(result.quota).toMatchObject({ blocked: true, pending: 1 });
  expect(result.schema).toMatchObject({ blocked: true, pending: 1 });
  expect(result.before).toBeUndefined();
  expect(result.countBefore).toBe(0);
  expect(result.final).toMatchObject({ blocked: false, pending: 0 });
  expect(result.saved).toMatchObject({ draft: 'A', revision: 1 });
  expect(result.count).toBe(1);
});

test('a lost reservation callback retries its original operation and never creates a second copy', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { createJournalConversationPersistence } = await import('/src/journal-conversation-persistence.ts');
    const { createConversationJournal } = await import('/src/conversation-journal.ts');
    const { createConversationArchive } = await import('/src/conversation-archive.ts');
    const suffix = crypto.randomUUID(), name = `adapter-lost-begin-${suffix}`;
    const archive = createConversationArchive({ databaseName: `adapter-archive-${suffix}` });
    const real = createConversationJournal({ databaseName: name, archive }); let lost = true; const ids: string[] = [];
    const journal = { pending: real.pending, resume: real.resume, async begin(input: Parameters<typeof real.begin>[0]) {
      ids.push(input.id); const result = await real.begin(input); if (lost) { lost = false; throw new Error('Respuesta de reserva perdida'); } return result;
    } };
    const readBase = () => new Promise<any>((resolve, reject) => {
      const open = indexedDB.open(name, 1); open.onupgradeneeded = () => open.result.createObjectStore('conversation'); open.onerror = () => reject(open.error);
      open.onsuccess = () => { const db = open.result, tx = db.transaction('conversation', 'readonly'), get = tx.objectStore('conversation').get('current'); get.onsuccess = () => resolve(get.result); tx.oncomplete = () => db.close(); tx.onabort = () => reject(tx.error); };
    });
    const writer = createJournalConversationPersistence({ journal, readBase }); writer.bindBase(undefined);
    const entry = { id: crypto.randomUUID(), role: 'user', engine: 'iphone', state: 'complete', text: 'Una vez', at: 1000 };
    await writer.persist({ entries: [entry], draft: 'A' }); const blocked = writer.status(), pending = await real.pending();
    await writer.persist({ entries: [entry], draft: 'AB' });
    return { blocked, pendingId: pending?.id, final: writer.status(), saved: await readBase(), count: (await archive.stats()).entries, ids };
  });
  expect(result.blocked).toMatchObject({ blocked: true, pending: 1 });
  expect(result.pendingId).toBe(result.ids[0]);
  expect(result.final).toMatchObject({ blocked: false, pending: 0 });
  expect(result.saved).toMatchObject({ draft: 'AB', revision: 2 });
  expect(result.count).toBe(1);
  expect(result.ids).toHaveLength(2);
  expect(result.ids[1]).not.toBe(result.ids[0]); // Only after the original was durably completed.
});

test('a newer recovered archive revision advances without replacing a different visible base', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { createJournalConversationPersistence } = await import('/src/journal-conversation-persistence.ts');
    const { createConversationJournal } = await import('/src/conversation-journal.ts');
    const { createConversationArchive } = await import('/src/conversation-archive.ts');
    const suffix = crypto.randomUUID(), name = `adapter-floor-${suffix}`;
    const archive = createConversationArchive({ databaseName: `adapter-archive-${suffix}` });
    const journal = createConversationJournal({ databaseName: name, archive });
    const entry = { id: crypto.randomUUID(), role: 'user', engine: 'iphone', state: 'complete', text: 'Solicitud', at: 1000 };
    const base = { entries: [entry], draft: 'Base', revision: 1 };
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open(name, 1); open.onupgradeneeded = () => open.result.createObjectStore('conversation').put(base, 'current');
      open.onsuccess = () => { open.result.close(); resolve(); }; open.onerror = () => reject(open.error);
    });
    await archive.upsert([entry], undefined, [entry], 4);
    const readBase = () => new Promise<any>((resolve, reject) => {
      const open = indexedDB.open(name, 1); open.onerror = () => reject(open.error);
      open.onsuccess = () => { const db = open.result, tx = db.transaction('conversation', 'readonly'), get = tx.objectStore('conversation').get('current'); get.onsuccess = () => resolve(get.result); tx.oncomplete = () => db.close(); tx.onabort = () => reject(tx.error); };
    });
    const writer = createJournalConversationPersistence({ journal, readBase }); writer.setRevision(4); writer.bindBase(base);
    await writer.persist({ entries: [entry], draft: 'Continuación' });
    return { status: writer.status(), saved: await readBase(), archive: await archive.restoreState(base) };
  });
  expect(result.status).toMatchObject({ blocked: false, pending: 0 });
  expect(result.saved).toMatchObject({ draft: 'Continuación', revision: 5 });
  expect(result.archive.revision).toBe(5);
});

test('a competing window after commit prevents adopting a stale snapshot as the writer base', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { createJournalConversationPersistence } = await import('/src/journal-conversation-persistence.ts');
    const { createConversationJournal } = await import('/src/conversation-journal.ts');
    const { createConversationArchive } = await import('/src/conversation-archive.ts');
    const suffix = crypto.randomUUID(), name = `adapter-after-${suffix}`;
    const archive = createConversationArchive({ databaseName: `adapter-archive-${suffix}` });
    const real = createConversationJournal({ databaseName: name, archive });
    const journal = { pending: real.pending, begin: real.begin, async resume(id: string) {
      const result = await real.resume(id);
      await new Promise<void>((resolve, reject) => { const open = indexedDB.open(name, 1); open.onerror = () => reject(open.error); open.onsuccess = () => {
        const db = open.result, tx = db.transaction('conversation', 'readwrite'); tx.objectStore('conversation').put({ entries: [], draft: 'Otra ventana', revision: 2 }, 'current');
        tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => { db.close(); reject(tx.error); }; }; });
      return result;
    } };
    const readBase = () => new Promise<any>((resolve, reject) => {
      const open = indexedDB.open(name, 1); open.onupgradeneeded = () => open.result.createObjectStore('conversation'); open.onerror = () => reject(open.error);
      open.onsuccess = () => { const db = open.result, tx = db.transaction('conversation', 'readonly'), get = tx.objectStore('conversation').get('current'); get.onsuccess = () => resolve(get.result); tx.oncomplete = () => db.close(); tx.onabort = () => reject(tx.error); };
    });
    const writer = createJournalConversationPersistence({ journal, readBase }); writer.bindBase(undefined);
    const entry = { id: crypto.randomUUID(), role: 'user', engine: 'iphone', state: 'complete', text: 'Conservar', at: 1000 };
    await writer.persist({ entries: [entry], draft: 'Original' });
    return { status: writer.status(), pending: writer.pending(), saved: await readBase(), archived: (await archive.page()).entries };
  });
  expect(result.status.blocked).toBe(true);
  expect(result.status.conversationError).toContain('cambió después');
  expect(result.pending).toHaveLength(1);
  expect(result.saved).toMatchObject({ draft: 'Otra ventana', revision: 2 });
  expect(result.archived[0].text).toBe('Conservar');
});

test('a changed durable base keeps the stale draft pending across retries without touching the archive', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { createJournalConversationPersistence } = await import('/src/journal-conversation-persistence.ts');
    const { createConversationJournal } = await import('/src/conversation-journal.ts');
    const { createConversationArchive } = await import('/src/conversation-archive.ts');
    const suffix = crypto.randomUUID(), name = `adapter-stale-${suffix}`;
    const archive = createConversationArchive({ databaseName: `adapter-archive-${suffix}` });
    const journal = createConversationJournal({ databaseName: name, archive });
    const base = { entries: [], draft: 'Original', revision: 1 };
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open(name, 1); open.onupgradeneeded = () => open.result.createObjectStore('conversation').put(base, 'current');
      open.onsuccess = () => { open.result.close(); resolve(); }; open.onerror = () => reject(open.error);
    });
    const readBase = () => new Promise<any>((resolve, reject) => {
      const open = indexedDB.open(name, 1); open.onerror = () => reject(open.error);
      open.onsuccess = () => { const db = open.result, tx = db.transaction('conversation', 'readonly'), get = tx.objectStore('conversation').get('current'); get.onsuccess = () => resolve(get.result); tx.oncomplete = () => db.close(); tx.onabort = () => reject(tx.error); };
    });
    const writer = createJournalConversationPersistence({ journal, readBase }); writer.bindBase(base);
    await new Promise<void>((resolve, reject) => { const open = indexedDB.open(name, 1); open.onerror = () => reject(open.error); open.onsuccess = () => {
      const db = open.result, tx = db.transaction('conversation', 'readwrite'); tx.objectStore('conversation').put({ ...base, draft: 'Otra ventana', revision: 2 }, 'current');
      tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => { db.close(); reject(tx.error); }; }; });
    const entry = { id: crypto.randomUUID(), role: 'user', engine: 'iphone', state: 'complete', text: 'Pendiente local', at: 1000 };
    await writer.persist({ entries: [entry], draft: 'Mis notas' }); const first = writer.status();
    await writer.persist({ entries: [entry], draft: 'Mis notas' });
    return { first, retry: writer.status(), queued: writer.pending(), saved: await readBase(), pending: await journal.pending(), count: (await archive.stats()).entries };
  });
  expect(result.first).toMatchObject({ blocked: true, pending: 1 });
  expect(result.retry.conversationError).toContain('conversación cambió');
  expect(result.queued[0].text).toBe('Pendiente local');
  expect(result.saved).toMatchObject({ draft: 'Otra ventana', revision: 2 });
  expect(result.pending).toBeUndefined();
  expect(result.count).toBe(0);
});
