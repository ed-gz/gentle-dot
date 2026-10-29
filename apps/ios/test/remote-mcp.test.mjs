import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { discoverMCPTools, parseMCPResponse, validateMCPArguments, canonicalJSON } from '../src/remote-mcp.ts';
import { validEndpoint, validateConnection } from '../src/external-connections.ts';

const id = 'e5e3f759-62cb-44e7-a1bd-4912012aa961';
const base = () => ({ id, kind: 'mcp', label: 'Servidor propio', endpoint: 'https://tools.example/mcp', revision: 1, enabled: true, createdAt: 1, updatedAt: 1 });
const schema = () => ({ type: 'object', properties: { text: { type: 'string', minLength: 1, maxLength: 100 } }, required: ['text'], additionalProperties: false });
const remote = () => ({ name: 'custom.send', description: 'Envía al servicio configurado', inputSchema: schema() });
function fixture(version = '2025-06-18') {
  const calls = []; const journal = []; let connection = base(); let changedSchema = false; let inputSchema; let failCall = false; let token = 'secret-stays-in-headers'; let taskSupport; let outputSchema; let callResult; let batchResponses = false;
  const services = {
    prepare: async () => connection,
    getConnection: async () => connection,
    token: async () => token,
    hash: async text => createHash('sha256').update(text).digest('hex'),
    begin: async value => { if (journal.some(entry => entry.fingerprint === value.fingerprint && entry.state !== 'succeeded')) throw new Error('uncertain replay blocked'); journal.push({ ...value }); },
    finish: async (requestId, state, resultJSON) => { const entry = journal.find(item => item.requestId === requestId); assert.equal(entry.state, 'executing'); entry.state = state; entry.resultJSON = resultJSON; },
    request: async request => {
      const rpc = JSON.parse(request.body); calls.push({ ...request, rpc });
      if (rpc.method === 'notifications/initialized') return { status: 202, headers: {}, body: '' };
      let result;
      if (rpc.method === 'initialize') result = { protocolVersion: version, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
      if (rpc.method === 'tools/list') result = { tools: [{ ...remote(), ...(inputSchema === undefined ? {} : { inputSchema }), ...(changedSchema ? { inputSchema: { ...schema(), additionalProperties: true } } : {}), ...(taskSupport === undefined ? {} : { execution: { taskSupport } }), ...(outputSchema === undefined ? {} : { outputSchema }) }] };
      if (rpc.method === 'tools/call') { if (failCall) throw new Error('network'); assert.equal(journal.at(-1).state, 'executing'); result = callResult ?? { content: [{ type: 'text', text: 'Confirmado' }] }; }
      const reply = { jsonrpc: '2.0', id: rpc.id, result };
      const body = batchResponses && rpc.method !== 'initialize' ? [{ jsonrpc: '2.0', method: 'notifications/progress', params: {} }, reply] : reply;
      return { status: 200, headers: { 'content-type': 'application/json', ...(rpc.method === 'initialize' ? { 'mcp-session-id': 'session-123' } : {}) }, body: JSON.stringify(body) };
    },
  };
  return { services, calls, journal, changeSchema: () => { changedSchema = true; },
    changeConnection: () => {
      connection = { ...connection, revision: connection.revision + 1, credentialAccount: '00000000-0000-4000-8000-000000000002' };
      token = 'test-next';
    }, failCall: () => { failCall = true; }, recover: () => { failCall = false; }, setTaskSupport: value => { taskSupport = value; },
    setInputSchema: value => { inputSchema = value; }, setOutputSchema: value => { outputSchema = value; }, setCallResult: value => { callResult = value; }, setBatchResponses: value => { batchResponses = value; } };
}
const context = askApproval => ({ signal: new AbortController().signal, askApproval });

test('generic connection metadata whitelists fields and excludes URL credentials', () => {
  assert.equal(validEndpoint('https://custom.example/api/mcp?tenant=one'), 'https://custom.example/api/mcp?tenant=one');
  for (const url of ['http://x.example/mcp', 'https://u:p@x.example', 'https://x.example/?token=secret', 'https://x.example/#x', 'https://x.example/\n']) assert.throws(() => validEndpoint(url));
  const clean = validateConnection({ ...base(), accessToken: 'secret', refreshToken: 'secret' });
  assert.equal('accessToken' in clean, false); assert.equal('refreshToken' in clean, false);
});
test('JSON schema validates nested arguments, refs, bounds and rejects unsafe unsupported schemas', () => {
  assert.deepEqual(validateMCPArguments(schema(), { text: 'Hola' }), { text: 'Hola' });
  for (const args of [{}, { text: '' }, { text: 1 }, { text: 'x', another: true }]) assert.throws(() => validateMCPArguments(schema(), args));
  const nested = { type: 'object', $defs: { count: { type: 'integer', minimum: 1, maximum: 2 } }, properties: { values: { type: 'array', items: { $ref: '#/$defs/count' }, uniqueItems: true } } };
  assert.deepEqual(validateMCPArguments(nested, { values: [1, 2] }), { values: [1, 2] });
  assert.throws(() => validateMCPArguments(nested, { values: [1, 1] }));
  assert.throws(() => validateMCPArguments({ type: 'object', patternProperties: { '.*': {} } }, {}), /no compatibles/);
  assert.throws(() => canonicalJSON(JSON.parse('{"__proto__":{"x":1}}')));
});
test('unsupported combinator branches never become false matches that permit a call', () => {
  for (const combinator of ['oneOf', 'anyOf', 'allOf']) {
    const uncertain = { type: 'object', properties: { text: { [combinator]: [
      { type: 'string' }, { type: 'string', pattern: '^allowed' },
    ] } } };
    assert.throws(() => validateMCPArguments(uncertain, { text: 'allowed text' }), /no compatibles/);
  }
  const external = { type: 'object', properties: { text: { oneOf: [
    { type: 'string' }, { $ref: 'https://schemas.example/value' },
  ] } } };
  assert.throws(() => validateMCPArguments(external, { text: 'allowed text' }), /Referencias externas/);
  // Ordinary supported branches retain the expected matching behaviour.
  const supported = { type: 'object', properties: { text: { oneOf: [
    { type: 'string', maxLength: 3 }, { type: 'string', minLength: 4 },
  ] } } };
  assert.deepEqual(validateMCPArguments(supported, { text: 'allowed' }), { text: 'allowed' });
});
test('MCP initialization and tool call retain session, protocol, exact approval and durable ordering', async () => {
  const f = fixture(); const [tool] = await discoverMCPTools(id, f.services);
  assert.equal(f.calls[0].rpc.params.protocolVersion, '2025-11-25');
  assert.equal(f.calls[0].headers['MCP-Protocol-Version'], undefined);
  assert.match(tool.definition.name, /^mcp_[a-f0-9]{24}$/);
  let details;
  const result = await tool.execute({ text: 'Mensaje exacto' }, context(async approval => { details = JSON.parse(approval.details); return true; }));
  assert.equal(result.confirmed, true);
  assert.deepEqual(details.arguments, { text: 'Mensaje exacto' }); assert.equal(details.endpoint, base().endpoint); assert.deepEqual(details.schema, schema());
  assert.equal(f.calls.filter(call => call.rpc.method === 'tools/list').length, 2);
  const call = f.calls.find(call => call.rpc.method === 'tools/call');
  assert.equal(call.headers['MCP-Protocol-Version'], '2025-06-18'); assert.equal(call.headers['Mcp-Session-Id'], 'session-123');
  assert.equal(call.rpc.id, f.journal[0].requestId); assert.equal(f.journal[0].state, 'succeeded');
  assert.equal(JSON.stringify(f.journal).includes('secret-stays-in-headers'), false);
});
test('an indeterminate input branch stops before approval, journaling or network execution', async () => {
  const f = fixture();
  f.setInputSchema({ type: 'object', properties: { text: { oneOf: [
    { type: 'string' }, { type: 'string', pattern: '^valid' },
  ] } }, required: ['text'] });
  const [tool] = await discoverMCPTools(id, f.services); let reviewed = false;
  await assert.rejects(tool.execute({ text: 'valid value' }, context(async () => { reviewed = true; return true; })), /no compatibles/);
  assert.equal(reviewed, false); assert.equal(f.journal.length, 0);
  assert.equal(f.calls.some(call => call.rpc.method === 'tools/call'), false);
});
test('negotiation uses the offered supported version on every subsequent request', async () => {
  for (const version of ['2025-11-25', '2025-06-18', '2025-03-26']) {
    const f = fixture(version); const [tool] = await discoverMCPTools(id, f.services);
    assert.equal(f.calls[0].rpc.params.protocolVersion, '2025-11-25');
    await tool.execute({ text: 'Exacto' }, context(async () => true));
    for (const call of f.calls.slice(1)) {
      assert.equal(call.headers['MCP-Protocol-Version'], version);
      assert.equal(call.headers['Mcp-Session-Id'], 'session-123');
    }
    assert.equal(f.calls.filter(call => call.rpc.method === 'initialize').length, 1);
  }
});
test('unsupported versions stop after initialization without advertising readiness or calling a tool', async () => {
  for (const version of ['2026-07-28', '', null, ['2025-11-25']]) {
    const f = fixture(version);
    await assert.rejects(discoverMCPTools(id, f.services), /versión MCP no compatible/);
    assert.deepEqual(f.calls.map(call => call.rpc.method), ['initialize']);
    assert.equal(f.journal.length, 0);
  }
});
test('MCP 2025-03-26 accepts correlated batches while preserving review and journal ordering', async () => {
  const f = fixture('2025-03-26'); f.setBatchResponses(true);
  const [tool] = await discoverMCPTools(id, f.services);
  const denied = await tool.execute({ text: 'Sin autorización' }, context(async () => false));
  assert.deepEqual(denied, { executed: false, approved: false });
  assert.equal(f.journal.length, 0);
  let review;
  const result = await tool.execute({ text: 'Contenido revisado' }, context(async value => { review = JSON.parse(value.details); return true; }));
  assert.equal(result.confirmed, true); assert.deepEqual(review.arguments, { text: 'Contenido revisado' });
  assert.equal(f.journal[0].state, 'succeeded');
  assert.equal(f.calls.find(call => call.rpc.method === 'tools/call').headers['MCP-Protocol-Version'], '2025-03-26');
});
test('legacy batches are bounded, version-scoped and require a single correlated response', () => {
  const notification = { jsonrpc: '2.0', method: 'notifications/progress', params: {} };
  const response = { jsonrpc: '2.0', id: 'one', result: { value: 1 } };
  const json = body => ({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.deepEqual(parseMCPResponse(json([notification, response]), 'one', '2025-03-26'), { value: 1 });
  assert.throws(() => parseMCPResponse(json([response]), 'one', '2025-06-18'), /Lote MCP/);
  assert.throws(() => parseMCPResponse(json([response]), 'one'), /Lote MCP/);
  const initialization = { jsonrpc: '2.0', id: 'one', result: { protocolVersion: '2025-03-26', capabilities: { tools: {} } } };
  assert.equal(parseMCPResponse(json([initialization]), 'one').protocolVersion, '2025-03-26');
  assert.throws(() => parseMCPResponse(json([{ ...initialization, result: { protocolVersion: '2025-06-18' } }]), 'one'), /Lote MCP/);
  assert.throws(() => parseMCPResponse(json([]), 'one', '2025-03-26'), /Lote MCP/);
  assert.throws(() => parseMCPResponse(json([response, response]), 'one', '2025-03-26'), /duplicada/);
  assert.throws(() => parseMCPResponse(json([response, { ...response, id: 'different' }]), 'one', '2025-03-26'), /correlacionada/);
  assert.throws(() => parseMCPResponse(json([response, { jsonrpc: '2.0', id: 'server', method: 'sampling/createMessage' }]), 'one', '2025-03-26'), /sampling/);
  assert.throws(() => parseMCPResponse(json(Array.from({ length: 1001 }, () => notification)), 'one', '2025-03-26'), /Lote MCP/);
  const sse = { status: 200, headers: { 'content-type': 'text/event-stream' }, body: `data: ${JSON.stringify([notification, response])}\n\n` };
  assert.deepEqual(parseMCPResponse(sse, 'one', '2025-03-26'), { value: 1 });
});
test('required MCP tasks never execute without task support, including a change during approval', async () => {
  for (const version of ['2025-11-25', '2025-06-18']) {
    const required = fixture(version); required.setTaskSupport('required');
    const [blocked] = await discoverMCPTools(id, required.services);
    let reviewed = false;
    await assert.rejects(blocked.execute({ text: 'No ejecutar' }, context(async () => { reviewed = true; return true; })), /tareas MCP asíncronas/);
    assert.equal(reviewed, false); assert.equal(required.journal.length, 0);
    assert.equal(required.calls.some(call => call.rpc.method === 'tools/call'), false);
  }
  const changed = fixture('2025-11-25'); changed.setTaskSupport('optional');
  const [tool] = await discoverMCPTools(id, changed.services);
  await assert.rejects(tool.execute({ text: 'Revisar' }, context(async () => { changed.setTaskSupport('required'); return true; })), /cambió/);
  assert.equal(changed.journal.length, 0); assert.equal(changed.calls.some(call => call.rpc.method === 'tools/call'), false);
  for (const invalid of ['always', ['optional'], null]) {
    const f = fixture('2025-11-25'); f.setTaskSupport(invalid);
    await assert.rejects(discoverMCPTools(id, f.services), /modalidad de ejecución/);
  }
});
test('uncertain MCP 2025-11-25 tool calls remain blocked from replay', async () => {
  const f = fixture('2025-11-25'); const [tool] = await discoverMCPTools(id, f.services); f.failCall();
  await assert.rejects(tool.execute({ text: 'Sin recibo' }, context(async () => true)), /sin confirmar/);
  assert.equal(f.journal[0].state, 'uncertain');
  await assert.rejects(tool.execute({ text: 'Sin recibo' }, context(async () => true)), /replay blocked/);
  assert.equal(f.calls.filter(call => call.rpc.method === 'tools/call').length, 1);
});
test('structured results with empty content retain exact data and validate the advertised output schema', async () => {
  const f = fixture('2025-11-25');
  const output = { type: 'object', properties: { number: { type: 'integer', minimum: 0 } }, required: ['number'], additionalProperties: false };
  f.setOutputSchema(output); f.setCallResult({ content: [], structuredContent: { number: 5 } });
  const [tool] = await discoverMCPTools(id, f.services);
  let review;
  const result = await tool.execute({ text: 'Leer' }, context(async value => { review = JSON.parse(value.details); return true; }));
  assert.deepEqual(review.outputSchema, output);
  assert.deepEqual(result.result, { content: [], structuredContent: { number: 5 } });
  assert.equal(result.outputValidation, 'valid'); assert.equal(result.untrustedContent, true);
  assert.equal(f.journal[0].state, 'succeeded'); assert.deepEqual(JSON.parse(f.journal[0].resultJSON), result.result);
});
test('invalid or unsupported output schema remains an unverified correlated result without replay', async () => {
  for (const output of [
    { type: 'object', properties: { number: { type: 'integer', minimum: 10 } }, required: ['number'] },
    { type: 'object', patternProperties: { '.*': {} } },
    { type: 'object', properties: { number: { oneOf: [{ type: 'integer' }, { type: 'integer', multipleOf: 5 }] } } },
  ]) {
    const f = fixture('2025-11-25'); f.setOutputSchema(output); f.setCallResult({ content: [], structuredContent: { number: 5 } });
    const [tool] = await discoverMCPTools(id, f.services);
    const result = await tool.execute({ text: 'Leer' }, context(async () => true));
    assert.equal(result.outputValidation, 'unverified'); assert.equal(result.confirmed, true); assert.equal(result.untrustedContent, true); assert.match(result.outputWarning, /no pudo verificarse/);
    assert.equal(f.journal[0].state, 'succeeded'); assert.equal(f.calls.filter(call => call.rpc.method === 'tools/call').length, 1);
  }
});
test('changed output schema invalidates the approval before any execution', async () => {
  const f = fixture('2025-11-25'); f.setOutputSchema({ type: 'object', properties: { n: { type: 'number' } } });
  const [tool] = await discoverMCPTools(id, f.services);
  await assert.rejects(tool.execute({ text: 'Leer' }, context(async () => { f.setOutputSchema({ type: 'object', properties: { n: { type: 'string' } } }); return true; })), /cambió/);
  assert.equal(f.journal.length, 0); assert.equal(f.calls.some(call => call.rpc.method === 'tools/call'), false);
});
test('expired session after dispatch stays uncertain; fresh discovery cannot replay the operation', async () => {
  const f = fixture('2025-11-25'), request = f.services.request;
  let sent = 0;
  f.services.request = async input => {
    if (JSON.parse(input.body).method !== 'tools/call') return request(input);
    sent++; return { status: 404, headers: {}, body: '' };
  };
  const [first] = await discoverMCPTools(id, f.services);
  await assert.rejects(first.execute({ text: 'Operación original' }, context(async () => true)), /sin confirmar/);
  assert.equal(f.journal[0].state, 'uncertain'); assert.equal(sent, 1);
  const [fresh] = await discoverMCPTools(id, f.services);
  await assert.rejects(fresh.execute({ text: 'Operación original' }, context(async () => true)), /replay blocked/);
  assert.equal(sent, 1);
});
test('missing or denied human approval never executes or creates a journal entry', async () => {
  const f = fixture(); const [tool] = await discoverMCPTools(id, f.services);
  await assert.rejects(tool.execute({ text: 'Hola' }, context(undefined)), /requiere revisión/);
  assert.deepEqual(await tool.execute({ text: 'Hola' }, context(async () => false)), { executed: false, approved: false });
  assert.equal(f.journal.length, 0); assert.equal(f.calls.some(call => call.rpc.method === 'tools/call'), false);
});
test('schema or connection revision changed during review invalidates approval', async () => {
  for (const kind of ['changeSchema', 'changeConnection']) {
    const f = fixture(); const [tool] = await discoverMCPTools(id, f.services);
    await assert.rejects(tool.execute({ text: 'Hola' }, context(async () => { f[kind](); return true; })), /cambió/);
    assert.equal(f.journal.length, 0); assert.equal(f.calls.some(call => call.rpc.method === 'tools/call'), false);
  }
});
test('lost remote response persists uncertainty and blocks replay even after another approval', async () => {
  const f = fixture(); const [tool] = await discoverMCPTools(id, f.services); f.failCall();
  await assert.rejects(tool.execute({ text: 'Hola' }, context(async () => true)), /sin confirmar/);
  assert.equal(f.journal[0].state, 'uncertain');
  await assert.rejects(tool.execute({ text: 'Hola' }, context(async () => true)), /replay blocked/);
  assert.equal(f.calls.filter(call => call.rpc.method === 'tools/call').length, 1);
});
test('changed schema and rotated credentials cannot replay uncertainty; different arguments remain a new operation', async () => {
  for (const change of ['changeSchema', 'changeConnection']) {
    const f = fixture(); const [original] = await discoverMCPTools(id, f.services); f.failCall();
    await assert.rejects(original.execute({ text: 'Incierto' }, context(async () => true)), /sin confirmar/);
    const previousFingerprint = f.journal[0].fingerprint;
    f[change](); f.recover();
    const [fresh] = await discoverMCPTools(id, f.services);
    await assert.rejects(fresh.execute({ text: 'Incierto' }, context(async () => true)), /replay blocked/);
    assert.equal(f.calls.filter(call => call.rpc.method === 'tools/call').length, 1);
    const result = await fresh.execute({ text: 'Otra operación' }, context(async () => true));
    assert.equal(result.confirmed, true); assert.equal(f.journal.length, 2);
    assert.notEqual(f.journal[1].fingerprint, previousFingerprint);
    if (change === 'changeConnection') assert.equal(f.journal[1].connectionRevision, 2);
  }
});
test('finite SSE accepts correlated results but never executes server requests or redirects', () => {
  const result = { content: [{ type: 'text', text: 'Listo' }] };
  const reply = { status: 200, headers: { 'content-type': 'text/event-stream' }, body: ': heartbeat\n\nevent: message\ndata: ' + JSON.stringify({ jsonrpc: '2.0', id: 'one', result }) + '\n\n' };
  assert.deepEqual(parseMCPResponse(reply, 'one'), result);
  assert.throws(() => parseMCPResponse(reply, 'different'), /correlacionada/);
  assert.throws(() => parseMCPResponse({ ...reply, status: 302 }, 'one'));
  assert.throws(() => parseMCPResponse({ ...reply, body: 'data: {"jsonrpc":"2.0","id":"server","method":"sampling/createMessage"}\n\n' }, 'one'), /sampling/);
});
test('tools/list pagination terminates and rejects repeated cursors', async () => {
  const f = fixture(); const original = f.services.request; let pages = 0;
  f.services.request = async request => {
    const rpc = JSON.parse(request.body);
    if (rpc.method !== 'tools/list') return original(request);
    pages++;
    return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { tools: [], nextCursor: 'repeat' } }) };
  };
  await assert.rejects(discoverMCPTools(id, f.services), /Paginación/); assert.equal(pages, 2);
});
