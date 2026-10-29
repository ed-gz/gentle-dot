import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { createMCPOAuth } from '../src/mcp-oauth.ts';
import { createMCPOAuthStore } from '../src/mcp-oauth-store.ts';
import { MCP_OAUTH_CALLBACK } from '../src/external-connections.ts';

const resource = 'https://fixture-mcp.invalid/mcp';
const issuer = 'https://fixture-auth.invalid/';
const connectionId = 'd5a6e456-7a93-4bcc-b006-4493c78b5b66';
const clientId = 'fixture-public-client';
const toBase64url = value => createHash('sha256').update(value).digest('base64url');

async function setup(t) {
  let codeChallenge, validRefresh = 'synthetic-refresh-1', tokenCalls = 0, refreshCalls = 0;
  const seen = [];
  const json = (response, status, body, headers = {}) => { response.writeHead(status, {'content-type':'application/json',...headers}); response.end(JSON.stringify(body)); };
  const server = createServer(async (request,response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    const url = new URL(request.url, 'http://localhost');
    const host = request.headers['x-fixture-host'];
    if (host === 'fixture-mcp.invalid' && url.pathname === '/mcp') {
      const rpc = JSON.parse(body); seen.push(rpc.method);
      if (rpc.method === 'initialize') return json(response,400,{jsonrpc:'2.0',id:rpc.id,error:{code:-32020,message:'modern only'}});
      assert.equal(rpc.method,'server/discover'); assert.equal(request.headers['mcp-method'],'server/discover');
      assert.equal(request.headers['mcp-protocol-version'],'2026-07-28');
      response.writeHead(401,{'www-authenticate':'Bearer resource_metadata="https://fixture-mcp.invalid/meta", scope="fixture:read"'}); response.end(); return;
    }
    if (host === 'fixture-mcp.invalid' && url.pathname === '/meta') return json(response,200,{resource,authorization_servers:[issuer],scopes_supported:['fixture:read']});
    if (host === 'fixture-auth.invalid' && url.pathname === '/.well-known/oauth-authorization-server') return json(response,200,{
      issuer,authorization_endpoint:issuer+'authorize',token_endpoint:issuer+'token',response_types_supported:['code'],
      code_challenge_methods_supported:['S256'],token_endpoint_auth_methods_supported:['none'],authorization_response_iss_parameter_supported:true,
    });
    if (host === 'fixture-auth.invalid' && url.pathname === '/authorize') {
      assert.equal(url.searchParams.get('client_id'),clientId); assert.equal(url.searchParams.get('resource'),resource);
      assert.equal(url.searchParams.get('redirect_uri'),MCP_OAUTH_CALLBACK); assert.equal(url.searchParams.get('code_challenge_method'),'S256');
      codeChallenge = url.searchParams.get('code_challenge');
      const callback = new URL(MCP_OAUTH_CALLBACK); callback.searchParams.set('code','synthetic-code'); callback.searchParams.set('state',url.searchParams.get('state')); callback.searchParams.set('iss',issuer);
      response.writeHead(302,{location:callback.href}); response.end(); return;
    }
    if (host === 'fixture-auth.invalid' && url.pathname === '/token') {
      const form = new URLSearchParams(body); assert.equal(form.get('client_id'),clientId); assert.equal(form.get('resource'),resource); assert.equal(form.has('client_secret'),false);
      if (form.get('grant_type') === 'authorization_code') {
        tokenCalls++; assert.equal(form.get('code'),'synthetic-code'); assert.equal(form.get('redirect_uri'),MCP_OAUTH_CALLBACK);
        assert.equal(toBase64url(form.get('code_verifier')),codeChallenge);
        return json(response,200,{token_type:'Bearer',access_token:'synthetic-access-1',refresh_token:validRefresh,expires_in:120,scope:'fixture:read'});
      }
      refreshCalls++; assert.equal(form.get('grant_type'),'refresh_token'); assert.equal(form.get('refresh_token'),validRefresh);
      validRefresh = 'synthetic-refresh-2';
      return json(response,200,{token_type:'Bearer',access_token:'synthetic-access-2',refresh_token:validRefresh,expires_in:120,scope:'fixture:read'});
    }
    response.writeHead(404); response.end();
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening'); t.after(() => server.close());
  const port = server.address().port;
  async function exchange(request) {
    const target = new URL(request.url);
    if (!['fixture-mcp.invalid','fixture-auth.invalid'].includes(target.hostname) || target.protocol !== 'https:') throw new Error('Unexpected external address');
    assert.equal(Object.keys(request.headers).some(key=>key.toLowerCase()==='authorization'),false);
    const response = await fetch(`http://127.0.0.1:${port}${target.pathname}${target.search}`, {method:request.method,
      headers:{...request.headers,'x-fixture-host':target.hostname},body:request.body,redirect:'manual'});
    return {status:response.status,headers:Object.fromEntries(response.headers),body:await response.text()};
  }
  const deps = {request:exchange,random:async()=>randomBytes(32).toString('base64url'),sha256:async value=>createHash('sha256').update(value).digest('hex'),
    now:()=>1000,schemes:async()=>['dev.gentledot.capri.auth'],cancel:async()=>{},
    authorize:async url => { const response = await exchange({url,method:'GET',headers:{}}); assert.equal(response.status,302); return response.headers.location; }};
  return {deps,seen,get tokenCalls(){return tokenCalls},get refreshCalls(){return refreshCalls}};
}

test('local OAuth server verifies real PKCE, custom-scheme callback, resource and rotated refresh', async t => {
  const f = await setup(t), oauth = createMCPOAuth(f.deps);
  const result = await oauth.authorize({endpoint:resource,clientId},new AbortController().signal);
  assert.equal(result.accessToken,'synthetic-access-1'); assert.deepEqual(result.scopes,['fixture:read']);
  const refreshed = await oauth.refresh(result); assert.equal(refreshed.refreshToken,'synthetic-refresh-2');
  assert.equal(f.tokenCalls,1); assert.equal(f.refreshCalls,1); assert.deepEqual(f.seen,['initialize','server/discover']);
});

test('cancelled browser callback never reaches the local token endpoint', async t => {
  const f = await setup(t), controller = new AbortController(); let release, entered, cancelled = false;
  const browser = new Promise(resolve => {release=resolve});
  const ready = new Promise(resolve => {entered=resolve});
  const oauth = createMCPOAuth({...f.deps,authorize:async url => {const callback = await f.deps.authorize(url); entered(); await browser; return callback;},cancel:async()=>{cancelled=true;}});
  const pending = oauth.authorize({endpoint:resource,clientId},controller.signal);
  await ready; controller.abort(); assert.equal(cancelled,true);
  release(); await assert.rejects(pending,{name:'AbortError'});
  assert.equal(f.tokenCalls,0);
});

test('tampered state or issuer in the local callback cannot exchange the authorization code', async t => {
  const f = await setup(t);
  for (const mutate of [url => url.searchParams.set('state','wrong'), url => url.searchParams.set('iss','https://other.invalid/')]) {
    const oauth = createMCPOAuth({...f.deps,authorize:async url => {const callback=new URL(await f.deps.authorize(url)); mutate(callback); return callback.href;}});
    await assert.rejects(oauth.authorize({endpoint:resource,clientId},new AbortController().signal));
  }
  assert.equal(f.tokenCalls,0);
});

test('a connection edited during the real callback cannot be overwritten by stale authorization', async t => {
  const f = await setup(t); let writes = 0;
  let conn = {id:connectionId,kind:'mcp',label:'fixture',endpoint:resource,revision:1,enabled:true,createdAt:1,updatedAt:1};
  const oauth = createMCPOAuth({...f.deps,authorize:async url => {const callback=await f.deps.authorize(url); conn={...conn,revision:2,label:'edited'}; return callback;}});
  const store = createMCPOAuthStore({oauth,getConnection:async()=>({...conn}),save:async (_input,_bundle,revision)=>{
    if (revision !== conn.revision) throw new Error('La conexión cambió'); writes++; return conn;
  }});
  await assert.rejects(store.authorizeAndSave({...conn},{endpoint:resource,clientId},new AbortController().signal,1),/cambió/);
  assert.equal(conn.label,'edited'); assert.equal(writes,0); assert.equal(f.tokenCalls,1);
});

test('lost refresh response remains uncertain and is not retried after store recreation', async t => {
  const f = await setup(t), normal = createMCPOAuth(f.deps);
  let bundle = await normal.authorize({endpoint:resource,clientId},new AbortController().signal); bundle = {...bundle,expiresAt:1001};
  let conn = {id:connectionId,kind:'mcp',label:'fixture',endpoint:resource,revision:1,enabled:true,credentialAccount:connectionId,createdAt:1,updatedAt:1};
  const lost = createMCPOAuth({...f.deps,request:async request => {const response=await f.deps.request(request); if (request.url===issuer+'token') throw new Error('synthetic response lost'); return response;}});
  const deps = {now:()=>1000,getConnection:async()=>({...conn}),readSecret:async()=>JSON.stringify(bundle),oauth:lost,
    save:async (_input,next,revision)=>{assert.equal(revision,conn.revision); bundle=next; conn={...conn,revision:revision+1}; return {...conn};}};
  await assert.rejects(createMCPOAuthStore(deps).prepare(connectionId),/No se confirmó/);
  assert.equal(bundle.refreshState,'uncertain'); assert.equal(f.refreshCalls,1);
  await assert.rejects(createMCPOAuthStore(deps).prepare(connectionId),/quedó sin confirmar/);
  assert.equal(f.refreshCalls,1);
});
