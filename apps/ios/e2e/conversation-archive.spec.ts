import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('archive retains more than the visible window, reloads, and idempotently completes streamed messages', async ({ page }) => {
  await page.goto('/');
  const created = await page.evaluate(async () => {
    const module = await import('/src/conversation-archive.ts'); const archive = module.conversationArchive;
    const entries = Array.from({ length: 200 }, (_, index) => ({ id: `entry-${index}`, engine: 'iphone', role: index % 2 ? 'assistant' : 'user', state: 'complete', text: `Mensaje ${index}`, at: 1000 + index }));
    const first = await archive.upsert(entries); const again = await archive.upsert(entries);
    await archive.upsert([{ id: 'stream', engine: 'iphone', role: 'assistant', state: 'pending', text: 'Parcial', at: 2000 }]);
    const before = (await archive.page({ limit: 1 })).entries[0];
    const completed = await archive.upsert([{ id: 'stream', engine: 'iphone', role: 'assistant', state: 'complete', text: 'Respuesta completa', at: 9000 }]);
    const after = await archive.load(before.key);
    return { first, again, completed, before, after };
  });
  expect(created.first.inserted).toBe(200); expect(created.again).toMatchObject({ inserted: 0, updated: 0, unchanged: 200 });
  expect(created.completed).toMatchObject({ entries: 201, updated: 1 }); expect(created.after).toMatchObject({ at: 2000, sequence: created.before.sequence, state: 'complete', text: 'Respuesta completa' });
  await page.reload();
  const loaded = await page.evaluate(async () => {
    const { conversationArchive: archive } = await import('/src/conversation-archive.ts'); const ids: string[] = []; let cursor: string | undefined; let pages = 0;
    do { const result = await archive.page({ limit: 50, cursor }); ids.push(...result.entries.map((entry: any) => entry.id)); cursor = result.cursor; pages++; if (pages > 10) throw new Error('Cursor did not terminate'); } while (cursor);
    const exported = await archive.export(); const lines = (await exported.blob.text()).trim().split('\n').map(line => JSON.parse(line));
    return { ids, pages, header: lines[0], records: lines.length - 1, first: lines[1].id, last: lines.at(-1).id, stats: await archive.stats() };
  });
  expect(new Set(loaded.ids).size).toBe(201); expect(loaded.ids).toContain('entry-0'); expect(loaded.pages).toBe(5);
  expect(loaded).toMatchObject({ records: 201, first: 'entry-0', last: 'stream', header: { schema: 'capri-conversation-archive/v1', entries: 201 }, stats: { entries: 201 } });
});

test('concurrent upserts serialize counters, preserve both scopes and export only allowed fields', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { conversationArchive: archive } = await import('/src/conversation-archive.ts');
    const entry = { id: 'same-id', role: 'user', state: 'complete', text: 'Contenido', at: 1000, token: 'must-not-archive', draft: 'not-submitted' };
    await Promise.all([archive.upsert([{ ...entry, engine: 'iphone' }]), archive.upsert([{ ...entry, engine: 'iphone' }]), archive.upsert([{ ...entry, engine: 'gentle' }], 'host-a/session-1'), archive.upsert([{ ...entry, engine: 'gentle' }], 'host-b/session-1')]);
    const all = await archive.page(); const scoped = await archive.page({ engine: 'gentle', scope: 'host-a/session-1' }); const exported = await archive.export();
    return { entries: all.entries.map((record: any) => ({ key: record.key, engine: record.engine, scope: record.scope, bytes: record.bytes })), scoped: scoped.entries.length, stats: await archive.stats(), export: await exported.blob.text() };
  });
  expect(result.stats.entries).toBe(3); expect(new Set(result.entries.map((item: any) => item.key)).size).toBe(3); expect(result.scoped).toBe(1);
  expect(result.stats.bytes).toBe(result.entries.reduce((total: number, item: any) => total + item.bytes, 0));
  expect(result.export).not.toContain('must-not-archive'); expect(result.export).not.toContain('not-submitted');
});

test('quota rejects the entire transaction without pruning or partially updating earlier messages', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { createConversationArchive } = await import('/src/conversation-archive.ts');
    const archive = createConversationArchive({ databaseName: 'archive-entry-quota', maximumEntries: 2 });
    const entry = { id: 'original', engine: 'iphone', role: 'user', state: 'complete', text: 'Keep original', at: 1000 };
    await archive.upsert([entry]);
    let countError = ''; try { await archive.upsert([{ ...entry, text: 'Must roll back' }, { ...entry, id: 'second' }, { ...entry, id: 'third' }]); } catch (error: any) { countError = error.code; }
    const bytes = createConversationArchive({ databaseName: 'archive-byte-quota', maximumBytes: 400 }); await bytes.upsert([entry]);
    let byteError = ''; try { await bytes.upsert([{ ...entry, text: '🦊'.repeat(100) }]); } catch (error: any) { byteError = error.code; }
    return { countError, byteError, records: (await archive.page()).entries, byteRecords: (await bytes.page()).entries, countStats: await archive.stats(), byteStats: await bytes.stats() };
  });
  expect(result.countError).toBe('quota'); expect(result.byteError).toBe('quota'); expect(result.records).toHaveLength(1); expect(result.byteRecords).toHaveLength(1);
  expect(result.records[0].text).toBe('Keep original'); expect(result.byteRecords[0].text).toBe('Keep original'); expect(result.countStats.entries).toBe(1); expect(result.byteStats.bytes).toBeLessThanOrEqual(400);
});

test('sparse search paginates honestly across scan limits and binds cursors to the query', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { conversationArchive: archive } = await import('/src/conversation-archive.ts');
    const entries = Array.from({ length: 1200 }, (_, index) => ({ id: `entry-${index}`, engine: 'iphone', role: 'user', state: 'complete', text: index === 0 || index === 1199 ? 'Reunión con Ana' : 'Otro mensaje', at: 1000 + index }));
    for (let offset = 0; offset < entries.length; offset += 500) await archive.upsert(entries.slice(offset, offset + 500));
    const first = await archive.search('reunion ANA', { limit: 1 });
    const sparse = await archive.search('reunion ANA', { limit: 1, cursor: first.cursor });
    const last = await archive.search('reunion ANA', { limit: 1, cursor: sparse.cursor });
    let invalid = ''; try { await archive.search('otra consulta', { cursor: first.cursor }); } catch (error: any) { invalid = error.code; }
    return { first, sparse, last, invalid };
  });
  expect(result.first.entries.map((entry: any) => entry.id)).toEqual(['entry-1199']); expect(result.first.hasMore).toBe(true);
  expect(result.sparse.entries).toEqual([]); expect(result.sparse).toMatchObject({ scanned: 1000, hasMore: true });
  expect(result.last.entries.map((entry: any) => entry.id)).toEqual(['entry-0']); expect(result.last.hasMore).toBe(false); expect(result.invalid).toBe('invalid');
});

test('real shell archives messages before its 120-card window prunes and retrieves them after reload', async ({ page }) => {
  const pageErrors: string[] = []; page.on('pageerror', error => pageErrors.push(error.message));
  await page.routeWebSocket('wss://archive.example/ws', ws => {
    let sequence = 0; const send = (data: object) => ws.send(JSON.stringify({ seq: sequence++, ...data }));
    ws.onMessage(raw => {
      const message = JSON.parse(String(raw));
      if (message.type === 'hello') send({ type: 'ready', agentState: 'idle', conversationId: 'memory-test' });
      if (message.type === 'get_history') {
        send({ type: 'history', conversationId: 'memory-test', messages: [] });
        for (let index = 0; index < 205; index++) send({ type: 'message_done', messageId: `archive-${index}`, text: index === 0 ? 'Evidencia inicial: reunión con Ana el martes.' : `Mensaje archivado ${index}` });
      }
    });
  });
  await page.goto('/'); await page.locator('[data-panel="settings"]').click();
  await page.getByText('Conexión manual', { exact: true }).click();
  await page.evaluate(() => {
    const state = globalThis as any; state.stageReads = 0;
    const stage = document.querySelector('#stage')!; const measure = stage.getBoundingClientRect.bind(stage);
    stage.getBoundingClientRect = () => { state.stageReads++; return measure(); };
  });
  await page.locator('#url').fill('wss://archive.example/ws'); await page.locator('#token').fill('fixture-only');
  await page.locator('#connection button[type="submit"]').click();
  await expect(page.locator('#cards .chat-card')).toHaveCount(120);
  expect(await page.evaluate(() => (globalThis as any).stageReads)).toBeLessThan(40);
  await expect.poll(() => page.evaluate(async () => (await (await import('/src/conversation-archive.ts')).conversationArchive.stats()).entries)).toBe(205);
  await page.reload(); await expect(page.locator('#cards .chat-card')).toHaveCount(120);
  const recalled = await page.evaluate(async () => {
    const { createMemoryTools } = await import('/src/conversation-memory-tools.ts');
    return createMemoryTools().find(tool => tool.definition.name === 'search_memory')!.execute({ query: 'Evidencia inicial' }, { signal: new AbortController().signal });
  });
  expect(recalled.records).toHaveLength(1); expect(recalled.records[0].text).toBe('Evidencia inicial: reunión con Ana el martes.');
  expect(recalled.records[0].source).toMatchObject({ engine: 'gentle', scope: 'host:wss://archive.example/ws|memory-test', state: 'complete' });
  await page.locator('[data-panel="inbox"]').click(); await expect(page.locator('#memory-status')).toContainText('205 mensajes');
  expect(pageErrors).toEqual([]);
});

test('an interrupted agent turn keeps its committed tool receipt in memory across reload', async ({ page }) => {
  await page.addInitScript(() => {
    const state = globalThis as any; state.isTauri = true; let step = 0;
    state.__TAURI_INTERNALS__ = { invoke: async (command: string) => {
      if (command.endsWith('share_list')) return { ok: true, items: [] };
      if (command.endsWith('check_availability')) return { available: true, status: 'available', supportsSpanish: true };
      if (command.endsWith('agent_step')) {
        step++;
        if (step === 1) return { ok: true, decision: { kind: 'tool', text: '', toolName: 'tool_describe', argumentsJSON: JSON.stringify({ name: 'work_create' }) } };
        if (step === 2) return { ok: true, decision: { kind: 'tool', text: '', toolName: 'work_create', argumentsJSON: JSON.stringify({ title: 'Recibo conservado', kind: 'task', instruction: 'Revisar logs originales.' }) } };
        state.waitingAfterCommit = true; return new Promise(() => {});
      }
      return { ok: true };
    } };
  });
  await page.goto('/'); await page.locator('#prompt').fill('Guarda un trabajo para revisar logs.'); await page.locator('#send').click();
  await expect.poll(() => page.evaluate(() => (globalThis as any).waitingAfterCommit)).toBe(true);
  await page.locator('#stop').click(); await expect(page.locator('#cards')).toContainText('Respuesta interrumpida.');
  await expect.poll(() => page.evaluate(async () => {
    const page = await (await import('/src/conversation-archive.ts')).conversationArchive.page();
    return page.entries.find(entry => entry.activities?.length)?.state;
  })).toBe('interrupted');
  await page.reload();
  const result = await page.evaluate(async () => {
    const { createMemoryTools } = await import('/src/conversation-memory-tools.ts'); const tool = createMemoryTools()[0]; const context = { signal: new AbortController().signal };
    const page: any = await tool.execute({}, context); const source = page.records.find((entry: any) => entry.source.state === 'interrupted').source;
    return tool.execute({ entryKey: source.key, activityIndex: 0 }, context);
  });
  expect(result.source.state).toBe('interrupted'); expect(result.activity.status).toBe('done');
  expect(JSON.parse(result.text)).toMatchObject({ title: 'Recibo conservado', savedLocally: true, synchronized: false });
});

test('shell stops new sends after archive failure, preserves the draft and exports pending data without deleting it', async ({ page }) => {
  await page.addInitScript(() => {
    const state = globalThis as any; state.isTauri = true; state.__TAURI_INTERNALS__ = { invoke: async (command: string) => {
      if (command.endsWith('share_list')) return { ok: true, items: [] };
      if (command.endsWith('check_availability')) return { available: true, status: 'available', supportsSpanish: true };
      if (command.endsWith('agent_step')) return { ok: true, decision: { kind: 'answer', text: 'Respuesta que debe conservarse.', toolName: '', argumentsJSON: '{}' } };
      return { ok: true };
    } };
  });
  await page.goto('/');
  // Shared WebGL warmup can block browser tasks on software renderers before
  // native availability and the initial durable checkpoint reach the UI.
  await expect(page.locator('#send')).toBeEnabled({ timeout: 15000 });
  await page.evaluate(async () => {
    const { conversationArchive } = await import('/src/conversation-archive.ts');
    (globalThis as any).restoreArchive = conversationArchive.upsert;
    conversationArchive.upsert = async (...args) => {
      // A draft-only checkpoint must remain possible before the first send.
      // Inject the quota failure when this case actually archives messages.
      if (args[0].length) throw new Error('Cuota local agotada (fixture).');
      return (globalThis as any).restoreArchive(...args);
    };
  });
  await page.locator('#prompt').fill('Conservar aunque falle el archivo.'); await page.locator('#send').click();
  await expect(page.locator('#cards')).toContainText('Respuesta que debe conservarse.');
  await expect(page.locator('#send')).toBeDisabled(); await expect(page.locator('#chat-notice')).toContainText('Los envíos están detenidos');
  await page.locator('#prompt').fill('Siguiente borrador, todavía sin enviar.');
  await expect.poll(() => page.evaluate(async () => (await (await import('/src/conversation.ts')).loadConversation()).draft)).toBe('Siguiente borrador, todavía sin enviar.');
  await page.locator('[data-panel="inbox"]').click(); await expect(page.locator('#memory-status')).toContainText('2 mensajes pendientes');
  // This case verifies the browser fallback; native delivery has its own fixture suite.
  await page.evaluate(() => { (globalThis as any).isTauri = false; });
  const download = page.waitForEvent('download'); await page.locator('#memory-export').click();
  const exported = await download; expect(exported.suggestedFilename()).toMatch(/^capri-conversacion-.*\.ndjson$/);
  const lines = (await readFile((await exported.path())!, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(lines.find(line => line.schema === 'capri-conversation-pending/v1')).toMatchObject({ entries: 2, committed: false });
  expect(lines.find(line => line.schema === 'capri-conversation-draft/v1')).toMatchObject({ submitted: false, text: 'Siguiente borrador, todavía sin enviar.' });
  expect(lines.some(line => line.text === 'Respuesta que debe conservarse.')).toBe(true);
  await page.evaluate(async () => { (await import('/src/conversation-archive.ts')).conversationArchive.upsert = (globalThis as any).restoreArchive; });
  await page.locator('#memory-retry').click(); await expect(page.locator('#memory-status')).toContainText('2 mensajes');
  await page.locator('[data-panel="chat"]').click(); await expect(page.locator('#send')).toBeEnabled();
  await expect(page.locator('#prompt')).toHaveValue('Siguiente borrador, todavía sin enviar.');
  await expect.poll(() => page.evaluate(async () => (await (await import('/src/conversation-archive.ts')).conversationArchive.stats()).entries)).toBe(2);
});

test('crash between archive commit and old window save cannot erase a completed answer or its receipt', async ({ page }) => {
  await page.addInitScript(() => {
    const state = globalThis as any;
    window.addEventListener('pagehide', event => { if (state.simulateCrash) event.stopImmediatePropagation(); }, true);
    document.addEventListener('visibilitychange', event => { if (state.simulateCrash) event.stopImmediatePropagation(); }, true);
  });
  await page.goto('/');
  // Wait for the durable bootstrap checkpoint. Initial shared WebGL shader
  // compilation can block the next browser task on CI software renderers.
  await expect.poll(() => page.evaluate(async () => (await (await import('/src/conversation.ts')).loadConversation()).revision), { timeout: 15000 }).toBe(1);
  await page.evaluate(async () => {
    const { saveConversation } = await import('/src/conversation.ts'); const { conversationArchive } = await import('/src/conversation-archive.ts');
    const old = { id: 'crash-turn', engine: 'iphone', role: 'assistant', state: 'pending', text: '', at: 1000, activities: [{ id: 'operation', kind: 'other', title: 'Guardar trabajo', status: 'running' }] };
    await saveConversation({ entries: [old], draft: 'Borrador conservado aparte', revision: 10 });
    const completed = { ...old, state: 'complete', text: 'Trabajo guardado en este iPhone.', activities: [{ ...old.activities[0], status: 'done', detail: '{"receipt":"local-42","synchronized":false}' }] };
    const later = { id: 'crash-new-entry', engine: 'iphone', role: 'user', state: 'complete', text: 'Nuevo mensaje confirmado sólo en el archivo.', at: 2000 };
    await conversationArchive.upsert([completed, later], undefined, [completed, later], 11);
    (globalThis as any).simulateCrash = true;
  });
  await page.reload();
  await expect(page.locator('#cards')).toContainText('Trabajo guardado en este iPhone.');
  await expect(page.locator('#cards')).toContainText('Nuevo mensaje confirmado sólo en el archivo.');
  await expect(page.locator('#prompt')).toHaveValue('Borrador conservado aparte');
  const result = await page.evaluate(async () => (await (await import('/src/conversation-archive.ts')).conversationArchive.page()).entries);
  expect(result.find(entry => entry.id === 'crash-turn')).toMatchObject({ state: 'complete', text: 'Trabajo guardado en este iPhone.', activities: [{ status: 'done', detail: '{"receipt":"local-42","synchronized":false}' }] });
});

test('legacy archive hydration keeps a newer receipt and rescue exports visible messages if archive reading fails', async ({ page }) => {
  await page.goto('/');
  const migration = await page.evaluate(async () => {
    const { createConversationArchive } = await import('/src/conversation-archive.ts'); const archive = createConversationArchive({ databaseName: 'legacy-crash-archive' });
    const old = { id: 'old-window', engine: 'iphone', role: 'assistant', state: 'interrupted', text: '', at: 1000 };
    await archive.upsert([{ ...old, state: 'complete', text: 'Confirmed legacy receipt' }]);
    return archive.restoreWindow([old]);
  });
  expect(migration[0]).toMatchObject({ state: 'complete', text: 'Confirmed legacy receipt' });
  await page.evaluate(async () => {
    const { saveConversation } = await import('/src/conversation.ts');
    // Capture-phase handler simulates losing the old WebView without a final save.
    window.addEventListener('pagehide', event => event.stopImmediatePropagation(), true);
    await saveConversation({ entries: [{ id: 'rescue-visible', engine: 'iphone', role: 'user', state: 'complete', text: 'Mensaje visible para rescatar', at: 1000 }], draft: '' });
    const { conversationArchive } = await import('/src/conversation-archive.ts');
    await conversationArchive.upsert([{ id: 'rescue-visible', engine: 'iphone', role: 'user', state: 'complete', text: 'Mensaje visible para rescatar', at: 1000 }], undefined, [{ id: 'rescue-visible', engine: 'iphone', role: 'user', state: 'complete', text: 'Mensaje visible para rescatar', at: 1000 }]);
  });
  await page.reload(); await expect(page.locator('#cards')).toContainText('Mensaje visible para rescatar');
  await page.evaluate(async () => { (await import('/src/conversation-archive.ts')).conversationArchive.export = async () => { throw new Error('Lectura no disponible (fixture).'); }; });
  await page.locator('[data-panel="inbox"]').click();
  const download = page.waitForEvent('download'); await page.locator('#memory-export').click();
  const lines = (await readFile((await (await download).path())!, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(lines.find(line => line.schema === 'capri-conversation-pending/v1')).toMatchObject({ committed: false, source: 'visible-and-pending-rescue', entries: 1 });
  expect(lines.some(line => line.text === 'Mensaje visible para rescatar')).toBe(true);
  await expect(page.locator('#memory-status')).toContainText('Exportación parcial');
});

test('a newer saved window after archive quota failure survives reload with both new messages and updated receipts', async ({ page }) => {
  await page.addInitScript(() => {
    const state = globalThis as any;
    window.addEventListener('pagehide', event => { if (state.simulateCrash) event.stopImmediatePropagation(); }, true);
    document.addEventListener('visibilitychange', event => { if (state.simulateCrash) event.stopImmediatePropagation(); }, true);
  });
  await page.goto('/');
  await expect.poll(() => page.evaluate(async () => (await (await import('/src/conversation.ts')).loadConversation()).revision), { timeout: 15000 }).toBe(1);
  await page.evaluate(async () => {
    const { conversationArchive } = await import('/src/conversation-archive.ts');
    const { createConversationPersistence } = await import('/src/conversation-persistence.ts');
    const original = { id: 'quota-stream', engine: 'iphone', role: 'assistant', state: 'pending', text: 'Parcial', at: 1000, activities: [{ id: 'operation', kind: 'other', title: 'Guardar', status: 'running' }] };
    await conversationArchive.upsert([original], undefined, [original], 10);
    const final = { ...original, state: 'complete', text: 'Texto final conservado en la ventana más nueva.', activities: [{ ...original.activities[0], status: 'done', detail: '{"receipt":"saved-after-quota"}' }] };
    const added = { id: 'quota-new-message', engine: 'iphone', role: 'user', state: 'complete', text: 'Mensaje nuevo durante la cuota.', at: 2000 };
    const persistence = createConversationPersistence({ archive: { upsert: async () => { throw new Error('Cuota agotada'); } } });
    persistence.setRevision(10); await persistence.persist({ entries: [final, added], draft: 'Borrador después de cuota' });
    (globalThis as any).simulateCrash = true;
  });
  await page.reload();
  await expect(page.locator('#cards')).toContainText('Texto final conservado en la ventana más nueva.');
  await expect(page.locator('#cards')).toContainText('Mensaje nuevo durante la cuota.');
  await expect(page.locator('#prompt')).toHaveValue('Borrador después de cuota');
  // The recovered checkpoint commits before the first rig frame, but an archive
  // read can overlap software GPU warmup. Keep the exact receipt assertion and
  // allow the same startup budget as the existing native-availability fixtures.
  const started = Date.now();
  await expect.poll(() => page.evaluate(async () => {
    const records = (await (await import('/src/conversation-archive.ts')).conversationArchive.page()).entries;
    return records.find(entry => entry.id === 'quota-stream')?.activities?.[0]?.detail;
  }), { timeout: 15000 }).toBe('{"receipt":"saved-after-quota"}');
  await test.info().attach('recovered-receipt-read', { body: JSON.stringify({ milliseconds: Date.now() - started }), contentType: 'application/json' });
  const stale = await page.evaluate(async () => {
    const { conversationArchive } = await import('/src/conversation-archive.ts');
    try { await conversationArchive.upsert([], undefined, [], 1); return 'accepted'; } catch (error: any) { return error.message; }
  });
  expect(stale).toContain('revisión más reciente');
});

test('a newer archived window preserves unarchived legacy IDs before pruning migration to 120 visible messages', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { createConversationArchive } = await import('/src/conversation-archive.ts');
    const { createConversationPersistence } = await import('/src/conversation-persistence.ts');
    const archive = createConversationArchive({ databaseName: 'legacy-unarchived-migration' });
    const make = (id: string, at: number) => ({ id, role: 'assistant', engine: 'iphone', state: 'complete', text: id, at });
    const archived = Array.from({ length: 120 }, (_, index) => make(`archived-${index}`, 1000 + index));
    const old = Array.from({ length: 119 }, (_, index) => make(`legacy-${index}`, index));
    // The old snapshot also holds a stale copy of an archived receipt. Its lower
    // revision cannot replace the confirmed content while the orphan IDs migrate.
    await archive.upsert(archived, undefined, archived, 5);
    const recovery = await archive.restoreState({ entries: [...old, { ...archived[0], text: 'Stale content' }] });
    const persistence = createConversationPersistence({ archive, save: async () => {} });
    persistence.setRevision(recovery.revision); persistence.seed(recovery.preserved);
    await persistence.persist({ entries: recovery.entries, draft: '' });
    return { visible: recovery.entries.length, preserved: recovery.preserved.length, count: (await archive.stats()).entries,
      old: (await archive.search('legacy-0')).entries[0]?.text, existing: (await archive.search('archived-0')).entries[0]?.text, blocked: persistence.status().blocked, error: persistence.status().archiveError };
  });
  expect(result).toEqual({ visible: 120, preserved: 239, count: 239, old: 'legacy-0', existing: 'archived-0', blocked: false, error: undefined });
});
