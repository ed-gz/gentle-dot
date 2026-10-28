import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { pickDocuments, listDocumentImports, importDocumentItem } from '../src/document-import.ts';

const bytes = Buffer.from('Material conservado');
const item = { schemaVersion: 1, id: 'd5a6e456-7a93-4bcc-b006-4493c78b5b66', createdAt: 1000, title: 'Nota', notes: '',
  files: [{ id: 'c623087b-1af4-4b20-a20a-31d33e419171', name: 'nota.txt', mime: 'text/plain', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }] };
test('native picker validates cancellation and manifest without accepting filesystem paths', async () => {
  assert.equal(await pickDocuments(async () => ({ ok: true, cancelled: true, items: [] })), null);
  assert.deepEqual(await pickDocuments(async command => { assert.equal(command, 'documents_pick'); return { ok: true, cancelled: false, items: [item] }; }), item);
  for (const result of [{ ok: true, cancelled: false, items: [] }, { ok: true, cancelled: true, items: [item] }, { ok: true, cancelled: false, items: [{ path: '/private/secret' }] }]) {
    await assert.rejects(pickDocuments(async () => result));
  }
});
test('import verifies original bytes and keeps native copy until durable save succeeds', async () => {
  const calls = [];
  const invoke = async (command, request) => {
    calls.push(command);
    if (command === 'documents_list') return { ok: true, items: [item] };
    if (command === 'documents_read') return { ok: true, data: bytes.toString('base64') };
    if (command === 'documents_ack') return { ok: true, persisted: true };
    throw new Error(command);
  };
  assert.deepEqual(await listDocumentImports(invoke), [item]);
  await assert.rejects(importDocumentItem(item, async () => { throw new Error('disk full'); }, invoke), /disk full/);
  assert.ok(!calls.includes('documents_ack'));
  await importDocumentItem(item, async ({ sourceId, files }) => {
    assert.equal(sourceId, 'document:' + item.id);
    assert.deepEqual(Buffer.from(await files[0].arrayBuffer()), bytes);
    assert.ok(!calls.includes('documents_ack'));
  }, invoke);
  assert.equal(calls.at(-1), 'documents_ack');
});
