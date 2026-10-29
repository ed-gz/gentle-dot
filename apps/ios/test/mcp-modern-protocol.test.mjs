import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MODERN_MCP_VERSION, MCPModernVersionUnsupported, modernMCPRequest, classifyModernDiscovery, classifyModernResult } from '../src/mcp-modern-protocol.ts';

const reply = (body, status = 200, type = 'application/json') => ({ status, headers: { 'content-type': type }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const success = (id = '1') => ({ jsonrpc: '2.0', id, result: { resultType: 'complete', supportedVersions: [MODERN_MCP_VERSION], capabilities: { tools: {} }, ttlMs: 0, cacheScope: 'private' } });
const failure = (code, id = '1') => ({ jsonrpc: '2.0', id, error: { code, message: 'fixture' } });

test('modern discovery and requests mirror version, method, name and per-request metadata without sessions', () => {
  for (const [method, params] of [['server/discover', {}], ['tools/list', { cursor: 'next' }], ['tools/call', { name: 'example.send', arguments: { text: 'hola' } }]]) {
    const request = modernMCPRequest('1', method, params), body = JSON.parse(request.body);
    assert.equal(request.method, 'POST');
    assert.equal(request.headers['MCP-Protocol-Version'], MODERN_MCP_VERSION);
    assert.equal(request.headers['Mcp-Method'], method);
    assert.equal(request.headers['Mcp-Session-Id'], undefined);
    assert.equal(request.headers['Mcp-Name'], method === 'tools/call' ? params.name : undefined);
    assert.equal(body.params._meta['io.modelcontextprotocol/protocolVersion'], MODERN_MCP_VERSION);
    assert.deepEqual(body.params._meta['io.modelcontextprotocol/clientCapabilities'], {});
    assert.equal(body.params._meta['io.modelcontextprotocol/clientInfo'].name, 'Capri iOS');
  }
});

test('modern request rejects forged metadata, arbitrary methods, invalid names, cursors and oversized payload', () => {
  for (const invoke of [
    () => modernMCPRequest('1', 'server/discover', { _meta: {} }),
    () => modernMCPRequest('1', 'unknown/method', {}),
    () => modernMCPRequest('1', 'tools/list', { cursor: '' }),
    () => modernMCPRequest('1', 'tools/list', { cursor: 'x'.repeat(2049) }),
    () => modernMCPRequest('1', 'tools/call', { name: 'unsafe\nheader', arguments: {} }),
    () => modernMCPRequest('1', 'tools/call', { name: 'tool', arguments: { text: 'x'.repeat(65536) } }),
    () => modernMCPRequest('1', 'tools/call', { name: 'tool', arguments: {}, inputResponses: {} }),
  ]) assert.throws(invoke);
});

test('modern discovery validates result, capabilities and correlation for JSON and finite SSE', () => {
  assert.equal(classifyModernDiscovery(reply(success()), '1'), 'modern');
  assert.equal(classifyModernDiscovery(reply(`data: ${JSON.stringify(success())}\n\n`, 200, 'text/event-stream'), '1'), 'modern');
  for (const value of [
    success('different'),
    { ...success(), result: { ...success().result, supportedVersions: ['2025-11-25'] } },
    { ...success(), result: { ...success().result, capabilities: {} } },
    { ...success(), result: { ...success().result, resultType: 'input_required' } },
    { ...success(), result: { ...success().result, resultType: 'other' } },
  ]) assert.throws(() => classifyModernDiscovery(reply(value), '1'));
  assert.throws(() => classifyModernDiscovery(reply('x'.repeat(2 * 1024 * 1024 + 1)), '1'));
});

test('only explicit legacy 400 outcomes can fall back; modern errors and auth never downgrade', () => {
  assert.throws(() => classifyModernDiscovery(reply('', 400), '1'), /no identificó/);
  for (const code of [-32600, -32601]) assert.equal(classifyModernDiscovery(reply(failure(code), 400), '1'), 'legacy');
  for (const code of [-32020, -32021, -32022, -32602, -32603]) assert.throws(() => classifyModernDiscovery(reply(failure(code), 400), '1'));
  for (const status of [401, 403, 404, 405, 500]) assert.throws(() => classifyModernDiscovery(reply('', status), '1'));
  for (const body of ['not-json', JSON.stringify(failure(-32601, 'other')), JSON.stringify({ jsonrpc: '2.0', id: '1', error: { code: '-32601' } })])
    assert.throws(() => classifyModernDiscovery(reply(body, 400), '1'));
  const offer = { jsonrpc: '2.0', id: '1', error: { code: -32022, message: 'unsupported', data: { requested: MODERN_MCP_VERSION, supported: ['2025-11-25'] } } };
  assert.throws(() => classifyModernDiscovery(reply(offer, 400), '1'), error => error instanceof MCPModernVersionUnsupported && error.supportedVersions[0] === '2025-11-25');
  assert.throws(() => classifyModernDiscovery(reply({...offer, error: {...offer.error, data: { requested: 'wrong', supported: ['2025-11-25'] } }}, 400), '1'), /Contraoferta/);
  // A 200 with a method-not-found error is intentionally not assumed to be
  // legacy: supporting it requires an explicit era decision by the caller.
  assert.throws(() => classifyModernDiscovery(reply(failure(-32601)), '1'));
});

test('intermediate MRTR is distinct from completed result, and unknown result types fail closed', () => {
  assert.equal(classifyModernResult({ resultType: 'complete', content: [] }), 'complete');
  assert.throws(() => classifyModernResult({ content: [] }));
  assert.equal(classifyModernResult({ resultType: 'input_required', inputRequests: {} }), 'input_required');
  for (const result of [null, [], { resultType: 'pending' }, { resultType: null }]) assert.throws(() => classifyModernResult(result));
});
