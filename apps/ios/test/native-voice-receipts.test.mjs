import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNativeVoiceReceipts, parseNativeVoiceReceipt } from '../src/native-voice-receipts.ts';

const id = 'ABCDEF01-ABCD-4BCD-8BCD-ABCDEF012345';
const owner = 'abcdef02-abcd-4bcd-8bcd-abcdef012345';
const audio = () => ({ id, owner, destination: 'chat', locale: 'es-MX', kind: 'speech', createdAt: 1, state: 'ready', byteCount: 400, sha256: 'a'.repeat(64) });
const receipt = (text = 'Hola Capri') => ({ schema: 'capri-native-voice-receipt/v1', audio: audio(), transcript: {
  sessionId: id, text, segments: [{ text, startSeconds: 0, endSeconds: 2 }], durationSeconds: 2, locale: 'es-MX', source: 'apple-speech-analyzer',
} });
const envelope = (value = receipt()) => ({ receipt: value, releaseState: 'retained' });

test('full native receipt preserves UUID spelling and a transcript longer than the composer', () => {
  const value = receipt('a'.repeat(12000));
  assert.deepEqual(parseNativeVoiceReceipt(value), value);
});

test('native receipt rejects altered source, destination, segments, and private payloads', () => {
  for (const mutate of [
    r => { r.audio.state = 'capturing'; }, r => { r.audio.destination = 'session:short'; },
    r => { r.transcript.sessionId = owner; }, r => { r.transcript.locale = 'es-ES'; },
    r => { r.transcript.text = 'other'; }, r => { r.transcript.segments[0].endSeconds = 3; },
    r => { r.transcript.segments[0].path = '/private/audio'; }, r => { r.path = '/private/audio'; },
  ]) { const value = receipt(); mutate(value); assert.throws(() => parseNativeVoiceReceipt(value)); }
});

test('list/get preserve exact source identity and reject duplicates or another result', async () => {
  const calls = [];
  const client = createNativeVoiceReceipts(async (command, args) => {
    calls.push({ command, args });
    if (command === 'list_voice_receipts') return { ok: true, receipts: [envelope()] };
    if (command === 'get_voice_receipt') return { ok: true, receipt: envelope() };
    throw new Error('unexpected');
  });
  assert.deepEqual(await client.list(), [envelope()]);
  assert.deepEqual(await client.get(id.toLowerCase()), envelope());
  assert.deepEqual(calls.map(call => call.command), ['list_voice_receipts', 'get_voice_receipt']);
  await assert.rejects(createNativeVoiceReceipts(async () => ({ ok: true, receipts: [envelope(), envelope()] })).list());
  await assert.rejects(createNativeVoiceReceipts(async () => ({ ok: true, receipt: envelope() })).get(owner));
});

test('release requires native confirmation; discard is a separate explicit operation', async () => {
  const calls = [];
  const client = createNativeVoiceReceipts(async (command, args) => { calls.push({ command, args });
    if (command === 'release_retained_voice') return { ok: true, releaseState: 'released' };
    if (command === 'discard_voice_receipt') return { ok: true };
    throw new Error('unexpected');
  });
  await client.release(receipt()); await client.discard(receipt());
  assert.deepEqual(calls.map(call => call.command), ['release_retained_voice', 'discard_voice_receipt']);
  assert.deepEqual(calls[0].args.receipt, receipt());
  for (const reply of [{ ok: true, releaseState: 'releasing' }, { ok: false }, {}]) {
    await assert.rejects(createNativeVoiceReceipts(async () => reply).release(receipt()));
  }
});
