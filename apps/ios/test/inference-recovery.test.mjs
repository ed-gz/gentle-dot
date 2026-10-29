import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseInferenceSnapshot, recoverInferenceResults, withInferenceDeadline } from '../src/inference-recovery.ts';
import { updateEntry } from '../src/conversation.ts';
import { archiveEntry } from '../src/conversation-archive.ts';

const id = 'd3dba896-4b5c-4c1c-98c9-4e60238fe6b9', revision = 'a3dba896-4b5c-4c1c-98c9-4e60238fe6b9';
const answer = { id, revision, startedAt: 1234, status: 'answer', text: 'La respuesta terminada.' };
const anchor = { id, engine: 'iphone', role: 'assistant', state: 'interrupted', text: '', at: 1234,
  activities: [{ id: 'receipt', kind: 'other', title: 'Borrador guardado', status: 'done', detail: 'Recibo confirmado' }] };
test('an unresponsive native bridge releases recovery without assuming its eventual result', async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  await assert.rejects(withInferenceDeadline(pending, 5), /no respondió a tiempo/);
  finish({ ok: true });
  await pending;
});
function fixture(records = [answer], entry = anchor) {
  let stored = structuredClone(entry);
  const events = [];
  const options = {
    list: async () => ({ items: structuredClone(records) }), find: async () => stored,
    apply(value) { events.push('apply'); stored = value; },
    commit: async () => { events.push('commit'); return true; },
    acknowledge: async value => { events.push(['ack', value.id, value.revision]); },
  };
  return { options, events, get: () => stored };
}
test('native journal validates identities, bounds and active ownership, stripping unknown fields', () => {
  assert.deepEqual(parseInferenceSnapshot({ ok: true, items: [{ ...answer, token: 'discard' }], activeId: null }), { items: [answer] });
  for (const value of [null, { ok: true }, { ok: true, items: [answer, answer] }, { ok: true, items: [answer], activeId: revision },
    { ok: true, items: [{ ...answer, status: 'tool', argumentsJSON: '{}' }] }, { ok: true, items: [{ ...answer, status: 'pending' }] },
    { ok: true, items: [{ ...answer, id: '../escape' }] }, { ok: true, items: [{ ...answer, text: '🦖'.repeat(2401) }] }]) {
    assert.throws(() => parseInferenceSnapshot(value));
  }
});
test('recovered answer keeps its original turn and receipts, then ACKs only after commit', async () => {
  const f = fixture(); await recoverInferenceResults(f.options);
  assert.deepEqual(f.events, ['apply', 'commit', ['ack', id, revision]]);
  assert.deepEqual(f.get(), { ...anchor, text: answer.text, state: 'complete' });
});
test('storage failure retains native copy; retry does not duplicate the answer', async () => {
  const f = fixture(); f.options.commit = async () => false;
  await assert.rejects(recoverInferenceResults(f.options), /no confirmó/);
  assert.deepEqual(f.events, ['apply']);
  f.options.commit = async () => { f.events.push('commit'); return true; };
  await recoverInferenceResults(f.options);
  assert.deepEqual(f.events, ['apply', 'commit', ['ack', id, revision]]);
});
test('lost ACK is retried without rewriting an already committed answer', async () => {
  const f = fixture(); f.options.acknowledge = async () => { throw new Error('lost receipt'); };
  await assert.rejects(recoverInferenceResults(f.options), /lost receipt/);
  f.options.acknowledge = async () => f.events.push('ack retry'); await recoverInferenceResults(f.options);
  assert.deepEqual(f.events, ['apply', 'commit', 'commit', 'ack retry']);
});
test('missing or conflicting anchor never acknowledges or overwrites another message', async () => {
  for (const entry of [undefined, { ...anchor, role: 'user' }, { ...anchor, engine: 'gentle' }, { ...anchor, state: 'complete', text: 'Otro resultado' }]) {
    const f = fixture(); f.options.find = async () => entry;
    await assert.rejects(recoverInferenceResults(f.options)); assert.deepEqual(f.events, []);
  }
});
test('pending work only becomes interrupted content; no resumed model or tool call exists', async () => {
  const f = fixture([{ ...answer, status: 'interrupted', text: '' }]); await recoverInferenceResults(f.options);
  assert.equal(f.get().state, 'interrupted'); assert.equal(f.get().role, 'notice');
  assert.match(f.get().text, /no repetí ninguna operación/);
});
test('a linked interrupted result preserves its assistant identity and request link', async () => {
  const linked = { ...anchor, replyTo: '02bce422-1da0-4ebc-b2fb-9df32a25434e' };
  const f = fixture([{ ...answer, status: 'interrupted', text: '' }], linked);
  await recoverInferenceResults(f.options);
  assert.equal(f.get().role, 'assistant');
  assert.equal(f.get().replyTo, linked.replyTo);
  assert.equal(f.get().state, 'interrupted');
  assert.equal(archiveEntry(f.get()).replyTo, linked.replyTo);
});
test('a still-active native turn remains pending without ACK or replacement', async () => {
  const f = fixture(); f.options.list = async () => ({ items: [{ ...answer, status: 'pending', text: '' }], activeId: id });
  assert.deepEqual(await recoverInferenceResults(f.options), { activeId: id, recovered: 0 });
  assert.deepEqual(f.events, []);
});
test('human cancellation wins over a completed answer and survives conversation/archive sanitization', async () => {
  const cancelled = { ...anchor, localCancelled: true, text: 'Respuesta cancelada.' };
  const f = fixture([answer], cancelled); await recoverInferenceResults(f.options);
  assert.deepEqual(f.get(), cancelled); assert.equal(f.events[0], 'commit');
  const clean = updateEntry([], { ...cancelled, token: 'discard' })[0];
  assert.equal(clean.localCancelled, true); assert.equal(archiveEntry(clean).localCancelled, true);
  assert.equal(Object.hasOwn(clean, 'token'), false);
});
test('presentation is informed only after an acknowledged recovery and honours cancellation', async () => {
  const f = fixture([answer], { ...anchor, localCancelled: true });
  f.options.onSettled = (record, cancelled) => f.events.push(['settled', record.id, cancelled]);
  await recoverInferenceResults(f.options);
  assert.deepEqual(f.events, ['commit', ['ack', id, revision], ['settled', id, true]]);
  const failed = fixture();
  failed.options.commit = async () => false;
  failed.options.onSettled = () => assert.fail('must not notify presentation without a commit');
  await assert.rejects(recoverInferenceResults(failed.options));
});
