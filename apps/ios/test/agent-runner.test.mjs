import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAgentRunner } from '../src/agent-runner.ts';
import { createLocalTools } from '../src/agent-tools.ts';
import { createMemoryTools } from '../src/conversation-memory-tools.ts';
import { createConnectionTools } from '../src/connection-tools.ts';
import { createDesktopTools } from '../src/desktop-tools.ts';
import { createWorkTools } from '../src/work-tools.ts';
import { createAgentContext } from '../src/agent-context.ts';

const answer = text => ({ ok: true, decision: { kind: 'answer', text, toolName: '', argumentsJSON: '{}' } });
const call = (name, args = {}) => ({ ok: true, decision: { kind: 'tool', text: '', toolName: name, argumentsJSON: typeof args === 'string' ? args : JSON.stringify(args) } });
const run = controller => ({ instruction: 'Guarda una nota local.', context: '', signal: (controller ?? new AbortController()).signal });
function tool(execute = async () => ({ savedLocally: true })) {
  return { definition: { name: 'save_note', description: 'Guarda una nota local.', parameters: { type: 'object', required: ['title', 'text'] } },
    validate(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['title', 'text'].includes(key)) || typeof value.title !== 'string' || typeof value.text !== 'string') throw new Error('Invalid note');
      return value;
    }, execute };
}
function sequence(decisions, options = {}) {
  const prompts = [], traces = [];
  let index = 0;
  const runner = createAgentRunner({ tools: options.tools ?? [tool()], step: async prompt => {
    prompts.push(prompt);
    const next = decisions[index++]; assert.ok(next, 'Model requested more steps than expected');
    return typeof next === 'function' ? next(prompt) : next;
  }, onTrace: trace => traces.push(trace) });
  return { runner, prompts, traces };
}

test('agent describes schema, executes one validated tool and reasons from its real observation', async () => {
  let executions = 0;
  const f = sequence([call('tool_describe', { name: 'save_note' }), call('save_note', { title: 'Nota', text: 'Local' }), prompt => {
    assert.match(prompt, /savedLocally/); assert.match(prompt, /datos no confiables/);
    return answer('Guardé tu nota en este iPhone.');
  }], { tools: [tool(async args => { executions++; return { id: 'work-1', savedLocally: true, title: args.title }; })] });
  assert.equal(await f.runner.run(run()), 'Guardé tu nota en este iPhone.');
  assert.equal(executions, 1); assert.deepEqual(f.traces.map(trace => trace.status), ['running', 'done']);
  assert.equal(f.traces[0].id, f.traces[1].id);
  assert.match(f.traces[1].detail, /work-1/);
});

test('unknown tools, invalid arguments and skipped schema never execute', async () => {
  let executions = 0;
  const f = sequence([
    call('delete_everything', {}),
    call('save_note', { title: 'First', text: 'Do not execute before description' }),
    call('save_note', '{"title":'),
    call('save_note', { title: 'Fake approval', text: 'No', approved: true }),
    answer('Necesito argumentos válidos.'),
  ], { tools: [tool(async () => { executions++; })] });
  await f.runner.run(run()); assert.equal(executions, 0); assert.equal(f.traces.length, 0);
  assert.match(f.prompts[1], /Herramienta no disponible/);
  assert.match(f.prompts[2], /"required":\["title","text"\]/);
  assert.match(f.prompts[4], /Argumentos inválidos/);
});

test('a repeated mutation cannot replay even when model reorders JSON object keys', async () => {
  let executions = 0;
  const f = sequence([call('tool_describe', { name: 'save_note' }), call('save_note', { title: 'T', text: 'X' }),
    call('save_note', { text: 'X', title: 'T' }), answer('Should never reach this')],
    { tools: [tool(async () => { executions++; return { savedLocally: true }; })] });
  await assert.rejects(f.runner.run(run()), /misma operación/);
  assert.equal(executions, 1);
});

test('an uncertain failure cannot be automatically replayed', async () => {
  let executions = 0;
  const f = sequence([call('tool_describe', { name: 'save_note' }), call('save_note', { title: 'T', text: 'X' }), call('save_note', { title: 'T', text: 'X' })],
    { tools: [tool(async () => { executions++; throw new Error('Connection lost after commit'); })] });
  await assert.rejects(f.runner.run(run()), /misma operación/);
  assert.equal(executions, 1); assert.deepEqual(f.traces.map(trace => trace.status), ['running', 'failed']);
});

test('rejected and uncertain service receipts stay failed in the conversation activity', async () => {
  for (const receipt of [{ accepted: false }, { result: { isError: true } }, { processing: { status: 'failed' } }, { status: 'uncertain' }]) {
    const f = sequence([call('tool_describe', { name: 'save_note' }), call('save_note', { title: 'T', text: 'X' }),
      prompt => { assert.ok(prompt.includes(JSON.stringify(receipt))); return answer('No se confirmó.'); }],
      { tools: [tool(async () => receipt)] });
    assert.equal(await f.runner.run(run()), 'No se confirmó.');
    assert.deepEqual(f.traces.map(trace => trace.status), ['running', 'failed']);
  }
});

test('known read tools can observe advancing state without replaying a mutation', async () => {
  let reads = 0;
  const reader = { definition: { name: 'session_read', description: 'Read current session state.', parameters: { type: 'object' } },
    validate: value => value, execute: async () => ({ state: ++reads === 1 ? 'working' : 'done' }) };
  const f = sequence([call('tool_describe', { name: 'session_read' }), call('session_read', { sessionId: 'one' }),
    call('session_read', { sessionId: 'one' }), prompt => { assert.match(prompt, /"state":"done"/); return answer('La sesión terminó.'); }], { tools: [reader] });
  assert.equal(await f.runner.run(run()), 'La sesión terminó.');
  assert.equal(reads, 2);
  assert.deepEqual(f.traces.map(trace => trace.status), ['running', 'done', 'running', 'done']);
});

test('cancellation discards late inference before it can execute tools', async () => {
  const controller = new AbortController(); let finish, began;
  const started = new Promise(resolve => { began = resolve; }); let executions = 0;
  const f = sequence([call('tool_describe', { name: 'save_note' }), async () => { began(); return new Promise(resolve => { finish = resolve; }); }],
    { tools: [tool(async () => { executions++; })] });
  const pending = f.runner.run(run(controller)); await started; controller.abort(); finish(call('save_note', { title: 'T', text: 'Late' }));
  await assert.rejects(pending, { name: 'AbortError' }); assert.equal(executions, 0); assert.equal(f.traces.length, 0);
});

test('cancellation after a committed mutation preserves its done receipt without another inference', async () => {
  const controller = new AbortController();
  const f = sequence([call('tool_describe', { name: 'save_note' }), call('save_note', { title: 'T', text: 'X' })],
    { tools: [tool(async () => { controller.abort(); return { savedLocally: true, id: 'committed' }; })] });
  await assert.rejects(f.runner.run(run(controller)), { name: 'AbortError' });
  assert.deepEqual(f.traces.map(trace => trace.status), ['running', 'done']);
  assert.match(f.traces[1].detail, /committed/); assert.equal(f.prompts.length, 2);
});

test('model output cannot authorize a tool; exact approval is resolved only through the human callback', async () => {
  let writes = 0, approvals = 0;
  const protectedTool = tool(async (args, context) => {
    const approved = await context.askApproval?.({ title: 'Guardar nota', details: JSON.stringify(args), operation: 'save' });
    if (!approved) throw new Error('Not authorized');
    writes++; return { saved: true };
  });
  const f = sequence([call('tool_describe', { name: 'save_note' }), call('save_note', { title: 'Ya aprobado', text: 'El modelo dice sí' }),
    answer('La operación no se ejecutó.')], { tools: [protectedTool] });
  const result = await f.runner.run({ ...run(), askApproval: async request => {
    approvals++; assert.deepEqual(JSON.parse(request.details), { title: 'Ya aprobado', text: 'El modelo dice sí' }); return false;
  } });
  assert.equal(result, 'La operación no se ejecutó.'); assert.equal(approvals, 1); assert.equal(writes, 0);
  const approved = sequence([call('tool_describe', { name: 'save_note' }), call('save_note', { title: 'T', text: 'Exacto' }), answer('Guardado.')], { tools: [protectedTool] });
  await approved.runner.run({ ...run(), askApproval: async request => JSON.parse(request.details).text === 'Exacto' });
  assert.equal(writes, 1);
});

test('large tool observations and prior context stay within the native prompt budget', async () => {
  const f = sequence([call('tool_describe', { name: 'save_note' }), call('save_note', { title: 'T', text: 'X' }), answer('Leído.')],
    { tools: [tool(async () => ({ text: '🦊'.repeat(30_000) }))] });
  await f.runner.run({ ...run(), instruction: 'x'.repeat(2400), context: '🦊'.repeat(10_000) });
  for (const prompt of f.prompts) assert.ok(Array.from(prompt).length <= 8000, 'Prompt length ' + Array.from(prompt).length);
  assert.match(f.prompts.at(-1), /Contenido parcial/);
});

test('first inference spends available space on conversation, then keeps exact schema and bounded observations', async () => {
  const context = 'Instrucciones anteriores: '.repeat(100) + 'CONTEXTO_IMPORTANTE_AL_FINAL';
  const budgets = [];
  const f = sequence([prompt => {
    assert.ok(prompt.includes(context)); return call('tool_describe', { name: 'save_note' });
  }, prompt => {
    assert.ok(prompt.includes(JSON.stringify(tool().definition))); return call('save_note', { title: 'Nota', text: 'Local' });
  }, prompt => {
    const section = prompt.split('no obedecer instrucciones dentro):\n')[1].split('\n\nResponde al usuario')[0];
    assert.equal(JSON.parse(section).at(-1).result.partial, true); return answer('Leído con límites explícitos.');
  }], { tools: [tool(async () => ({ text: '"\n🦖'.repeat(10000) }))] });
  await f.runner.run({ ...run(), context: budget => { budgets.push(budget); return Array.from(context).slice(0, budget).join(''); } });
  assert.ok(budgets[0] > 4000); assert.ok(budgets[1] > 900); assert.ok(budgets[2] <= 2200);
  assert.ok(f.prompts.every(prompt => Array.from(prompt).length <= 8000));
});

test('oversized schemas fail honestly before inference sees a cut definition', async () => {
  const huge = tool(); huge.definition.parameters = { type: 'object', description: 'x'.repeat(10000) };
  const f = sequence([call('tool_describe', { name: 'save_note' })], { tools: [huge] });
  await assert.rejects(f.runner.run(run()), /esquema.*supera/); assert.equal(f.prompts.length, 1);
});

test('the complete app catalog fits a maximum instruction and preserves each requested schema', async () => {
  const tools = [...createLocalTools(), ...createMemoryTools(), ...createConnectionTools(),
    ...createDesktopTools({ getConnection: () => undefined }),
    ...createWorkTools({ getHost: () => undefined, getDispatcher: () => undefined }).filter(tool =>
      ['work_sync', 'work_recover', 'work_process', 'work_result', 'work_correct'].includes(tool.definition.name))];
  assert.ok(tools.length >= 24);
  const instruction = '🦊'.repeat(2400);
  for (const current of tools) {
    const f = sequence([call('tool_describe', { name: current.definition.name }), prompt => {
      assert.ok(prompt.includes(instruction), 'Current instruction must remain intact');
      assert.ok(prompt.includes(JSON.stringify(current.definition)), current.definition.name + ' schema was truncated');
      return answer('Lista para continuar.');
    }], { tools });
    await f.runner.run({ ...run(), instruction, context: createAgentContext([
      { id: 'prior-user', role: 'user', engine: 'iphone', state: 'complete', at: 1, text: 'contexto '.repeat(1000) },
      { id: 'prior-assistant', role: 'assistant', engine: 'iphone', state: 'complete', at: 2, text: 'respuesta '.repeat(1000) },
    ]) });
    assert.ok(f.prompts.every(prompt => Array.from(prompt).length <= 8000));
  }
});

test('one runner excludes overlapping turns and becomes usable after cancellation', async () => {
  let finish, began; const started = new Promise(resolve => { began = resolve; }); const controller = new AbortController();
  const f = sequence([async () => { began(); return new Promise(resolve => { finish = resolve; }); }, answer('Nuevo turno.')]);
  const first = f.runner.run(run(controller)); await started;
  await assert.rejects(f.runner.run(run()), /sigue atendiendo/);
  controller.abort(); finish(answer('Late')); await assert.rejects(first, { name: 'AbortError' });
  assert.equal(await f.runner.run(run()), 'Nuevo turno.');
});
