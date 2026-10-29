import { expect, test } from './fixtures.ts';

const fixture = () => ({ ownerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', destination: 'chat',
  audioSHA256: 'a'.repeat(64), audioBytes: 3,
  transcript: { sessionId: '12345678-1234-4234-8234-123456789012', text: 'Revisa el error.',
    locale: 'es-MX', source: 'apple-speech-analyzer', durationSeconds: 2,
    segments: [{ text: 'Revisa el error.', startSeconds: 0.1, endSeconds: 1.8 }] } });

test('receipts are idempotent only for exact evidence and remain scoped to their destination', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async input => {
    const path = '/src/voice-receipt-store.ts', { createVoiceReceiptStore } = await import(path);
    const name = `voice-receipt-${crypto.randomUUID()}`, a = createVoiceReceiptStore({ databaseName: name });
    const saved = await a.put(input), repeated = await a.put(input);
    const changed = await Promise.allSettled([
      a.put({ ...input, destination: `session:${'b'.repeat(64)}` }),
      a.put({ ...input, audioSHA256: 'c'.repeat(64) }),
      a.put({ ...input, transcript: { ...input.transcript, text: 'Otro texto.' } }),
      a.put({ ...input, transcript: { ...input.transcript, segments: [{ ...input.transcript.segments[0], extra: 'unexpected' }] } }),
      a.put({ ...input, transcript: { ...input.transcript, sessionId: '33333333-3333-4333-8333-333333333333' } }),
    ]);
    return { saved, repeated, changed: changed.map(item => item.status), chat: await a.list('chat'), other: await a.list(`session:${'b'.repeat(64)}`),
      reopened: await createVoiceReceiptStore({ databaseName: name }).get(input.transcript.sessionId) };
  }, fixture());
  expect(result.saved).toEqual(result.repeated);
  expect(result.reopened).toEqual(result.saved);
  expect(result.changed).toEqual(['rejected', 'rejected', 'rejected', 'rejected', 'rejected']);
  expect(result.chat).toHaveLength(1);
  expect(result.other).toEqual([]);
});

test('discard removes recognized words and times, but a tombstone prevents re-creation', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async input => {
    const path = '/src/voice-receipt-store.ts', { createVoiceReceiptStore } = await import(path);
    const name = `voice-receipt-discard-${crypto.randomUUID()}`, store = createVoiceReceiptStore({ databaseName: name });
    const receipt = await store.put(input), discarded = await store.discard(receipt), repeated = await store.discard(receipt);
    const replay = await store.put(input);
    const raw = await new Promise<any>((resolve, reject) => {
      const open = indexedDB.open(name);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result, tx = db.transaction('receipts', 'readonly'), get = tx.objectStore('receipts').get(input.transcript.sessionId);
        get.onsuccess = () => resolve(get.result); tx.oncomplete = () => db.close(); tx.onabort = () => reject(tx.error);
      };
    });
    const forged = await Promise.allSettled([store.discard({ ...receipt, version: 99 }), store.apply(receipt, await store.readDraft('chat'))]);
    return { discarded, repeated, replay, raw, forged: forged.map(item => item.status) };
  }, fixture());
  expect(result.discarded).toEqual(result.repeated);
  expect(result.discarded).toEqual(result.replay);
  expect(result.raw.state).toBe('discarded');
  expect(result.raw).not.toHaveProperty('transcript');
  expect(JSON.stringify(result.raw)).not.toContain('Revisa el error.');
  expect(JSON.stringify(result.raw)).not.toContain('startSeconds');
  expect(result.forged).toEqual(['rejected', 'rejected']);
});

test('accessor changes and mutations after a call cannot redirect a receipt or draft', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async input => {
    const path = '/src/voice-receipt-store.ts', { createVoiceReceiptStore } = await import(path);
    const name = `voice-receipt-snapshot-${crypto.randomUUID()}`, store = createVoiceReceiptStore({ databaseName: name });
    let reads = 0;
    const tricky = { ...input, get destination() { reads++; return reads === 1 ? 'chat' : 'invalid'; } };
    const receipt = await store.put(tricky);
    const previous = await store.readDraft('chat');
    const saving = store.saveDraft(previous, 'Borrador');
    previous.destination = `session:${'d'.repeat(64)}`;
    const saved = await saving;
    const expected = { ...saved };
    const applying = store.apply(receipt, expected);
    expected.destination = `session:${'d'.repeat(64)}`; expected.text = 'alterado';
    const applied = await applying;
    return { reads, receipt, saved, applied, other: await store.readDraft(`session:${'d'.repeat(64)}`) };
  }, fixture());
  expect(result.reads).toBe(1);
  expect(result.receipt.destination).toBe('chat');
  expect(result.applied.draft.text).toBe('Borrador\nRevisa el error.');
  expect(result.other.text).toBe('');
});

test('an incompatible existing schema is refused without modifying its data', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async input => {
    const path = '/src/voice-receipt-store.ts', { createVoiceReceiptStore } = await import(path);
    const name = `voice-receipt-old-schema-${crypto.randomUUID()}`;
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open(name, 1);
      open.onupgradeneeded = () => {
        const receipts = open.result.createObjectStore('receipts', { keyPath: 'transcript.sessionId' });
        receipts.put({ transcript: { sessionId: input.transcript.sessionId, text: 'Conservar' } });
        open.result.createObjectStore('drafts', { keyPath: 'destination' });
      };
      open.onsuccess = () => { open.result.close(); resolve(); }; open.onerror = () => reject(open.error);
    });
    const status = await Promise.allSettled([createVoiceReceiptStore({ databaseName: name }).put(input)]);
    const retained = await new Promise<any>((resolve, reject) => {
      const open = indexedDB.open(name);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result, tx = db.transaction('receipts', 'readonly'), get = tx.objectStore('receipts').get(input.transcript.sessionId);
        get.onsuccess = () => resolve(get.result); tx.oncomplete = () => db.close(); tx.onabort = () => reject(tx.error);
      };
    });
    return { status: status[0].status, retained };
  }, fixture());
  expect(result.status).toBe('rejected');
  expect(result.retained.transcript.text).toBe('Conservar');
});

test('draft and receipt commit together, and retry does not insert speech twice', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async input => {
    const path = '/src/voice-receipt-store.ts', { createVoiceReceiptStore } = await import(path);
    const name = `voice-receipt-apply-${crypto.randomUUID()}`, a = createVoiceReceiptStore({ databaseName: name });
    const receipt = await a.put(input), empty = await a.readDraft('chat');
    const existing = await a.saveDraft(empty, 'Borrador anterior');
    const first = await a.apply(receipt, existing);
    const typed = await a.saveDraft(first.draft, `${first.draft.text}\nNota personal`);
    const reopened = createVoiceReceiptStore({ databaseName: name });
    const retry = await reopened.apply(receipt, existing);
    const invalid = await Promise.allSettled([
      reopened.apply({ ...receipt, createdAt: receipt.createdAt + 1 }, existing),
      reopened.apply({ ...receipt, version: receipt.version + 30 }, existing),
    ]);
    return { first, typed, retry, invalid: invalid.map(item => item.status), stored: await reopened.get(input.transcript.sessionId), current: await reopened.readDraft('chat') };
  }, fixture());
  expect(result.first.alreadyApplied).toBe(false);
  expect(result.first.draft.text).toBe('Borrador anterior\nRevisa el error.');
  expect(result.retry.alreadyApplied).toBe(true);
  expect(result.invalid).toEqual(['rejected', 'rejected']);
  expect(result.retry.draft.text).toBe('Borrador anterior\nRevisa el error.\nNota personal');
  expect(result.stored).toMatchObject({ state: 'applied', appliedRevision: 2 });
  expect(result.current).toEqual(result.typed);
});

test('edit and transcription race without replacing either side', async ({ page, context }) => {
  await page.goto('/'); const other = await context.newPage(); await other.goto('/');
  const setup = await page.evaluate(async input => {
    const path = '/src/voice-receipt-store.ts', { createVoiceReceiptStore } = await import(path);
    const name = `voice-receipt-race-${crypto.randomUUID()}`, store = createVoiceReceiptStore({ databaseName: name });
    return { name, receipt: await store.put(input), draft: await store.readDraft('chat') };
  }, fixture());
  const applying = page.evaluate(async setup => {
    const path = '/src/voice-receipt-store.ts';
    return (await import(path)).createVoiceReceiptStore({ databaseName: setup.name }).apply(setup.receipt, setup.draft);
  }, setup);
  const editing = other.evaluate(async setup => {
    const path = '/src/voice-receipt-store.ts';
    return (await import(path)).createVoiceReceiptStore({ databaseName: setup.name }).saveDraft(setup.draft, 'Mi edición');
  }, setup);
  const outcomes = await Promise.allSettled([applying, editing]);
  expect(outcomes.map(item => item.status).sort()).toEqual(['fulfilled', 'rejected']);
  const persisted = await page.evaluate(async setup => {
    const path = '/src/voice-receipt-store.ts', store = (await import(path)).createVoiceReceiptStore({ databaseName: setup.name });
    return { receipt: await store.get(setup.receipt.transcript.sessionId), draft: await store.readDraft('chat') };
  }, setup);
  if (outcomes[0].status === 'fulfilled') {
    expect(persisted.receipt.state).toBe('applied'); expect(persisted.draft.text).toBe('Revisa el error.');
  } else {
    expect(persisted.receipt.state).toBe('pending'); expect(persisted.draft.text).toBe('Mi edición');
    const later = await page.evaluate(async setup => {
      const path = '/src/voice-receipt-store.ts', store = (await import(path)).createVoiceReceiptStore({ databaseName: setup.name });
      return store.apply(setup.receipt, await store.readDraft('chat'));
    }, setup);
    expect(later.draft.text).toBe('Mi edición\nRevisa el error.');
  }
  await other.close();
});

test('two pages cannot create distinct sessions for the same native owner', async ({ page, context }) => {
  await page.goto('/'); const other = await context.newPage(); await other.goto('/');
  const name = `voice-receipt-owner-${await page.evaluate(() => crypto.randomUUID())}`, input = fixture();
  const put = (current: typeof page, sessionId: string, destination: string) => current.evaluate(async ({ name, input, sessionId, destination }) => {
    const path = '/src/voice-receipt-store.ts';
    return (await import(path)).createVoiceReceiptStore({ databaseName: name }).put({ ...input, destination, transcript: { ...input.transcript, sessionId } });
  }, { name, input, sessionId, destination });
  const results = await Promise.allSettled([
    put(page, input.transcript.sessionId, 'chat'),
    put(other, '33333333-3333-4333-8333-333333333333', `session:${'b'.repeat(64)}`),
  ]);
  expect(results.map(item => item.status).sort()).toEqual(['fulfilled', 'rejected']);
  const stored = await page.evaluate(async name => {
    const path = '/src/voice-receipt-store.ts', store = (await import(path)).createVoiceReceiptStore({ databaseName: name });
    return [...await store.list('chat'), ...await store.list(`session:${'b'.repeat(64)}`)];
  }, name);
  expect(stored).toHaveLength(1);
  await other.close();
});

test('concurrent apply and explicit discard have one winner, without cross-destination insertion', async ({ page, context }) => {
  await page.goto('/'); const other = await context.newPage(); await other.goto('/');
  const setup = await page.evaluate(async input => {
    const path = '/src/voice-receipt-store.ts', { createVoiceReceiptStore } = await import(path);
    const name = `voice-receipt-cancel-${crypto.randomUUID()}`, store = createVoiceReceiptStore({ databaseName: name });
    return { name, receipt: await store.put(input), draft: await store.readDraft('chat') };
  }, fixture());
  const apply = page.evaluate(async setup => {
    const path = '/src/voice-receipt-store.ts'; return (await import(path)).createVoiceReceiptStore({ databaseName: setup.name }).apply(setup.receipt, setup.draft);
  }, setup);
  const discard = other.evaluate(async setup => {
    const path = '/src/voice-receipt-store.ts'; return (await import(path)).createVoiceReceiptStore({ databaseName: setup.name }).discard(setup.receipt);
  }, setup);
  const outcomes = await Promise.allSettled([apply, discard]);
  expect(outcomes.map(item => item.status).sort()).toEqual(['fulfilled', 'rejected']);
  const persisted = await page.evaluate(async setup => {
    const path = '/src/voice-receipt-store.ts', store = (await import(path)).createVoiceReceiptStore({ databaseName: setup.name });
    const wrong = await Promise.allSettled([store.apply(setup.receipt, { destination: `session:${'d'.repeat(64)}`, text: '', revision: 0 })]);
    return { receipt: await store.get(setup.receipt.transcript.sessionId), draft: await store.readDraft('chat'), wrong: wrong[0].status };
  }, setup);
  expect(persisted.wrong).toBe('rejected');
  if (outcomes[0].status === 'fulfilled') { expect(persisted.receipt.state).toBe('applied'); expect(persisted.draft.text).toBe('Revisa el error.'); }
  else { expect(persisted.receipt.state).toBe('discarded'); expect(persisted.draft.text).toBe(''); }
  await other.close();
});

test('aborted writes and an oversized draft preserve the receipt and previous draft', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async input => {
    const path = '/src/voice-receipt-store.ts', { createVoiceReceiptStore } = await import(path);
    const name = `voice-receipt-abort-${crypto.randomUUID()}`, store = createVoiceReceiptStore({ databaseName: name });
    const receipt = await store.put(input), empty = await store.readDraft('chat');
    const prior = await store.saveDraft(empty, 'Antes');
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      const request = original.apply(this, args);
      if (this.transaction.db.name === name && this.name === 'receipts') throw new Error('abort after both write requests');
      return request;
    };
    let aborted = false;
    try { await store.apply(receipt, prior); } catch { aborted = true; }
    finally { IDBObjectStore.prototype.put = original; }
    const afterAbort = { receipt: await store.get(input.transcript.sessionId), draft: await store.readDraft('chat') };
    const full = await store.saveDraft(prior, 'x'.repeat(8000));
    const over = await Promise.allSettled([store.apply(receipt, full)]);
    return { aborted, afterAbort, over: over[0].status, final: { receipt: await store.get(input.transcript.sessionId), draft: await store.readDraft('chat') } };
  }, fixture());
  expect(result.aborted).toBe(true);
  expect(result.afterAbort.receipt.state).toBe('pending'); expect(result.afterAbort.draft.text).toBe('Antes');
  expect(result.over).toBe('rejected'); expect(result.final.receipt.state).toBe('pending'); expect(result.final.draft.text).toHaveLength(8000);
});
