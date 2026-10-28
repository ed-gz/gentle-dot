import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { createProviderTools } from '../src/provider-tools.ts';
import { gmailRaw, gmailReadable } from '../src/provider-mail.ts';
import { validateCredentialBundle, validateConnection } from '../src/external-connections.ts';

const id = 'e5e3f759-62cb-44e7-a1bd-4912012aa961';
const hash = async bytes => createHash('sha256').update(bytes).digest('hex');
const endpoints = { github: 'https://api.github.com/', slack: 'https://slack.com/api/', gmail: 'https://gmail.googleapis.com/', odoo: 'https://business.example/' };
function fixture(provider, extra = {}) {
  let connection = { id, kind: 'https-api', label: provider, endpoint: endpoints[provider], provider, revision: 1, enabled: true, createdAt: 1, updatedAt: 1, ...extra };
  let fail = false; let status = 200; let attachment = new TextEncoder().encode('evidencia');
  const calls = []; const journal = []; const events = [];
  const services = {
    getConnection: async () => connection,
    access: async () => ({ connection, accessToken: 'credential-never-in-model' }), hash,
    attachment: async () => attachment,
    begin: async record => { if (journal.some(entry => entry.fingerprint === record.fingerprint && entry.state !== 'succeeded')) throw new Error('uncertain replay blocked'); journal.push({ ...record }); events.push('durable'); },
    finish: async (requestId, state, resultJSON) => { const record = journal.find(entry => entry.requestId === requestId); assert.equal(record.state, 'executing'); record.state = state; record.resultJSON = resultJSON; },
    request: async request => {
      calls.push(request);
      if (request.method === 'POST' && !request.url.endsWith('/search_read')) events.push('post');
      if (fail) throw new Error('network');
      let value;
      if (provider === 'github') value = request.method === 'POST' ? { number: 12, html_url: 'https://github.com/org/repo/issues/12' } : [{ id: 12, title: 'Existing' }];
      if (provider === 'slack') value = request.method === 'POST' ? { ok: true, channel: 'C123', ts: '123.456' } : { ok: true, messages: [{ text: 'Hola' }] };
      if (provider === 'gmail') value = request.url.endsWith('/profile') ? { emailAddress: 'owner@example.com' } : request.method === 'POST' ? { id: 'abc123', threadId: 'abc123' } : { messages: [{ id: 'abc123' }] };
      if (provider === 'odoo') {
        const body = JSON.parse(request.body); const method = connection.apiMode === 'legacy' ? body.params.args[4] : request.url.split('/').at(-1);
        const result = method === 'create' ? [99] : method === 'write' ? true : [{ id: 1, name: 'Confirmed' }];
        value = connection.apiMode === 'legacy' ? { jsonrpc: '2.0', id: body.id, result } : result;
      }
      return { status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) };
    },
  };
  return { services, calls, journal, events, change: () => { connection = { ...connection, revision: connection.revision + 1 }; }, fail: () => { fail = true; }, status: value => { status = value; }, changeAttachment: () => { attachment = new TextEncoder().encode('alterado!'); } };
}
const ctx = approve => ({ signal: new AbortController().signal, askApproval: approve });
const find = (tools, suffix) => tools.find(tool => tool.definition.name.endsWith('_' + suffix));

test('provider metadata and OAuth bundle are allowlisted without client secrets', () => {
  const bundle = validateCredentialBundle({ accessToken: 'access', refreshToken: 'refresh', expiresAt: Date.now() + 100000, provider: 'gmail', clientId: 'public-id', scopes: ['gmail.readonly'], refreshState: 'ready', clientSecret: 'never', password: 'never' });
  assert.equal('clientSecret' in bundle, false); assert.equal('password' in bundle, false);
  const metadata = validateConnection({ id, kind: 'https-api', label: 'Odoo', endpoint: endpoints.odoo, provider: 'odoo', apiMode: 'legacy', database: 'operations', uid: 7, revision: 1, enabled: true, createdAt: 1, updatedAt: 1, accessToken: 'secret' });
  assert.equal(metadata.uid, 7); assert.equal('accessToken' in metadata, false);
});
test('GitHub read routes are fixed and creating an issue waits for exact review and durable reservation', async () => {
  const f = fixture('github'); const tools = await createProviderTools(id, f.services);
  await find(tools, 'issues').execute({ repository: 'org/repo', page: 2 }, ctx());
  assert.match(f.calls[0].url, /repos\/org\/repo\/issues\?state=all&per_page=20&page=2$/);
  assert.equal(f.journal.length, 0);
  let review;
  const result = await find(tools, 'create_issue').execute({ repository: 'org/repo', title: 'Confirmed issue', text: 'Evidence only', labels: ['bug'] }, ctx(async request => { review = request; f.events.push('approved'); return true; }));
  assert.equal(result.result.accepted, true);
  assert.deepEqual(f.events, ['approved', 'durable', 'post']);
  assert.match(review.details, /Evidence only/); assert.doesNotMatch(review.details, /credential-never-in-model/);
  assert.equal(f.calls.at(-1).headers['X-GitHub-Api-Version'], '2026-03-10');
  assert.equal(JSON.stringify(f.journal).includes('credential-never-in-model'), false);
});
test('denied review, changed connection and argument injection cannot send', async () => {
  const f = fixture('slack'); const tool = find(await createProviderTools(id, f.services), 'send_message');
  assert.equal((await tool.execute({ channel: 'C123', text: 'Hola' }, ctx(async () => false))).executed, false);
  await assert.rejects(tool.execute({ channel: 'C123', text: 'Hola', url: 'https://evil.example/' }, ctx(async () => true)), /inválidos/);
  await assert.rejects(tool.execute({ channel: 'C123', text: 'Hola' }, ctx(async () => { f.change(); return true; })), /cambió/);
  assert.equal(f.calls.length, 0); assert.equal(f.journal.length, 0);
});
test('Slack sends literal text with unfurls disabled and requires a provider confirmation', async () => {
  const f = fixture('slack'); const tool = find(await createProviderTools(id, f.services), 'send_message');
  await tool.execute({ channel: 'C123', text: 'Contenido exacto' }, ctx(async () => true));
  assert.deepEqual(JSON.parse(f.calls[0].body), { channel: 'C123', text: 'Contenido exacto', mrkdwn: false, parse: 'none', link_names: false, unfurl_links: false, unfurl_media: false });
  assert.equal(f.journal[0].state, 'succeeded');
});
test('ambiguous external writes persist uncertainty and are not repeated', async () => {
  const f = fixture('github'); const tool = find(await createProviderTools(id, f.services), 'create_issue'); f.fail();
  const operation = { repository: 'org/repo', title: 'Title', text: 'Text', labels: [] };
  await assert.rejects(tool.execute(operation, ctx(async () => true)), /sin confirmar/);
  assert.equal(f.journal[0].state, 'uncertain');
  await assert.rejects(tool.execute(operation, ctx(async () => true)), /replay blocked/);
  assert.equal(f.calls.length, 1);
});
test('a definite HTTP rejection is recorded as a confirmed rejection, not successful business execution', async () => {
  const f = fixture('slack'); f.status(403);
  const result = await find(await createProviderTools(id, f.services), 'send_message').execute({ channel: 'C123', text: 'Message' }, ctx(async () => true));
  assert.equal(result.accepted, false); assert.equal(result.httpStatus, 403); assert.equal(f.journal[0].state, 'succeeded');
});
test('Gmail MIME includes verified sender, encoded Unicode subject and immutable verified attachment bytes', async () => {
  const f = fixture('gmail'); const tool = find(await createProviderTools(id, f.services), 'send_message');
  const bytes = new TextEncoder().encode('evidencia');
  const operation = { to: ['ana@example.com'], cc: [], bcc: ['audit@example.com'], subject: 'Reunión 🎵', text: 'Acuerdos confirmados', attachments: [{ workId: 'work', fileId: 'file', name: 'evidencia.txt', mime: 'text/plain', size: bytes.length, sha256: await hash(bytes) }] };
  let review;
  await tool.execute(operation, ctx(async request => { review = JSON.parse(request.details); return true; }));
  assert.equal(review.from, 'owner@example.com'); assert.equal(review.operation.attachments[0].sha256, await hash(bytes));
  const outgoing = f.calls.find(request => request.url.endsWith('/messages/send'));
  assert.equal(outgoing.url, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
  const mime = Buffer.from(JSON.parse(outgoing.body).raw, 'base64url').toString('utf8');
  assert.match(mime, /From: owner@example.com/); assert.match(mime, /Bcc: audit@example.com/);
  assert.match(mime, /Subject: =\?UTF-8\?B\?/); assert.match(mime, /ZXZpZGVuY2lh/);
  assert.equal(mime.split('\r\n').every(line => line.length < 998), true);
  const altered = fixture('gmail'); const changed = find(await createProviderTools(id, altered.services), 'send_message');
  await assert.rejects(changed.execute(operation, ctx(async () => { altered.changeAttachment(); return true; })), /huella/);
  assert.equal(altered.calls.some(request => request.url.endsWith('/messages/send')), false);
});
test('MIME builders reject header injection and Gmail read never interprets HTML', () => {
  const operation = { kind: 'gmail.message', to: ['ana@example.com'], cc: [], bcc: [], subject: 'Hola', text: 'text', attachments: [] };
  assert.throws(() => gmailRaw({ ...operation, subject: 'Hello\r\nBcc: evil@example.com' }, 'owner@example.com', [], 'boundary'));
  assert.throws(() => gmailRaw({ ...operation, to: ['ana@example.com\r\nBcc:evil@example.com'] }, 'owner@example.com', [], 'boundary'));
  const html = '<script>fetch("https://evil.example")</script>';
  const value = gmailReadable({ id: 'a', payload: { mimeType: 'text/html', body: { data: Buffer.from(html).toString('base64url') }, headers: [] } });
  assert.equal(value.content[0].text, html); assert.equal(value.untrustedContent, true);
});
test('Odoo JSON2 and legacy use explicit models/methods and never persist the API key in journal', async () => {
  for (const mode of ['json2', 'legacy']) {
    const f = fixture('odoo', { apiMode: mode, database: 'operations', uid: 7 }); const tools = await createProviderTools(id, f.services);
    await find(tools, 'projects').execute({}, ctx());
    const result = await find(tools, 'create_task').execute({ projectId: 4, name: 'Confirmed task', description: '<script>unsafe</script>', assigneeIds: [7], deadline: '2026-11-01' }, ctx(async () => true));
    assert.equal(result.result.taskId, 99);
    const sent = f.calls.at(-1); const body = JSON.parse(sent.body);
    if (mode === 'json2') { assert.match(sent.url, /json\/2\/project.task\/create$/); assert.equal(body.vals_list[0].project_id, 4); assert.equal(sent.headers['X-Odoo-Database'], 'operations'); }
    else { assert.match(sent.url, /jsonrpc$/); assert.deepEqual(body.params.args.slice(0, 5), ['operations', 7, 'credential-never-in-model', 'project.task', 'create']); assert.equal(sent.headers.Authorization, undefined); }
    assert.match(sent.body, /&lt;script&gt;/); assert.doesNotMatch(JSON.stringify(f.journal), /credential-never-in-model/);
  }
});
test('provider adapters refuse an arbitrary credential destination', async () => {
  const f = fixture('gmail', { endpoint: 'https://evil.example/' });
  await assert.rejects(createProviderTools(id, f.services), /endpoint oficial/);
  assert.equal(f.calls.length, 0);
});
test('provider arguments survive the connection wrapper validation before execution', async () => {
  const cases = [
    ['github', {}, 'create_issue', { repository: 'org/repo', title: 'Title', text: 'Text', labels: [] }],
    ['slack', {}, 'send_message', { channel: 'C123', text: 'Text' }],
    ['gmail', {}, 'send_message', { to: ['ana@example.com'], cc: [], bcc: [], subject: 'Subject', text: 'Text', attachments: [] }],
    ['odoo', { apiMode: 'json2' }, 'create_task', { projectId: 4, name: 'Task', description: '', assigneeIds: [] }],
    ['odoo', { apiMode: 'legacy', database: 'operations', uid: 7 }, 'update_task', { taskId: 4, changes: { name: 'New name' } }],
  ];
  for (const [provider, metadata, name, input] of cases) {
    const f = fixture(provider, metadata); const tool = find(await createProviderTools(id, f.services), name);
    const validated = tool.validate(input);
    assert.deepEqual(tool.validate(validated), validated);
    const result = await tool.execute(validated, ctx(async () => true));
    assert.equal(result.result.accepted, true);
  }
  for (const [provider, metadata, name, input] of [
    ['slack', {}, 'conversations', {}], ['slack', {}, 'history', { channel: 'C123' }],
    ['gmail', {}, 'search', {}], ['odoo', { apiMode: 'json2' }, 'search_tasks', {}],
  ]) {
    const f = fixture(provider, metadata); const tool = find(await createProviderTools(id, f.services), name);
    const validated = tool.validate(input);
    assert.deepEqual(tool.validate(validated), validated);
    await tool.execute(validated, ctx());
    assert.equal(f.calls.length, 1);
    if (name === 'conversations') assert.equal(new URL(f.calls[0].url).searchParams.get('types'), 'public_channel');
  }
});
test('credential retrieval cannot revive a connection changed during Keychain access', async () => {
  const f = fixture('github'); const original = f.services.access;
  f.services.access = async () => { const access = await original(); f.change(); return access; };
  const tools = await createProviderTools(id, f.services);
  await assert.rejects(find(tools, 'repositories').execute({}, ctx()), /cambió/);
  await assert.rejects(find(tools, 'create_issue').execute({ repository: 'org/repo', title: 'Title', text: 'Text', labels: [] }, ctx(async () => { throw new Error('must not ask'); })), /cambió/);
  assert.equal(f.calls.length, 0); assert.equal(f.journal.length, 0);
});
