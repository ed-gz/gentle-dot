import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCheckpointConversation } from '../src/checkpoint-conversation.ts';
import { fingerprintForCheckpoint } from '../src/checkpoint-client.ts';

const id = 'd3dba896-4b5c-4c1c-98c9-4e60238fe6b9', userId = '02bce422-1da0-4ebc-b2fb-9df32a25434e';
const revision = 'b71484fd-6a7c-4ea1-b6ce-075ba36ea5f6', next = 'ca438d1a-5a9a-4bb6-aa0a-51e73458ca19', step = '78432045-3def-46e6-b43c-794bfc6a84c5';
const resumedRevision = 'fe074890-f4f8-47a1-974c-1f4cd2d3cc08';
const instruction = 'Revisa mi sesión', context = 'Contexto anterior';
const tools = [{ name: 'session_read', description: 'Consulta la sesión', parameters: { type: 'object', properties: {} } }];
const clone = value => structuredClone(value);
const proposed = { kind: 'tool', text: 'Revisaré la sesión.', toolName: 'session_read', argumentsJSON: '{"id":"A"}' };
const answer = { kind: 'answer', text: 'Ya revisé el contexto.', toolName: '', argumentsJSON: '{}' };
function fixture() {
  const timeline = new Map([[userId, { id: userId, role: 'user', engine: 'iphone', state: 'complete', text: instruction, at: 1 }], [id, { id, role: 'assistant', engine: 'iphone', state: 'pending', text: '', at: 2 }]]);
  const items = new Map(); const anchors = new Map(); const calls = [];
  let response = proposed, failAnchorReady = false, failCommit = false, loseRemove = false;
  const anchorStore = {
    async create(value) { if (anchors.has(value.id)) throw new Error('duplicate'); const result = { ...clone(value), version: 1 }; anchors.set(value.id, result); calls.push('anchor-create'); return clone(result); },
    async get(key) { return clone(anchors.get(key)); }, async list() { return clone([...anchors.values()]); },
    async compareAndSwap(expected, changes) {
      if (JSON.stringify(anchors.get(expected.id)) !== JSON.stringify(expected)) throw new Error('stale anchor');
      if (failAnchorReady && changes.state === 'ready') { failAnchorReady = false; throw new Error('disk unavailable'); }
      const result = { ...clone(expected), ...clone(changes), version: expected.version + 1 }; anchors.set(expected.id, result); calls.push(`anchor-${result.state}`); return clone(result);
    },
    async remove(expected) { if (JSON.stringify(anchors.get(expected.id)) !== JSON.stringify(expected)) throw new Error('stale anchor'); anchors.delete(expected.id); calls.push('anchor-remove'); },
  };
  const turns = {
    async readPair(requestId, turnId) {
      if (requestId !== userId || turnId !== id) return undefined;
      const user = timeline.get(requestId), turn = timeline.get(turnId);
      return user && turn ? { user: clone(user), turn: clone(turn) } : undefined;
    },
    async commitAnswer(expectedUser, expected, text) {
      calls.push('chat-commit');
      if (failCommit) return false;
      if (JSON.stringify(timeline.get(expectedUser.id)) !== JSON.stringify(expectedUser)) return false;
      if (JSON.stringify(timeline.get(expected.id)) !== JSON.stringify(expected)) return false;
      timeline.set(expected.id, { ...clone(expected), role: 'assistant', state: 'complete', text }); return true;
    },
  };
  const client = {
    async create(idArg, text, contextArg, toolsArg) {
      calls.push('native-create');
      if (items.has(idArg)) throw new Error('duplicate');
      const value = { id: idArg, revision, sourceFingerprint: await fingerprintForCheckpoint(text, contextArg, toolsArg), state: 'ready' };
      items.set(idArg, value); return clone(value);
    },
    async list() { calls.push('native-list'); return { items: clone([...items.values()]) }; },
    async run(idArg, revisionArg) {
      calls.push('native-run');
      assert.equal(anchors.get(idArg).state, 'running');
      assert.equal(anchors.get(idArg).nativeRevision, revisionArg);
      const current = items.get(idArg);
      assert.equal(current.revision, revisionArg);
      const result = { ...current, revision: next, state: response.kind === 'answer' ? 'answer' : 'awaitingForeground', decision: clone(response) };
      items.set(idArg, result); return clone(result);
    },
    async resume(idArg, revisionArg, gesture) {
      calls.push('native-resume'); assert.equal(gesture, true);
      const current = items.get(idArg); assert.equal(current.revision, revisionArg);
      const result = { id: idArg, revision: resumedRevision, sourceFingerprint: current.sourceFingerprint, state: 'ready' };
      items.set(idArg, result); return clone(result);
    },
    async remove(idArg, revisionArg) {
      calls.push('native-remove'); assert.equal(items.get(idArg).revision, revisionArg); items.delete(idArg);
      if (loseRemove) { loseRemove = false; throw new Error('ack lost'); }
    },
  };
  const controller = createCheckpointConversation({ turns, anchors: anchorStore, client });
  return { controller, timeline, items, anchors, calls, client, anchorStore, turns,
    setResponse(value) { response = value; }, failReady() { failAnchorReady = true; }, failCommit(value) { failCommit = value; }, loseRemove() { loseRemove = true; } };
}
const input = { id, userId, instruction, context, tools };

test('native planning requires durable original turn and revision; proposal is returned without executing it', async () => {
  const f = fixture();
  const result = await f.controller.start(input);
  assert.equal(result.kind, 'proposal'); assert.deepEqual(result.record.decision, proposed);
  assert.deepEqual(f.calls, ['anchor-create','native-create','anchor-ready','anchor-running','native-run','native-list','anchor-awaitingForeground']);
  assert.equal(f.timeline.get(id).state, 'pending');
  assert.equal((await f.controller.recover(id)).kind, 'proposal');
  assert.equal(f.calls.filter(call => call === 'native-run').length, 1);
});

test('lost create callback or anchor write never starts inference; recovery adopts only the exact ready input', async () => {
  const f = fixture(); f.failReady();
  await assert.rejects(f.controller.start(input), /disk unavailable/);
  assert.equal(f.calls.includes('native-run'), false);
  assert.equal((await f.controller.recover(id)).kind, 'ready');
  assert.equal(f.calls.includes('native-run'), false);
  const g = fixture(); g.failReady(); await assert.rejects(g.controller.start(input));
  g.items.get(id).sourceFingerprint = 'a'.repeat(64);
  await assert.rejects(g.controller.recover(id), /no coincide/);
  assert.equal(g.calls.includes('native-run'), false);
});

test('answer is committed to the exact turn before native removal and survives a lost removal reply', async () => {
  const f = fixture(); f.setResponse(answer); f.failCommit(true);
  await assert.rejects(f.controller.start(input), /no confirmó/);
  assert.equal(f.items.get(id).state, 'answer'); assert.equal(f.calls.includes('native-remove'), false);
  f.failCommit(false); f.loseRemove();
  await assert.rejects(f.controller.recover(id), /ack lost/);
  assert.equal(f.timeline.get(id).text, answer.text); assert.equal(f.anchors.get(id).state, 'answerCommitted');
  assert.equal((await f.controller.recover(id)).kind, 'answer');
  assert.equal(f.anchors.has(id), false); assert.equal(f.items.has(id), false);
  assert.equal(f.calls.filter(call => call === 'chat-commit').length, 2);
});

test('a changed, removed or cancelled original turn cannot receive a recovered response', async () => {
  for (const change of ['request', 'cancel', 'remove']) {
    const f = fixture(); f.setResponse(answer); f.failCommit(true);
    await assert.rejects(f.controller.start(input)); f.failCommit(false);
    if (change === 'request') f.timeline.set(userId, { ...f.timeline.get(userId), text: 'Otro mensaje' });
    if (change === 'cancel') f.timeline.set(id, { ...f.timeline.get(id), state: 'interrupted', localCancelled: true });
    if (change === 'remove') f.timeline.delete(id);
    await assert.rejects(f.controller.recover(id), /original/);
    assert.equal(f.items.has(id), true); assert.equal(f.calls.includes('native-remove'), false);
  }
});

test('orphaned inference is displayed without retry and resumes only after an explicit gesture', async () => {
  const f = fixture(); f.failReady(); await assert.rejects(f.controller.start(input));
  await f.controller.recover(id);
  const anchor = f.anchors.get(id); await f.anchorStore.compareAndSwap(anchor, { state: 'running' });
  const current = f.items.get(id); f.items.set(id, { ...current, state: 'running', revision: next, stepId: step });
  assert.equal((await f.controller.recover(id)).kind, 'interrupted');
  await assert.rejects(f.controller.resume(id, false), /requiere una indicación/);
  assert.equal(f.calls.includes('native-resume'), false);
  assert.equal((await f.controller.resume(id, true)).kind, 'proposal');
  assert.equal(f.calls.filter(call => call === 'native-resume').length, 1);
});

test('lost recovery callback retains its transition and never starts inference automatically', async () => {
  const f = fixture(); f.failReady(); await assert.rejects(f.controller.start(input)); await f.controller.recover(id);
  await f.anchorStore.compareAndSwap(f.anchors.get(id), { state: 'running' });
  f.items.set(id, { ...f.items.get(id), state: 'running', revision: next, stepId: step });
  const resume = f.client.resume;
  f.client.resume = async (...args) => { await resume(...args); throw new Error('resume callback lost'); };
  await assert.rejects(f.controller.resume(id, true), /callback lost/);
  assert.equal(f.anchors.get(id).state, 'resuming');
  assert.equal((await f.controller.recover(id)).kind, 'ready');
  assert.equal(f.calls.filter(call => call === 'native-run').length, 0);
  f.client.resume = resume;
  assert.equal((await f.controller.resume(id, true)).kind, 'proposal');
  assert.equal(f.calls.filter(call => call === 'native-run').length, 1);
});

test('partial native recovery keeps the new interrupted revision for a later explicit retry', async () => {
  const f = fixture(); f.failReady(); await assert.rejects(f.controller.start(input)); await f.controller.recover(id);
  await f.anchorStore.compareAndSwap(f.anchors.get(id), { state: 'running' });
  f.items.set(id, { ...f.items.get(id), state: 'running', revision: next, stepId: step });
  const resume = f.client.resume;
  f.client.resume = async () => {
    f.items.set(id, { ...f.items.get(id), state: 'interrupted', revision: resumedRevision, stepId: undefined });
    throw new Error('partial write');
  };
  await assert.rejects(f.controller.resume(id, true), /partial write/);
  assert.equal((await f.controller.recover(id)).kind, 'interrupted');
  assert.equal(f.anchors.get(id).nativeRevision, resumedRevision);
  assert.equal(f.calls.filter(call => call === 'native-run').length, 0);
  f.client.resume = resume;
});

test('missing original turn or failed anchor persistence prevents native creation', async () => {
  const f = fixture(); f.timeline.delete(userId);
  await assert.rejects(f.controller.start(input), /Guarda primero/); assert.deepEqual(f.calls, []);
  const g = fixture(); g.anchors.set(id, { id });
  await assert.rejects(g.controller.start(input), /duplicate/); assert.equal(g.calls.includes('native-create'), false);
});

test('a request and turn that are not a bound pair cannot start native planning', async () => {
  const f = fixture(); const unrelated = 'ec58b974-b902-4621-a026-f049cbf392cf';
  f.timeline.set(unrelated, { ...f.timeline.get(userId), id: unrelated });
  await assert.rejects(f.controller.start({ ...input, userId: unrelated }), /Guarda primero/);
  assert.equal(f.calls.includes('native-create'), false);
});

test('a notice cannot act as an assistant turn', async () => {
  const f = fixture(); f.timeline.set(id, { ...f.timeline.get(id), role: 'notice' });
  await assert.rejects(f.controller.start(input), /Guarda primero/);
  assert.equal(f.calls.includes('native-create'), false);
});

test('a durable pending turn projected as interrupted remains usable, while explicit cancellation fences it', async () => {
  const f = fixture(); f.timeline.set(id, { ...f.timeline.get(id), state: 'interrupted' });
  assert.equal((await f.controller.start(input)).kind, 'proposal');
  const g = fixture(); g.timeline.set(id, { ...g.timeline.get(id), state: 'interrupted', localCancelled: true });
  await assert.rejects(g.controller.start(input), /Guarda primero/);
  assert.equal(g.calls.includes('native-create'), false);
});
