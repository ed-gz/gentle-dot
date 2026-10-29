import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createConnectionSelectionStore } from '../src/connection-selection.ts';

const url = 'wss://laptop.example.ts.net/ws';
const origin = 'https://laptop.example.ts.net';
const paired = { url, token: 'pair_fixture_token_1234567890ABCDEFG', deviceId: 'phone-a', name: 'Capri' };
const manual = { source: 'manual', url, token: 'manual_fixture_only' };
function fixture() {
  const data = new Map(); const store = createConnectionSelectionStore({
    get: async (scope, account) => data.get(`${scope}:${account}`) ?? null,
    set: async (scope, account, value) => { data.set(`${scope}:${account}`, value); },
    pairing: async () => data.has('pair') ? paired : null,
  });
  return { data, store };
}

test('the exact authenticated selection survives restart without preferring an older paired token', async () => {
  const { data, store } = fixture(); data.set('pair', true);
  const ticket = await store.begin(url); await store.commit(ticket, manual);
  assert.deepEqual(await store.restore(url), manual);
  assert.equal([...data.keys()].some(key => key.includes('token')), false);
  const saved = [...data.values()].find(value => typeof value === 'string');
  assert.ok(saved.includes('manual_fixture_only'), 'credential remains in Keychain, not public settings');
});

test('Keychain selection preserves device identity and wins over missing or stale public settings', async () => {
  const { store } = fixture(); const ticket = await store.begin(url);
  await store.commit(ticket, { source: 'paired', ...paired, ignored: 'never saved' });
  assert.deepEqual(await store.restore(url), { source: 'paired', ...paired });
  assert.deepEqual(await store.restore(), { source: 'paired', ...paired });
  assert.deepEqual(await store.restore('wss://different.example.ts.net/ws'), { source: 'paired', ...paired });
});

test('interrupted or failed storage never restores the prior credential', async () => {
  const { data, store } = fixture(); let ticket = await store.begin(url); await store.commit(ticket, { source: 'paired', ...paired });
  ticket = await store.begin(url);
  await assert.rejects(store.restore(url), /no se guardó por completo/);
  await assert.rejects(store.commit(ticket, { ...manual, url: 'wss://different.example.ts.net/ws' }), /cambió/);
  await assert.rejects(store.restore(url), /no se guardó por completo/);
  const item = [...data.entries()].find(([key]) => key.includes('capri.selected'));
  assert.ok(item && !item[1].includes('manual_fixture_only'));
  assert.deepEqual(await store.rollback(ticket), { source: 'paired', ...paired });
  assert.deepEqual(await store.restore(url), { source: 'paired', ...paired });
});

test('a staged candidate can be retried or the prior connection explicitly recovered after restart', async () => {
  const { data, store } = fixture(); let ticket = await store.begin(url); await store.commit(ticket, { source: 'paired', ...paired });
  ticket = await store.begin(url); await store.stage(ticket, manual);
  await assert.rejects(store.restore(), error => error.name === 'ConnectionSelectionPending' && error.hasPrevious && error.hasCandidate);
  const reloaded = createConnectionSelectionStore({
    get: async (scope, account) => data.get(`${scope}:${account}`) ?? null,
    set: async (scope, account, value) => { data.set(`${scope}:${account}`, value); },
  });
  const recovery = await reloaded.recoverCandidate(); assert.equal(recovery.connection.token, manual.token);
  assert.deepEqual(await reloaded.recoverPrevious(), { source: 'paired', ...paired });
  assert.deepEqual(await reloaded.restore(), { source: 'paired', ...paired });
});

test('an interrupted pairing recovers only the exact precommitted attempt and requires explicit retry', async () => {
  const { data, store } = fixture();
  let ticket = await store.begin(url); await store.commit(ticket, manual);
  const attempt = 'd3dba896-4b5c-4c1c-98c9-4e60238fe6b9';
  ticket = await store.begin(url, manual, attempt);
  const unrelated = 'd3dba896-4b5c-4c1c-98c9-4e60238fe6ba';
  data.set(`daemon-pairing:attempt:${unrelated}`, JSON.stringify(paired));
  const reopened = createConnectionSelectionStore({ get: async (scope, account) => data.get(`${scope}:${account}`) ?? null,
    set: async (scope, account, value) => { data.set(`${scope}:${account}`, value); } });
  await assert.rejects(reopened.restore(), error => error.name === 'ConnectionSelectionPending' && error.hasPrevious && error.hasCandidate);
  assert.equal(await reopened.recoverCandidate(), null);
  data.set(`daemon-pairing:attempt:${attempt}`, JSON.stringify(paired));
  const recovered = await reopened.recoverCandidate();
  assert.deepEqual(recovered.connection, { source:'paired', ...paired });
  await assert.rejects(reopened.restore(), /no se guardó por completo/);
  await reopened.commit(recovered.ticket, recovered.connection);
  assert.deepEqual(await reopened.restore(), { source:'paired', ...paired });
});

test('late pairing write cannot replace a recovered previous connection or select an unrelated host', async () => {
  const { data, store } = fixture();
  let ticket = await store.begin(url); await store.commit(ticket, manual);
  const attempt = 'd3dba896-4b5c-4c1c-98c9-4e60238fe6b9';
  await store.begin(url, manual, attempt);
  data.set(`daemon-pairing:attempt:${attempt}`, JSON.stringify({ ...paired, url:'wss://other.example.ts.net/ws' }));
  await assert.rejects(store.recoverCandidate(), /otro host/);
  assert.deepEqual(await store.recoverPrevious(), manual);
  data.set(`daemon-pairing:attempt:${attempt}`, JSON.stringify(paired));
  assert.deepEqual(await store.restore(), manual);
  assert.equal(await store.recoverCandidate(), null);
});

test('a known rejected first pairing can leave a disconnected marker without exposing legacy access', async () => {
  const { data, store } = fixture(); data.set('pair', true);
  const ticket = await store.begin(url, undefined, 'd3dba896-4b5c-4c1c-98c9-4e60238fe6b9');
  assert.equal(await store.rollback(ticket, true), null);
  assert.equal(await store.restore(url), null);
});

test('an older candidate cannot commit or roll back a newer attempt for the same host', async () => {
  const { data, store } = fixture();
  const attemptA = 'd3dba896-4b5c-4c1c-98c9-4e60238fe6b9';
  const attemptB = 'd3dba896-4b5c-4c1c-98c9-4e60238fe6ba';
  await store.begin(url, manual, attemptA);
  data.set(`daemon-pairing:attempt:${attemptA}`, JSON.stringify(paired));
  const prior = await store.recoverCandidate();
  const other = createConnectionSelectionStore({ get: async (scope, account) => data.get(`${scope}:${account}`) ?? null,
    set: async (scope, account, value) => { data.set(`${scope}:${account}`, value); } });
  await other.begin(url, manual, attemptB);
  await assert.rejects(store.commit(prior.ticket, prior.connection), /cambió/);
  await assert.rejects(store.stage(prior.ticket, prior.connection), /cambió/);
  await assert.rejects(store.rollback(prior.ticket, true), /cambió/);
  await assert.rejects(other.restore(), error => error.name === 'ConnectionSelectionPending' && error.hasCandidate);
});

test('disconnect uses a durable tombstone and never falls back to legacy credentials', async () => {
  const { data, store } = fixture(); data.set('pair', true); data.set(`daemon-manual:${origin}`, manual.token);
  await store.disconnect(); assert.equal(await store.restore(url), null);
});

test('legacy migration accepts only unambiguous, validated credentials', async () => {
  const { data, store } = fixture(); data.set('pair', true);
  assert.deepEqual(await store.restore(url), { source: 'paired', ...paired });
  data.set(`daemon-manual:${origin}`, manual.token);
  await assert.rejects(store.restore(url), /dos accesos/);
  data.delete('pair'); assert.deepEqual(await store.restore(url), manual);
});

test('malformed markers, unavailable Keychain and invalid records fail closed', async () => {
  const { data, store } = fixture(); data.set('daemon-manual:capri.selected-connection.v1', '{bad');
  await assert.rejects(store.restore(url), /verificar/);
  const inaccessible = createConnectionSelectionStore({ get: async () => { throw new Error('denied'); } });
  await assert.rejects(inaccessible.restore(url), /denied/);
  const empty = fixture(); const ticket = await empty.store.begin(url);
  await assert.rejects(empty.store.commit(ticket, { ...manual, token: '' }), /no corresponde/);
  await assert.rejects(empty.store.restore(url), /no se guardó/);
});

test('superseded callbacks and concurrent writes cannot overwrite the current selection', async () => {
  const { store } = fixture(); const old = await store.begin(url); const current = await store.begin(url);
  await assert.rejects(store.commit(old, manual), /cambió/);
  await store.commit(current, { source: 'paired', ...paired });
  assert.deepEqual(await store.restore(url), { source: 'paired', ...paired });
  let release; const blocked = createConnectionSelectionStore({ get: async () => null, set: () => new Promise(resolve => { release = resolve; }) });
  const first = blocked.begin(url); await assert.rejects(blocked.disconnect(), /Espera/);
  await Promise.resolve(); release(); await first;
});
