import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { prepareWorkTransfer } from '../src/work-sync.ts';
import { canonicalWorkManifest } from '../../../packages/protocol/src/work-sync.ts';
import { reviseWorkItem, transitionWorkItem, addWorkVersionItem } from '../src/work-inbox.ts';
const item = () => ({ id: 'work-1', title: 'Meeting', kind: 'meeting', instruction: 'Prepare a draft', createdAt: 1, updatedAt: 2, revision: 3, status: 'approved', files: [{ id: 'audio-1', name: 'audio.m4a', type: 'audio/mp4', size: 4 }], versions: [{ id: 'v1', text: 'First draft á', createdAt: 2 }, { id: 'v2', text: 'Second draft', createdAt: 3 }] });
test('snapshot hashes the exact bytes and every text version, preserving the approved revision', async () => {
  const work = item(); const transfer = await prepareWorkTransfer(work, 'wss://host/ws', async () => new Blob(['data']));
  assert.equal(transfer.manifest.revision, 3); assert.equal(transfer.manifest.files.length, 3);
  assert.equal(transfer.manifest.files[0].sha256, createHash('sha256').update('data').digest('hex'));
  assert.equal(transfer.manifest.files[1].bytes, new TextEncoder().encode(work.versions[0].text).length);
  assert.equal(transfer.manifestHash, createHash('sha256').update(canonicalWorkManifest(transfer.manifest)).digest('hex'));
  assert.equal(work.status, 'approved'); assert.equal(work.transfer, undefined);
});
test('missing/changed local blobs and unapproved work never create a transfer', async () => {
  await assert.rejects(prepareWorkTransfer({ ...item(), status: 'prepared' }, 'host'), /Aprueba/);
  await assert.rejects(prepareWorkTransfer(item(), 'host', async () => undefined), /Falta/);
  await assert.rejects(prepareWorkTransfer(item(), 'host', async () => new Blob(['wrong size'])), /Falta/);
});
test('cancellation while hashing a file stops preparation without creating a transfer', async () => {
  const abort = new AbortController();
  const blob = new Blob([new Uint8Array(600_000)]);
  const originalSlice = blob.slice.bind(blob); let reads = 0;
  blob.slice = (start, end) => { reads++; const result = originalSlice(start, end); abort.abort(); return result; };
  const work = item(); work.files[0].size = blob.size;
  await assert.rejects(prepareWorkTransfer(work, 'host', async () => blob, abort.signal), { name: 'AbortError' });
  assert.equal(reads, 1);
  assert.equal(work.status, 'approved'); assert.equal(work.transfer, undefined);
});
test('revisions invalidate previous transfer snapshots; delivery-state changes preserve them', async () => {
  const transfer = await prepareWorkTransfer(item(), 'wss://host/ws', async () => new Blob(['data']));
  const work = { ...item(), transfer };
  assert.equal(reviseWorkItem(work, 'New instruction').transfer, undefined);
  assert.equal(addWorkVersionItem(work, 'New draft', 'v3').transfer, undefined);
  assert.equal(transitionWorkItem({ ...work, status: 'uncertain' }, 'prepared').transfer, undefined);
  assert.deepEqual(transitionWorkItem({ ...work, status: 'sending' }, 'uncertain').transfer, transfer);
});
