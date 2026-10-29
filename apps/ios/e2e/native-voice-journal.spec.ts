import { expect, test } from './fixtures.ts';

test('voice insertion and its identity commit together, including restart and a repeated request', async ({ page }) => {
  await page.goto('/');
  const setup = await page.evaluate(async () => {
    const { createConversationJournal } = await import('/src/conversation-journal.ts');
    const { createConversationArchive } = await import('/src/conversation-archive.ts');
    const { createNativeVoiceDelivery, prepareNativeVoiceDelivery } = await import('/src/native-voice-delivery.ts');
    const name = `voice-journal-${crypto.randomUUID()}`, archiveName = `voice-archive-${crypto.randomUUID()}`, op = crypto.randomUUID();
    const id = 'ABCDEF01-ABCD-4BCD-8BCD-ABCDEF012345', text = 'Dictado';
    const receipt = { schema: 'capri-native-voice-receipt/v1', audio: { id, owner: 'abcdef02-abcd-4bcd-8bcd-abcdef012345', destination: 'chat', locale: 'es-MX', kind: 'speech', createdAt: 1, state: 'ready', byteCount: 10, sha256: 'a'.repeat(64) }, transcript: { sessionId: id, text, segments: [{ text, startSeconds: 0, endSeconds: 1 }], durationSeconds: 1, locale: 'es-MX', source: 'apple-speech-analyzer' } } as const;
    const intent = await prepareNativeVoiceDelivery(receipt, 'Antes'), snapshot = { entries: [], draft: 'Antes\nDictado', revision: 1 };
    const journal = createConversationJournal({ databaseName: name, archive: createConversationArchive({ databaseName: archiveName }) });
    await journal.begin({ id: op, baseRevision: 0, snapshot, pending: [], voiceDelivery: intent });
    return { name, archiveName, op, receipt, intent, snapshot, before: await createNativeVoiceDelivery({ databaseName: name }).delivered(receipt) };
  });
  expect(setup.before).toBe(false);
  await page.reload();
  const after = await page.evaluate(async setup => {
    const { createConversationJournal } = await import('/src/conversation-journal.ts');
    const { createConversationArchive } = await import('/src/conversation-archive.ts');
    const { createNativeVoiceDelivery } = await import('/src/native-voice-delivery.ts');
    const journal = createConversationJournal({ databaseName: setup.name, archive: createConversationArchive({ databaseName: setup.archiveName }) });
    await journal.resume(setup.op);
    const marker = await createNativeVoiceDelivery({ databaseName: setup.name }).delivered(setup.receipt as any);
    const retry = await journal.resume(setup.op);
    const repeated = await Promise.allSettled([journal.begin({ id: crypto.randomUUID(), baseRevision: 1, base: setup.snapshot, snapshot: { ...setup.snapshot, revision: 2 }, pending: [], voiceDelivery: setup.intent })]);
    return { marker, retry, repeated: repeated[0].status, pending: await journal.pending() };
  }, setup);
  expect(after.marker).toBe(true);
  expect(after.retry.alreadyCommitted).toBe(true);
  expect(after.repeated).toBe('rejected'); expect(after.pending).toBeUndefined();
});

test('an altered insertion or mismatched receipt cannot create a delivery marker', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { createConversationJournal } = await import('/src/conversation-journal.ts');
    const { createConversationArchive } = await import('/src/conversation-archive.ts');
    const { createNativeVoiceDelivery, prepareNativeVoiceDelivery } = await import('/src/native-voice-delivery.ts');
    const name = `voice-bad-${crypto.randomUUID()}`, archiveName = `voice-bad-archive-${crypto.randomUUID()}`;
    const id = 'ABCDEF01-ABCD-4BCD-8BCD-ABCDEF012345', text = 'Original';
    const receipt = { schema: 'capri-native-voice-receipt/v1', audio: { id, owner: 'abcdef02-abcd-4bcd-8bcd-abcdef012345', destination: 'chat', locale: 'es-MX', kind: 'speech', createdAt: 1, state: 'ready', byteCount: 10, sha256: 'a'.repeat(64) }, transcript: { sessionId: id, text, segments: [{ text, startSeconds: 0, endSeconds: 1 }], durationSeconds: 1, locale: 'es-MX', source: 'apple-speech-analyzer' } } as const;
    const intent = await prepareNativeVoiceDelivery(receipt, ''), journal = createConversationJournal({ databaseName: name, archive: createConversationArchive({ databaseName: archiveName }) });
    const failure = await Promise.allSettled([journal.begin({ id: crypto.randomUUID(), baseRevision: 0, snapshot: { entries: [], draft: 'Otro', revision: 1 }, pending: [], voiceDelivery: intent })]);
    return { failure: failure[0].status, pending: await journal.pending(), delivered: await createNativeVoiceDelivery({ databaseName: name }).delivered(receipt) };
  });
  expect(result).toEqual({ failure: 'rejected', pending: undefined, delivered: false });
});

test('a pre-reservation failure retries the original voice action before a newer edited draft', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { createConversationJournal, JournalReservationRejected } = await import('/src/conversation-journal.ts');
    const { createConversationArchive } = await import('/src/conversation-archive.ts');
    const { createJournalConversationPersistence } = await import('/src/journal-conversation-persistence.ts');
    const { createNativeVoiceDelivery, prepareNativeVoiceDelivery } = await import('/src/native-voice-delivery.ts');
    const name = `voice-deferred-${crypto.randomUUID()}`, archiveName = `voice-deferred-archive-${crypto.randomUUID()}`;
    const id = 'ABCDEF01-ABCD-4BCD-8BCD-ABCDEF012345', text = 'Dictado';
    const receipt = { schema: 'capri-native-voice-receipt/v1', audio: { id, owner: 'abcdef02-abcd-4bcd-8bcd-abcdef012345', destination: 'chat', locale: 'es-MX', kind: 'speech', createdAt: 1, state: 'ready', byteCount: 10, sha256: 'a'.repeat(64) }, transcript: { sessionId: id, text, segments: [{ text, startSeconds: 0, endSeconds: 1 }], durationSeconds: 1, locale: 'es-MX', source: 'apple-speech-analyzer' } } as const;
    const intent = await prepareNativeVoiceDelivery(receipt, 'Antes'), journal = createConversationJournal({ databaseName: name, archive: createConversationArchive({ databaseName: archiveName }) });
    let first = true;
    const readBase = () => new Promise<any>((resolve, reject) => { const open = indexedDB.open(name, 1); open.onerror = () => reject(open.error); open.onsuccess = () => { const db = open.result, tx = db.transaction('conversation', 'readonly'), get = tx.objectStore('conversation').get('current'); get.onsuccess = () => resolve(get.result); tx.oncomplete = () => db.close(); tx.onabort = () => reject(tx.error); }; });
    const writer = createJournalConversationPersistence({ readBase, journal: { pending: journal.pending, resume: journal.resume, begin: async input => { if (first) { first = false; throw new JournalReservationRejected('Cuota'); } return journal.begin(input); } } });
    writer.bindBase(undefined);
    await writer.persist({ entries: [], draft: 'Antes\nDictado' }, intent);
    const blocked = writer.status().blocked;
    await writer.persist({ entries: [], draft: 'Antes\nDictado\nEditado' });
    return { blocked, final: await readBase(), delivered: await createNativeVoiceDelivery({ databaseName: name }).delivered(receipt), status: writer.status() };
  });
  expect(result.blocked).toBe(true); expect(result.status.blocked).toBe(false);
  expect(result.delivered).toBe(true); expect(result.final.draft).toBe('Antes\nDictado\nEditado');
});

test('two windows cannot reserve and insert the same dictation twice', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { createConversationJournal } = await import('/src/conversation-journal.ts');
    const { createConversationArchive } = await import('/src/conversation-archive.ts');
    const { createNativeVoiceDelivery, prepareNativeVoiceDelivery } = await import('/src/native-voice-delivery.ts');
    const name = `voice-concurrent-${crypto.randomUUID()}`, archiveName = `voice-concurrent-archive-${crypto.randomUUID()}`;
    const id = 'ABCDEF01-ABCD-4BCD-8BCD-ABCDEF012345', text = 'Una vez';
    const receipt = { schema: 'capri-native-voice-receipt/v1', audio: { id, owner: 'abcdef02-abcd-4bcd-8bcd-abcdef012345', destination: 'chat', locale: 'es-MX', kind: 'speech', createdAt: 1, state: 'ready', byteCount: 10, sha256: 'a'.repeat(64) }, transcript: { sessionId: id, text, segments: [{ text, startSeconds: 0, endSeconds: 1 }], durationSeconds: 1, locale: 'es-MX', source: 'apple-speech-analyzer' } } as const;
    const intent = await prepareNativeVoiceDelivery(receipt, ''), archive = createConversationArchive({ databaseName: archiveName });
    const a = createConversationJournal({ databaseName: name, archive }), b = createConversationJournal({ databaseName: name, archive });
    const one = crypto.randomUUID(), two = crypto.randomUUID(), snapshot = { entries: [], draft: 'Una vez', revision: 1 };
    const contenders = await Promise.allSettled([a.begin({ id: one, baseRevision: 0, snapshot, pending: [], voiceDelivery: intent }), b.begin({ id: two, baseRevision: 0, snapshot, pending: [], voiceDelivery: intent })]);
    const winning = contenders[0].status === 'fulfilled' ? one : two;
    await a.resume(winning);
    return { statuses: contenders.map(item => item.status).sort(), delivered: await createNativeVoiceDelivery({ databaseName: name }).delivered(receipt), pending: await a.pending() };
  });
  expect(result.statuses).toEqual(['fulfilled', 'rejected']); expect(result.delivered).toBe(true); expect(result.pending).toBeUndefined();
});

for (const rejectFirst of [false, true]) test(`an earlier queued draft cannot overwrite a later voice insertion${rejectFirst ? ' after a pre-reservation failure' : ''}`, async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async rejectFirst => {
    const { createConversationJournal, JournalReservationRejected } = await import('/src/conversation-journal.ts');
    const { createConversationArchive } = await import('/src/conversation-archive.ts');
    const { createJournalConversationPersistence } = await import('/src/journal-conversation-persistence.ts');
    const { createNativeVoiceDelivery, prepareNativeVoiceDelivery } = await import('/src/native-voice-delivery.ts');
    const name = `voice-order-${crypto.randomUUID()}`, archiveName = `voice-order-archive-${crypto.randomUUID()}`;
    const id = 'ABCDEF01-ABCD-4BCD-8BCD-ABCDEF012345', text = 'Dictado';
    const receipt = { schema: 'capri-native-voice-receipt/v1', audio: { id, owner: 'abcdef02-abcd-4bcd-8bcd-abcdef012345', destination: 'chat', locale: 'es-MX', kind: 'speech', createdAt: 1, state: 'ready', byteCount: 10, sha256: 'a'.repeat(64) }, transcript: { sessionId: id, text, segments: [{ text, startSeconds: 0, endSeconds: 1 }], durationSeconds: 1, locale: 'es-MX', source: 'apple-speech-analyzer' } } as const;
    const intent = await prepareNativeVoiceDelivery(receipt, 'Antes'), journal = createConversationJournal({ databaseName: name, archive: createConversationArchive({ databaseName: archiveName }) });
    let rejectVoice = rejectFirst;
    const readBase = () => new Promise<any>((resolve, reject) => { const open = indexedDB.open(name, 1); open.onerror = () => reject(open.error); open.onsuccess = () => { const db = open.result, tx = db.transaction('conversation', 'readonly'), get = tx.objectStore('conversation').get('current'); get.onsuccess = () => resolve(get.result); tx.oncomplete = () => db.close(); tx.onabort = () => reject(tx.error); }; });
    const writer = createJournalConversationPersistence({ readBase, journal: { pending: journal.pending, resume: journal.resume, begin: async input => { if (input.voiceDelivery && rejectVoice) { rejectVoice = false; throw new JournalReservationRejected('Cuota'); } return journal.begin(input); } } });
    writer.bindBase(undefined);
    const earlier = writer.persist({ entries: [], draft: 'Antes' });
    const voice = writer.persist({ entries: [], draft: 'Antes\nDictado' }, intent);
    const later = writer.persist({ entries: [], draft: 'Antes\nDictado\nEditado' });
    await Promise.all([earlier, voice, later]);
    return { final: await readBase(), delivered: await createNativeVoiceDelivery({ databaseName: name }).delivered(receipt), status: writer.status() };
  }, rejectFirst);
  expect(result.status.blocked).toBe(false); expect(result.delivered).toBe(true);
  expect(result.final.draft).toBe('Antes\nDictado\nEditado');
});

test('a forged transcript and coherent snapshot never mark the original receipt delivered', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { createConversationJournal } = await import('/src/conversation-journal.ts');
    const { createConversationArchive } = await import('/src/conversation-archive.ts');
    const { createNativeVoiceDelivery, prepareNativeVoiceDelivery } = await import('/src/native-voice-delivery.ts');
    const name = `voice-forge-${crypto.randomUUID()}`, archiveName = `voice-forge-archive-${crypto.randomUUID()}`;
    const id = 'ABCDEF01-ABCD-4BCD-8BCD-ABCDEF012345', text = 'Texto real 🧠';
    const receipt = { schema: 'capri-native-voice-receipt/v1', audio: { id, owner: 'abcdef02-abcd-4bcd-8bcd-abcdef012345', destination: 'chat', locale: 'es-MX', kind: 'speech', createdAt: 1, state: 'ready', byteCount: 10, sha256: 'a'.repeat(64) }, transcript: { sessionId: id, text, segments: [{ text, startSeconds: 0, endSeconds: 1 }], durationSeconds: 1, locale: 'es-MX', source: 'apple-speech-analyzer' } } as const;
    const intent = await prepareNativeVoiceDelivery(receipt, ''), journal = createConversationJournal({ databaseName: name, archive: createConversationArchive({ databaseName: archiveName }) });
    const bad = structuredClone(intent); bad.transcript = 'Texto alterado';
    const atBegin = await Promise.allSettled([journal.begin({ id: crypto.randomUUID(), baseRevision: 0, snapshot: { entries: [], draft: bad.transcript, revision: 1 }, pending: [], voiceDelivery: bad })]);
    const operation = crypto.randomUUID(); await journal.begin({ id: operation, baseRevision: 0, snapshot: { entries: [], draft: text, revision: 1 }, pending: [], voiceDelivery: intent });
    await new Promise<void>((resolve, reject) => { const open = indexedDB.open(name, 1); open.onerror = () => reject(open.error); open.onsuccess = () => { const db = open.result, tx = db.transaction('conversation', 'readwrite'), store = tx.objectStore('conversation'), req = store.get('conversation-journal:v1'); req.onsuccess = () => { const item = req.result; item.snapshot.draft = 'Texto alterado'; item.voiceDelivery.transcript = 'Texto alterado'; item.voiceDelivery.receipt.transcript.text = 'Texto alterado'; item.voiceDelivery.receipt.transcript.segments[0].text = 'Texto alterado'; store.put(item, 'conversation-journal:v1'); }; tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => reject(tx.error); }; });
    const atResume = await Promise.allSettled([journal.resume(operation)]);
    return { atBegin: atBegin[0].status, atResume: atResume[0].status, delivered: await createNativeVoiceDelivery({ databaseName: name }).delivered(receipt), pending: Boolean(await journal.pending()) };
  });
  expect(result).toEqual({ atBegin: 'rejected', atResume: 'rejected', delivered: false, pending: true });
});

test('delivery cannot authorize cleanup when the current snapshot is missing, corrupt or older', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { createConversationJournal } = await import('/src/conversation-journal.ts');
    const { createConversationArchive } = await import('/src/conversation-archive.ts');
    const { createNativeVoiceDelivery, prepareNativeVoiceDelivery } = await import('/src/native-voice-delivery.ts');
    const { cleanupDeliveredVoiceReceipt } = await import('/src/protected-voice.ts');
    const name = `voice-current-${crypto.randomUUID()}`, archiveName = `voice-current-archive-${crypto.randomUUID()}`;
    const id = 'ABCDEF01-ABCD-4BCD-8BCD-ABCDEF012345', text = 'Guardado';
    const receipt = { schema: 'capri-native-voice-receipt/v1', audio: { id, owner: 'abcdef02-abcd-4bcd-8bcd-abcdef012345', destination: 'chat', locale: 'es-MX', kind: 'speech', createdAt: 1, state: 'ready', byteCount: 10, sha256: 'a'.repeat(64) }, transcript: { sessionId: id, text, segments: [{ text, startSeconds: 0, endSeconds: 1 }], durationSeconds: 1, locale: 'es-MX', source: 'apple-speech-analyzer' } } as const;
    const journal = createConversationJournal({ databaseName: name, archive: createConversationArchive({ databaseName: archiveName }) });
    const op = crypto.randomUUID(), intent = await prepareNativeVoiceDelivery(receipt, '');
    await journal.begin({ id: op, baseRevision: 0, snapshot: { entries: [], draft: text, revision: 1 }, pending: [], voiceDelivery: intent }); await journal.resume(op);
    const delivery = createNativeVoiceDelivery({ databaseName: name }); let releases = 0, discards = 0;
    const deps = { delivered: delivery.delivered, release: async () => { releases++; }, get: async () => ({ receipt, releaseState: 'released' as const }), discard: async () => { discards++; } };
    const set = (value?: unknown) => new Promise<void>((resolve, reject) => { const open = indexedDB.open(name, 1); open.onerror = () => reject(open.error); open.onsuccess = () => { const db = open.result, tx = db.transaction('conversation', 'readwrite'), store = tx.objectStore('conversation'); value === undefined ? store.delete('current') : store.put(value, 'current'); tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => reject(tx.error); }; });
    const outcomes = [];
    for (const current of [undefined, { entries: [], draft: text, revision: 0 }, { entries: [{ id: 'corrupt' }], draft: text, revision: 1 }, { entries: [], draft: 'Alterado con la misma revisión', revision: 1 }]) {
      await set(current); outcomes.push((await Promise.allSettled([cleanupDeliveredVoiceReceipt(receipt, deps)]))[0].status);
    }
    await set({ entries: [], draft: 'Editado voluntariamente', revision: 2 });
    const legitimate = await delivery.delivered(receipt);
    return { outcomes, releases, discards, legitimate };
  });
  expect(result).toEqual({ outcomes: ['rejected', 'rejected', 'rejected', 'rejected'], releases: 0, discards: 0, legitimate: true });
});
