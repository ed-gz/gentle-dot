import { expect, test } from './fixtures.ts';

test('checkpoint anchors persist and serialize competing revisions without losing a turn', async ({ page }) => {
  await page.goto('/');
  const first = await page.evaluate(async () => {
    const module = await import('/src/checkpoint-anchor-store.ts');
    const store = module.checkpointAnchorStore;
    const id = 'd3dba896-4b5c-4c1c-98c9-4e60238fe6b9';
    const userId = '02bce422-1da0-4ebc-b2fb-9df32a25434e';
    const initial = await store.create({ id, userId, fingerprint: 'a'.repeat(64), requestFingerprint: 'b'.repeat(64), state: 'preparing' });
    const results = await Promise.allSettled([
      store.compareAndSwap(initial, { state: 'ready', nativeRevision: 'b71484fd-6a7c-4ea1-b6ce-075ba36ea5f6' }),
      store.compareAndSwap(initial, { state: 'ready', nativeRevision: 'ca438d1a-5a9a-4bb6-aa0a-51e73458ca19' }),
    ]);
    return { statuses: results.map(result => result.status).sort(), saved: await store.get(id) };
  });
  expect(first.statuses).toEqual(['fulfilled', 'rejected']);
  expect(first.saved).toMatchObject({ state: 'ready', version: 2, fingerprint: 'a'.repeat(64) });
  await page.reload();
  const second = await page.evaluate(async () => {
    const module = await import('/src/checkpoint-anchor-store.ts');
    const store = module.checkpointAnchorStore;
    const current = await store.get('d3dba896-4b5c-4c1c-98c9-4e60238fe6b9');
    if (!current) throw new Error('missing anchor');
    let removed = false;
    try { await store.remove(current); removed = true; } catch { /* Running work is not terminal. */ }
    const running = await store.compareAndSwap(current, { state: 'running' });
    let forged = false;
    try { await store.compareAndSwap(running, { state: 'ready', id: 'other' } as never); forged = true; } catch { /* immutable identity */ }
    return { current, removed, running, forged, final: await store.get(current.id) };
  });
  expect(second.current).toEqual(first.saved);
  expect(second.removed).toBe(false);
  expect(second.forged).toBe(false);
  expect(second.final).toEqual(second.running);
});

test('checkpoint anchor capacity fails atomically without discarding pending work', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const module = await import('/src/checkpoint-anchor-store.ts');
    const store = module.checkpointAnchorStore;
    for (let i = 0; i < 20; i++) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      const userId = `10000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      await store.create({ id, userId, fingerprint: 'c'.repeat(64), requestFingerprint: 'd'.repeat(64), state: 'preparing' });
    }
    let overflow = false;
    try { await store.create({ id: '20000000-0000-4000-8000-000000000000', userId: '30000000-0000-4000-8000-000000000000', fingerprint: 'c'.repeat(64), requestFingerprint: 'd'.repeat(64), state: 'preparing' }); } catch { overflow = true; }
    const saved = await store.list();
    return { overflow, count: saved.length, allPreparing: saved.every((item: { state: string }) => item.state === 'preparing') };
  });
  expect(result).toEqual({ overflow: true, count: 20, allPreparing: true });
});
