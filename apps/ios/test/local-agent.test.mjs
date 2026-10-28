import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentStep, validateAgentDecision } from '../src/local-intelligence.ts';

test('structured decisions distinguish answers from one catalog tool request', () => {
  assert.equal(validateAgentDecision({ kind: 'answer', text: 'El borrador se conserva en este iPhone.', toolName: '', argumentsJSON: '{}' }), true);
  assert.equal(validateAgentDecision({ kind: 'tool', text: 'Consultaré tus trabajos.', toolName: 'works.list', argumentsJSON: '{"limit":10}' }), true);
  assert.equal(validateAgentDecision({ kind: 'tool', text: '', toolName: 'mcp:new_service.query', argumentsJSON: '{}' }), true);
});

test('malformed or ambiguous decisions cannot cross the model boundary', () => {
  const good = { kind: 'tool', text: 'Prepararé el borrador.', toolName: 'actions.prepare', argumentsJSON: '{}' };
  for (const bad of [null, [], {}, { ...good, kind: 'execute' }, { ...good, toolName: '' }, { ...good, toolName: '../escape' },
    { ...good, text: 'a'.repeat(2401) }, { ...good, argumentsJSON: '{bad' }, { ...good, argumentsJSON: 'null' },
    { ...good, argumentsJSON: '[]' }, { ...good, argumentsJSON: '"object"' }, { ...good, argumentsJSON: '{"x":"' + 'a'.repeat(4000) + '"}' },
    { ...good, kind: 'answer' }, { ...good, kind: 'answer', toolName: '', argumentsJSON: '{"action":"send"}' },
    { ...good, kind: 'answer', toolName: '', text: ' ' }]) assert.equal(validateAgentDecision(bad), false);
});

test('Unicode limits count code points and missing native inference stays visible', async () => {
  assert.equal(validateAgentDecision({ kind: 'answer', text: '🦖'.repeat(2400), toolName: '', argumentsJSON: '{}' }), true);
  assert.equal((await agentStep('🦖'.repeat(8001))).error, 'invalid_prompt');
  assert.equal((await agentStep('   ')).error, 'invalid_prompt');
  const unavailable = await agentStep('Consulta mis trabajos');
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.error, 'bridge_unavailable');
  assert.equal(unavailable.decision, undefined);
});
