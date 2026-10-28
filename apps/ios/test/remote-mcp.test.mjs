import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { discoverMCPTools, parseMCPResponse, validateMCPArguments, canonicalJSON } from '../src/remote-mcp.ts';
import { validEndpoint, validateConnection } from '../src/external-connections.ts';

const id = 'e5e3f759-62cb-44e7-a1bd-4912012aa961';
const base = () => ({ id, kind: 'mcp', label: 'Servidor propio', endpoint: 'https://tools.example/mcp', revision: 1, enabled: true, createdAt: 1, updatedAt: 1 });
const schema = () => ({ type: 'object', properties: { text: { type: 'string', minLength: 1, maxLength: 100 } }, required: ['text'], additionalProperties: false });
const remote = () => ({ name: 'custom.send', description: 'Envía al servicio configurado', inputSchema: schema() });
function fixture() {
  const calls = []; const journal = []; let connection = base(); let changedSchema = false; let failCall = false; let token = 'secret-stays-in-headers';
  const services = {
    getConnection: async () => connection,
    token: async () => token,
    hash: async text => createHash('sha256').update(text).digest('hex'),
    begin: async value => { if (journal.some(entry => entry.fingerprint === value.fingerprint && entry.state !== 'succeeded')) throw new Error('uncertain replay blocked'); journal.push({ ...value }); },
    finish: async (requestId, state, resultJSON) => { const entry = journal.find(item => item.requestId === requestId); assert.equal(entry.state, 'executing'); entry.state = state; entry.resultJSON = resultJSON; },
    request: async request => {
      const rpc = JSON.parse(request.body); calls.push({ ...request, rpc });
      if (rpc.method === 'notifications/initialized') return { status: 202, headers: {}, body: '' };
      let result;
      if (rpc.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
      if (rpc.method === 'tools/list') result = { tools: [{ ...remote(), ...(changedSchema ? { inputSchema: { ...schema(), additionalProperties: true } } : {}) }] };
      if (rpc.method === 'tools/call') { if (failCall) throw new Error('network'); assert.equal(journal.at(-1).state, 'executing'); result = { content: [{ type: 'text', text: 'Confirmado' }] }; }
      return { status: 200, headers: { 'content-type': 'application/json', ...(rpc.method === 'initialize' ? { 'mcp-session-id': 'session-123' } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }) };
    },
  };
  return { services, calls, journal, changeSchema: () => { changedSchema = true; },
    changeConnection: () => {
      connection = { ...connection, revision: connection.revision + 1, credentialAccount: '00000000-0000-4000-8000-000000000002' };
      token = 'test-next';
    }, failCall: () => { failCall = true; }, recover: () => { failCall = false; } };
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
test('MCP initialization and tool call retain session, protocol, exact approval and durable ordering', async () => {
  const f = fixture(); const [tool] = await discoverMCPTools(id, f.services);
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
