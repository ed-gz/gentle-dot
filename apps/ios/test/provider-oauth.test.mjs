import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createProviderOAuth, validateOAuthConfig, oauthCallbackCode } from '../src/provider-oauth.ts';
import { createProviderOAuthStore } from '../src/provider-oauth-store.ts';

const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const state = 's'.repeat(43);
const slack = { provider: 'slack', clientId: '123.456', redirectUri: 'capri-auth://oauth/slack', scopes: ['chat:write'] };
const google = { provider: 'gmail', clientId: '123-test.apps.googleusercontent.com', redirectUri: 'com.googleusercontent.apps.123-test:/oauth2redirect/google', scopes: ['https://www.googleapis.com/auth/gmail.send'] };
const github = { provider: 'github', clientId: 'test-client-123', scopes: ['read:user'] };
const signal = () => new AbortController().signal;
const response = body => ({ status: 200, headers: {}, body: JSON.stringify(body) });
const hash = async value => Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))).toString('hex');
const slackToken = () => ({ ok: true, authed_user: { access_token: 'fake-access', refresh_token: 'fake-refresh', expires_in: 43200, token_type: 'user', scope: 'chat:write' } });
function pkceFixture(config = slack, token = slackToken()) {
  let random = 0; const requests = [], browser = [];
  const deps = {
    random: async () => ++random === 1 ? verifier : state,
    sha256: hash, now: () => 100000,
    authorize: async (url, scheme) => { browser.push({ url, scheme }); return config.redirectUri + '?code=fake-code&state=' + state; },
    request: async request => { requests.push(request); return response(token); },
    cancel: async () => {},
  };
  return { deps, requests, browser, client: () => createProviderOAuth(deps) };
}

test('Slack public PKCE uses the RFC S256 challenge, user scopes, exact callback and no client secret', async () => {
  const f = pkceFixture();
  const bundle = await f.client().authorize(slack, signal());
  const url = new URL(f.browser[0].url);
  assert.equal(url.origin + url.pathname, 'https://slack.com/oauth/v2/authorize');
  assert.equal(url.searchParams.get('code_challenge'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  assert.equal(url.searchParams.get('scope'), '');
  assert.equal(url.searchParams.get('user_scope'), 'chat:write');
  assert.equal(url.searchParams.get('state'), state);
  assert.equal(f.browser[0].scheme, 'capri-auth');
  const form = new URLSearchParams(f.requests[0].body);
  assert.equal(form.get('code_verifier'), verifier); assert.equal(form.has('client_secret'), false);
  assert.equal(f.requests[0].url, 'https://slack.com/api/oauth.v2.access');
  assert.deepEqual(bundle, { provider: 'slack', clientId: slack.clientId, redirectUri: slack.redirectUri, accessToken: 'fake-access',
    refreshToken: 'fake-refresh', expiresAt: 43300000, scopes: ['chat:write'], obtainedAt: 100000, refreshState: 'ready' });
});

test('Google requires an iOS reversed client scheme and exchanges without a confidential secret', async () => {
  const f = pkceFixture(google, { access_token: 'fake-google', refresh_token: 'fake-google-refresh', token_type: 'Bearer', expires_in: 3600, scope: google.scopes.join(' ') });
  const result = await f.client().authorize(google, signal());
  assert.equal(result.provider, 'gmail');
  const url = new URL(f.browser[0].url);
  assert.equal(url.searchParams.get('access_type'), 'offline'); assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(f.requests[0].url, 'https://oauth2.googleapis.com/token');
  assert.equal(new URLSearchParams(f.requests[0].body).has('client_secret'), false);
  assert.throws(() => validateOAuthConfig({ ...google, redirectUri: 'capri-auth://oauth/google' }));
  assert.throws(() => validateOAuthConfig({ ...google, scopes: ['https://www.googleapis.com/auth/cloud-platform'] }));
  assert.throws(() => validateOAuthConfig({ ...slack, scopes: ['commands'] }));
});

test('forged, duplicate and wrong-target callbacks never reach the token endpoint', async () => {
  for (const callback of [
    slack.redirectUri + '?code=x&state=wrong',
    slack.redirectUri + '?code=x&state=' + state + '&state=' + state,
    slack.redirectUri + '?code=x&code=y&state=' + state,
    'capri-auth://oauth/other?code=x&state=' + state,
    slack.redirectUri + '?code=x&state=' + state + '#access_token=evil',
    slack.redirectUri + '?error=access_denied&state=' + state,
  ]) {
    assert.throws(() => oauthCallbackCode(callback, slack.redirectUri, state));
    const f = pkceFixture(); f.deps.authorize = async () => callback;
    await assert.rejects(f.client().authorize(slack, signal()));
    assert.equal(f.requests.length, 0);
  }
});

test('cancelling browser authorization rejects a late callback without exchanging its code', async () => {
  const f = pkceFixture(); const controller = new AbortController();
  let release, began; const started = new Promise(resolve => { began = resolve; }); let cancelled = 0;
  f.deps.authorize = async () => { began(); return new Promise(resolve => { release = resolve; }); };
  f.deps.cancel = async () => { cancelled++; };
  const waiting = f.client().authorize(slack, controller.signal);
  await started; controller.abort(); release(slack.redirectUri + '?code=x&state=' + state);
  await assert.rejects(waiting, { name: 'AbortError' });
  assert.equal(cancelled, 1); assert.equal(f.requests.length, 0);
});

test('GitHub device flow respects pending/slow_down and reveals only the human code', async () => {
  let now = 100000; const waits = [], requests = [], displayed = [];
  const replies = [
    { device_code: 'fake-device-secret', user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 },
    { error: 'authorization_pending' }, { error: 'slow_down' },
    { access_token: 'fake-github', token_type: 'bearer', scope: 'read:user' },
  ];
  const client = createProviderOAuth({ now: () => now,
    sleep: async milliseconds => { waits.push(milliseconds); now += milliseconds; },
    request: async request => { requests.push(request); return response(replies.shift()); } });
  const bundle = await client.authorize(github, signal(), value => { displayed.push(value); });
  assert.equal(bundle.accessToken, 'fake-github');
  assert.deepEqual(waits, [5000, 5000, 10000]);
  assert.deepEqual(displayed, [{ userCode: 'ABCD-EFGH', verificationUri: 'https://github.com/login/device', expiresAt: 1000000 }]);
  assert.ok(requests.every(request => !new URLSearchParams(request.body).has('client_secret')));
  assert.equal(new URLSearchParams(requests[1].body).get('grant_type'), 'urn:ietf:params:oauth:grant-type:device_code');
});

test('device approval uses only GitHub official verification URL and cancellation stops polling', async () => {
  for (const badURL of ['https://evil.example/login/device', 'https://github.com.evil.test/login/device']) {
    let requests = 0;
    const client = createProviderOAuth({ request: async () => { requests++; return response({ device_code: 'x', user_code: 'ABCD-EFGH', verification_uri: badURL, expires_in: 900, interval: 5 }); } });
    await assert.rejects(client.authorize(github, signal(), () => { assert.fail('Unexpected display'); }));
    assert.equal(requests, 1);
  }
  let requests = 0; const controller = new AbortController();
  const client = createProviderOAuth({ request: async () => { requests++; return response({ device_code: 'x', user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 }); } });
  await assert.rejects(client.authorize(github, controller.signal, () => controller.abort()), { name: 'AbortError' });
  assert.equal(requests, 1);
});

test('refresh sends one public-client request and requires rotated Slack credentials', async () => {
  const f = pkceFixture();
  const original = { provider: 'slack', clientId: slack.clientId, redirectUri: slack.redirectUri, scopes: ['chat:write'], accessToken: 'old', refreshToken: 'old-refresh', expiresAt: 1000 };
  f.deps.request = async request => { f.requests.push(request); return response({ ok: true, token_type: 'user', access_token: 'new', refresh_token: 'new-refresh', expires_in: 43200, scope: 'chat:write' }); };
  const refreshed = await f.client().refresh(original);
  assert.equal(refreshed.refreshToken, 'new-refresh');
  const form = new URLSearchParams(f.requests[0].body);
  assert.equal(form.get('grant_type'), 'refresh_token'); assert.equal(form.has('code_verifier'), false); assert.equal(form.has('client_secret'), false);
  f.deps.request = async () => response({ ok: true, token_type: 'user', access_token: 'new', expires_in: 43200 });
  await assert.rejects(f.client().refresh(original), /rotatorias/);
  const googleFixture = pkceFixture(google);
  googleFixture.deps.request = async () => response({ access_token: 'new-google', token_type: 'Bearer', expires_in: 3600 });
  assert.equal((await googleFixture.client().refresh({ ...original, provider: 'gmail', clientId: google.clientId, redirectUri: google.redirectUri, scopes: google.scopes })).refreshToken, 'old-refresh');
});

test('refresh preserves provider-normalized prior grants without requesting additional scopes', async () => {
  const requests = [];
  const client = createProviderOAuth({ now: () => 100000, request: async request => {
    requests.push(request);
    return response({ access_token: 'new-access', refresh_token: 'new-refresh', token_type: 'bearer', expires_in: 3600 });
  } });
  const result = await client.refresh({ provider: 'github', clientId: github.clientId, accessToken: 'old', refreshToken: 'old-refresh',
    scopes: ['repo', 'user'], expiresAt: 1000 });
  assert.deepEqual(result.scopes, ['repo', 'user']);
  assert.equal(new URLSearchParams(requests[0].body).has('scope'), false);
  assert.throws(() => validateOAuthConfig({ ...github, scopes: ['user'] }));
});

function vaultFixture() {
  let connection = { id: 'connection-1', kind: 'https-api', provider: 'slack', label: 'Slack', endpoint: 'https://slack.com/api/', revision: 1, enabled: true, credentialAccount: 'account-1', createdAt: 1, updatedAt: 1 };
  const records = new Map([['account-1', { provider: 'slack', clientId: slack.clientId, redirectUri: slack.redirectUri, scopes: ['chat:write'],
    accessToken: 'old-token', refreshToken: 'old-refresh', expiresAt: 1000, obtainedAt: 1, refreshState: 'ready' }]]);
  let refreshes = 0; const saved = [];
  const deps = {
    getConnection: async id => id === connection.id ? structuredClone(connection) : null,
    readSecret: async account => records.has(account) ? JSON.stringify(records.get(account)) : null,
    now: () => 100000,
    save: async (input, bundle, expected) => {
      assert.equal(expected, connection.revision, 'CAS revision mismatch');
      const account = 'account-' + (connection.revision + 1);
      records.set(account, structuredClone(bundle)); saved.push(structuredClone(bundle));
      connection = { ...connection, ...input, revision: connection.revision + 1, credentialAccount: account };
      return structuredClone(connection);
    },
    oauth: {
      authorize: async () => ({ ...records.get('account-1'), expiresAt: 900000, accessToken: 'signed-in' }),
      refresh: async previous => { refreshes++; return { ...previous, accessToken: 'new-token', refreshToken: 'new-refresh', expiresAt: 900000, refreshState: 'ready' }; },
    },
  };
  return { deps, records, saved, connection: () => connection, refreshes: () => refreshes, store: () => createProviderOAuthStore(deps) };
}

test('Keychain refresh is reserved by CAS once, shared concurrently and returns the new metadata revision', async () => {
  const f = vaultFixture(); const store = f.store();
  const [one, two] = await Promise.all([store.getValidProviderAccess('connection-1'), store.getValidProviderAccess('connection-1')]);
  assert.equal(f.refreshes(), 1);
  assert.deepEqual(f.saved.map(bundle => bundle.refreshState), ['refreshing', 'ready']);
  assert.equal(one.connection.revision, 3); assert.equal(two.connection.revision, 3);
  assert.equal(one.accessToken, 'new-token');
  assert.equal(Object.hasOwn(one.connection, 'accessToken'), false);
  assert.equal((await store.getValidProviderAccess('connection-1')).accessToken, 'new-token');
  assert.equal(f.refreshes(), 1);
});

test('an uncertain refresh persists and is never repeated after service restart', async () => {
  const f = vaultFixture(); let attempts = 0;
  f.deps.oauth.refresh = async () => { attempts++; throw new Error('Lost response after server rotated token'); };
  await assert.rejects(f.store().getValidProviderAccess('connection-1'), /No se confirmó/);
  assert.deepEqual(f.saved.map(bundle => bundle.refreshState), ['refreshing', 'uncertain']);
  await assert.rejects(f.store().getValidProviderAccess('connection-1'), /no se repetirá/);
  assert.equal(attempts, 1);
});

test('independent callers cannot both claim the same rotating refresh token', async () => {
  const f = vaultFixture();
  const results = await Promise.allSettled([f.store().getValidProviderAccess('connection-1'), f.store().getValidProviderAccess('connection-1')]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(f.refreshes(), 1);
  assert.deepEqual(f.saved.map(bundle => bundle.refreshState), ['refreshing', 'ready']);
});

test('cancelling an access caller after refresh starts still preserves the rotated Keychain credential', async () => {
  const f = vaultFixture(); const controller = new AbortController();
  f.deps.oauth.refresh = async previous => {
    controller.abort();
    return { ...previous, accessToken: 'new-after-cancel', refreshToken: 'rotated-after-cancel', expiresAt: 900000, refreshState: 'ready' };
  };
  await assert.rejects(f.store().getValidProviderAccess('connection-1', controller.signal), { name: 'AbortError' });
  assert.deepEqual(f.saved.map(bundle => bundle.refreshState), ['refreshing', 'ready']);
  assert.equal((await f.store().getValidProviderAccess('connection-1')).accessToken, 'new-after-cancel');
});

test('interrupted refresh reservations block replay and provider target changes block token use', async () => {
  const f = vaultFixture(); f.records.get('account-1').refreshState = 'refreshing';
  await assert.rejects(f.store().getValidProviderAccess('connection-1'), /no se repetirá/);
  assert.equal(f.refreshes(), 0);
  f.records.get('account-1').refreshState = 'ready'; f.connection().endpoint = 'https://evil.example/api/';
  await assert.rejects(f.store().getValidProviderAccess('connection-1'), /endpoint oficial/);
  assert.equal(f.saved.length, 0);
});

test('authorization persists tokens in Keychain and only returns public connection metadata', async () => {
  const f = vaultFixture();
  const result = await f.store().authorizeAndSave({ id: 'connection-1', kind: 'https-api', label: 'Slack', endpoint: 'https://slack.com/api/', provider: 'slack' }, slack, signal(), undefined, 1);
  assert.equal(result.revision, 2); assert.equal(Object.hasOwn(result, 'accessToken'), false);
  assert.equal(f.records.get(result.credentialAccount).accessToken, 'signed-in');
  await assert.rejects(f.store().authorizeAndSave({ ...result, endpoint: 'https://evil.example/' }, slack, signal(), undefined, 2), /endpoint oficial/);
});

test('Keychain read cannot return a token after connection disablement, removal or rotation', async () => {
  for (const change of ['disabled', 'removed', 'rotated']) {
    const f = vaultFixture(); f.records.get('account-1').expiresAt = 900000;
    const read = f.deps.readSecret, get = f.deps.getConnection; let removed = false;
    f.deps.getConnection = async id => removed ? null : get(id);
    f.deps.readSecret = async account => {
      const raw = await read(account);
      if (change === 'disabled') f.connection().enabled = false;
      if (change === 'removed') removed = true;
      if (change === 'rotated') { f.connection().revision++; f.connection().credentialAccount = 'new-account'; }
      return raw;
    };
    await assert.rejects(f.store().getValidProviderAccess('connection-1'), /conexión cambió/);
    assert.equal(f.refreshes(), 0);
  }
});

test('a completed shared access promise is revalidated before delivering its token', async () => {
  const f = vaultFixture(); f.records.get('account-1').expiresAt = 900000;
  const get = f.deps.getConnection; let reads = 0;
  f.deps.getConnection = async id => { reads++; return reads >= 3 ? null : get(id); };
  await assert.rejects(f.store().getValidProviderAccess('connection-1'), /conexión cambió/);
  assert.equal(f.refreshes(), 0);
});
