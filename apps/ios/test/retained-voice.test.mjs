import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRetainedVoiceBridge, parseRetainedVoiceRecord } from '../src/retained-voice.ts';
import { VoiceBridgeTimeout, VoiceCancelUnconfirmed, VoiceRetryPending } from '../src/perception.ts';

const id = '11111111-1111-4111-8111-111111111111', owner = '22222222-2222-4222-8222-222222222222';
const capturing = () => ({ id, owner, destination: 'chat', locale: 'es-MX', kind: 'speech', createdAt: 50, state: 'capturing' });
const ready = () => ({ ...capturing(), state: 'ready', byteCount: 100, sha256: 'a'.repeat(64) });
const transcript = () => ({ ok: true, sessionId: id, source: 'apple-speech-analyzer', locale: 'es-MX', durationSeconds: 2,
  text: 'Hola Capri.', segments: [{ text: 'Hola Capri.', startSeconds: 0, endSeconds: 1.8 }] });

test('retention records require exact identity and bounded closed bytes', () => {
  assert.deepEqual(parseRetainedVoiceRecord(capturing()), capturing());
  assert.deepEqual(parseRetainedVoiceRecord(ready()), ready());
  for (const modify of [
    v => { v.id = owner; }, v => { v.owner = '../audio'; }, v => { v.destination = 'session:short'; },
    v => { v.locale = 'en-US'; }, v => { v.kind = 'cloud'; }, v => { v.createdAt = 0; },
    v => { v.byteCount = 0; }, v => { v.byteCount = 128 * 1024 * 1024 + 1; }, v => { v.sha256 = 'x'.repeat(64); },
    v => { v.path = '/private/audio'; }, v => { v.state = 'capturing'; },
  ]) { const value = ready(); modify(value); assert.throws(() => parseRetainedVoiceRecord(value)); }
});

test('protected start and stop bind the same owner, destination, audio and transcript', async () => {
  const calls = [];
  const bridge = createRetainedVoiceBridge(async (command, args) => {
    calls.push({ command, args: structuredClone(args) });
    if (command === 'start_voice') return { ok: true, sessionId: id, maxDurationSeconds: 90, retainedAudio: capturing() };
    if (command === 'stop_voice') return { ...transcript(), retainedAudio: ready() };
    throw new Error('Unexpected native operation');
  });
  const start = await bridge.start(owner, 'chat');
  const done = await bridge.stop(start.record);
  assert.deepEqual(done.record, ready()); assert.equal(done.transcript.text, 'Hola Capri.');
  assert.deepEqual(calls.map(call => call.command), ['start_voice', 'stop_voice']);
  assert.deepEqual(calls[1].args, { sessionId: id, ownerId: owner, retainDestination: 'chat' });
});

test('invalid or cross-destination start is fenced by the exact owner', async () => {
  const calls = [];
  const bridge = createRetainedVoiceBridge(async (command, args) => {
    calls.push({ command, args });
    if (command === 'start_voice') return { ok: true, sessionId: id, maxDurationSeconds: 90, retainedAudio: { ...capturing(), destination: `session:${'b'.repeat(64)}` } };
    if (command === 'cancel_voice') return { ok: true };
    throw new Error('Unexpected operation');
  });
  await assert.rejects(bridge.start(owner, 'chat'));
  assert.deepEqual(calls.map(call => call.command), ['start_voice', 'cancel_voice']);
  assert.deepEqual(calls[1].args, { ownerId: owner });
  await assert.rejects(bridge.start(owner, 'invalid'));
  assert.equal(calls.length, 2);
});

test('lost start response fences only its owner and ignores a late completion', async () => {
  let resolveStart;
  const calls = [];
  const bridge = createRetainedVoiceBridge(async (command, args) => {
    calls.push({ command, args });
    if (command === 'start_voice') return await new Promise(resolve => { resolveStart = resolve; });
    if (command === 'cancel_voice') return { ok: true };
    throw new Error('Unexpected operation');
  }, { start: 5, cancel: 50 });
  await assert.rejects(bridge.start(owner, 'chat'), VoiceBridgeTimeout);
  resolveStart({ ok: true, sessionId: id, maxDurationSeconds: 90, retainedAudio: capturing() });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(calls.map(call => call.command), ['start_voice', 'cancel_voice']);
  assert.deepEqual(calls[1].args, { ownerId: owner });

  const unconfirmed = createRetainedVoiceBridge(async () => await new Promise(() => {}), { start: 5, cancel: 5 });
  await assert.rejects(unconfirmed.start(owner, 'chat'), VoiceCancelUnconfirmed);
});

test('late retries, altered audio metadata and wrong transcript never acknowledge work', async () => {
  for (const change of [
    r => { r.retainedAudio.owner = id; }, r => { r.retainedAudio.destination = `session:${'b'.repeat(64)}`; },
    r => { r.retainedAudio.createdAt++; }, r => { r.retainedAudio.sha256 = 'b'.repeat(64); },
    r => { r.locale = 'es-ES'; }, r => { r.text = 'Otro texto'; },
  ]) {
    const result = { ...transcript(), retainedAudio: ready() }; change(result);
    const calls = [];
    const bridge = createRetainedVoiceBridge(async command => { calls.push(command); return result; });
    await assert.rejects(bridge.stop(ready()));
    assert.deepEqual(calls, ['stop_voice']);
  }
  const bridge = createRetainedVoiceBridge(async () => ({ ok: false, error: 'preview_pending', sessionId: id, message: 'Audio pendiente.' }));
  await assert.rejects(bridge.stop(capturing()), error => error instanceof VoiceRetryPending && error.sessionId === id);
});

test('inspection and attachment reject changed identity and never delete audio', async () => {
  const calls = [];
  const bridge = createRetainedVoiceBridge(async command => {
    calls.push(command);
    if (command === 'inspect_retained_voice') return { ok: true, retainedAudio: ready() };
    if (command === 'attach_retained_voice') return { ok: true, sessionId: id, ownerId: owner, retainedAudio: ready() };
    throw new Error('Unexpected operation');
  });
  const record = await bridge.inspect();
  assert.deepEqual(await bridge.attach(record), ready());
  await assert.rejects(bridge.attach(capturing()));
  const altered = createRetainedVoiceBridge(async () => ({ ok: true, sessionId: id, ownerId: owner, retainedAudio: { ...ready(), byteCount: 101 } }));
  await assert.rejects(altered.attach(record));
  assert.deepEqual(calls, ['inspect_retained_voice', 'attach_retained_voice']);
});
