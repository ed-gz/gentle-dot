import { expect, test } from './fixtures.ts';

test('session draft bytes survive reload, remain scoped, and concurrent stale writers cannot revive a cleared file', async ({ page }) => {
  await page.goto('/');
  expect(await page.evaluate(async () => {
    const path = '/src/session-attachment-drafts.ts';
    const { sessionAttachmentDraft: draft } = await import(path);
    const one = draft('wss://one.example/ws', 'pane', 'session');
    const stale = draft('wss://one.example/ws', 'pane', 'session');
    await one.load(); await stale.load();
    await one.save([new File([new Uint8Array([0, 255, 17, 128])], 'evidencia.bin', { type: 'application/octet-stream', lastModified: 1234 })]);
    let conflict = '';
    try { await stale.save([]); } catch (error) { conflict = (error as Error).message; }
    return {
      conflict,
      otherHost: (await draft('wss://two.example/ws', 'pane', 'session').load()).length,
      otherSession: (await draft('wss://one.example/ws', 'pane', 'other').load()).length,
    };
  })).toEqual({ conflict: expect.stringContaining('otra vista'), otherHost: 0, otherSession: 0 });
  await page.reload();
  expect(await page.evaluate(async () => {
    const path = '/src/session-attachment-drafts.ts';
    const { sessionAttachmentDraft: draft } = await import(path);
    const one = draft('wss://one.example/ws', 'pane', 'session');
    const [file] = await one.load();
    const stale = draft('wss://one.example/ws', 'pane', 'session');
    await stale.load(); await one.save([]);
    let conflict = '';
    try { await stale.save([file]); } catch (error) { conflict = (error as Error).message; }
    return { name: file.name, type: file.type, modified: file.lastModified, bytes: [...new Uint8Array(await file.arrayBuffer())], conflict, cleared: (await one.load()).length };
  })).toEqual({ name: 'evidencia.bin', type: 'application/octet-stream', modified: 1234, bytes: [0, 255, 17, 128], conflict: expect.stringContaining('otra vista'), cleared: 0 });
});

test('queued mutations settle before a new editor loads; quota abort retains the previously committed bytes', async ({ page }) => {
  await page.goto('/');
  expect(await page.evaluate(async () => {
    const path = '/src/session-attachment-drafts.ts';
    const { sessionAttachmentDraft: draft } = await import(path);
    const one = draft('wss://one.example/ws', 'pane', 'session');
    await one.load();
    const first = one.save([new File(['first'], 'one.txt')]);
    const second = one.save([new File(['second'], 'two.txt')]);
    const newEditor = draft('wss://one.example/ws', 'pane', 'session');
    const [restored] = await newEditor.load();
    await first; await second;
    const original = IDBObjectStore.prototype.put;
    let failure = '';
    try {
      IDBObjectStore.prototype.put = function(...args) {
        if (this.transaction.db.name === 'capri-ios-session-files') throw new DOMException('Espacio insuficiente', 'QuotaExceededError');
        return original.apply(this, args);
      };
      try { await newEditor.save([]); } catch (error) { failure = (error as Error).message; }
    } finally { IDBObjectStore.prototype.put = original; }
    const [kept] = await draft('wss://one.example/ws', 'pane', 'session').load();
    await newEditor.save([]);
    return { restored: await restored.text(), failure, kept: await kept.text(), cleared: (await newEditor.load()).length };
  })).toEqual({ restored: 'second', failure: 'Espacio insuficiente', kept: 'second', cleared: 0 });
});

test('draft count and file bounds fail atomically without erasing existing selections', async ({ page }) => {
  await page.goto('/');
  expect(await page.evaluate(async () => {
    const path = '/src/session-attachment-drafts.ts';
    const { sessionAttachmentDraft: draft } = await import(path);
    const first = draft('wss://one.example/ws', 'pane', 'session-0');
    await first.load();
    for (let i = 0; i < 100; i++) {
      const item = draft('wss://one.example/ws', 'pane', `session-${i}`);
      await item.load(); await item.save([new File(['kept'], 'kept.txt')]);
    }
    const next = draft('wss://one.example/ws', 'pane', 'session-100');
    await next.load();
    const errors = [];
    for (const files of [[new File(['extra'], 'extra.txt')], Array.from({ length: 11 }, () => new File(['x'], 'x.txt')), [new File(['x'], 'bad\nname')]]) {
      try { await next.save(files); } catch (error) { errors.push((error as Error).message); }
    }
    await first.load(); await first.save([]);
    await next.save([new File([], 'empty.txt')]);
    return { errors, existing: (await draft('wss://one.example/ws', 'pane', 'session-99').load())[0].name, freedSlot: (await next.load())[0].size };
  })).toEqual({ errors: [expect.stringContaining('espacio'), expect.stringContaining('10 archivos'), expect.stringContaining('no es válido')], existing: 'kept.txt', freedSlot: 0 });
});
