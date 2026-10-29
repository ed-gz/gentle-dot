import assert from 'node:assert/strict';
import { test } from 'node:test';
import { discoverMCPAuthorization, mcpChallenge, mcpScopes } from '../src/mcp-oauth-discovery.ts';

const resource = 'https://tools.example/team/mcp';
const issuer = 'https://login.example/tenant';
const metadata = { resource, authorization_servers: [issuer], scopes_supported: ['read', 'write'] };
const server = { issuer, authorization_endpoint: issuer + '/authorize', token_endpoint: issuer + '/token',
  response_types_supported: ['code'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] };
const json = body => ({ status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(body) });
const missing = { status: 404, headers: {}, body: '' };
const signal = () => new AbortController().signal;
function fixture(overrides = {}) {
  const calls = [];
  const replies = {
    [resource]: { status: 401, headers: { 'www-authenticate': 'Bearer resource_metadata="https://tools.example/resource.json", scope="files:read"' }, body: '' },
    'https://tools.example/resource.json': json(metadata),
    'https://login.example/.well-known/oauth-authorization-server/tenant': json(server), ...overrides,
  };
  const request = async request => { calls.push(request); return replies[request.url] ?? missing; };
  return { calls, request };
}

test('MCP discovery follows the challenged resource and issuer with no existing credential', async () => {
  const f = fixture();
  const found = await discoverMCPAuthorization(resource, signal(), f.request);
  assert.deepEqual(found, { resource, issuer, authorizationEndpoint: server.authorization_endpoint,
    tokenEndpoint: server.token_endpoint, scopes: ['files:read'], responseIssuerRequired: false });
  assert.equal(f.calls.length, 3);
  assert.equal(JSON.parse(f.calls[0].body).method, 'initialize');
  assert.ok(f.calls.every(call => !Object.hasOwn(call.headers, 'Authorization')));
  assert.equal(f.calls[1].method, 'GET');
});

test('modern-only protected MCP can issue an OAuth challenge after a validated discovery probe', async () => {
  const f = fixture();
  const request = async input => {
    if (input.url === resource && JSON.parse(input.body).method === 'initialize') {
      f.calls.push(input);
      return {status:400, headers:{'content-type':'application/json'}, body:JSON.stringify({jsonrpc:'2.0',id:'capri-oauth-discovery',error:{code:-32020,message:'headers'}})};
    }
    if (input.url === resource) {
      assert.equal(input.headers['Mcp-Method'], 'server/discover');
      assert.equal(input.headers['MCP-Protocol-Version'], '2026-07-28');
      assert.equal(JSON.parse(input.body).params._meta['io.modelcontextprotocol/protocolVersion'], '2026-07-28');
    }
    return f.request(input);
  };
  const found = await discoverMCPAuthorization(resource, signal(), request);
  assert.deepEqual(found.scopes, ['files:read']);
  assert.deepEqual(f.calls.slice(0,2).map(call => JSON.parse(call.body).method), ['initialize','server/discover']);
  assert.ok(f.calls.every(call => !Object.hasOwn(call.headers, 'Authorization')));
});

test('modern OAuth probe refuses ambiguous errors, mismatched IDs and server failures without bypassing authorization', async () => {
  for (const response of [
    {status:400, headers:{}, body:''},
    {status:400, headers:{}, body:JSON.stringify({jsonrpc:'2.0',id:'other',error:{code:-32020,message:'headers'}})},
    {status:500, headers:{}, body:''},
  ]) {
    let calls = 0;
    await assert.rejects(discoverMCPAuthorization(resource, signal(), async () => { calls++; return response; }));
    assert.equal(calls,1);
  }
});

test('resource path/root and OAuth/OIDC discovery fall back in documented order', async () => {
  const f = fixture({
    [resource]: { status: 405, headers: {}, body: '' },
    'https://tools.example/.well-known/oauth-protected-resource': json(metadata),
    'https://login.example/.well-known/oauth-authorization-server/tenant': missing,
    'https://login.example/tenant/.well-known/openid-configuration': json(server),
  });
  const result = await discoverMCPAuthorization(resource, signal(), f.request);
  assert.deepEqual(result.scopes, ['read', 'write']);
  assert.deepEqual(f.calls.slice(1).map(call => call.url), [
    'https://tools.example/.well-known/oauth-protected-resource/team/mcp',
    'https://tools.example/.well-known/oauth-protected-resource',
    'https://login.example/.well-known/oauth-authorization-server/tenant',
    'https://login.example/.well-known/openid-configuration/tenant',
    'https://login.example/tenant/.well-known/openid-configuration',
  ]);
});

test('challenge parser separates schemes and quoted commas; rejects ambiguous or malformed challenges', () => {
  assert.deepEqual(mcpChallenge('Basic realm="hello, there", resource_metadata="https://wrong.example", Bearer scope = "read write", resource_metadata="https://tools.example/meta"'),
    { metadata: 'https://tools.example/meta', scopes: ['read', 'write'] });
  assert.deepEqual(mcpChallenge('Basic realm="hi"'), {});
  assert.deepEqual(mcpChallenge('Bearer'), {});
  assert.deepEqual(mcpChallenge('Bearer scope=""'), { scopes: [] });
  for (const challenge of ['Bearer scope="read", scope="write"', 'Bearer, Bearer scope="read"', 'Bearer scope="unterminated',
    'Bearer scope="read"\r\nx: y', 'Bearer resource_metadata="http://insecure.example"', 'Bearer scope="read",, error="invalid_token"']) {
    assert.throws(() => mcpChallenge(challenge), undefined, challenge);
  }
  for (const scopes of [[''], ['with space'], ['a\\b'], ['a"b'], [12], Array(51).fill('read')]) assert.throws(() => mcpScopes(scopes));
});

test('wrong resources, issuer substitution, confidential-only clients and missing PKCE fail closed', async () => {
  for (const bad of [{ ...metadata, resource: 'https://other.example/mcp' }, { ...metadata, authorization_servers: ['http://login.example'] },
    { ...metadata, authorization_servers: [] }, { ...metadata, authorization_servers: [issuer + '?tenant=evil'] }]) {
    const f = fixture({ 'https://tools.example/resource.json': json(bad) });
    await assert.rejects(discoverMCPAuthorization(resource, signal(), f.request));
    assert.equal(f.calls.length, 2);
  }
  for (const bad of [{ ...server, issuer: 'https://other.example' }, { ...server, code_challenge_methods_supported: ['plain'] },
    { ...server, token_endpoint_auth_methods_supported: ['client_secret_basic'] }, { ...server, response_types_supported: ['token'] },
    { ...server, token_endpoint: 'https://login.example/token?client_secret=no' }]) {
    const f = fixture({ 'https://login.example/.well-known/oauth-authorization-server/tenant': json(bad) });
    await assert.rejects(discoverMCPAuthorization(resource, signal(), f.request));
    assert.equal(f.calls.length, 3);
  }
});

test('discovery never bypasses malformed metadata, redirects, server failures or cancellation', async () => {
  for (const response of [{ status: 302, headers: { location: 'https://evil.example' }, body: '' },
    { status: 500, headers: {}, body: '' }, json({}), { ...json(metadata), body: 'x'.repeat(65537) },
    { ...json(metadata), headers: { 'content-type': 'text/html' } }]) {
    const f = fixture({ 'https://tools.example/resource.json': response });
    await assert.rejects(discoverMCPAuthorization(resource, signal(), f.request));
    assert.equal(f.calls.length, 2);
  }
  const controller = new AbortController(), f = fixture();
  await assert.rejects(discoverMCPAuthorization(resource, controller.signal, async request => {
    const reply = await f.request(request); controller.abort(); return reply;
  }), { name: 'AbortError' });
  assert.equal(f.calls.length, 1);
});
