import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { blobSHA256 } from '../src/blob-sha256.ts';

test('hashes a multi-chunk file without reading its whole ArrayBuffer', async () => {
  const bytes = Buffer.alloc(1024 * 1024 + 29);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37 + (i >>> 8)) & 255;
  const blob = new Blob([bytes]);
  const slice = blob.slice.bind(blob); const ranges = [];
  blob.arrayBuffer = () => { throw new Error('whole-file read'); };
  blob.slice = (start, end) => { ranges.push([start, end]); return slice(start, end); };
  assert.equal(await blobSHA256(blob), createHash('sha256').update(bytes).digest('hex'));
  assert.ok(ranges.length > 1);
  assert.ok(ranges.every(([start, end]) => end - start <= 256 * 1024));
  assert.equal(ranges.at(-1)[1], blob.size);
});

test('handles empty input, aborts before subsequent chunks, and rejects short reads', async () => {
  assert.equal(await blobSHA256(new Blob()), createHash('sha256').digest('hex'));
  const abort = new AbortController(); const blob = new Blob([new Uint8Array(600_000)]), slice = blob.slice.bind(blob); let calls = 0;
  blob.slice = (start, end) => { calls++; const result = slice(start, end); if (calls === 1) abort.abort(); return result; };
  await assert.rejects(blobSHA256(blob, abort.signal), { name: 'AbortError' });
  assert.equal(calls, 1);
  const short = new Blob([new Uint8Array(10)]);
  short.slice = () => new Blob([new Uint8Array(9)]);
  await assert.rejects(blobSHA256(short), /todos los bytes/);
});
