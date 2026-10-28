import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { createMCPOAuth } from '../src/mcp-oauth.ts';
import { createMCPOAuthStore } from '../src/mcp-oauth-store.ts';
import { MCP_OAUTH_CALLBACK, validateCredentialBundle } from '../src/external-connections.ts';

const endpoint = 'https://tools.example/mcp', issuer = 'https://auth.example/';
const id = 'd5a6e456-7a93-4bcc-b006-4493c78b5b66';
const state = 's'.repeat(43), verifier = 'v'.repeat(43);
const config = { endpoint, clientId: 'public-capri' };
const token = { token_type: 'Bearer', access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 3600, scope: 'read' };
const json = body => ({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
function fixture(extra = {}) {
  const requests = [], browsers = []; let entropy = 0;
  const deps = {
    random: async () => ++entropy === 1 ? verifier : state,
    sha256: async value => createHash('sha256').update(value).digest('hex'), now: () => 100000,
    schemes: async () => ['dev.gentledot.capri.auth'], cancel: async () => {},
    authorize: async (url, scheme) => { browsers.push({ url, scheme }); return MCP_OAUTH_CALLBACK + '?code=fixture-code&state=' + state + '&iss=' + encodeURIComponent(issuer); },
    request: async request => {
      requests.push(request);
      if (request.url === endpoint) return { status: 401, headers: {}, body: '' };
      if (request.url.includes('oauth-protected-resource')) return json({ resource: endpoint, authorization_servers: [issuer], scopes_supported: ['read'] });
      if (request.url.includes('oauth-authorization-server')) return json({ issuer, authorization_endpoint: issuer + 'authorize', token_endpoint: issuer + 'token',
        response_types_supported: ['code'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], authorization_response_iss_parameter_supported: true });
      if (request.url === issuer + 'token') return json(token);
      throw new Error('unexpected endpoint');
    }, ...extra,
  };
  return { client: createMCPOAuth(deps), deps, requests, browsers };
}
const signal = () => new AbortController().signal;
test('public MCP authorization uses native browser, S256 and the exact resource; secrets remain in the credential bundle', async () => {
  const f = fixture(), result = await f.client.authorize(config, signal());
  const auth = new URL(f.browsers[0].url), form = new URLSearchParams(f.requests.at(-1).body);
  assert.equal(auth.searchParams.get('resource'), endpoint); assert.equal(form.get('resource'), endpoint);
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256'); assert.equal(form.get('code_verifier'), verifier);
  assert.equal(auth.searchParams.get('redirect_uri'), MCP_OAUTH_CALLBACK);
  assert.equal(form.get('redirect_uri'), MCP_OAUTH_CALLBACK); assert.equal(form.has('client_secret'), false);
  assert.equal(auth.searchParams.get('scope'), 'read'); assert.equal(result.accessToken, token.access_token);
  assert.equal(result.expiresAt, 3700000); assert.deepEqual(result.mcpOAuth, { resource: endpoint, issuer, tokenEndpoint: issuer + 'token' });
  assert.ok(f.requests.every(r => !('Authorization' in r.headers)));
});
test('unregistered native callback, mismatched state/issuer and cancellation cannot exchange a code', async () => {
  for (const extra of [
    { schemes: async () => [] },
    { authorize: async () => MCP_OAUTH_CALLBACK + '?code=x&state=wrong' },
    { authorize: async () => MCP_OAUTH_CALLBACK + '?code=x&state=' + state + '&iss=https%3A%2F%2Fwrong.example' },
    { authorize: async () => MCP_OAUTH_CALLBACK + '?code=x&state=' + state },
  ]) {
    const f = fixture(extra); await assert.rejects(f.client.authorize(config, signal()));
    assert.ok(!f.requests.some(r => r.url === issuer + 'token'));
  }
  const controller = new AbortController(); let cancelled = false;
  const f = fixture({ authorize: async () => { controller.abort(); return MCP_OAUTH_CALLBACK + '?code=x&state=' + state; }, cancel: async () => { cancelled = true; } });
  await assert.rejects(f.client.authorize(config, controller.signal), { name: 'AbortError' });
  assert.equal(cancelled, true); assert.ok(!f.requests.some(r => r.url === issuer + 'token'));
});
test('refresh is resource bound, must rotate, and never rediscovers a token destination', async () => {
  const f = fixture(), bundle = await f.client.authorize(config, signal());
  await assert.rejects(f.client.refresh(bundle), /rotación/);
  const calls = [];
  const next = createMCPOAuth({ ...f.deps, request: async request => { calls.push(request); return json({ ...token, refresh_token: 'fixture-rotated' }); } });
  const result = await next.refresh(bundle);
  assert.equal(calls.length, 1); assert.equal(calls[0].url, issuer + 'token');
  assert.equal(new URLSearchParams(calls[0].body).get('resource'), endpoint);
  assert.equal(result.refreshToken, 'fixture-rotated');
  assert.throws(() => validateCredentialBundle({ ...bundle, provider: 'gmail' }));
});
test('MCP store coalesces refresh, reserves before network and persists uncertainty rather than replaying it', async () => {
  let connection = { id, kind: 'mcp', label: 'Propio', endpoint, enabled: true, revision: 1, credentialAccount: id, createdAt: 1, updatedAt: 1 };
  let bundle = { ...(await fixture().client.authorize(config, signal())), expiresAt: 100001 };
  let refreshed = 0; const states = [];
  const deps = { getConnection: async () => ({ ...connection }), readSecret: async () => JSON.stringify(bundle), now: () => 100000,
    save: async (input, next, revision) => { assert.equal(revision, connection.revision); states.push(next.refreshState); bundle = next; connection = { ...connection, revision: revision + 1 }; return { ...connection }; },
    oauth: { authorize: async () => bundle, refresh: async previous => { refreshed++; assert.equal(bundle.refreshState, 'refreshing'); return { ...previous, refreshToken: 'next', expiresAt: 500000, refreshState: 'ready' }; } } };
  const store = createMCPOAuthStore(deps);
  const [a, b] = await Promise.all([store.prepare(id), store.prepare(id)]);
  assert.equal(a.revision, b.revision); assert.equal(refreshed, 1); assert.deepEqual(states, ['refreshing', 'ready']);
  bundle = { ...bundle, expiresAt: 100001 };
  const failure = createMCPOAuthStore({ ...deps, oauth: { ...deps.oauth, refresh: async () => { refreshed++; throw new Error('response lost'); } } });
  await assert.rejects(failure.prepare(id), /No se confirmó/);
  assert.equal(bundle.refreshState, 'uncertain');
  await assert.rejects(failure.prepare(id), /quedó sin confirmar/); assert.equal(refreshed, 2);
});
test('revocation while reading Keychain blocks refresh and public client credentials cannot move between MCP resources', async () => {
  const bundle = await fixture().client.authorize(config, signal());
  let connection = { id, kind: 'mcp', label: 'Propio', endpoint, enabled: true, revision: 1, credentialAccount: id, createdAt: 1, updatedAt: 1 };
  const store = createMCPOAuthStore({ getConnection: async () => ({ ...connection }),
    readSecret: async () => { connection = { ...connection, enabled: false, revision: 2 }; return JSON.stringify(bundle); },
    save: async () => { throw new Error('must not save'); } });
  await assert.rejects(store.prepare(id), /cambió/);
  await assert.rejects(store.authorizeAndSave({ ...connection, endpoint: 'https://other.example/mcp' }, config, signal(), 2), /otro destino/);
});
