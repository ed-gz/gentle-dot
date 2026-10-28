import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ARCHIVE_LIMITS, archiveEntry, archiveScope, matchesMemory, memoryTerms, createConversationArchive } from '../src/conversation-archive.ts';
import { createMemoryTools } from '../src/conversation-memory-tools.ts';
const entry = (extra = {}) => ({ id: 'message-1', engine: 'iphone', role: 'user', state: 'complete', text: 'La reunión ocurrió el martes; Ana revisará el ticket.', at: 1000, ...extra });
test('archive allowlist preserves evidence and excludes draft, credentials and transport wrappers', () => {
  const safe = archiveEntry({ ...entry(), token: 'private', connection: { token: 'private' }, draft: 'not submitted', transportText: 'hidden wrapper' });
  assert.deepEqual(safe, { ...entry(), scope: 'iphone:main' });
  assert.equal(safe.token, undefined); assert.equal(safe.draft, undefined); assert.equal(safe.transportText, undefined);
  const pending = archiveEntry(entry({ state: 'pending', activities: [{ id: 't', title: 'Transferir', kind: 'other', status: 'running', detail: 'Sin ACK', token: 'private' }] }));
  assert.equal(pending.state, 'pending'); assert.equal(pending.activities[0].status, 'running'); assert.equal(pending.activities[0].token, undefined);
});
test('host/session scopes remain separate and unbound history is labeled honestly', () => {
  assert.equal(archiveScope(entry({ engine: 'gentle', id: 'host:wss://host.example/ws|session-a|message-1' })), 'host:wss://host.example/ws|session-a');
  assert.equal(archiveScope(entry({ engine: 'gentle', id: 'host:wss://other.example/ws|session-a|message-1' })), 'host:wss://other.example/ws|session-a');
  assert.equal(archiveScope(entry({ engine: 'gentle', id: 'legacy-message' })), 'gentle:unscoped');
  assert.equal(archiveEntry(entry(), 'explicit-scope').scope, 'explicit-scope');
});
test('limits reject oversized/malformed records without silently truncating them', () => {
  assert.equal(archiveEntry(entry({ text: 'x'.repeat(32000) })).text.length, 32000);
  for (const invalid of [entry({ text: 'x'.repeat(32001) }), entry({ at: Infinity }), entry({ at: 9e15 }), entry({ activities: Array.from({ length: 81 }, () => ({})) }), entry({ engine: 'invented' })]) assert.throws(() => archiveEntry(invalid));
  assert.throws(() => createConversationArchive({ maximumEntries: ARCHIVE_LIMITS.entries + 1 }), /Cuota/);
  assert.throws(() => createConversationArchive({ maximumBytes: ARCHIVE_LIMITS.bytes + 1 }), /Cuota/);
});
test('search matches real message terms accent-insensitively and never derives personal facts', () => {
  assert.equal(matchesMemory(archiveEntry(entry()), memoryTerms('reunion ANA')), true);
  assert.equal(matchesMemory(archiveEntry(entry()), memoryTerms('reunion viernes')), false);
  assert.equal(matchesMemory(archiveEntry(entry({ text: 'Otro contenido', activities: [{ id: 't', kind: 'other', title: 'reunion', status: 'done' }] })), memoryTerms('reunion')), false);
  assert.throws(() => memoryTerms('  ')); assert.throws(() => memoryTerms('a '.repeat(13)));
});
test('missing storage never pretends the archive or export succeeded', async () => {
  const archive = createConversationArchive();
  await assert.rejects(archive.upsert([entry()]), /no está disponible/);
  await assert.rejects(archive.page(), /no está disponible/);
  await assert.rejects(archive.export(), /no está disponible/);
});
test('memory tools return exact snippets with provenance, pagination and uncertainty', async () => {
  const record = { ...archiveEntry(entry({ state: 'interrupted', text: 'x'.repeat(800) + 'Ana verificó logs.' })), key: 'archive-key', sequence: 1, storedAt: 1000, updatedAt: 1000, bytes: 900 };
  const calls = []; const store = { page: async input => { calls.push(input); return { entries: [record], cursor: 'next', hasMore: true, scanned: 1000 }; }, search: async (query, input) => { calls.push({ query, ...input }); return { entries: [record], cursor: 'next', hasMore: true, scanned: 1000 }; }, load: async key => key === record.key ? record : undefined };
  const tools = createMemoryTools(store); const context = { signal: new AbortController().signal };
  const found = await tools.find(tool => tool.definition.name === 'search_memory').execute({ query: 'Ana' }, context);
  assert.equal(found.hasMore, true); assert.equal(found.cursor, 'next'); assert.equal(found.records[0].source.state, 'interrupted'); assert.equal(found.records[0].source.timestamp, '1970-01-01T00:00:01.000Z');
  assert.equal(found.records[0].text, record.text.slice(found.records[0].offset, found.records[0].end)); assert.equal(found.evidenceOnly, true);
  const read = await tools[0].execute({ entryKey: record.key, offset: 800 }, context); assert.equal(read.text, 'Ana verificó logs.');
  await assert.rejects(tools[0].execute({ entryKey: record.key, offset: 10000 }, context), /supera/);
  assert.throws(() => tools[1].validate({ query: 'Ana', secret: 'private' }), /inválidos/);
});
