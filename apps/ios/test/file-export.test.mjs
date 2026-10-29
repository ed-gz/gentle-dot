import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { exportNativeFile, exportNativeFileRanges, exportFileName, FILE_EXPORT_LIMIT } from '../src/file-export.ts';

const hashID = '5d3d8ff7-b06e-4f88-a17b-3bfbd37e8ca4';
const exportID = 'b56ae6b2-8595-42dc-9f01-e03a45443fbd';
test('export names remove traversal, prefix hidden files and preserve extensions within UTF8 limits', () => {
  assert.equal(exportFileName('../../minutes.txt'), 'minutes.txt');
  assert.equal(exportFileName('C:\\recordings\\reunión.m4a'), 'reunión.m4a');
  assert.equal(exportFileName('.env'), 'capri.env');
  assert.equal(exportFileName('meeting: 1\n.m4a'), 'meeting_ 1_.m4a');
  assert.equal(exportFileName('../'), 'archivo');
  assert.equal(exportFileName('..'), 'archivo');
  assert.equal(exportFileName('safe\u202Efdp.exe'), 'safe_fdp.exe');
  const name = exportFileName('🔷'.repeat(250) + '.ndjson');
  assert.ok(new TextEncoder().encode(name).length <= 240);
  assert.equal(name.endsWith('.ndjson'), true);
  assert.equal(name.includes('\uFFFD'), false);
});
function fixture(options = {}) {
  const calls = []; const chunks = []; let hash = createHash('sha256'); let metadata;
  const call = async (command, request) => {
    calls.push({ command, request });
    if (options.override) { const overridden = await options.override(command, request); if (overridden !== undefined) return overridden; }
    if (command === 'crypto_hash_begin') return { ok: true, id: hashID };
    if (command === 'crypto_hash_update') { hash.update(Buffer.from(request.data, 'base64')); return { ok: true }; }
    if (command === 'crypto_hash_finish') return { ok: true, hex: hash.digest('hex') };
    if (command === 'export_begin') { metadata = request; return { ok: true, id: exportID }; }
    if (command === 'export_write') {
      assert.equal(request.offset, chunks.reduce((size, chunk) => size + chunk.length, 0));
      const data = Buffer.from(request.data, 'base64'); assert.ok(data.length <= 256 * 1024); chunks.push(data);
      return { ok: true, written: request.offset + data.length };
    }
    if (command === 'export_present') {
      const output = Buffer.concat(chunks);
      assert.equal(output.length, metadata.size); assert.equal(createHash('sha256').update(output).digest('hex'), metadata.sha256);
      return { ok: true, exported: !options.cancelled, cancelled: !!options.cancelled };
    }
    if (['export_cancel', 'crypto_hash_cancel'].includes(command)) return { ok: true };
    throw new Error('Unexpected command');
  };
  return { call, calls, chunks };
}
test('exports exact bytes in bounded chunks and confirms only the native picker result', async () => {
  const bytes = new Uint8Array(600001); for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
  const f = fixture(); const blob = new Blob([bytes]);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const result = await exportNativeFile(blob, 'Reunión.m4a', { expectedSHA256: sha256 }, f.call);
  assert.deepEqual(result, { status: 'exported', name: 'Reunión.m4a', size: bytes.length, sha256 });
  assert.deepEqual(Buffer.concat(f.chunks), Buffer.from(bytes));
  assert.equal(f.calls.filter(call => call.command === 'export_present').length, 1);
  assert.equal(f.calls.filter(call => call.command === 'export_write').length, 3);
  assert.deepEqual(f.calls.slice(-2).map(call => call.command), ['export_cancel', 'crypto_hash_cancel']);
});
test('range-backed exports never request a whole file and reject a short range', async () => {
  const bytes = new Uint8Array(600_001).map((_, index) => index % 251), reads = []; const f = fixture();
  const source = { size: bytes.length, read: async (offset, length) => { reads.push([offset, length]); return bytes.slice(offset, offset + length); } };
  const result = await exportNativeFileRanges(source, 'reunion.m4a', {}, f.call);
  assert.equal(result.status, 'exported'); assert.equal(reads.length, 6); assert.ok(reads.every(([, length]) => length <= 256 * 1024));
  const short = fixture(); await assert.rejects(exportNativeFileRanges({ ...source, read: async () => new Uint8Array(1) }, 'reunion.m4a', {}, short.call), /todos los bytes/);
  assert.equal(short.calls.some(call => call.command === 'export_present'), false);
});
test('the picker cancellation is distinct from exported and retains source bytes', async () => {
  const f = fixture({ cancelled: true }); const blob = new Blob(['Original']);
  assert.deepEqual(await exportNativeFile(blob, 'memory.ndjson', {}, f.call), { status: 'cancelled' });
  assert.equal(await blob.text(), 'Original');
});
test('rejects over-limit files, unsafe names and mismatched hashes before presentation', async () => {
  const f = fixture();
  const oversized = new Blob([]); Object.defineProperty(oversized, 'size', { value: FILE_EXPORT_LIMIT + 1 });
  await assert.rejects(exportNativeFile(oversized, 'large.bin', {}, f.call), /256 MiB/);
  for (const name of ['../secret', '.hidden', 'dir/file', 'dir\\file', 'a:b', 'bad\nname', '🔷'.repeat(61)]) await assert.rejects(exportNativeFile(new Blob(['x']), name, {}, f.call), /nombre/);
  assert.equal(f.calls.length, 0);
  await assert.rejects(exportNativeFile(new Blob(['x']), 'file.txt', { expectedSHA256: '0'.repeat(64) }, f.call), /no coinciden/);
  assert.equal(f.calls.some(call => call.command.startsWith('export_')), false);
});
test('an incomplete block acknowledgement never opens the picker or retries', async () => {
  const f = fixture({ override: command => command === 'export_write' ? { ok: true, written: 0 } : undefined });
  await assert.rejects(exportNativeFile(new Blob(['x']), 'file.txt', {}, f.call), /todos los bytes/);
  assert.equal(f.calls.filter(call => call.command === 'export_write').length, 1);
  assert.equal(f.calls.some(call => call.command === 'export_present'), false);
  assert.equal(f.calls.some(call => call.command === 'export_cancel'), true);
});
test('cancellation during transfer cleans up without presenting', async () => {
  const controller = new AbortController();
  const f = fixture({ override: command => { if (command === 'export_begin') controller.abort(); } });
  await assert.rejects(exportNativeFile(new Blob(['x']), 'file.txt', { signal: controller.signal }, f.call), { name: 'AbortError' });
  assert.equal(f.calls.some(call => call.command === 'export_present'), false);
  assert.equal(f.calls.some(call => call.command === 'export_cancel'), true);
});
test('missing delegate confirmation and lost replies never report export success', async () => {
  for (const reply of [{ ok: true }, { ok: true, exported: true, cancelled: true }, { ok: false, message: 'Native unavailable' }]) {
    const f = fixture({ override: command => command === 'export_present' ? reply : undefined });
    await assert.rejects(exportNativeFile(new Blob(['x']), 'file.txt', {}, f.call));
    assert.equal(f.calls.filter(call => call.command === 'export_present').length, 1);
    assert.equal(f.calls.some(call => call.command === 'export_cancel'), true);
  }
});
test('empty files hash and export, while a confirmed copy wins a concurrent cancellation', async () => {
  const controller = new AbortController();
  const f = fixture({ override: command => { if (command === 'export_present') { controller.abort(); return { ok: true, exported: true, cancelled: false }; } } });
  const result = await exportNativeFile(new Blob([]), 'empty.txt', { signal: controller.signal }, f.call);
  assert.equal(result.status, 'exported'); assert.equal(result.sha256, createHash('sha256').digest('hex'));
  assert.equal(f.calls.some(call => call.command === 'export_write'), false);
});
