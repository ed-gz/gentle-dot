import { expect, test } from './fixtures.ts';

const fixture = () => ({ ownerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', destination: 'chat', audioSHA256: 'a'.repeat(64), audioBytes: 3,
  transcript: { sessionId: '12345678-1234-4234-8234-123456789012', text: 'Revisa el error.', locale: 'es-MX', source: 'apple-speech-analyzer', durationSeconds: 2,
    segments: [{ text: 'Revisa el error.', startSeconds: 0.1, endSeconds: 1.8 }] } });

test('real conversation v1 stores draft and bound receipt together and retry never inserts twice', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async input => {
    const path = '/src/voice-chat-commit.ts', { createVoiceChatCommit } = await import(path);
    const name = `voice-chat-atomic-${crypto.randomUUID()}`;
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open(name, 1);
      open.onupgradeneeded = () => open.result.createObjectStore('conversation').put({ entries: [], draft: 'Antes', revision: 1 }, 'current');
      open.onsuccess = () => { open.result.close(); resolve(); }; open.onerror = () => reject(open.error);
    });
    const store = createVoiceChatCommit({ databaseName: name }), base = { draft: 'Antes', revision: 1 };
    const first = await store.apply(input, base);
    const retried = await createVoiceChatCommit({ databaseName: name }).apply(input, base);
    const invalid = await Promise.allSettled([
      store.apply({ ...input, destination: `session:${'b'.repeat(64)}` }, base),
      store.apply({ ...input, audioSHA256: 'b'.repeat(64) }, base),
      store.apply(input, { draft: 'Otra versión', revision: 1 }),
      store.apply({ ...input, transcript: { ...input.transcript, sessionId: '33333333-3333-4333-8333-333333333333' } }, { draft: first.currentDraft, revision: first.currentRevision }),
    ]);
    return { first, retried, invalid: invalid.map(item => item.status), receipt: await store.inspect(input.transcript.sessionId) };
  }, fixture());
  expect(result.first).toMatchObject({ currentDraft: 'Antes\nRevisa el error.', currentRevision: 2, alreadyApplied: false });
  expect(result.retried).toMatchObject({ currentDraft: 'Antes\nRevisa el error.', currentRevision: 2, alreadyApplied: true });
  expect(result.invalid).toEqual(['rejected', 'rejected', 'rejected', 'rejected']);
  expect(result.receipt.input.transcript.text).toBe('Revisa el error.');
  expect(JSON.stringify(result.receipt)).not.toContain('Antes');
});

test('two pages racing with the same base cannot overwrite another voice or user draft', async ({ page, context }) => {
  await page.goto('/'); const other = await context.newPage(); await other.goto('/');
  const name = `voice-chat-race-${await page.evaluate(() => crypto.randomUUID())}`, input = fixture();
  const apply = (current: typeof page, value: any) => current.evaluate(async ({ name, value }) => {
    const path = '/src/voice-chat-commit.ts';
    return (await import(path)).createVoiceChatCommit({ databaseName: name }).apply(value, { draft: '', revision: 0 });
  }, { name, value });
  const changed = { ...input, ownerId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', transcript: { ...input.transcript, sessionId: '33333333-3333-4333-8333-333333333333' } };
  const outcomes = await Promise.allSettled([apply(page, input), apply(other, changed)]);
  expect(outcomes.map(value => value.status).sort()).toEqual(['fulfilled', 'rejected']);
  const winner = outcomes[0].status === 'fulfilled' ? input : changed;
  const inspection = await page.evaluate(async ({ name, winner }) => {
    const path = '/src/voice-chat-commit.ts';
    return (await import(path)).createVoiceChatCommit({ databaseName: name }).inspect(winner.transcript.sessionId);
  }, { name, winner });
  expect(inspection.input.transcript.text).toBe('Revisa el error.');
  await other.close();
});

test('aborted owner write commits neither receipt nor draft', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async input => {
    const path = '/src/voice-chat-commit.ts', { createVoiceChatCommit } = await import(path);
    const name = `voice-chat-abort-${crypto.randomUUID()}`, store = createVoiceChatCommit({ databaseName: name });
    const previous = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      const request = previous.apply(this, args);
      if (this.transaction.db.name === name && typeof args[1] === 'string' && args[1].startsWith('voice-owner:')) throw new Error('simulated abort after all writes requested');
      return request;
    };
    const failure = await Promise.allSettled([store.apply(input, { draft: '', revision: 0 })]);
    IDBObjectStore.prototype.put = previous;
    const receipt = await store.inspect(input.transcript.sessionId);
    const retry = await store.apply(input, { draft: '', revision: 0 });
    return { failed: failure[0].status, receipt, retry };
  }, fixture());
  expect(result.failed).toBe('rejected'); expect(result.receipt).toBeUndefined();
  expect(result.retry).toMatchObject({ currentDraft: 'Revisa el error.', currentRevision: 1, alreadyApplied: false });
});

test('a newer stale snapshot cannot erase the independent committed voice proof', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async input => {
    const path = '/src/voice-chat-commit.ts', { createVoiceChatCommit } = await import(path);
    const name = `voice-chat-snapshot-${crypto.randomUUID()}`, store = createVoiceChatCommit({ databaseName: name });
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open(name, 1);
      open.onupgradeneeded = () => open.result.createObjectStore('conversation').put({ entries: [], draft: 'Notas privadas', revision: 1 }, 'current');
      open.onsuccess = () => { open.result.close(); resolve(); }; open.onerror = () => reject(open.error);
    });
    const first = await store.apply(input, { draft: 'Notas privadas', revision: 1 });
    // Reproduce the current writer limitation: a newer stale snapshot can win.
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open(name, 1);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result, tx = db.transaction('conversation', 'readwrite');
        tx.objectStore('conversation').put({ entries: [], draft: 'Nueva edición', revision: 3 }, 'current');
        tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => { db.close(); reject(tx.error); };
      };
    });
    const receipt = await store.inspect(input.transcript.sessionId), recovered = await createVoiceChatCommit({ databaseName: name }).list();
    const retry = await store.apply(input, { draft: 'Notas privadas', revision: 1 });
    return { first, receipt, retry, recovered };
  }, fixture());
  expect(result.receipt.input.transcript.text).toBe('Revisa el error.');
  expect(JSON.stringify(result.receipt)).not.toContain('Notas privadas');
  expect(result.recovered).toHaveLength(1);
  expect(result.recovered[0].input.transcript.text).toBe('Revisa el error.');
  expect(result.retry).toMatchObject({ currentDraft: 'Nueva edición', currentRevision: 3, alreadyApplied: true });
});

test('corrupt data, incompatible schemas and oversize transcripts never alter existing content', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async input => {
    const path = '/src/voice-chat-commit.ts', { createVoiceChatCommit } = await import(path);
    async function seed(name: string, wrongSchema: boolean, value: object) {
      await new Promise<void>((resolve, reject) => {
        const open = indexedDB.open(name, 1);
        open.onupgradeneeded = () => { const store = wrongSchema ? open.result.createObjectStore('conversation', { keyPath: 'id' }) : open.result.createObjectStore('conversation');
          if (wrongSchema) store.put({ id: 'current', ...value }); else store.put(value, 'current'); };
        open.onsuccess = () => { open.result.close(); resolve(); }; open.onerror = () => reject(open.error);
      });
    }
    const names = [0,1,2].map(() => `voice-chat-invalid-${crypto.randomUUID()}`);
    await seed(names[0], true, { entries: [], draft: 'conservar', revision: 1 });
    await seed(names[1], false, { entries: [], draft: 'conservar', revision: 1, injected: 'no tocar' });
    await seed(names[2], false, { entries: [], draft: 'x'.repeat(8000), revision: 1 });
    const statuses = await Promise.all(names.map((name, index) => Promise.allSettled([createVoiceChatCommit({ databaseName: name }).apply(input,
      { draft: index === 2 ? 'x'.repeat(8000) : 'conservar', revision: 1 })]).then(result => result[0].status)));
    const retained = await Promise.all(names.map(name => new Promise<any>((resolve, reject) => {
      const open = indexedDB.open(name); open.onerror = () => reject(open.error);
      open.onsuccess = () => { const db = open.result, tx = db.transaction('conversation', 'readonly'), get = tx.objectStore('conversation').get('current');
        get.onsuccess = () => resolve(get.result); tx.oncomplete = () => db.close(); tx.onabort = () => reject(tx.error); };
    })));
    return { statuses, retained };
  }, fixture());
  expect(result.statuses).toEqual(['rejected', 'rejected', 'rejected']);
  expect(result.retained[0].draft).toBe('conservar'); expect(result.retained[1].injected).toBe('no tocar'); expect(result.retained[2].draft).toHaveLength(8000);
});

test('inspection refuses a receipt when its owner binding is missing or changed', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async input => {
    const path = '/src/voice-chat-commit.ts', { createVoiceChatCommit } = await import(path);
    const name = `voice-chat-owner-${crypto.randomUUID()}`, store = createVoiceChatCommit({ databaseName: name });
    await store.apply(input, { draft: '', revision: 0 });
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open(name); open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result, tx = db.transaction('conversation', 'readwrite');
        tx.objectStore('conversation').put('33333333-3333-4333-8333-333333333333', `voice-owner:${input.ownerId}`);
        tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => { db.close(); reject(tx.error); };
      };
    });
    const inspected = await Promise.allSettled([store.inspect(input.transcript.sessionId), store.list()]);
    return inspected.map(item => item.status);
  }, fixture());
  expect(result).toEqual(['rejected', 'rejected']);
});

test('draft proof distinguishes a lone surrogate from a replacement character', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async input => {
    const path = '/src/voice-chat-commit.ts', { createVoiceChatCommit } = await import(path);
    const apply = async (draft: string) => {
      const name = `voice-chat-unicode-${crypto.randomUUID()}`;
      await new Promise<void>((resolve, reject) => {
        const open = indexedDB.open(name, 1);
        open.onupgradeneeded = () => open.result.createObjectStore('conversation').put({ entries: [], draft, revision: 1 }, 'current');
        open.onsuccess = () => { open.result.close(); resolve(); }; open.onerror = () => reject(open.error);
      });
      return createVoiceChatCommit({ databaseName: name }).apply(input, { draft, revision: 1 });
    };
    const lone = await apply('\ud800'), replacement = await apply('\ufffd');
    return { lone: lone.receipt.committedDraftSHA256, replacement: replacement.receipt.committedDraftSHA256 };
  }, fixture());
  expect(result.lone).not.toBe(result.replacement);
});

test('a modified transcript is not accepted as the original receipt', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async input => {
    const path = '/src/voice-chat-commit.ts', { createVoiceChatCommit } = await import(path);
    const name = `voice-chat-mismatched-proof-${crypto.randomUUID()}`, store = createVoiceChatCommit({ databaseName: name });
    await store.apply(input, { draft: '', revision: 0 });
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open(name); open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result, tx = db.transaction('conversation', 'readwrite'), items = tx.objectStore('conversation'), key = `voice-receipt:${input.transcript.sessionId}`;
        const get = items.get(key);
        get.onsuccess = () => {
          const old = get.result;
          items.put({ ...old, input: { ...old.input, transcript: { ...old.input.transcript, text: 'otro texto',
            segments: [{ text: 'otro texto', startSeconds: 0.1, endSeconds: 1.8 }] } } }, key);
        };
        tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => { db.close(); reject(tx.error); };
      };
    });
    const checked = await Promise.allSettled([store.inspect(input.transcript.sessionId), store.list()]);
    return checked.map(item => item.status);
  }, fixture());
  expect(result).toEqual(['rejected', 'rejected']);
});
