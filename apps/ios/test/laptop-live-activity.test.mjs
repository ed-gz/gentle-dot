import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLaptopLiveActivity } from '../src/laptop-live-activity.ts';

const id = 'd3dba896-4b5c-4c1c-98c9-4e60238fe6b9';
const nextId = 'a3dba896-4b5c-4c1c-98c9-4e60238fe6b9';
const when = 1_800_000_000_000;
function fixture() {
  const calls = [], ids = [id, nextId];
  let state = { enabled: true, status: 'ready' };
  const coordinator = {
    snapshot: () => structuredClone(state),
    observe: async value => { calls.push(['observe', value]); state = { ...state, status: 'active', activity: { ...value, id: 'native', sequence: 1 } }; },
    finish: async value => { calls.push(['finish', value]); state = { enabled: true, status: 'ready' }; },
  };
  return { calls, coordinator, set: value => { state = value; }, observer: createLaptopLiveActivity({ coordinator, identifier: () => ids.shift() }) };
}
const ready = state => ({ type: 'ready', agentState: state });
const update = state => ({ type: 'agent_state', state });

test('separate opt-in waits for a real daemon event and shows only global phases', async () => {
  const f = fixture();
  await f.observer.message(ready('thinking'),when); assert.deepEqual(f.calls, []);
  await f.observer.setEnabled(true); assert.deepEqual(f.calls, []);
  await f.observer.message(ready('thinking'),when); assert.deepEqual(f.calls, []);
  await f.observer.start(ready('thinking'),when);
  await f.observer.message(update('working'),when+1);
  await f.observer.message(update('needs_you'),when+2);
  assert.deepEqual(f.calls, [
    ['observe', { origin: 'laptop', turnId: id, phase: 'thinking', observedAt:when }],
    ['observe', { origin: 'laptop', turnId: id, phase: 'working', observedAt:when+1 }],
    ['observe', { origin: 'laptop', turnId: id, phase: 'attention', observedAt:when+2 }],
  ]);
  await f.observer.message(update('idle'),when+3);
  assert.deepEqual(f.calls.at(-1), ['finish', { origin: 'laptop', turnId: id, phase: 'dismissed' }]);
  await f.observer.message(update('working'),when+4); assert.equal(f.calls.at(-1)[0], 'finish');
  await f.observer.start(update('working'),when+4);
  assert.equal(f.calls.at(-1)[1].turnId, nextId);
});

test('disconnect does not assert completion or relabel the previous observation on a new connection', async () => {
  const f = fixture(); await f.observer.setEnabled(true); await f.observer.start(ready('working'),when);
  f.observer.disconnected(); assert.equal(f.calls.length, 1);
  await f.observer.message(ready('needs_you'),when+1);
  await f.observer.message(update('restarting'),when+2);
  assert.equal(f.calls.length,1);
  await f.observer.setEnabled(false);
  assert.deepEqual(f.calls.at(-1), ['finish', {origin:'laptop',turnId:id,phase:'dismissed'}]);
  await f.observer.setEnabled(true);await f.observer.start(ready('needs_you'),when+3);
  assert.deepEqual(f.calls.at(-1), ['observe', { origin: 'laptop', turnId: nextId, phase: 'attention', observedAt:when+3 }]);
});

test('only authenticated state events are accepted, never socket sends or message completions', async () => {
  const f = fixture(); await f.observer.setEnabled(true);
  for (const message of [{ type: 'send' }, { type: 'message_done' }, { type: 'interrupted' }, { type: 'activity' }]) await f.observer.message(message,when);
  assert.deepEqual(f.calls, []);
  await f.observer.message(ready('error'),when); await f.observer.message(update('starting'),when);
  assert.deepEqual(f.calls, []);
});

test('a disconnected generation discards queued events and does not touch another activity', async () => {
  const f = fixture(); await f.observer.setEnabled(true);
  const p = f.observer.start(ready('working'),when); f.observer.disconnected(); await p;
  assert.deepEqual(f.calls, []);
  f.set({ enabled: true, status: 'active', activity: { origin: 'iphone', turnId: nextId } });
  await f.observer.setEnabled(true);
  await f.observer.start(ready('working'),when); assert.deepEqual(f.calls, []);
});

test('opt-out closes only its own display without stopping the daemon', async () => {
  const f = fixture(); await f.observer.setEnabled(true); await f.observer.start(ready('thinking'),when);
  await f.observer.setEnabled(false);
  assert.deepEqual(f.calls.at(-1), ['finish', { origin: 'laptop', turnId: id, phase: 'dismissed' }]);
  await f.observer.message(update('working'),when); assert.equal(f.calls.length, 2);
});
