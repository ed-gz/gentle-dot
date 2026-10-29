import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanupDeliveredVoiceReceipt, createProtectedVoice } from '../src/protected-voice.ts';
const id = 'ABCDEF01-ABCD-4BCD-8BCD-ABCDEF012345', owner = 'abcdef02-abcd-4bcd-8bcd-abcdef012345';
const capturing = () => ({ id, owner, destination: 'chat', locale: 'es-MX', kind: 'speech', createdAt: 1, state: 'capturing' });
const ready = () => ({ ...capturing(), state: 'ready', byteCount: 100, sha256: 'a'.repeat(64) });
const transcript = () => ({ sessionId: id, text: 'Hola Capri', segments: [{ text: 'Hola Capri', startSeconds: 0, endSeconds: 1 }], durationSeconds: 1, locale: 'es-MX', source: 'apple-speech-analyzer' });
const receipt = () => ({ schema: 'capri-native-voice-receipt/v1', audio: ready(), transcript: transcript() });
const envelope = () => ({ receipt: receipt(), releaseState: 'retained' });
function harness() {
  const calls = []; let saved, pending;
  const bridge = { inspect: async () => pending, start: async (ownerId, destination) => { calls.push(['start', ownerId, destination]); return { session: { sessionId: id, maxDurationSeconds: 90 }, record: capturing() }; },
    attach: async record => { calls.push(['attach', record.id]); }, stop: async () => { calls.push(['stop']); saved = envelope(); return { record: ready(), transcript: transcript() }; } };
  const receipts = { get: async () => { calls.push(['get']); return saved; }, release: async () => { calls.push(['release']); saved.releaseState = 'released'; } };
  const voice = createProtectedVoice({ bridge, receipts, cancel: async value => { calls.push(['cancel', value]); }, isDelivered: async () => true });
  return { voice, calls, setSaved: value => { saved = value; }, setPending: value => { pending = value; }, receipts };
}
test('recording returns only an exact durable receipt and release closes its owner lease first', async () => {
  const h = harness(); const start = await h.voice.start(owner, 'chat'); const result = await h.voice.finish(start.record);
  assert.deepEqual(result, envelope()); await h.voice.release(result.receipt);
  assert.deepEqual(h.calls.map(x => x[0]), ['start', 'get', 'stop', 'get', 'get', 'cancel', 'get', 'release']);
  assert.deepEqual(h.calls.find(x => x[0] === 'cancel'), ['cancel', owner]);
});
test('a lost stop callback is recovered from the exact native receipt without retranscribing', async () => {
  const h = harness(); h.setSaved(envelope());
  assert.deepEqual(await h.voice.recover(ready()), envelope());
  assert.deepEqual(h.calls.map(x => x[0]), ['get']);
});
test('wrong owner, destination, audio or transcript never release or apply', async () => {
  for (const mutate of [r => { r.receipt.audio.owner = id; }, r => { r.receipt.audio.destination = `session:${'b'.repeat(64)}`; }, r => { r.receipt.audio.sha256 = 'b'.repeat(64); }]) {
    const h = harness(), value = envelope(); mutate(value); h.setSaved(value);
    await assert.rejects(h.voice.recover(ready())); assert.deepEqual(h.calls.map(x => x[0]), ['get']);
  }
  const h = harness(); h.setSaved(envelope()); const changed = receipt(); changed.transcript.text = 'otro';
  await assert.rejects(h.voice.release(changed)); assert.deepEqual(h.calls.map(x => x[0]), ['get']);
});
test('a timeout or missing receipt preserves audio and blocks release', async () => {
  const h = harness(); h.setSaved(envelope());
  const voice = createProtectedVoice({ bridge: { inspect: async () => undefined, start: async () => {}, attach: async () => {}, stop: async () => {} }, receipts: h.receipts,
    cancel: async () => { throw new Error('closing'); }, isDelivered: async () => true });
  await assert.rejects(voice.release(receipt())); assert.deepEqual(h.calls.map(x => x[0]), ['get']);
  h.setSaved(undefined); await assert.rejects(h.voice.release(receipt()));
});

test('automatic release requires delivery before and after owner cancellation; manual release is explicit', async () => {
  const h = harness(); h.setSaved(envelope()); let delivered = false, cancels = 0, releases = 0;
  const voice = createProtectedVoice({ bridge: { inspect: async () => undefined, start: async () => {}, attach: async () => {}, stop: async () => {} },
    receipts: { get: h.receipts.get, release: async () => { releases++; } }, cancel: async () => { cancels++; delivered = false; }, isDelivered: async () => delivered });
  await assert.rejects(voice.release(receipt())); assert.equal(cancels, 0); assert.equal(releases, 0);
  delivered = true; await assert.rejects(voice.release(receipt())); assert.equal(cancels, 1); assert.equal(releases, 0);
  await voice.releaseManually(receipt()); assert.equal(cancels, 2); assert.equal(releases, 1);
});
test('previously released receipt is still revalidated by the native journal', async () => {
  const h = harness(); h.setSaved({ ...envelope(), releaseState: 'released' });
  await h.voice.release(receipt());
  assert.deepEqual(h.calls.map(x => x[0]), ['get', 'release']);
});
test('an incomplete recording and occupied slot cannot be silently replaced', async () => {
  const h = harness(); h.setPending(capturing());
  await assert.rejects(h.voice.start(owner, 'chat')); await assert.rejects(h.voice.recover(capturing()));
  assert.deepEqual(h.calls.map(x => x[0]), ['get']);
});

test('cleanup never discards pending or changed receipts and requires delivery again after release', async () => {
  const calls = [], value = receipt(); let delivered = false, changed = false, releaseState = 'released';
  const deps = { delivered: async () => { calls.push('delivered'); return delivered; }, release: async () => { calls.push('release'); },
    get: async () => { calls.push('get'); const result = receipt(); if (changed) result.audio.byteCount++; return { receipt: result, releaseState }; }, discard: async () => { calls.push('discard'); } };
  await cleanupDeliveredVoiceReceipt(value, deps); assert.deepEqual(calls, ['delivered']);
  calls.length = 0; delivered = true; changed = true;
  await assert.rejects(cleanupDeliveredVoiceReceipt(value, deps)); assert.deepEqual(calls, ['delivered', 'release', 'get']);
  calls.length = 0; changed = false; releaseState = 'retained';
  await assert.rejects(cleanupDeliveredVoiceReceipt(value, deps)); assert.deepEqual(calls, ['delivered', 'release', 'get']);
  calls.length = 0; releaseState = 'released';
  let checks = 0; deps.delivered = async () => { calls.push('delivered'); return ++checks === 1; };
  await assert.rejects(cleanupDeliveredVoiceReceipt(value, deps)); assert.deepEqual(calls, ['delivered', 'release', 'get', 'delivered']);
  calls.length = 0; deps.delivered = async () => { calls.push('delivered'); return true; };
  await cleanupDeliveredVoiceReceipt(value, deps); assert.deepEqual(calls, ['delivered', 'release', 'get', 'delivered', 'discard']);
});
