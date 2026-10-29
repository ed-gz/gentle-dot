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

test('native UUID spelling survives capture, stop, inspection and attachment', async () => {
  const nativeId = 'ABCDEF01-ABCD-4BCD-8BCD-ABCDEF012345';
  const nativeOwner = 'abcdef02-abcd-4bcd-8bcd-abcdef012345';
  const pending = { ...capturing(), id: nativeId, owner: nativeOwner };
  const closed = { ...ready(), id: nativeId, owner: nativeOwner };
  const nativeTranscript = { ...transcript(), sessionId: nativeId };
  const seen = [];
  const bridge = createRetainedVoiceBridge(async (command, args) => {
    seen.push(command);
    if (command === 'start_voice') {
      assert.equal(args.ownerId, nativeOwner);
      return { ok: true, sessionId: nativeId, maxDurationSeconds: 90, retainedAudio: pending };
    }
    if (command === 'stop_voice') {
      assert.equal(args.sessionId, nativeId); // Swift checks literal session ID.
      assert.equal(args.ownerId, nativeOwner);
      return { ...nativeTranscript, retainedAudio: closed };
    }
    if (command === 'inspect_retained_voice') return { ok: true, retainedAudio: closed };
    if (command === 'attach_retained_voice') {
      assert.deepEqual(args.record, closed); // Swift compares the full serialized record.
      return { ok: true, sessionId: nativeId, ownerId: nativeOwner, retainedAudio: closed };
    }
    throw new Error('Unexpected native operation');
  });
  const started = await bridge.start(nativeOwner.toUpperCase(), 'chat');
  assert.equal(started.record.id, nativeId);
  assert.equal((await bridge.stop(started.record)).transcript.sessionId, nativeId);
  const inspected = await bridge.inspect();
  assert.deepEqual(await bridge.attach(inspected), closed);
  assert.deepEqual(seen, ['start_voice', 'stop_voice', 'inspect_retained_voice', 'attach_retained_voice']);
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

test('explicit discard drains the exact owner and refuses a changed or uncertain record', async () => {
  const calls = [];
  const bridge = createRetainedVoiceBridge(async (command, args) => {
    calls.push({ command, args });
    if (command === 'cancel_voice') return { ok: true };
    if (command === 'inspect_retained_voice') return { ok: true, retainedAudio: capturing() };
    if (command === 'discard_retained_voice') return { ok: true };
    throw new Error('Unexpected operation');
  });
  await bridge.discard(capturing());
  assert.deepEqual(calls.map(call => call.command), ['cancel_voice', 'inspect_retained_voice', 'discard_retained_voice']);
  assert.deepEqual(calls[2].args.record, capturing());
  calls.length = 0;
  const changed = createRetainedVoiceBridge(async (command) => { calls.push({ command }); return command === 'cancel_voice' ? { ok: true } : { ok: true, retainedAudio: { ...capturing(), destination: `session:${'b'.repeat(64)}` } }; });
  await assert.rejects(changed.discard(capturing()));
  assert.deepEqual(calls.map(call => call.command), ['cancel_voice', 'inspect_retained_voice']);
  calls.length = 0;
  const uncertain = createRetainedVoiceBridge(async command => { calls.push({ command }); throw new Error('lost callback'); });
  await assert.rejects(uncertain.discard(capturing()));
  assert.deepEqual(calls.map(call => call.command), ['cancel_voice']);
});

test('pending native discard is retried by identity and never attached as audio', async () => {
  const calls = [];
  const bridge = createRetainedVoiceBridge(async (command, args) => {
    calls.push({ command, args });
    if (command === 'cancel_voice') return { ok: true };
    if (command === 'inspect_retained_voice') return { ok: true, discardPending: capturing() };
    if (command === 'discard_retained_voice') return { ok: true };
    throw new Error('Unexpected operation');
  });
  assert.deepEqual(await bridge.inspectState(), { state: 'discard-pending', record: capturing() });
  await assert.rejects(bridge.inspect(), /espera confirmación/);
  await bridge.discard(capturing());
  assert.deepEqual(calls.map(call => call.command), ['inspect_retained_voice', 'inspect_retained_voice', 'cancel_voice', 'inspect_retained_voice', 'discard_retained_voice']);
  assert.deepEqual(calls.at(-1).args.record, capturing());
  const ambiguous = createRetainedVoiceBridge(async () => ({ ok: true, retainedAudio: capturing(), discardPending: capturing() }));
  await assert.rejects(ambiguous.inspectState());
});

test('incomplete audio export sends only the exact record and requires a picker result', async () => {
  const calls = [];
  let response = { ok: true, exported: true, cancelled: false };
  const bridge = createRetainedVoiceBridge(async (command, args) => { calls.push({ command, args }); return response; });
  assert.equal(await bridge.exportIncomplete(capturing()), 'exported');
  assert.deepEqual(calls, [{ command: 'export_incomplete_voice', args: { record: capturing() } }]);
  response = { ok: true, exported: false, cancelled: true };
  assert.equal(await bridge.exportIncomplete(capturing()), 'cancelled');
  for (const bad of [{ ok: true }, { ok: true, exported: true, cancelled: true }, { ok: false, exported: true, cancelled: false }]) {
    response = bad; await assert.rejects(bridge.exportIncomplete(capturing()));
  }
  const count = calls.length;
  await assert.rejects(bridge.exportIncomplete(ready()));
  assert.equal(calls.length, count);
});

test('exact retained asset preparation rejects altered audio, mismatched locale and old owners', async () => {
  const fresh = '33333333-3333-4333-8333-333333333333';
  let current = ready(); let result = { ok: true, available: true, status: 'available', locale: 'es-MX', assetsInstalled: true }; const calls = [];
  const bridge = createRetainedVoiceBridge(async (command, args) => {
    calls.push({ command, args });
    if (command === 'prepare_retained_voice') return result;
    if (command === 'inspect_retained_voice') return { ok: true, retainedAudio: current };
    if (command === 'attach_retained_voice') return { ok: false, error: 'assets_required' };
    throw new Error('Unexpected operation');
  });
  await assert.rejects(bridge.attach(ready()), /Prepara el idioma/);
  await assert.rejects(bridge.prepare(ready(), owner));
  await bridge.prepare(ready(), fresh);
  assert.deepEqual(calls.find(x => x.command === 'prepare_retained_voice').args, { record: ready(), ownerId: fresh });
  current = { ...ready(), sha256: 'b'.repeat(64) };
  await assert.rejects(bridge.prepare(ready(), fresh));
  current = ready(); result = { ...result, locale: 'es-ES' };
  await assert.rejects(bridge.prepare(ready(), fresh));
  assert.ok(!calls.some(x => x.command.includes('discard') || x.command.includes('release')));
});
