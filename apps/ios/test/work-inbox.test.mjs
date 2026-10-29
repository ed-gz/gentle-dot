import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  WORK_LIMITS, validateWorkInput, validateWorkFiles, assertWorkRevision,
  transitionWorkItem, reviseWorkItem, addWorkVersionItem,
  createWork, listWork, readWorkFile, deleteWork, importedWorkTitle,
} from '../src/work-inbox.ts';

const item = (extra = {}) => ({
  id: 'work-1', title: 'Meeting', kind: 'meeting', instruction: 'Extract decisions',
  createdAt: 10, updatedAt: 10, status: 'local', revision: 1,
  files: [{ id: 'file-1', name: 'notes.txt', type: 'text/plain', size: 4 }],
  versions: [], ...extra,
});
const file = (type = 'text/plain', size = 1, name = 'notes.txt') => new File([new Uint8Array(size)], name, { type });

test('new work validates and persists an explicit input allowlist', () => {
  const attachment = file();
  const input = { title: '  Follow up  ', kind: 'task', instruction: '  Prepare proposal  ', files: [attachment], token: 'secret', url: 'wss://private' };
  const safe = validateWorkInput(input);
  assert.deepEqual(safe, { title: 'Follow up', kind: 'task', instruction: 'Prepare proposal', files: [attachment] });
  assert.notEqual(safe.files, input.files);
  assert.deepEqual(validateWorkInput({ title: 'Record meeting', kind: 'meeting', instruction: '' }), {
    title: 'Record meeting', kind: 'meeting', instruction: '', files: [],
  });
});

test('title and instruction bounds reject bad work and permit exact limits', () => {
  const valid = { title: 'x'.repeat(WORK_LIMITS.title), kind: 'task', instruction: 'x'.repeat(WORK_LIMITS.instruction) };
  assert.doesNotThrow(() => validateWorkInput(valid));
  for (const invalid of [
    null, {}, { ...valid, title: '' }, { ...valid, title: ' ' },
    { ...valid, title: 'x'.repeat(WORK_LIMITS.title + 1) },
    { ...valid, instruction: 'x'.repeat(WORK_LIMITS.instruction + 1) },
    { ...valid, instruction: null }, { ...valid, kind: 'automation' },
  ]) assert.throws(() => validateWorkInput(invalid));
});

test('attachments accept audio, text, PDF and images while rejecting unsupported payloads', () => {
  for (const type of ['audio/mp4', 'audio/webm', 'audio/x-m4a', 'text/plain', 'text/markdown', 'text/plain;charset=utf-8', 'application/pdf', 'application/json', 'image/png', 'image/heic']) {
    assert.doesNotThrow(() => validateWorkFiles([file(type)]), type);
  }
  for (const type of ['', 'video/mp4', 'application/octet-stream', 'application/x-executable']) {
    assert.throws(() => validateWorkFiles([file(type)]), /tipo de archivo reconocido/);
  }
  assert.throws(() => validateWorkFiles([new Blob(['data'], { type: 'text/plain' })]), /archivos válidos/);
  assert.throws(() => validateWorkFiles([file('text/plain', 0)]), /contener datos/);
  assert.throws(() => validateWorkFiles([file('text/plain', 1, 'bad\nname')]), /nombre/);
});

test('attachment count and byte limits apply per file and per work', () => {
  const max = file('audio/mp4', WORK_LIMITS.fileBytes, 'recording.m4a');
  assert.doesNotThrow(() => validateWorkFiles([max, max]));
  assert.doesNotThrow(() => validateWorkFiles(Array.from({ length: 10 }, () => file())));
  assert.throws(() => validateWorkFiles(Array.from({ length: 11 }, () => file())), /10 archivos/);
  assert.throws(() => validateWorkFiles([file('text/plain', WORK_LIMITS.fileBytes + 1)]), /25 MiB/);
  const large = file('audio/mp4', 1, 'large.m4a'); Object.defineProperty(large, 'size', { value: WORK_LIMITS.audioBytes });
  assert.doesNotThrow(() => validateWorkFiles([large, large]));
  assert.throws(() => validateWorkFiles([large, large, file()]), /256 MiB/);
  const over = file('audio/mp4', 1, 'too-large.m4a'); Object.defineProperty(over, 'size', { value: WORK_LIMITS.audioBytes + 1 });
  assert.throws(() => validateWorkFiles([over]), /128 MiB/);
});

test('work cannot bypass review and approval to reach sending or sent', () => {
  for (const status of ['sending', 'sent', 'approved', 'failed', 'uncertain']) {
    assert.throws(() => transitionWorkItem(item(), status), /no permitido/);
  }
  let work = transitionWorkItem(item(), 'prepared', 20);
  assert.equal(work.revision, 2);
  assert.equal(work.updatedAt, 20);
  assert.throws(() => transitionWorkItem(work, 'sending'), /no permitido/);
  work = transitionWorkItem(work, 'approved', 30);
  work = transitionWorkItem(work, 'sending', 40);
  assert.equal(work.status, 'sending');
  assert.equal(work.revision, 4);
  work = transitionWorkItem(work, 'sent', 50);
  assert.equal(work.status, 'sent');
  assert.equal(work.revision, 5);
  assert.throws(() => transitionWorkItem(work, 'sending'), /no permitido/);
});

test('failed and uncertain deliveries require a fresh approval before retrying', () => {
  for (const outcome of ['failed', 'uncertain']) {
    const work = transitionWorkItem(item({ status: 'sending' }), outcome);
    assert.throws(() => transitionWorkItem(work, 'sending'), /no permitido/);
    const prepared = transitionWorkItem(work, 'prepared');
    assert.equal(prepared.status, 'prepared');
    assert.throws(() => transitionWorkItem(prepared, 'sending'), /no permitido/);
  }
  assert.throws(() => transitionWorkItem(item({ status: 'sending' }), 'approved'), /no permitido/);
});

test('empty work stays local until there is usable input', () => {
  const empty = item({ instruction: '', files: [] });
  assert.throws(() => transitionWorkItem(empty, 'prepared'), /Añade/);
  assert.equal(transitionWorkItem({ ...empty, versions: [{ id: 'v1', text: 'Transcript', createdAt: 20 }] }, 'prepared').status, 'prepared');
});

test('editing instruction invalidates prior approval and preserves source data without mutating it', () => {
  const original = item({ status: 'approved', error: 'old error', token: 'secret', revision: 7 });
  const revised = reviseWorkItem(original, '  New instruction  ', 100);
  assert.equal(revised.status, 'local');
  assert.equal(revised.instruction, 'New instruction');
  assert.equal(revised.revision, 8);
  assert.equal(revised.updatedAt, 100);
  assert.equal(revised.createdAt, original.createdAt);
  assert.equal(original.status, 'approved');
  assert.equal(original.instruction, 'Extract decisions');
  assert.equal(revised.token, undefined);
  assert.equal(revised.error, undefined);
  assert.notEqual(revised.files, original.files);
  assert.notEqual(revised.files[0], original.files[0]);
});

test('new versions invalidate approval, keep previous versions and stay bounded', () => {
  const original = item({ status: 'approved', versions: [{ id: 'v1', text: 'First draft', createdAt: 30 }] });
  const revised = addWorkVersionItem(original, '  Better draft  ', 'v2', 40);
  assert.equal(revised.status, 'local');
  assert.equal(revised.revision, 2);
  assert.deepEqual(revised.versions, [
    { id: 'v1', text: 'First draft', createdAt: 30 }, { id: 'v2', text: 'Better draft', createdAt: 40 },
  ]);
  assert.equal(original.versions.length, 1);
  assert.throws(() => addWorkVersionItem(original, ' ', 'v2'), /Versión/);
  assert.throws(() => addWorkVersionItem(original, 'x'.repeat(WORK_LIMITS.versionText + 1), 'v2'), /Versión/);
  assert.throws(() => addWorkVersionItem(original, 'Again', 'v1'), /Identificador/);
  assert.throws(() => addWorkVersionItem(item({ versions: Array.from({ length: 100 }, (_, i) => ({ id: `v${i}`, text: 'draft', createdAt: 1 })) }), 'Next', 'next'), /100 versiones/);
});

test('edits cannot change content during delivery or after confirmed delivery', () => {
  for (const status of ['sending', 'sent']) {
    assert.throws(() => reviseWorkItem(item({ status }), 'Changed'), /no se puede editar/);
    assert.throws(() => addWorkVersionItem(item({ status }), 'Changed', 'v1'), /no se puede editar/);
  }
});

test('compare-and-swap revision guards reject stale and invalid callers', () => {
  const work = item({ revision: 5 });
  assert.doesNotThrow(() => assertWorkRevision(work, 5));
  for (const revision of [1, 4, 6, 0, -1, 5.5, NaN, Infinity, '5']) {
    assert.throws(() => assertWorkRevision(work, revision), /Recarga/);
  }
});

test('missing IndexedDB fails promptly without treating data as saved or sent', async () => {
  assert.equal(globalThis.indexedDB, undefined);
  await assert.rejects(listWork(), /no está disponible/);
  await assert.rejects(createWork({ title: 'Draft', kind: 'task', instruction: 'Work' }), /no está disponible/);
  await assert.rejects(readWorkFile('work-1', 'file-1'), /no está disponible/);
  await assert.rejects(deleteWork('work-1', 1), /no está disponible/);
});


test('native import titles preserve graphemes, fit UTF-16 and handle an empty label', () => {
  assert.equal(importedWorkTitle('  Reunión ágil  '), 'Reunión ágil');
  assert.equal(importedWorkTitle('   '), 'Material importado');
  assert.equal(importedWorkTitle('🎵'.repeat(61) + '.m4a'), '🎵'.repeat(60));
  const accent = 'a'.repeat(119) + 'e\u0301' + 'extra';
  assert.equal(importedWorkTitle(accent), 'a'.repeat(119));
  assert.equal(importedWorkTitle('x'.repeat(120) + 'y').length, 120);
});
