import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalWorkManifest, parseClientMessage, parseWorkSyncReply, type WorkSyncManifest, type WorkSyncRequest } from '@gentle-dot/protocol';
import { expect, it } from 'vitest';
import { WorkSyncStore } from '../src/work-sync.ts';
import { tempDir } from './helpers.ts';

const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const manifest = (bytes = Buffer.from('meeting evidence')): WorkSyncManifest => ({ schema: 1, workId: 'work-1', revision: 3, title: 'Meeting', kind: 'meeting', instruction: 'Prepare a draft only', files: [{ id: 'audio-1', name: '../untrusted.m4a', mime: 'audio/mp4', bytes: bytes.length, sha256: hash(bytes), role: 'attachment' }] });
function fixture(bytes = Buffer.from('meeting evidence')) {
  const root = join(tempDir(), 'inbox'); const store = new WorkSyncStore(root); const transferId = randomUUID(); const content = manifest(bytes); const manifestHash = hash(canonicalWorkManifest(content));
  const request = (operation: Record<string, unknown>) => ({ type: 'work_sync', requestId: randomUUID(), transferId, ...operation }) as WorkSyncRequest;
  const send = (operation: Record<string, unknown>, owner = 'paired-device-1') => store.handle(owner, request(operation));
  return { root, store, transferId, content, manifestHash, bytes, request, send, begin: () => send({ operation: 'begin', manifest: content, manifestHash }) };
}
it('persists bytes before a correlated commit; lost ACK is recovered unchanged after restart', async () => {
  const f = fixture(); expect(await f.begin()).toMatchObject({ state: 'uploading', offsets: { 'audio-1': 0 } });
  expect(await f.send({ operation: 'chunk', fileId: 'audio-1', offset: 0, data: f.bytes.toString('base64') })).toMatchObject({ state: 'uploading', offsets: { 'audio-1': f.bytes.length } });
  const committed = await f.send({ operation: 'commit' }); expect(committed.state).toBe('committed'); expect(parseWorkSyncReply(committed)).toEqual(committed);
  const afterRestart = new WorkSyncStore(f.root); const recovered = await afterRestart.handle('paired-device-1', f.request({ operation: 'status' }));
  expect(recovered).toMatchObject({ state: 'committed', ...(committed.state === 'committed' ? { receipt: committed.receipt } : {}) });
  const directory = join(f.root, hash('paired-device-1'), f.transferId);
  expect(await readFile(join(directory, 'audio-1'))).toEqual(f.bytes);
  expect((await stat(join(directory, 'audio-1'))).mode & 0o777).toBe(0o600);
  expect((await stat(directory)).mode & 0o777).toBe(0o700);
  expect(await readdir(directory)).toEqual(expect.arrayContaining(['manifest.json', 'audio-1']));
});
it('resumes durable offsets, accepts byte-identical duplicates, rejects conflicting duplicates/gaps', async () => {
  const f = fixture(); await f.begin();
  const chunk = { operation: 'chunk', fileId: 'audio-1', offset: 0, data: f.bytes.subarray(0, 7).toString('base64') };
  await f.send(chunk); expect(await f.send(chunk)).toMatchObject({ state: 'uploading', offsets: { 'audio-1': 7 } });
  expect(await new WorkSyncStore(f.root).handle('paired-device-1', f.request({ operation: 'status' }))).toMatchObject({ state: 'uploading', offsets: { 'audio-1': 7 } });
  expect(await f.send({ ...chunk, data: Buffer.from('changed').toString('base64') })).toMatchObject({ state: 'error', code: 'conflict' });
  expect(await f.send({ ...chunk, offset: 9 })).toMatchObject({ state: 'error', code: 'conflict' });
  expect(await f.send({ operation: 'commit' })).toMatchObject({ state: 'error', code: 'conflict' });
});
it('isolates authenticated owners and binds transfer IDs to the exact reviewed manifest', async () => {
  const f = fixture(); await f.begin();
  expect(await f.send({ operation: 'status' }, 'paired-device-2')).toMatchObject({ state: 'missing' });
  const changed = { ...f.content, instruction: 'Send external email' };
  expect(await f.send({ operation: 'begin', manifest: changed, manifestHash: hash(canonicalWorkManifest(changed)) })).toMatchObject({ state: 'error', code: 'conflict' });
  expect(await f.send({ operation: 'begin', manifest: changed, manifestHash: f.manifestHash })).toMatchObject({ state: 'error', code: 'invalid' });
});
it('checks hashes at commit and serializes concurrent chunks without silently duplicating bytes', async () => {
  const f = fixture(); await f.begin();
  const chunk = { operation: 'chunk', fileId: 'audio-1', offset: 0, data: f.bytes.toString('base64') };
  const replies = await Promise.all([f.send(chunk), f.send(chunk)]); expect(replies.every(r => r.state === 'uploading')).toBe(true);
  await writeFile(join(f.root, hash('paired-device-1'), f.transferId, 'audio-1'), Buffer.alloc(f.bytes.length));
  expect(await f.send({ operation: 'commit' })).toMatchObject({ state: 'error', code: 'conflict' });
});
it('checks a multi-block attachment before committing and refuses a substituted symlink', async () => {
  const bytes = Buffer.alloc(700_123); for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37 + (i >>> 8)) & 255;
  const f = fixture(bytes); await f.begin();
  const path = join(f.root, hash('paired-device-1'), f.transferId, 'audio-1');
  await writeFile(path, bytes);
  expect(await f.send({ operation: 'commit' })).toMatchObject({ state: 'committed' });
  const g = fixture(bytes); await g.begin();
  const other = join(g.root, hash('paired-device-1'), g.transferId, 'audio-1');
  await writeFile(other, bytes); await unlink(other); await symlink(path, other);
  expect(await g.send({ operation: 'commit' })).toMatchObject({ state: 'error' });
  expect(await readFile(path)).toEqual(bytes);
});
it('validates protocol frames and rejects traversal, oversized chunks, duplicate IDs and wrong receipts', () => {
  const f = fixture(); const begin = f.request({ operation: 'begin', manifest: f.content, manifestHash: f.manifestHash });
  expect(parseClientMessage(JSON.stringify(begin))).toEqual(begin);
  for (const invalid of [{ ...begin, transferId: '../outside' }, { ...begin, manifest: { ...f.content, files: [f.content.files[0], f.content.files[0]] } }, f.request({ operation: 'chunk', fileId: 'audio-1', offset: -1, data: 'eA==' }), f.request({ operation: 'chunk', fileId: 'audio-1', offset: 0, data: 'a'.repeat(100_000) })]) expect(parseClientMessage(JSON.stringify(invalid))).toBeUndefined();
  expect(parseWorkSyncReply({ type: 'work_sync_reply', requestId: 'r1', transferId: 'a', state: 'committed', receipt: { transferId: 'b', workId: 'w', revision: 1, manifestHash: f.manifestHash, committedAt: 1 } })).toBeUndefined();
});
