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

test('credential rotation preserves refresh metadata and a losing CAS removes only its new keychain entry', async ({ page }) => {
  await page.addInitScript(() => {
    const state = globalThis as any;
    state.isTauri = true;
    state.testKeychain = new Map<string, string>();
    state.__TAURI_INTERNALS__ = { invoke: async (command: string, args: any) => {
      const request = args?.request;
      const key = request ? `${request.scope}:${request.account}` : '';
      if (command.endsWith('|secret_set')) { state.testKeychain.set(key, request.value); return { ok: true, persisted: true }; }
      if (command.endsWith('|secret_get')) return { ok: true, value: state.testKeychain.get(key) };
      if (command.endsWith('|secret_delete')) { state.testKeychain.delete(key); return { ok: true }; }
      if (command.endsWith('|share_list')) return { ok: true, items: [] };
      return { ok: false, available: false, status: 'fixture_unavailable' };
    } };
  });
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const path = '/src/external-connections.ts'; const store = await import(path);
    const initial = await store.saveConnectionCredentials({ kind: 'https-api', provider: 'gmail', label: 'Mail', endpoint: 'https://gmail.googleapis.com/' },
      { accessToken: 'fixture-old-access', refreshToken: 'fixture-refresh', provider: 'gmail', clientId: 'public-id', scopes: ['gmail.readonly'], refreshState: 'ready' });
    const config = { ...initial, label: 'Mail rotated' };
    const attempts = await Promise.allSettled([
      store.saveConnectionCredentials(config, { accessToken: 'fixture-access-one', refreshToken: 'fixture-refresh-one', provider: 'gmail', refreshState: 'ready' }, initial.revision),
      store.saveConnectionCredentials(config, { accessToken: 'fixture-access-two', refreshToken: 'fixture-refresh-two', provider: 'gmail', refreshState: 'ready' }, initial.revision),
    ]);
    const metadata = await store.getConnection(initial.id);
    const keychain = (globalThis as any).testKeychain as Map<string, string>;
    const surviving = JSON.parse(keychain.get(`external-connections:${metadata.credentialAccount}`)!);
    return { statuses: attempts.map(value => value.status), metadata, remaining: keychain.size, surviving, stored: JSON.stringify(await store.listConnections()) };
  });
  expect(result.statuses.sort()).toEqual(['fulfilled', 'rejected']);
  expect(result.remaining).toBe(1);
  expect(result.metadata.revision).toBe(2);
  expect(result.surviving.accessToken).toMatch(/^fixture-access-(one|two)$/);
  expect(result.surviving.refreshToken).toMatch(/^fixture-refresh-(one|two)$/);
  expect(result.stored).not.toContain('fixture-access');
  expect(result.stored).not.toContain('fixture-refresh');
});
