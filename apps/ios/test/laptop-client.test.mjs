import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLaptopClient } from '../src/laptop-client.ts';
const connection = { url: 'wss://laptop.example/ws', token: 'fixture-only' };
const state = { available: true, sessions: [{ paneId: 'p', sessionId: 's', provider: 'herdr', label: 'Work', state: 'idle', connected: true }], approvals: [], policies: [], events: [] };
const reply = value => ({ status: 200, headers: {}, body: JSON.stringify(value) });
test('native session transport uses the linked host and discards a late response after relinking', async () => {
  let current = connection, resolve; const calls = [];
  const client = createLaptopClient(connection, { current: () => current, request: async value => { calls.push(value); return new Promise(r => resolve = r); } });
  const reading = client.snapshot(); current = { ...connection, token: 'replacement' }; resolve(reply(state));
  await assert.rejects(reading, /Cambió la laptop/);
  assert.equal(calls[0].url, 'https://laptop.example/orchestration'); assert.equal(calls[0].headers.Authorization, 'Bearer fixture-only');
  await assert.rejects(client.snapshot(), /Cambió la laptop/); assert.equal(calls.length, 1);
  assert.equal(typeof client.uploadAttachment, 'function'); assert.equal(client.terminalMood, undefined);
  assert.throws(() => client.uploadAttachment('p', 's', new File(['x'], 'note.txt')), /Cambió la laptop/);
});
test('session identity, malformed inventory and aborted reads cannot be presented as another session', async () => {
  let value = state; const client = createLaptopClient(connection, { current: () => connection, request: async () => reply(value) });
  assert.equal((await client.snapshot()).sessions[0].label, 'Work');
  value = { ...state, sessions: [{ ...state.sessions[0], state: 'invented' }] }; await assert.rejects(client.snapshot(), /sesión no válida/);
  value = { sessionId: 'different', messages: [], deliveries: [] }; await assert.rejects(client.inspect('p', 's'), /no corresponde/);
  const abort = new AbortController(); abort.abort(); await assert.rejects(client.snapshot(abort.signal), { name: 'AbortError' });
});
test('cancelling a native read releases the session view before the late bridge response', async () => {
  let resolve; const abort = new AbortController();
  const client = createLaptopClient(connection, { current: () => connection, request: () => new Promise(r => resolve = r) });
  const result = client.snapshot(abort.signal); abort.abort();
  await assert.rejects(result, { name: 'AbortError' }); resolve(reply(state));
});
