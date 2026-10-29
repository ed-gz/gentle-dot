import { expect, test } from './fixtures.ts';

test('competing append and an old snapshot cannot overwrite an answered turn', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const path = '/src/isolated-turn-store.ts';
    const { createIsolatedTurnStore } = await import(path);
    const name = `isolated-turn-race-${crypto.randomUUID()}`;
    const first = createIsolatedTurnStore({ databaseName: name }), second = createIsolatedTurnStore({ databaseName: name });
    const user = { id: crypto.randomUUID(), engine: 'iphone', role: 'user', state: 'complete', text: 'solicitud', at: 1000 };
    const turn = { id: crypto.randomUUID(), engine: 'iphone', role: 'assistant', state: 'pending', text: '', at: 1001, replyTo: user.id };
    const otherUser = { ...user, id: crypto.randomUUID() }, otherTurn = { ...turn, id: crypto.randomUUID(), replyTo: otherUser.id };
    const oldSnapshot = await first.read();
    const attempts = await Promise.allSettled([first.append(oldSnapshot.revision, user, turn), second.append(oldSnapshot.revision, otherUser, otherTurn)]);
    const winner = attempts[0].status === 'fulfilled' ? { user, turn } : { user: otherUser, turn: otherTurn };
    const finished = await first.finish(winner.user, winner.turn, { kind: 'answer', text: 'respuesta persistida' });
    const stale = await Promise.allSettled([second.append(oldSnapshot.revision, user, turn)]);
    const reopened = await createIsolatedTurnStore({ databaseName: name }).read();
    return { attempts: attempts.map(x => x.status).sort(), finished, stale: stale[0].status, reopened, winner: winner.turn.id };
  });
  expect(result.attempts).toEqual(['fulfilled', 'rejected']);
  expect(result.finished).toBe(true);
  expect(result.stale).toBe('rejected');
  expect(result.reopened.revision).toBe(2);
  expect(result.reopened.entries.find((entry: any) => entry.id === result.winner)).toMatchObject({ state: 'complete', text: 'respuesta persistida' });
});

test('concurrent cancellation and answer serialize, and the losing result cannot be committed', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const path = '/src/isolated-turn-store.ts';
    const { createIsolatedTurnStore } = await import(path);
    const name = `isolated-finish-race-${crypto.randomUUID()}`;
    const a = createIsolatedTurnStore({ databaseName: name }), b = createIsolatedTurnStore({ databaseName: name });
    const user = { id: crypto.randomUUID(), engine: 'iphone', role: 'user', state: 'complete', text: 'petición', at: 1000 };
    const turn = { id: crypto.randomUUID(), engine: 'iphone', role: 'assistant', state: 'pending', text: '', at: 1001, replyTo: user.id };
    await a.append(0, user, turn);
    const outcomes = await Promise.all([a.finish(user, turn, { kind: 'answer', text: 'respuesta' }), b.finish(user, turn, { kind: 'cancel' })]);
    const repeated = await b.finish(user, turn, { kind: 'answer', text: 'resultado tardío' });
    const persisted = await createIsolatedTurnStore({ databaseName: name }).read();
    return { outcomes, repeated, persisted, turnId: turn.id };
  });
  expect(result.outcomes.filter(Boolean)).toHaveLength(1);
  expect(result.repeated).toBe(false);
  expect(result.persisted.revision).toBe(2);
  const turn = result.persisted.entries.find((entry: any) => entry.id === result.turnId);
  expect(turn).toMatchObject(result.outcomes[0]
    ? { state: 'complete', text: 'respuesta' }
    : { state: 'interrupted', localCancelled: true, text: 'Respuesta interrumpida.' });
});

test('mismatched requests, duplicate IDs and quota errors preserve existing turns', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const path = '/src/isolated-turn-store.ts';
    const { createIsolatedTurnStore } = await import(path);
    const store = createIsolatedTurnStore({ databaseName: `isolated-failures-${crypto.randomUUID()}`, maximumEntries: 2 });
    const user = { id: crypto.randomUUID(), engine: 'iphone', role: 'user', state: 'complete', text: 'sin cambios', at: 1000 };
    const turn = { id: crypto.randomUUID(), engine: 'iphone', role: 'assistant', state: 'pending', text: '', at: 1001, replyTo: user.id };
    await store.append(0, user, turn);
    const wrong = await store.finish({ ...user, text: 'otro mensaje' }, turn, { kind: 'answer', text: 'incorrecta' });
    const duplicate = await Promise.allSettled([store.append(1, user, turn)]);
    const invalid = await Promise.allSettled([store.finish(user, { ...turn, id: 'invalid' }, { kind: 'answer', text: 'incorrecta' })]);
    const another = { ...user, id: crypto.randomUUID() }, anotherTurn = { ...turn, id: crypto.randomUUID(), replyTo: another.id };
    const full = await Promise.allSettled([store.append(1, another, anotherTurn)]);
    return { wrong, duplicate: duplicate[0].status, invalid: invalid[0].status, full: full[0].status, snapshot: await store.read() };
  });
  expect(result.wrong).toBe(false);
  expect(result.duplicate).toBe('rejected');
  expect(result.invalid).toBe('rejected');
  expect(result.full).toBe('rejected');
  expect(result.snapshot).toMatchObject({ revision: 1, entries: [{ text: 'sin cambios' }, { state: 'pending', text: '' }] });
});

test('an aborted transaction leaves the original turn available for recovery', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const path = '/src/isolated-turn-store.ts';
    const { createIsolatedTurnStore } = await import(path);
    const name = `isolated-abort-${crypto.randomUUID()}`;
    const store = createIsolatedTurnStore({ databaseName: name });
    const user = { id: crypto.randomUUID(), engine: 'iphone', role: 'user', state: 'complete', text: 'solicitud', at: 1000 };
    const turn = { id: crypto.randomUUID(), engine: 'iphone', role: 'assistant', state: 'pending', text: '', at: 1001, replyTo: user.id };
    await store.append(0, user, turn);
    const previousPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      const request = previousPut.apply(this, args);
      if (this.transaction.db.name === name) throw new Error('simulated failure after write request');
      return request;
    };
    let rejected = false;
    try { await store.finish(user, turn, { kind: 'answer', text: 'no confirmado' }); }
    catch { rejected = true; }
    finally { IDBObjectStore.prototype.put = previousPut; }
    const afterAbort = await createIsolatedTurnStore({ databaseName: name }).read();
    const retried = await store.finish(user, turn, { kind: 'answer', text: 'confirmado' });
    const afterRetry = await store.read();
    return { rejected, afterAbort, retried, afterRetry };
  });
  expect(result.rejected).toBe(true);
  expect(result.afterAbort).toMatchObject({ revision: 1, entries: [{ text: 'solicitud' }, { state: 'pending', text: '' }] });
  expect(result.retried).toBe(true);
  expect(result.afterRetry).toMatchObject({ revision: 2, entries: [{ text: 'solicitud' }, { state: 'complete', text: 'confirmado' }] });
});

test('two independent pages cannot both finish the same original turn', async ({ page, context }) => {
  await page.goto('/');
  const another = await context.newPage();
  await another.goto('/');
  const fixture = await page.evaluate(async () => {
    const path = '/src/isolated-turn-store.ts';
    const { createIsolatedTurnStore } = await import(path);
    const name = `isolated-two-pages-${crypto.randomUUID()}`;
    const user = { id: crypto.randomUUID(), engine: 'iphone', role: 'user', state: 'complete', text: 'una solicitud', at: 1000 };
    const turn = { id: crypto.randomUUID(), engine: 'iphone', role: 'assistant', state: 'pending', text: '', at: 1001, replyTo: user.id };
    await createIsolatedTurnStore({ databaseName: name }).append(0, user, turn);
    return { name, user, turn };
  });
  const finish = (current: typeof page, text: string) => current.evaluate(async ({ fixture, text }) => {
    const path = '/src/isolated-turn-store.ts';
    return (await import(path)).createIsolatedTurnStore({ databaseName: fixture.name }).finish(fixture.user, fixture.turn, { kind: 'answer', text });
  }, { fixture, text });
  const outcomes = await Promise.all([finish(page, 'página uno'), finish(another, 'página dos')]);
  const persisted = await page.evaluate(async name => {
    const path = '/src/isolated-turn-store.ts';
    return (await import(path)).createIsolatedTurnStore({ databaseName: name }).read();
  }, fixture.name);
  expect(outcomes.filter(Boolean)).toHaveLength(1);
  expect(persisted.revision).toBe(2);
  expect(persisted.entries[1].text).toBe(outcomes[0] ? 'página uno' : 'página dos');
  await another.close();
});
