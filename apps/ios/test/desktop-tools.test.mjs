import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDesktopSessionClient, createDesktopTools, parseDesktopPage, parseDesktopSessions } from '../src/desktop-tools.ts';
import { DeviceBridgeError } from '../src/device-bridge.ts';

const conn = { url: 'wss://computer.example.ts.net/ws', token: 'never-print-this-credential', deviceId: 'device-1' };
const target = { paneId: 'pane-1', sessionId: 'session-1' };
const session = { ...target, label: 'Operations', connected: true, state: 'idle', capabilities: { inspect: true, prompt: true, abort: true, deliveryReceipts: true } };
const page = () => ({ sessionId: target.sessionId, instanceId: 'instance-1', messages: [{ id: 'message-1', role: 'assistant', content: [{ type: 'text', text: 'Waiting for instruction' }] }], deliveries: [], history: { hasEarlier: false } });
const context = askApproval => ({ signal: new AbortController().signal, askApproval });
function fixture(overrides = {}) {
  const calls = []; let receipt; let current = conn;
  const client = createDesktopSessionClient({ getConnection: () => current, request: async request => {
    calls.push(request); const payload = request.body ? JSON.parse(request.body) : undefined;
    let value;
    if (!payload) value = { available: true, sessions: [session], approvals: [{ secret: 'do-not-project' }] };
    else if (payload.action === 'inspect') value = { ...page(), deliveries: receipt ? [receipt] : [] };
    else if (payload.action === 'prompt') {
      if (overrides.failSend) throw new Error('socket disconnected');
      receipt = { id: payload.clientMessageId, status: 'queued', acceptedAt: '2026-10-27T20:00:00Z', preview: payload.text, deliverAs: payload.deliverAs };
      value = { accepted: true, sessionId: target.sessionId, instanceId: overrides.wrongAck ? 'other-instance' : 'instance-1' };
    } else value = { accepted: true, sessionId: target.sessionId, instanceId: 'instance-1' };
    if (overrides.inspect && payload?.action === 'inspect') value = overrides.inspect(calls, value);
    return { status: 200, body: JSON.stringify(value), headers: {} };
  } });
  return { client, calls, changeConnection: value => { current = value; } };
}
test('session tools reuse existing sessions and expose no create/answer/permission tool', async () => {
  const f = fixture(); const sessions = await f.client.list(); assert.equal(sessions.length, 1); assert.equal(sessions[0].label, 'Operations'); assert.equal(sessions[0].approvals, undefined);
  assert.deepEqual(createDesktopTools({ getConnection: () => conn }).map(tool => tool.definition.name), ['session_list','session_read','session_send','session_abort']);
  const history = await f.client.read(target); assert.equal(history.messages[0].text, 'Waiting for instruction');
  assert.equal(f.calls[0].url, 'https://computer.example.ts.net/orchestration'); assert.equal(f.calls[0].headers.Authorization, `Bearer ${conn.token}`);
});
test('a late session inventory cannot be attributed to a newly selected laptop', async () => {
  let current = conn;
  let resolveRequest;
  const client = createDesktopSessionClient({ getConnection: () => current, request: () => new Promise(resolve => { resolveRequest = resolve; }) });
  const listing = client.list();
  current = { ...conn, url: 'wss://other.example.ts.net/ws', deviceId: 'other-device' };
  resolveRequest({ status: 200, body: JSON.stringify({ available: true, sessions: [session] }), headers: {} });
  await assert.rejects(listing, /conexión cambió/);
});
test('send displays exact target and text before one mutation, then correlates a receipt without claiming completion', async () => {
  const f = fixture(); let reviewed;
  const result = await f.client.send({ ...target, text: 'Analyze deploy risks', deliverAs: 'followUp' }, context(async approval => {
    reviewed = JSON.parse(approval.details); assert.equal(f.calls.some(call => call.body && JSON.parse(call.body).action === 'prompt'), false); return true;
  }));
  assert.equal(reviewed.text, 'Analyze deploy risks'); assert.equal(reviewed.sessionId, target.sessionId); assert.equal(reviewed.token, undefined);
  assert.equal(result.status, 'queued'); assert.equal(result.completed, false); assert.equal(result.clientMessageId, reviewed.clientMessageId);
  const sends = f.calls.filter(call => call.body && JSON.parse(call.body).action === 'prompt'); assert.equal(sends.length, 1); assert.equal(JSON.parse(sends[0].body).clientMessageId, result.receipt.id);
});
test('missing/denied approval, changed connection and replaced Pi process prevent mutation', async () => {
  for (const ask of [undefined, async () => false]) {
    const f = fixture(); await assert.rejects(f.client.send({ ...target, text: 'Do work' }, context(ask)), /no fue aprobada/);
    assert.equal(f.calls.some(call => call.body && JSON.parse(call.body).action === 'prompt'), false);
  }
  const f = fixture(); await assert.rejects(f.client.send({ ...target, text: 'Do work' }, context(async () => { f.changeConnection({ ...conn, deviceId: 'new-device' }); return true; })), /conexión cambió/);
  let reads = 0; const changed = fixture({ inspect: (_calls, value) => ({ ...value, instanceId: ++reads > 1 ? 'restarted-instance' : 'instance-1' }) });
  await assert.rejects(changed.client.send({ ...target, text: 'Do work' }, context(async () => true)), /reinició/);
  assert.equal(changed.calls.some(call => call.body && JSON.parse(call.body).action === 'prompt'), false);
});
test('lost or mismatched acknowledgement is uncertain and never retried automatically', async () => {
  for (const flags of [{ failSend: true }, { wrongAck: true }]) {
    const f = fixture(flags); const result = await f.client.send({ ...target, text: 'Do work' }, context(async () => true));
    assert.equal(result.status, 'uncertain'); assert.match(result.clientMessageId, /^[a-f0-9-]{36}$/);
    assert.equal(f.calls.filter(call => call.body && JSON.parse(call.body).action === 'prompt').length, 1);
  }
});
test('a session prompt whose connection changes in flight remains uncertain and is not retried', async () => {
  let current = conn;
  let sends = 0;
  const client = createDesktopSessionClient({ getConnection: () => current, request: async request => {
    const payload = request.body ? JSON.parse(request.body) : undefined;
    if (!payload) return { status: 200, headers: {}, body: JSON.stringify({ available: true, sessions: [session] }) };
    if (payload.action === 'inspect') return { status: 200, headers: {}, body: JSON.stringify(page()) };
    sends++;
    current = { ...conn, url: 'wss://other.example.ts.net/ws', deviceId: 'other-device' };
    return { status: 200, headers: {}, body: JSON.stringify({ accepted: true, sessionId: target.sessionId, instanceId: 'instance-1' }) };
  } });
  const result = await client.send({ ...target, text: 'Revisar trabajo' }, context(async () => true));
  assert.equal(result.status, 'uncertain');
  assert.equal(sends, 1);
});
test('abort approval identifies shared session, and schema guards reject forged or oversized host data', async () => {
  const f = fixture(); let approval;
  assert.equal((await f.client.abort(target, context(async input => { approval = input; return true; }))).accepted, true);
  assert.equal(JSON.parse(approval.details).action, 'abort'); assert.equal(JSON.parse(approval.details).sessionId, target.sessionId);
  assert.throws(() => parseDesktopPage({ ...page(), sessionId: 'foreign' }, target.sessionId), /distinta/);
  assert.throws(() => parseDesktopPage({ ...page(), deliveries: [{ id: 'r', status: 'done' }] }, target.sessionId), /inválida/);
  assert.throws(() => parseDesktopSessions({ available: true, sessions: [{ ...session, paneId: '\0' }] }), /válida/);
});
test('human-only answer rechecks the exact current question after approval', async () => {
  const question = { id: 'q1', title: 'Enviar correo', message: 'A: Ana. Texto exacto.', kind: 'confirm', expiresAt: new Date(Date.now() + 60000).toISOString() };
  let reads = 0; const f = fixture({ inspect: (_calls, value) => ({ ...value, question: { ...question, message: ++reads > 1 ? 'Texto cambiado.' : question.message } }) });
  await assert.rejects(f.client.answerFromHuman({ ...target, requestId: 'q1', confirmed: true }, context(async () => true)), /permiso cambió/);
  assert.equal(f.calls.some(call => call.body && JSON.parse(call.body).action === 'answer'), false);
});
test('human review preserves authored option effects and refuses a changed consequence', async () => {
  let reads = 0; const question = { id: 'q1', title: 'Publicar', message: 'Elige el alcance.', kind: 'select', expiresAt: new Date(Date.now() + 60000).toISOString(), fingerprint: 'content-hash', options: [{ id: 'publish', label: 'Publicar', description: 'Envía el documento completo', effect: 'Visible para el equipo', consequence: 'Comunicación externa' }] };
  const f = fixture({ inspect: (_calls, value) => ({ ...value, question: { ...question, options: question.options.map(option => ({ ...option, consequence: ++reads > 1 ? 'Público en internet' : option.consequence })) } }) });
  let reviewed;
  await assert.rejects(f.client.answerFromHuman({ ...target, requestId: 'q1', optionId: 'publish' }, context(async approval => { reviewed = JSON.parse(approval.details); return true; })), /permiso cambió/);
  assert.equal(reviewed.request.options[0].description, question.options[0].description); assert.equal(reviewed.request.options[0].consequence, 'Comunicación externa');
  assert.equal(f.calls.some(call => call.body && JSON.parse(call.body).action === 'answer'), false);
});
test('cancellation during the post-approval reread prevents the pending mutation', async () => {
  const controller = new AbortController(); let reads = 0;
  const f = fixture({ inspect: (_calls, value) => { if (++reads === 2) controller.abort(); return value; } });
  await assert.rejects(f.client.send({ ...target, text: 'Do work' }, { signal: controller.signal, askApproval: async () => true }));
  assert.equal(f.calls.some(call => call.body && JSON.parse(call.body).action === 'prompt'), false);
});

test('agent session read adapts valid large history while preserving cursor and reuses the safe limit', async () => {
  const calls = [];
  const client = createDesktopSessionClient({ getConnection: () => conn, request: async request => {
    const payload = JSON.parse(request.body); calls.push(payload);
    if (payload.limit === 50) throw new DeviceBridgeError('size_limit', 'native limit');
    return { status: 200, headers: {}, body: JSON.stringify({ ...page(),
      messages: Array.from({ length: payload.limit }, (_, index) => ({ id: `m${index}`, role: 'assistant', content: 'x'.repeat(25000) })),
      history: { hasEarlier: true, before: 'previous' } }) };
  } });
  const value = await client.read({ ...target, limit: 50, before: 'original' });
  assert.deepEqual(calls.map(call => call.limit), [50, 25, 12, 6]);
  assert.ok(calls.every(call => call.action === 'inspect' && call.before === 'original' && call.sessionId === target.sessionId));
  assert.equal(value.messages.length, 6); assert.equal(value.history.before, 'previous');
  calls.length = 0; await client.read(target); assert.equal(calls[0].limit, 6);
});

test('agent session read never retries network failure, cancellation or a changed connection', async () => {
  let current = conn, calls = 0;
  const controller = new AbortController();
  const client = createDesktopSessionClient({ getConnection: () => current, request: async () => {
    calls++;
    if (calls === 1) throw new Error('offline');
    if (calls === 2) { controller.abort(); throw new DeviceBridgeError('size_limit', 'large'); }
    current = { ...conn, deviceId: 'replacement' };
    throw new DeviceBridgeError('size_limit', 'large');
  } });
  await assert.rejects(client.read(target), /no confirmó/); assert.equal(calls, 1);
  await assert.rejects(client.read(target, controller.signal), { name: 'AbortError' }); assert.equal(calls, 2);
  await assert.rejects(client.read(target), /conexión cambió/); assert.equal(calls, 3);
});

test('agent session read does not retry malformed or oversized individual messages', async () => {
  let calls = 0;
  const client = createDesktopSessionClient({ getConnection: () => conn, request: async () => {
    calls++;
    return { status: 200, headers: {}, body: JSON.stringify({ ...page(), messages: [{ id: 'm', role: 'assistant', content: 'x'.repeat(32001) }] }) };
  } });
  await assert.rejects(client.read(target), /mensaje.*supera/); assert.equal(calls, 1);
});

test('agent session read also adapts when the JavaScript response limit is exceeded', async () => {
  const limits = [];
  const client = createDesktopSessionClient({ getConnection: () => conn, request: async request => {
    const payload = JSON.parse(request.body); limits.push(payload.limit);
    return { status: 200, headers: {}, body: JSON.stringify({ ...page(),
      messages: Array.from({ length: payload.limit }, (_, index) => ({ id: `m${index}`, role: 'assistant', content: 'x'.repeat(25000) })) }) };
  } });
  assert.equal((await client.read({ ...target, limit: 50 })).messages.length, 6);
  assert.deepEqual(limits, [50, 25, 12, 6]);
});

test('an oversized response to a session mutation remains uncertain and is never replayed', async () => {
  let sends = 0;
  const client = createDesktopSessionClient({ getConnection: () => conn, request: async request => {
    const payload = request.body && JSON.parse(request.body);
    if (payload?.action === 'prompt') { sends++; throw new DeviceBridgeError('size_limit', 'large'); }
    return { status: 200, headers: {}, body: JSON.stringify(payload ? page() : { available: true, sessions: [session] }) };
  } });
  const result = await client.send({ ...target, text: 'Revisa la sesión' }, context(async () => true));
  assert.equal(result.status, 'uncertain'); assert.equal(sends, 1);
});
