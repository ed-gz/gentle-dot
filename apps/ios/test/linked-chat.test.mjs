import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { createLinkedChat } from '../src/linked-chat.ts';

const originalSocket = globalThis.WebSocket;
class FakeSocket {
  static OPEN = 1;
  static all = [];
  readyState = 0;
  sent = [];
  sequence = 0;
  constructor(url) { this.url = url; FakeSocket.all.push(this); }
  send(raw) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.(); }
  receive(message) { this.onmessage?.({ data: JSON.stringify({ seq: ++this.sequence, ...message }) }); }
  drop(code = 1006) { this.readyState = 3; this.onclose?.({ code }); }
}
function fixture() {
  const statuses = [], messages = [];
  const chat = createLinkedChat({ onStatus: value => statuses.push(value), onMessage: value => messages.push(value) });
  chat.connect('wss://example.ts.net/ws', ' example-secret ');
  return { chat, statuses, messages, socket: FakeSocket.all.at(-1) };
}
function ready(socket, features) { socket.open(); socket.receive({ type: 'ready', agentState: 'idle', ...(features ? { features: { conversations: false, ...features } } : {}) }); }
beforeEach(() => {
  globalThis.WebSocket = FakeSocket;
  FakeSocket.all = [];
  mock.timers.enable({ apis: ['setTimeout'] });
});
afterEach(() => { mock.timers.reset(); globalThis.WebSocket = originalSocket; });

test('waits for valid ready before send/abort and requests history once', () => {
  const { chat, socket, statuses } = fixture();
  socket.open();
  assert.equal(chat.send('Hello'), false);
  assert.equal(chat.abort(), false);
  socket.receive({ type: 'ready', agentState: 'bogus' });
  assert.equal(chat.ready(), false);
  socket.receive({ type: 'ready', agentState: 'idle' });
  socket.receive({ type: 'ready', agentState: 'idle' });
  assert.equal(chat.ready(), true);
  assert.deepEqual(statuses, ['connecting', 'ready']);
  assert.deepEqual(socket.sent, [{ type: 'hello', token: 'example-secret', protocol: 1 }, { type: 'get_history' }]);
  assert.equal(chat.send(' Hello '), true);
  assert.match(socket.sent.at(-1).requestId, /^[0-9a-f-]{36}$/);
  assert.equal(socket.sent.at(-1).text, 'Hello');
  assert.equal(chat.send(' '.repeat(3)), false);
  assert.equal(chat.send('a'.repeat(8001)), false);
  assert.equal(chat.abort(), true);
  assert.deepEqual(socket.sent.at(-1), { type: 'abort' });
});

test('reconnects without replaying a prompt and ignores stale socket events', () => {
  const { chat, socket, messages } = fixture();
  ready(socket);
  chat.send('Only once');
  socket.drop();
  assert.equal(chat.ready(), false);
  assert.equal(chat.send('Keep draft'), false);
  mock.timers.tick(499);
  assert.equal(FakeSocket.all.length, 1);
  mock.timers.tick(1);
  const next = FakeSocket.all.at(-1);
  ready(next);
  socket.receive({ type: 'message_done', messageId: 'old', text: 'Stale' });
  socket.drop();
  assert.equal(messages.some(message => message.messageId === 'old'), false);
  assert.equal(next.sent.some(message => message.type === 'send'), false);
  assert.equal(chat.ready(), true);
});

test('rejects authorization and protocol failures without retry or resume', () => {
  for (const code of [4401, 4400]) {
    const { chat, socket, statuses } = fixture();
    socket.open();
    socket.drop(code);
    const count = FakeSocket.all.length;
    chat.resume();
    mock.timers.tick(60000);
    assert.equal(FakeSocket.all.length, count);
    assert.equal(chat.ready(), false);
    assert.equal(statuses.at(-1), 'rejected');
  }
});

test('a failed socket send returns false and never queues the prompt for replay', () => {
  const { chat, socket } = fixture();
  ready(socket);
  socket.send = () => { throw new Error('Connection lost'); };
  assert.equal(chat.send('Keep this draft'), false);
  assert.equal(chat.ready(), false);
  mock.timers.tick(500);
  const next = FakeSocket.all.at(-1);
  ready(next);
  assert.deepEqual(next.sent.map(message => message.type), ['hello', 'get_history']);
});

test('times out a silent handshake and caps offline retry delay', () => {
  const { socket } = fixture();
  socket.open();
  mock.timers.tick(12000);
  assert.equal(socket.readyState, 3);
  for (const delay of [500, 1000, 2000, 5000, 10000, 30000, 30000]) {
    const count = FakeSocket.all.length;
    mock.timers.tick(delay - 1);
    assert.equal(FakeSocket.all.length, count);
    mock.timers.tick(1);
    assert.equal(FakeSocket.all.length, count + 1);
    FakeSocket.all.at(-1).drop();
  }
});

test('suspension closes the connection, resume refreshes history, disconnect removes credentials', () => {
  const { chat, socket } = fixture();
  ready(socket);
  chat.suspend();
  assert.equal(socket.readyState, 3);
  assert.equal(chat.send('No background send'), false);
  mock.timers.tick(60000);
  assert.equal(FakeSocket.all.length, 1);
  chat.resume();
  const next = FakeSocket.all.at(-1);
  ready(next);
  assert.deepEqual(next.sent.map(message => message.type), ['hello', 'get_history']);
  chat.resume();
  assert.equal(FakeSocket.all.length, 2);
  chat.disconnect();
  chat.resume();
  mock.timers.tick(60000);
  assert.equal(FakeSocket.all.length, 2);
});

test('validates chat/history/ask fields and bounds the UTF-8 payload before UI delivery', () => {
  const { socket, messages } = fixture();
  ready(socket);
  const valid = [
    { type: 'agent_state', state: 'thinking' },
    { type: 'history', conversationId: 'c1', messages: [{ id: 'h1', role: 'assistant', text: 'Earlier', activities: [] }] },
    { type: 'user_message', messageId: 'u1', text: '<script>literal</script>' },
    { type: 'message_delta', messageId: 'm1', delta: 'Partial' },
    { type: 'message_done', messageId: 'm1', text: 'Final', stopped: true },
    { type: 'toast', level: 'warning', message: 'Attention' },
    { type: 'ask', ask: { requestId: 'a1', method: 'confirm', title: 'Confirm?' } },
    { type: 'ask_resolved', requestId: 'a1' },
    { type: 'error', code: 'busy', message: 'Wait' },
  ];
  valid.forEach(value => socket.receive(value));
  const count = messages.length;
  [
    { type: 'history', messages: [null] },
    { type: 'history', messages: [{ id: 'h', role: 'assistant', text: 'X', activities: 'bad' }] },
    { type: 'message_delta', messageId: 'm', delta: {} },
    { type: 'message_done', messageId: 'm', text: 'X', stopped: 'true' },
    { type: 'toast', level: 'info', message: 'X', session: { paneId: {} } },
    { type: 'toast', level: { toString: null }, message: 'X' },
    { type: 'ask', ask: { requestId: 'a', method: 'confirm', title: 'X', options: [{}] } },
    { type: 'message_done', messageId: 'm', text: 'é'.repeat(600000) },
    { type: 'message_done', messageId: 'm', text: 'Invalid sequence', seq: -1 },
  ].forEach(value => socket.receive(value));
  socket.onmessage({ data: '{broken' });
  socket.onmessage({ data: new Blob(['binary']) });
  assert.equal(messages.length, count);
  assert.deepEqual(messages.slice(1).map(({ seq, ...message }) => message), valid);
});

test('rejects unsafe endpoints and blank tokens without opening a socket', () => {
  const chat = createLinkedChat({ onStatus() {}, onMessage() {} });
  assert.throws(() => chat.connect('ws://example.ts.net/ws', 'secret'));
  assert.throws(() => chat.connect('wss://example.ts.net/ws?token=secret', 'secret'));
  assert.throws(() => chat.connect('wss://example.ts.net/ws', '   '));
  assert.equal(FakeSocket.all.length, 0);
});

test('human answers bind to the current ask and cannot bypass app or PIN channels', () => {
  const { chat, socket } = fixture(); ready(socket);
  assert.equal(chat.answer('missing', { confirmed: true }), false);
  socket.receive({ type: 'ask', ask: { requestId: 'confirm', method: 'confirm', title: 'Revisar contenido' } });
  assert.equal(chat.answer('confirm', { value: 'true' }), false);
  assert.equal(chat.answer('confirm', { confirmed: true }), true);
  assert.deepEqual(socket.sent.at(-1), { type: 'ui_response', requestId: 'confirm', confirmed: true });
  socket.receive({ type: 'ask_resolved', requestId: 'confirm' });
  assert.equal(chat.answer('confirm', { confirmed: true }), false);
  for (const method of ['app', 'pin']) {
    socket.receive({ type: 'ask', ask: { requestId: method, method, title: 'Sensitive' } });
    assert.equal(chat.answer(method, { confirmed: true }), false);
  }
  socket.receive({ type: 'ask', ask: { requestId: 'select', method: 'select', title: 'Choose', options: ['A', 'B'] } });
  assert.equal(chat.answer('select', { value: 'C' }), false);
  assert.equal(chat.answer('select', { value: 'A' }), true);
  socket.drop();
  assert.equal(chat.answer('select', { value: 'A' }), false);
});

test('an unchanged request ID cannot authorize content that changed after human review', () => {
  const { chat, socket } = fixture(); ready(socket);
  const shown = { requestId: 'same-id', method: 'confirm', title: 'Enviar borrador', message: 'Destino: Ana. Texto: versión A.' };
  socket.receive({ type: 'ask', ask: shown });
  const changed = { ...shown, message: 'Destino: Carlos. Texto: versión B.' };
  socket.receive({ type: 'ask', ask: changed });
  const before = socket.sent.length;
  assert.equal(chat.answer(shown.requestId, { confirmed: true }, shown), false);
  assert.equal(socket.sent.length, before);
  assert.equal(chat.answer(changed.requestId, { confirmed: true }, { message: changed.message, title: changed.title, method: changed.method, requestId: changed.requestId }), true);
  assert.deepEqual(socket.sent.at(-1), { type: 'ui_response', requestId: changed.requestId, confirmed: true });
});

test('option and expiry changes invalidate the reviewed ask snapshot', () => {
  const { chat, socket } = fixture(); ready(socket);
  const shown = { requestId: 'choice-id', method: 'select', title: 'Selecciona alcance', options: ['Privado','Equipo'], expiresAt: '2099-01-01T00:00:00.000Z' };
  socket.receive({ type: 'ask', ask: shown });
  socket.receive({ type: 'ask', ask: { ...shown, options: ['Privado','Internet'] } });
  assert.equal(chat.answer(shown.requestId, { value: 'Privado' }, shown), false);
  socket.receive({ type: 'ask', ask: { ...shown, expiresAt: '2099-01-02T00:00:00.000Z' } });
  assert.equal(chat.answer(shown.requestId, { value: 'Privado' }, shown), false);
});

test('work RPC requires matching request and transfer IDs and does not replay after disconnect', async () => {
  const { chat, socket } = fixture(); ready(socket, { workSync: 1 });
  const request = { type: 'work_sync', operation: 'status', requestId: 'request-1', transferId: 'transfer-1' };
  let settled = false;
  const response = chat.exchange(request).then(value => { settled = true; return value; });
  socket.receive({ type: 'work_sync_reply', state: 'missing', requestId: 'request-1', transferId: 'wrong' });
  await Promise.resolve(); assert.equal(settled, false);
  socket.receive({ type: 'work_sync_reply', state: 'missing', requestId: 'request-1', transferId: 'transfer-1' });
  assert.equal((await response).state, 'missing');
  const lost = chat.exchange({ ...request, requestId: 'request-2' });
  const rejected = assert.rejects(lost, /interrumpió/); socket.drop(); await rejected;
  mock.timers.tick(500); const next = FakeSocket.all.at(-1); ready(next);
  assert.equal(next.sent.some(message => message.type === 'work_sync'), false);
});

test('a missing durable reply times out without inventing receipt or resending', async () => {
  const { chat, socket } = fixture(); ready(socket, { workSync: 1 });
  const response = chat.exchange({ type: 'work_sync', operation: 'status', requestId: 'status-1', transferId: 'transfer-1' });
  const rejected = assert.rejects(response, /no confirmó/);
  mock.timers.tick(30000); await rejected;
  assert.equal(socket.sent.filter(message => message.type === 'work_sync').length, 1);
});

test('legacy or future unsupported work capability keeps chat ready without emitting a work request', async () => {
  for (const flags of [undefined, { workSync: 2, meetingDrafts: 2 }]) {
    const { chat, socket, statuses } = fixture(); ready(socket, flags);
    assert.equal(chat.ready(), true); assert.equal(chat.supportsWorkSync(), false);
    await assert.rejects(chat.exchange({ type: 'work_sync', operation: 'status', requestId: 'legacy-request', transferId: 'legacy-transfer' }), /Actualiza Gentle Dot/);
    assert.equal(socket.sent.some(message => message.type === 'work_sync'), false);
    assert.equal(chat.send('El chat continúa disponible'), true); assert.equal(statuses.at(-1), 'ready');
    chat.disconnect();
  }
});
test('meeting processing needs its own capability and reconnect cannot retain capabilities from the previous socket', async () => {
  const { chat, socket } = fixture(); ready(socket, { workSync: 1 });
  assert.equal(chat.supportsWorkSync(), true); assert.equal(chat.supportsMeetingDrafts(), false);
  const process = { type: 'work_sync', operation: 'process', requestId: 'process-1', transferId: 'meeting-1', approvedManifestHash: 'a'.repeat(64) };
  await assert.rejects(chat.exchange(process), /procesamiento de reuniones/);
  assert.equal(socket.sent.some(message => message.type === 'work_sync'), false);
  socket.drop(); assert.equal(chat.supportsWorkSync(), false); mock.timers.tick(500);
  const current = FakeSocket.all.at(-1); ready(current, { workSync: 1, meetingDrafts: 1 });
  assert.equal(chat.supportsMeetingDrafts(), true);
  const operation = chat.exchange(process); current.receive({ type: 'work_sync_reply', requestId: 'process-1', transferId: 'meeting-1', state: 'processing', processing: { status: 'running', message: 'Preparando borrador' } });
  assert.equal((await operation).state, 'processing');
  chat.suspend(); assert.equal(chat.supportsMeetingDrafts(), false); chat.resume(); ready(FakeSocket.all.at(-1));
  assert.equal(chat.ready(), true); assert.equal(chat.supportsWorkSync(), false);
});
test('malformed advertised capabilities never cross the ready boundary', () => {
  const { chat, socket } = fixture(); socket.open();
  for (const workSync of [true, '1', 0, -1, 1.5, 65536]) socket.receive({ type: 'ready', agentState: 'idle', features: { conversations: false, workSync } });
  assert.equal(chat.ready(), false);
  socket.receive({ type: 'ready', agentState: 'idle', features: { conversations: false, workSync: 1 } }); assert.equal(chat.ready(), true);
});
