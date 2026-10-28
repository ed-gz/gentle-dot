import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTrustedApprovals } from '../src/trusted-approvals.ts';

const token = 't'.repeat(48);
const connection = { url: 'wss://workstation.tail1234.ts.net/ws', token };
const now = Date.parse('2026-10-27T12:00:00Z');
const view = () => ({ id: 'approval-unique-id', title: 'Enviar mensaje', message: 'Destinatario: Ana\nTexto: Confirmo el acuerdo.', expiresAt: new Date(now + 60_000).toISOString() });
const response = (approvals, status = 200) => ({ status, headers: {}, body: JSON.stringify({ approvals }) });

test('human approval binds the exact displayed snapshot and waits for server acknowledgement', async () => {
  const calls = [];
  const helper = createTrustedApprovals({ getConnection: () => connection, now: () => now,
    request: async request => { calls.push(request); return request.method === 'GET' ? response([view()]) : { status: 200, headers: {}, body: '{"ok":true}' }; } });
  const [snapshot] = await helper.list();
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(snapshot.body, view().message);
  assert.deepEqual(await helper.answer(snapshot, true), { confirmed: true, approved: true });
  assert.deepEqual(calls.map(item => item.method), ['GET', 'GET', 'POST']);
  assert.deepEqual(JSON.parse(calls[2].body), { requestId: view().id, approved: true });
  await assert.rejects(helper.answer(snapshot, true), error => error.code === 'uncertain');
  assert.equal(calls.length, 3);
});

test('changed title, content, expiration, connection, or unissued snapshot never sends approval', async () => {
  for (const mutate of [item => ({ ...item, title: 'Otro título' }), item => ({ ...item, message: 'Texto modificado' }), item => ({ ...item, expiresAt: new Date(now + 90_000).toISOString() }), () => undefined]) {
    let reads = 0; let posts = 0;
    const helper = createTrustedApprovals({ getConnection: () => connection, now: () => now,
      request: async request => { if (request.method === 'POST') posts++; const item = ++reads === 1 ? view() : mutate(view()); return response(item ? [item] : []); } });
    const [snapshot] = await helper.list();
    await assert.rejects(helper.answer(snapshot, true), error => ['changed', 'expired'].includes(error.code));
    assert.equal(posts, 0);
    await assert.rejects(helper.answer({ ...snapshot }, true), error => error.code === 'invalid');
  }
  let current = connection; let posts = 0;
  const helper = createTrustedApprovals({ getConnection: () => current, now: () => now, request: async request => { if (request.method === 'POST') posts++; return response([view()]); } });
  const [snapshot] = await helper.list();
  current = { ...connection, token: 'r'.repeat(48) };
  await assert.rejects(helper.answer(snapshot, true), error => error.code === 'changed');
  assert.equal(posts, 0);
});

test('403 explains required device approval and expiration is enforced locally', async () => {
  const forbidden = createTrustedApprovals({ getConnection: () => connection, request: async () => response([], 403) });
  await assert.rejects(forbidden.list(), error => error.code === 'forbidden' && /token maestro/.test(error.message));
  let time = now; let calls = 0;
  const helper = createTrustedApprovals({ getConnection: () => connection, now: () => time, request: async () => { calls++; return response([view()]); } });
  const [snapshot] = await helper.list(); time += 60_001;
  await assert.rejects(helper.answer(snapshot, false), error => error.code === 'expired');
  assert.equal(calls, 1);
});

test('lost POST acknowledgement is uncertain and never retried automatically', async () => {
  let posts = 0;
  const helper = createTrustedApprovals({ getConnection: () => connection, now: () => now,
    request: async request => { if (request.method === 'POST') { posts++; throw new Error('network'); } return response([view()]); } });
  const [snapshot] = await helper.list();
  await assert.rejects(helper.answer(snapshot, false), error => error.code === 'uncertain');
  await assert.rejects(helper.answer(snapshot, false), error => error.code === 'uncertain');
  assert.equal(posts, 1);
});

test('connection replacement during refresh and duplicate ids prevent submitting', async () => {
  let current = connection; let reads = 0; let posts = 0;
  const helper = createTrustedApprovals({ getConnection: () => current, now: () => now,
    request: async request => { if (request.method === 'POST') posts++; if (++reads === 2) current = { ...connection, url: 'wss://other.tail1234.ts.net/ws' }; return response([view()]); } });
  const [snapshot] = await helper.list();
  await assert.rejects(helper.answer(snapshot, true), error => error.code === 'changed');
  assert.equal(posts, 0);
  const duplicates = createTrustedApprovals({ getConnection: () => connection, request: async () => response([view(), view()]) });
  await assert.rejects(duplicates.list(), error => error.code === 'invalid');
});
