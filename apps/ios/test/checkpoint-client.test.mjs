import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCheckpointClient } from '../src/checkpoint-client.ts';

const id = 'd3dba896-4b5c-4c1c-98c9-4e60238fe6b9';
const revision = 'b71484fd-6a7c-4ea1-b6ce-075ba36ea5f6';
const next = 'ca438d1a-5a9a-4bb6-aa0a-51e73458ca19';
const step = '78432045-3def-46e6-b43c-794bfc6a84c5';
const tool = { name: 'session_read', description: 'Consulta una sesión', parameters: { type: 'object', properties: {}, additionalProperties: false } };
const source = { instruction: 'Revisa la sesión', context: 'Contexto', tools: [{ name: tool.name, description: tool.description, schemaJSON: JSON.stringify(tool.parameters) }] };
const waiting = { ...source, id, revision: next, state: 'awaitingForeground', decision: { kind: 'tool', text: 'Revisaré tu sesión.', toolName: 'session_read', argumentsJSON: '{"sessionId":"s"}' } };

test('a native run freezes the catalog, returns a proposal, and never executes it', async () => {
  const calls = [];
  const client = createCheckpointClient(async (command, args) => {
    calls.push({ command, args });
    if (command === 'checkpoint_create') return { ok: true, record: { ...source, id, revision, state: 'ready' } };
    if (command === 'checkpoint_run') return { ok: true, record: waiting };
    throw new Error('unexpected command');
  });
  const created = await client.create(id, 'Revisa la sesión', 'Contexto', [tool]);
  const result = await client.run(created.id, created.revision, true);
  assert.deepEqual(result.decision, waiting.decision);
  assert.equal(result.sourceFingerprint, created.sourceFingerprint);
  assert.deepEqual(calls.map(call => call.command), ['checkpoint_create', 'checkpoint_run']);
  assert.deepEqual(JSON.parse(calls[0].args.tools[0].schemaJSON), tool.parameters);
  assert.equal(calls[1].args.allowBackground, true);
});

test('recovery is explicit, keeps running or uncertain states visible, and never invokes tools', async () => {
  const calls = [];
  const client = createCheckpointClient(async (command, args) => {
    calls.push({ command, args });
    if (command === 'checkpoint_list') return { ok: true, items: [{ ...source, id, revision, state: 'running', stepID: step }] };
    if (command === 'checkpoint_resume') return { ok: true, record: { ...source, id, revision: next, state: 'ready' } };
    throw new Error('unexpected command');
  });
  assert.equal((await client.list()).items[0].state, 'running');
  await assert.rejects(client.resume(id, revision, false), /requiere una indicación/);
  assert.equal(calls.length, 1);
  assert.equal((await client.resume(id, revision, true)).state, 'ready');
  assert.deepEqual(calls.map(call => call.command), ['checkpoint_list', 'checkpoint_resume']);
});

test('a live stop is only a request; a pre-start stop returns confirmed cancellation', async () => {
  let value = { ok: true, message: 'Interrupción solicitada.' };
  const client = createCheckpointClient(async () => value);
  assert.equal(await client.stop(id, revision), undefined);
  value = { ok: true, record: { ...source, id, revision: next, state: 'cancelled' } };
  assert.equal((await client.stop(id, revision)).state, 'cancelled');
});

test('malformed identities, wrong decisions and forged terminal replies are rejected', async () => {
  let value = { ok: true, items: [{ id, revision, state: 'running' }] };
  const client = createCheckpointClient(async () => value);
  await assert.rejects(client.list(), /paso del análisis/);
  value = { ok: true, items: [{ id, revision, state: 'answer', decision: waiting.decision }] };
  await assert.rejects(client.list(), /propuesta/);
  value = { ok: true, items: [{ id, revision, state: 'ready', decision: {} }] };
  await assert.rejects(client.list(), /propuesta/);
  value = { ok: true, record: { ...waiting, id: next } };
  await assert.rejects(client.run(id, revision), /no coincide/);
  await assert.rejects(client.run('invalid', revision), /identidad/);
  await assert.rejects(client.create(id, 'Hola', '', [tool, tool]), /catálogo/);
});

test('native source binding rejects a different request or an unknown proposed tool', async () => {
  let value = { ok: true, record: { ...source, instruction: 'Una instrucción diferente', id, revision, state: 'ready' } };
  const client = createCheckpointClient(async () => value);
  await assert.rejects(client.create(id, source.instruction, source.context, [tool]), /no coincide/);
  value = { ok: true, record: { ...waiting, decision: { ...waiting.decision, toolName: 'otro_servicio' } } };
  await assert.rejects(client.run(id, revision), /no pertenece al catálogo/);
});
