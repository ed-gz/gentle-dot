import { expect, test } from './fixtures.ts';

test('checkpoint answer survives a lost removal reply in the real isolated IDB stores', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const storePath = '/src/isolated-turn-store.ts', adapterPath = '/src/isolated-checkpoint-turns.ts';
    const controllerPath = '/src/checkpoint-conversation.ts', clientPath = '/src/checkpoint-client.ts';
    const { createIsolatedTurnStore } = await import(storePath);
    const { createIsolatedCheckpointTurns } = await import(adapterPath);
    const { createCheckpointConversation } = await import(controllerPath);
    const { fingerprintForCheckpoint } = await import(clientPath);
    const name = `isolated-checkpoint-${crypto.randomUUID()}`, id = crypto.randomUUID(), userId = crypto.randomUUID();
    const store = createIsolatedTurnStore({ databaseName: name });
    const user = { id: userId, role: 'user', engine: 'iphone', state: 'complete', text: 'Analiza mi sesión', at: 1000 };
    const turn = { id, role: 'assistant', engine: 'iphone', state: 'pending', text: '', at: 1001, replyTo: userId };
    await store.append(0, user, turn);
    let native: any, lost = true; const calls: string[] = [];
    const client = {
      async create(key: string, instruction: string, context: string, tools: any[]) {
        return native = { id: key, revision: crypto.randomUUID(), sourceFingerprint: await fingerprintForCheckpoint(instruction, context, tools), state: 'ready' };
      },
      async run() { native = { ...native, revision: crypto.randomUUID(), state: 'answer', decision: { kind: 'answer', text: 'Respuesta duradera', toolName: '', argumentsJSON: '{}' } }; },
      async list() { return { items: native ? [structuredClone(native)] : [] }; },
      async remove(key: string, revision: string) {
        const saved = await createIsolatedTurnStore({ databaseName: name }).read();
        calls.push(saved.entries[1].state === 'complete' && saved.entries[1].text === 'Respuesta duradera' && native.id === key && native.revision === revision ? 'durable-before-remove' : 'unsafe-remove');
        native = undefined;
        if (lost) { lost = false; throw new Error('callback perdido'); }
      },
    };
    const controller = createCheckpointConversation({ turns: createIsolatedCheckpointTurns(store), client });
    let firstError = '';
    try { await controller.start({ id, userId, instruction: user.text, context: '', tools: [] }); }
    catch (error) { firstError = String(error); }
    const restored = createCheckpointConversation({ turns: createIsolatedCheckpointTurns(createIsolatedTurnStore({ databaseName: name })), client });
    const recovered = await restored.recover(id);
    return { firstError, recovered: recovered.kind, calls, saved: await store.read() };
  });
  expect(result.firstError).toContain('callback perdido');
  expect(result.recovered).toBe('answer');
  expect(result.calls).toEqual(['durable-before-remove']);
  expect(result.saved.entries[1]).toMatchObject({ state: 'complete', text: 'Respuesta duradera' });
});

test('a cancellation that wins while the model runs preserves the native answer', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const storePath = '/src/isolated-turn-store.ts', adapterPath = '/src/isolated-checkpoint-turns.ts';
    const controllerPath = '/src/checkpoint-conversation.ts', clientPath = '/src/checkpoint-client.ts';
    const { createIsolatedTurnStore } = await import(storePath);
    const { createIsolatedCheckpointTurns } = await import(adapterPath);
    const { createCheckpointConversation } = await import(controllerPath);
    const { fingerprintForCheckpoint } = await import(clientPath);
    const name = `isolated-cancel-${crypto.randomUUID()}`, id = crypto.randomUUID(), userId = crypto.randomUUID();
    const store = createIsolatedTurnStore({ databaseName: name });
    const user = { id: userId, role: 'user', engine: 'iphone', state: 'complete', text: 'Analiza esto', at: 1000 };
    const turn = { id, role: 'assistant', engine: 'iphone', state: 'pending', text: '', at: 1001, replyTo: userId };
    await store.append(0, user, turn);
    let native: any, removed = false, cancelled = false;
    const client = {
      async create(key: string, instruction: string, context: string, tools: any[]) { return native = { id: key, revision: crypto.randomUUID(), sourceFingerprint: await fingerprintForCheckpoint(instruction, context, tools), state: 'ready' }; },
      async run() {
        cancelled = await createIsolatedTurnStore({ databaseName: name }).finish(user, turn, { kind: 'cancel' });
        native = { ...native, revision: crypto.randomUUID(), state: 'answer', decision: { kind: 'answer', text: 'Respuesta tardía', toolName: '', argumentsJSON: '{}' } };
      },
      async list() { return { items: native ? [structuredClone(native)] : [] }; },
      async remove() { removed = true; native = undefined; },
    };
    let error = '';
    try { await createCheckpointConversation({ turns: createIsolatedCheckpointTurns(store), client }).start({ id, userId, instruction: user.text, context: '', tools: [] }); }
    catch (caught) { error = String(caught); }
    return { cancelled, removed, nativeState: native?.state, error, saved: await store.read() };
  });
  expect(result.cancelled).toBe(true);
  expect(result.removed).toBe(false);
  expect(result.nativeState).toBe('answer');
  expect(result.error).toContain('cancelado');
  expect(result.saved.entries[1]).toMatchObject({ state: 'interrupted', localCancelled: true });
});

test('a different request cannot claim an existing turn even when their text is equal', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const storePath = '/src/isolated-turn-store.ts', adapterPath = '/src/isolated-checkpoint-turns.ts';
    const { createIsolatedTurnStore } = await import(storePath);
    const { createIsolatedCheckpointTurns } = await import(adapterPath);
    const store = createIsolatedTurnStore({ databaseName: `isolated-pairs-${crypto.randomUUID()}` });
    const user = { id: crypto.randomUUID(), role: 'user', engine: 'iphone', state: 'complete', text: 'Mismo texto', at: 1000 };
    const turn = { id: crypto.randomUUID(), role: 'assistant', engine: 'iphone', state: 'pending', text: '', at: 1001, replyTo: user.id };
    const other = { ...user, id: crypto.randomUUID() }, otherTurn = { ...turn, id: crypto.randomUUID(), replyTo: other.id };
    await store.append(0, user, turn); await store.append(1, other, otherTurn);
    const adapter = createIsolatedCheckpointTurns(store);
    const wrongPair = await adapter.readPair(other.id, turn.id);
    const { replyTo: _replyTo, ...projectedTurn } = turn;
    const committed = await adapter.commitAnswer(other, projectedTurn, 'incorrecta');
    return { found: !!wrongPair, committed, saved: await store.read() };
  });
  expect(result.found).toBe(false);
  expect(result.committed).toBe(false);
  expect(result.saved.entries[1]).toMatchObject({ state: 'pending', text: '' });
});
