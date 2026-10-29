import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLaptopClient } from '../src/laptop-client.ts';
import { DeviceBridgeError } from '../src/device-bridge.ts';
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
test('a long terminal title cannot hide other valid sessions or change their identities', async () => {
  const label = 'Sesión de Gentle Shell '.repeat(60);
  const snapshot = { ...state, sessions: [state.sessions[0], { ...state.sessions[0], paneId: 'p2', sessionId: 's2', label }] };
  const client = createLaptopClient(connection, { current: () => connection, request: async () => reply(snapshot) });
  const sessions = (await client.snapshot()).sessions;
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].label, 'Work');
  assert.equal(sessions[1].paneId, 'p2'); assert.equal(sessions[1].sessionId, 's2');
  assert.equal(sessions[1].label.length, 1000); assert.equal(sessions[1].label.at(-1), '…');
  const ordinary = 'x'.repeat(121);
  const another = createLaptopClient(connection, { current: () => connection, request: async () => reply({ ...state, sessions: [{ ...state.sessions[0], label: ordinary }] }) });
  assert.equal((await another.snapshot()).sessions[0].label, ordinary);
});
test('cancelling a native read releases the session view before the late bridge response', async () => {
  let resolve; const abort = new AbortController();
  const client = createLaptopClient(connection, { current: () => connection, request: () => new Promise(r => resolve = r) });
  const result = client.snapshot(abort.signal); abort.abort();
  await assert.rejects(result, { name: 'AbortError' }); resolve(reply(state));
});

test('legacy toolResult entries remain visible without changing their content or order', async () => {
  const client = createLaptopClient(connection, { current: () => connection, request: async () => reply({
    sessionId: 's', messages: [
      { id: 'a', role: 'assistant', content: [{ type: 'text', text: 'Revisando.' }] },
      { id: 't', role: 'toolResult', isError: true, content: [{ type: 'text', text: 'Error real' }] },
    ],
  }) });
  const value = await client.inspect('p', 's');
  assert.deepEqual(value.messages.map(message => [message.id, message.role, message.isError, message.content[0].text]), [
    ['a', 'assistant', undefined, 'Revisando.'], ['t', 'tool', true, 'Error real'],
  ]);
});

test('legacy image blocks retain the surrounding history without exposing inline bytes', async () => {
  let payload = { sessionId: 's', messages: [
    { id: 'u', role: 'user', content: [{ type: 'text', text: 'Antes' }, { type: 'image', data: 'private-base64-image', mimeType: 'image/png' }, { type: 'text', text: 'Después' }] },
    { id: 'a', role: 'assistant', content: [{ type: 'text', text: 'Continuación real' }] },
  ], history: { supported: true, hasEarlier: true, before: 'previous' } };
  const client = createLaptopClient(connection, { current: () => connection, request: async () => reply(payload) });
  const value = await client.inspect('p', 's');
  assert.deepEqual(value.messages.map(message => message.id), ['u', 'a']);
  assert.deepEqual(value.messages[0].content.map(block => block.text), ['Antes', '[Imagen adjunta no disponible en esta vista]', 'Después']);
  assert.equal(value.messages[1].content[0].text, 'Continuación real');
  assert.equal(value.history.before, 'previous');
  assert.doesNotMatch(JSON.stringify(value), /private-base64-image/);
  payload = { sessionId: 's', messages: [{ id: 'u', role: 'user', content: [{ type: 'unexpected', data: 'private' }] }] };
  await assert.rejects(client.inspect('p', 's'), /historial no corresponde/i);
});

test('iOS reads older histories and refuses unverified prompt instances', async () => {
  const requests = [];
  const client = createLaptopClient(connection, { current: () => connection, request: async request => {
    const body = JSON.parse(request.body); requests.push(body);
    // An older host ignores the extra field and still returns inline image blocks.
    return body.action === 'inspect' ? reply({ sessionId: 's', messages: [{ id: 'u', role: 'user', content: [{ type: 'image', data: 'old-host-bytes' }] }] }) : reply({ ok: true });
  } });
  const history = await client.inspect('p', 's', undefined, { before: 'cursor', limit: 25 });
  assert.deepEqual(requests[0], { action: 'inspect', paneId: 'p', sessionId: 's', before: 'cursor', limit: 25, historyContent: 'text-only-v1' });
  assert.equal(history.messages[0].content[0].text, '[Imagen adjunta no disponible en esta vista]');
  assert.doesNotMatch(JSON.stringify(history), /old-host-bytes/);
  await assert.rejects(client.act({ action: 'prompt', paneId: 'p', sessionId: 's', text: 'continúa' }), /identificar la instancia/);
  assert.equal(requests.some(body => body.action === 'prompt'), false);
});

test('a large history page is retried at a smaller size with the same cursor, never replaying mutations', async () => {
  const calls = [];
  const client = createLaptopClient(connection, { current: () => connection, request: async request => {
    const body = request.body && JSON.parse(request.body); calls.push(body);
    if (body?.action === 'navigate') throw new DeviceBridgeError('size_limit', 'Límite de respuesta.');
    if (body?.limit > 12) throw new DeviceBridgeError('size_limit', 'Límite de respuesta.');
    return reply({ sessionId: 's', messages: [{ id: 'one', role: 'assistant', content: [{ type: 'text', text: 'Historia' }] }], history: { supported: true, hasEarlier: true, before: 'previous' } });
  } });
  const result = await client.inspect('p', 's', undefined, { before: 'cursor', limit: 50 });
  assert.equal(result.history.before, 'previous');
  assert.deepEqual(calls.map(({ limit, before }) => ({ limit, before })), [50, 25, 12].map(limit => ({ limit, before: 'cursor' })));
  calls.length = 0;
  await client.inspect('p', 's');
  assert.equal(calls[0].limit, 12, 'subsequent polls reuse the proven page size');
  calls.length = 0;
  await assert.rejects(client.browserAction({ action: 'navigate', url: 'https://example.test/' }), /Límite/);
  assert.equal(calls.length, 1);
});

test('history pagination does not retry non-size failures or cross a changed connection', async () => {
  let attempts = 0, current = connection;
  const client = createLaptopClient(connection, { current: () => current, request: async () => {
    attempts++;
    if (attempts === 1) throw new DeviceBridgeError('network', 'Sin conexión.');
    current = { ...connection, token: 'replacement' };
    throw new DeviceBridgeError('size_limit', 'Límite.');
  } });
  await assert.rejects(client.inspect('p', 's'), /Sin conexión/);
  assert.equal(attempts, 1);
  await assert.rejects(client.inspect('p', 's'), /Cambió la laptop/);
  assert.equal(attempts, 2);
});

test('the JavaScript response limit also retries oversized UTF-8 history pages', async () => {
  const sizes = [];
  const client = createLaptopClient(connection, { current: () => connection, request: async request => {
    const { limit } = JSON.parse(request.body); sizes.push(limit);
    if (limit === 50) return reply({ oversized: '😀'.repeat(530_000) });
    return reply({ sessionId: 's', messages: [], history: { supported: true, hasEarlier: false } });
  } });
  assert.deepEqual((await client.inspect('p', 's')).messages, []);
  assert.deepEqual(sizes, [50, 25]);
});
