import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAgentContext } from '../src/agent-context.ts';
const entry = (id, role, text, extra = {}) => ({ id, role, text, engine: 'iphone', state: 'complete', at: Number(id) || 1, ...extra });

test('conversation context retains useful prior instructions and responses in chronological order', () => {
  const request = 'El proyecto usa PostgreSQL. Conserva los nombres de tablas. '.repeat(8) + 'No cambies production.env.';
  const response = 'Revisaré la configuración y prepararé un borrador. '.repeat(9);
  const source = [entry('1', 'user', request), entry('2', 'assistant', response), entry('3', 'user', 'Y respeta la ventana de mantenimiento del viernes.')];
  const context = JSON.parse(createAgentContext(source)(4000));
  assert.deepEqual(context.turns.map(turn => turn.id), ['1', '2', '3']);
  assert.equal(context.turns[0].text, request); assert.equal(context.turns[1].text, response);
  assert.equal(context.turns[2].text, source[2].text); assert.equal(context.omittedMessages, 0);
});
test('interrupted operations preserve exact identity and receipt status instead of implying success', () => {
  const context = JSON.parse(createAgentContext([entry('1', 'assistant', '', { engine: 'gentle', state: 'interrupted', activities: [
    { id: 'transfer-request-123', kind: 'other', title: 'Transferir trabajo', status: 'failed', detail: '{"status":"uncertain","transferId":"transfer-123"}' },
  ] })], { attachedWork: 'work-123' })(2500));
  assert.equal(context.attachedWork, 'work-123'); assert.equal(context.turns[0].state, 'interrupted');
  assert.equal(context.turns[0].engine, 'gentle'); assert.equal(context.turns[0].activities[0].id, 'transfer-request-123');
  assert.match(context.turns[0].activities[0].result, /uncertain/); assert.match(context.memory, /no confirma/);
});
test('tight Unicode and escaping budgets keep valid JSON, source order and explicit partial history', () => {
  const source = Array.from({ length: 20 }, (_, i) => entry(String(i + 1), i % 2 ? 'assistant' : 'user', '"\n🦖\\'.repeat(1000)));
  const build = createAgentContext(source);
  for (const budget of [300, 800, 1800, 4000, 6500]) {
    const text = build(budget); assert.ok(Array.from(text).length <= budget);
    const parsed = JSON.parse(text); assert.ok(parsed.partial || parsed.omittedMessages > 0);
    if (parsed.turns?.length) {
      assert.equal(parsed.turns.at(-1).id, '20');
      assert.deepEqual(parsed.turns.map(turn => Number(turn.id)), parsed.turns.map(turn => Number(turn.id)).sort((a, b) => a - b));
      assert.ok(parsed.turns.every(turn => turn.partial));
    }
  }
  assert.equal(source[19].text, '"\n🦖\\'.repeat(1000));
});
test('context captures a snapshot and never includes hidden transport wrappers or unrelated fields', () => {
  const source = [entry('1', 'user', 'Hola', { transportText: 'HOST_CONTEXT_WRAPPER', token: 'not-a-context-field' })];
  const build = createAgentContext(source); source[0].text = 'Changed after capture';
  const text = build(2000); assert.match(text, /Hola/); assert.doesNotMatch(text, /Changed|HOST_CONTEXT|not-a-context-field/);
});
