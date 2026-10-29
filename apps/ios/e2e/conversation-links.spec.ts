import { expect, test } from './fixtures.ts';

test('new local answers keep their exact request link across completion and reload', async ({ page }) => {
  await page.addInitScript(() => {
    const state = globalThis as any; state.isTauri = true;
    state.__TAURI_INTERNALS__ = { invoke: async (command: string) => {
      if (command.endsWith('results_list') || command.endsWith('share_list') || command.endsWith('documents_list')) return { ok: true, items: [] };
      if (command.endsWith('check_availability')) return { available: true, status: 'available', supportsSpanish: true };
      if (command.endsWith('agent_step')) return { ok: true, decision: { kind: 'answer', text: 'Respuesta de prueba.', toolName: '', argumentsJSON: '{}' } };
      return { ok: true };
    } };
  });
  await page.goto('/');
  await page.locator('#prompt').fill('Enlaza esta solicitud.');
  await page.locator('#send').click();
  await expect(page.locator('.chat-card[data-role="assistant"]')).toContainText('Respuesta de prueba.');
  await expect.poll(async () => page.evaluate(async () => {
    const path = '/src/conversation.ts'; const saved = await (await import(path)).loadConversation();
    return saved.entries.find((entry: any) => entry.role === 'assistant')?.state;
  })).toBe('complete');
  const before = await page.evaluate(async () => {
    const path = '/src/conversation.ts', archivePath = '/src/conversation-archive.ts';
    const saved = await (await import(path)).loadConversation(), records = await (await import(archivePath)).conversationArchive.page();
    return { saved: saved.entries, archived: records.entries };
  });
  const user = before.saved.find((entry: any) => entry.role === 'user');
  const answer = before.saved.find((entry: any) => entry.role === 'assistant');
  expect(answer.replyTo).toBe(user.id);
  expect(before.archived.find((entry: any) => entry.id === answer.id).replyTo).toBe(user.id);
  await page.reload();
  await expect(page.locator('.chat-card[data-role="assistant"]')).toContainText('Respuesta de prueba.');
  const restored = await page.evaluate(async () => {
    const path = '/src/conversation.ts', archivePath = '/src/conversation-archive.ts';
    const saved = await (await import(path)).loadConversation();
    const archive = (await import(archivePath)).conversationArchive;
    return { saved: saved.entries, restored: (await archive.restoreState(saved)).entries };
  });
  expect(restored.saved.find((entry: any) => entry.id === answer.id).replyTo).toBe(user.id);
  expect(restored.restored.find((entry: any) => entry.id === answer.id).replyTo).toBe(user.id);
});

test('older unlinked messages stay unlinked and invalid archive links fail without overwriting', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const path = '/src/conversation-archive.ts'; const { createConversationArchive } = await import(path);
    const archive = createConversationArchive({ databaseName: `archive-link-${crypto.randomUUID()}` });
    const user = { id: crypto.randomUUID(), role: 'user', engine: 'iphone', state: 'complete', text: 'Anterior', at: 1000 };
    const old = { id: crypto.randomUUID(), role: 'assistant', engine: 'iphone', state: 'complete', text: 'Sin vínculo', at: 1001 };
    await archive.upsert([user, old], undefined, [user, old], 1);
    const invalid = await Promise.allSettled([archive.upsert([{ ...old, replyTo: old.id }], undefined, [user, old], 2)]);
    const record = await archive.load(JSON.stringify(['iphone', 'iphone:main', old.id]));
    const restored = await archive.restoreState({ entries: [], revision: 0 });
    return { status: invalid[0].status, record, restored };
  });
  expect(result.status).toBe('rejected');
  expect(result.record.text).toBe('Sin vínculo');
  expect(result.record.replyTo).toBeUndefined();
  expect(result.restored.entries[1].replyTo).toBeUndefined();
});

test('a newer archive update cannot erase or change an existing request link', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const path = '/src/conversation-archive.ts'; const { createConversationArchive } = await import(path);
    const archive = createConversationArchive({ databaseName: `archive-linked-${crypto.randomUUID()}` });
    const user = { id: crypto.randomUUID(), role: 'user', engine: 'iphone', state: 'complete', text: 'Petición', at: 1000 };
    const turn = { id: crypto.randomUUID(), role: 'assistant', engine: 'iphone', state: 'pending', text: '', at: 1001, replyTo: user.id };
    await archive.upsert([user, turn], undefined, [user, turn], 1);
    const { replyTo: _replyTo, ...withoutLink } = turn;
    const results = await Promise.allSettled([
      archive.upsert([{ ...withoutLink, state: 'complete', text: 'sin vínculo' }], undefined, [user, withoutLink], 2),
      archive.upsert([{ ...turn, replyTo: crypto.randomUUID() }], undefined, [user, turn], 2),
    ]);
    return { status: results.map(result => result.status), record: await archive.load(JSON.stringify(['iphone', 'iphone:main', turn.id])), userId: user.id };
  });
  expect(result.status).toEqual(['rejected', 'rejected']);
  expect(result.record).toMatchObject({ state: 'pending', text: '', replyTo: result.userId });
});

test('a local inference failure preserves the linked assistant turn', async ({ page }) => {
  await page.addInitScript(() => {
    const state = globalThis as any; state.isTauri = true;
    state.__TAURI_INTERNALS__ = { invoke: async (command: string) => {
      if (command.endsWith('results_list') || command.endsWith('share_list') || command.endsWith('documents_list')) return { ok: true, items: [] };
      if (command.endsWith('check_availability')) return { available: true, status: 'available', supportsSpanish: true };
      if (command.endsWith('agent_step')) return { ok: false, error: 'fixture_failure', message: 'Fallo comprobable.' };
      return { ok: true };
    } };
  });
  await page.goto('/');
  await page.locator('#prompt').fill('Solicitud que fallará.');
  await page.locator('#send').click();
  await expect(page.locator('.chat-card[data-role="assistant"]')).toContainText('Fallo comprobable.');
  await expect.poll(async () => page.evaluate(async () => {
    const path = '/src/conversation.ts'; const saved = await (await import(path)).loadConversation();
    return saved.entries.find((entry: any) => entry.role === 'assistant')?.state;
  })).toBe('interrupted');
  const saved = await page.evaluate(async () => { const path = '/src/conversation.ts'; return (await (await import(path)).loadConversation()).entries; });
  expect(saved.find((entry: any) => entry.role === 'assistant').replyTo).toBe(saved.find((entry: any) => entry.role === 'user').id);
});

test('cancelling a new local turn preserves its request link and discards a late answer', async ({ page }) => {
  await page.addInitScript(() => {
    const state = globalThis as any; state.isTauri = true;
    state.__TAURI_INTERNALS__ = { invoke: async (command: string) => {
      if (command.endsWith('results_list') || command.endsWith('share_list') || command.endsWith('documents_list')) return { ok: true, items: [] };
      if (command.endsWith('check_availability')) return { available: true, status: 'available', supportsSpanish: true };
      if (command.endsWith('agent_step')) return await new Promise(resolve => { state.finishLinkedTurn = resolve; });
      return { ok: true };
    } };
  });
  await page.goto('/');
  await page.locator('#prompt').fill('Esta solicitud se va a detener.'); await page.locator('#send').click();
  await expect.poll(() => page.evaluate(() => typeof (globalThis as any).finishLinkedTurn)).toBe('function');
  await page.locator('#stop').click();
  await page.evaluate(() => (globalThis as any).finishLinkedTurn({ ok: true, decision: { kind: 'answer', text: 'No mostrar', toolName: '', argumentsJSON: '{}' } }));
  await expect(page.locator('.chat-card[data-role="assistant"]')).toContainText('Respuesta interrumpida.');
  await expect(page.locator('#cards')).not.toContainText('No mostrar');
  await expect.poll(async () => page.evaluate(async () => {
    const path = '/src/conversation.ts'; const saved = await (await import(path)).loadConversation();
    return saved.entries.find((entry: any) => entry.role === 'assistant')?.localCancelled;
  })).toBe(true);
  await page.reload();
  const saved = await page.evaluate(async () => { const path = '/src/conversation.ts'; return (await (await import(path)).loadConversation()).entries; });
  const turn = saved.find((entry: any) => entry.role === 'assistant');
  expect(turn).toMatchObject({ localCancelled: true, replyTo: saved.find((entry: any) => entry.role === 'user').id });
});
