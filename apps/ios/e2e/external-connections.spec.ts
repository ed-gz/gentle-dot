import { expect, test } from '@playwright/test';

test('connection metadata persists without secrets and concurrent revisions cannot overwrite', async ({ page }) => {
  await page.goto('/');
  const saved = await page.evaluate(async () => {
    const path = '/src/external-connections.ts'; const store = await import(path);
    return store.saveConnection({ kind: 'mcp', label: 'Servidor independiente', endpoint: 'https://custom.example/mcp', accessToken: 'never persist' }, '');
  });
  await page.reload();
  const result = await page.evaluate(async ({ id, revision }) => {
    const path = '/src/external-connections.ts'; const store = await import(path);
    const original = await store.getConnection(id);
    const changes = await Promise.allSettled([
      store.saveConnection({ id, kind: 'mcp', label: 'Primera edición', endpoint: original.endpoint }, undefined, revision),
      store.saveConnection({ id, kind: 'mcp', label: 'Segunda edición', endpoint: original.endpoint }, undefined, revision),
    ]);
    return { original, changed: await store.getConnection(id), statuses: changes.map(value => value.status) };
  }, saved);
  expect(result.original.label).toBe('Servidor independiente');
  expect(result.original).not.toHaveProperty('accessToken');
  expect(result.original).not.toHaveProperty('credentialAccount');
  expect(result.changed.revision).toBe(2);
  expect(result.statuses.sort()).toEqual(['fulfilled', 'rejected']);
});

test('execution is reserved atomically and uncertain state survives restart without replay', async ({ page }) => {
  await page.goto('/');
  const data = await page.evaluate(async () => {
    const path = '/src/external-connections.ts'; const store = await import(path);
    const connection = await store.saveConnection({ kind: 'mcp', label: 'Servidor', endpoint: 'https://custom.example/mcp' }, '');
    const entry = { requestId: crypto.randomUUID(), fingerprint: 'f'.repeat(64), connectionId: connection.id, connectionRevision: connection.revision,
      endpoint: connection.endpoint, toolName: 'send', schemaJSON: '{}', argumentsJSON: '{"text":"exacto"}', state: 'executing', createdAt: Date.now(), updatedAt: Date.now() };
    const attempts = await Promise.allSettled([store.beginRemoteExecution(entry), store.beginRemoteExecution({ ...entry, requestId: crypto.randomUUID() })]);
    const [record] = await store.listRemoteExecutions();
    return { entry: record, statuses: attempts.map(value => value.status) };
  });
  expect(data.statuses.sort()).toEqual(['fulfilled', 'rejected']);
  await page.reload();
  const result = await page.evaluate(async entry => {
    const path = '/src/external-connections.ts'; const store = await import(path);
    let blocked = false;
    try { await store.beginRemoteExecution({ ...entry, requestId: crypto.randomUUID() }); } catch { blocked = true; }
    await store.finishRemoteExecution(entry.requestId, 'uncertain');
    return { blocked, records: await store.listRemoteExecutions() };
  }, data.entry);
  expect(result.blocked).toBe(true);
  expect(result.records).toHaveLength(1);
  expect(result.records[0].state).toBe('uncertain');
});
