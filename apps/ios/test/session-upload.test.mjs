import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { uploadSessionFile } from '../src/session-upload.ts';

const connection = { url: 'wss://laptop.example/ws', token: 'fixture-only', deviceId: 'phone-1' };
const hashId = '11111111-1111-4111-8111-111111111111', transferId = '22222222-2222-4222-8222-222222222222';
const batch = 'u_abcdefghijklmnopqrstuv';
function fixture(override = () => undefined) {
  const calls = [], chunks = []; let metadata; const hash = createHash('sha256');
  const call = async (command, request) => {
    calls.push({ command, request });
    const replacement = await override(command, request); if (replacement !== undefined) return replacement;
    if (command === 'crypto_hash_begin') return { ok: true, id: hashId };
    if (command === 'crypto_hash_update') { hash.update(Buffer.from(request.data, 'base64')); return { ok: true }; }
    if (command === 'crypto_hash_finish') return { ok: true, hex: hash.digest('hex') };
    if (command === 'session_upload_begin') { metadata = request; return { ok: true, id: transferId }; }
    if (command === 'session_upload_write') {
      const bytes = Buffer.from(request.data, 'base64'); assert.ok(bytes.length <= 256 * 1024);
      assert.equal(request.offset, chunks.reduce((sum, chunk) => sum + chunk.length, 0)); chunks.push(bytes);
      return { ok: true, written: request.offset + bytes.length };
    }
    if (command === 'session_upload_send') {
      const uploaded = Buffer.concat(chunks); assert.equal(uploaded.length, metadata.size);
      assert.equal(createHash('sha256').update(uploaded).digest('hex'), metadata.sha256);
      return { ok: true, status: 200, body: JSON.stringify({ uploadId: metadata.uploadId ?? batch, name: metadata.name,
        size: metadata.size, mime: 'application/octet-stream', path: `uploads/${metadata.uploadId ?? batch}/${metadata.name}` }) };
    }
    if (command.endsWith('_cancel')) return { ok: true };
    throw new Error('Unexpected command');
  };
  return { call, calls, chunks };
}
const options = extra => ({ current: () => connection, ...extra });

test('session upload preserves binary bytes in bounded passes, exact destination and confirmed batch', async () => {
  const bytes = Buffer.alloc(600001); for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  const file = new File([bytes], 'Evidencia.bin');
  file.arrayBuffer = () => { throw new Error('Whole-file buffering is not allowed'); };
  const f = fixture();
  const receipt = await uploadSessionFile(connection, 'pane-A', 'session-A', file, options({ uploadId: batch }), f.call);
  assert.deepEqual(Buffer.concat(f.chunks), bytes);
  assert.deepEqual(receipt, { uploadId: batch, name: file.name, size: bytes.length, mime: 'application/octet-stream', path: `uploads/${batch}/${file.name}` });
  const begin = f.calls.find(c => c.command === 'session_upload_begin').request;
  assert.equal(begin.url, 'https://laptop.example/upload'); assert.equal(begin.token, 'fixture-only');
  assert.equal(begin.paneId, 'pane-A'); assert.equal(begin.sessionId, 'session-A');
  assert.equal(f.calls.filter(c => c.command === 'session_upload_send').length, 1);
  assert.deepEqual(f.calls.slice(-2).map(c => c.command), ['session_upload_cancel', 'crypto_hash_cancel']);
});
test('invalid destination, oversized file and already-cancelled request never begin preparation', async () => {
  const f = fixture(), file = new File(['x'], 'note.txt'), oversized = new File([], 'large.bin');
  Object.defineProperty(oversized, 'size', { value: 25 * 1024 * 1024 + 1 });
  await assert.rejects(uploadSessionFile(connection, 'p', 's', oversized, options(), f.call), /25 MiB/);
  await assert.rejects(uploadSessionFile(connection, 'p\r\nInjected', 's', file, options(), f.call));
  await assert.rejects(uploadSessionFile({ ...connection, url: 'wss://laptop.example/other' }, 'p', 's', file, options(), f.call));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(uploadSessionFile(connection, 'p', 's', file, options({ signal: controller.signal }), f.call), { name: 'AbortError' });
  assert.equal(f.calls.length, 0);
});
test('an incomplete native block or cancellation after begin never starts HTTP upload', async () => {
  for (const cancelled of [false, true]) {
    const controller = new AbortController();
    const f = fixture(command => {
      if (cancelled && command === 'session_upload_begin') controller.abort();
      if (!cancelled && command === 'session_upload_write') return { ok: true, written: 0 };
    });
    await assert.rejects(uploadSessionFile(connection, 'p', 's', new File(['original'], 'note.txt'), options({ signal: controller.signal }), f.call));
    assert.equal(f.calls.some(c => c.command === 'session_upload_send'), false);
    assert.equal(f.calls.some(c => c.command === 'session_upload_cancel'), true);
  }
});
test('host or credential changes between chunks discard the transfer without crossing destinations', async () => {
  let current = connection;
  const f = fixture(command => { if (command === 'session_upload_write') current = { ...connection, token: 'changed' }; });
  await assert.rejects(uploadSessionFile(connection, 'p', 's', new File(['private'], 'note.txt'), { current: () => current }, f.call), /Cambió la laptop/);
  assert.equal(f.calls.filter(c => c.command === 'session_upload_begin').length, 1);
  assert.equal(f.calls.some(c => c.command === 'session_upload_send'), false);
});
test('cancelling an in-flight upload releases the caller and ignores a later receipt', async () => {
  let finish; const controller = new AbortController();
  const f = fixture(command => command === 'session_upload_send' ? new Promise(resolve => { finish = resolve; }) : undefined);
  const file = new File(['original'], 'note.txt');
  const upload = uploadSessionFile(connection, 'p', 's', file, options({ signal: controller.signal }), f.call);
  while (!finish) await new Promise(resolve => setTimeout(resolve, 0));
  controller.abort(); await assert.rejects(upload, { name: 'AbortError' });
  finish({ ok: true, status: 200, body: '{}' });
  assert.equal(await file.text(), 'original'); assert.equal(f.calls.some(c => c.command === 'session_upload_cancel'), true);
  assert.equal(f.calls.filter(c => c.command === 'session_upload_send').length, 1);
});
test('missing, wrong-sized, cross-batch and unsafe receipts never authorize a prompt', async () => {
  const valid = { uploadId: batch, name: 'note.txt', size: 1, mime: 'application/octet-stream', path: `uploads/${batch}/note.txt` };
  for (const value of [null, { ...valid, size: 2 }, { ...valid, uploadId: 'another_batch' }, { ...valid, name: '../note.txt' }, { ...valid, path: '/private/file' }, { ...valid, mime: 'text/html' }]) {
    const f = fixture(command => command === 'session_upload_send' ? { ok: true, status: 200, body: JSON.stringify(value) } : undefined);
    await assert.rejects(uploadSessionFile(connection, 'p', 's', new File(['x'], 'note.txt'), options({ uploadId: batch }), f.call), /recibo/);
    assert.equal(f.calls.filter(c => c.command === 'session_upload_send').length, 1);
  }
});
test('an empty file has a verified digest and receipt without inventing a data block', async () => {
  const f = fixture(); const receipt = await uploadSessionFile(connection, 'p', 's', new File([], 'empty.txt'), options(), f.call);
  assert.equal(receipt.size, 0); assert.equal(f.calls.some(c => c.command === 'session_upload_write'), false);
});
