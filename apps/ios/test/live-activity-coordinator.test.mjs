import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLiveActivityCoordinator } from '../src/live-activity-coordinator.ts';
import { createLiveActivityBridge } from '../src/live-activity.ts';

const id = 'd3dba896-4b5c-4c1c-98c9-4e60238fe6b9', other = 'a3dba896-4b5c-4c1c-98c9-4e60238fe6b9';
const turn = { turnId: id, origin: 'iphone', phase: 'thinking' };
const item = { id: 'activity-1', ...turn, sequence: 1, observedAt: 1234, stale: false };
function fixture(initial = []) {
  let inventory = structuredClone(initial); const calls = [];
  const bridge = {
    availability: async () => { calls.push(['available']); return true; },
    list: async () => { calls.push(['list']); return structuredClone(inventory); },
    start: async input => { calls.push(['start', input]); const saved = { ...input, id: 'activity-1', observedAt: 1234, stale: false }; inventory = [saved]; return structuredClone(saved); },
    update: async (input, ending = false) => {
      calls.push([ending ? 'end' : 'update', input]);
      if (ending) inventory = [];
      else inventory = [{ ...input, observedAt: 2345, stale: false }];
    },
  };
  return { bridge, calls, get: () => inventory, set: value => { inventory = structuredClone(value); } };
}
const callNames = calls => calls.map(call => call[0]);

test('opt-in inspects availability and inventory, but starts only from an actual event', async () => {
  const f = fixture(); const coordinator = createLiveActivityCoordinator({ bridge: f.bridge });
  await coordinator.observe(turn); assert.deepEqual(f.calls, []);
  await coordinator.setEnabled(true); assert.deepEqual(callNames(f.calls), ['available', 'list']);
  assert.equal(coordinator.snapshot().status, 'ready');
  await coordinator.observe({ ...turn, secret: 'never send' });
  assert.deepEqual(f.calls[2], ['start', { ...turn, sequence: 1 }]);
  assert.deepEqual(coordinator.snapshot().activity, item);
});

test('each update is monotonic and only publishes the state observed from ActivityKit', async () => {
  const f = fixture(); const coordinator = createLiveActivityCoordinator({ bridge: f.bridge });
  await coordinator.setEnabled(true); await coordinator.observe(turn);
  await coordinator.observe({ ...turn, phase: 'working' });
  assert.deepEqual(callNames(f.calls), ['available', 'list', 'start', 'update', 'list']);
  assert.deepEqual(f.calls[3][1], { ...turn, phase: 'working', id: item.id, sequence: 2 });
  assert.deepEqual(coordinator.snapshot().activity, { ...item, phase: 'working', sequence: 2, observedAt: 2345 });
});

test('a final event before a late start callback closes that exact activity and fences later events', async () => {
  const f = fixture(); let release, started;
  const original = f.bridge.start;
  f.bridge.start = input => new Promise(resolve => { started = true; release = () => original(input).then(resolve); });
  const coordinator = createLiveActivityCoordinator({ bridge: f.bridge }); await coordinator.setEnabled(true);
  const pending = coordinator.observe(turn); await new Promise(resolve => setImmediate(resolve)); assert.equal(started, true);
  const ending = coordinator.finish({ ...turn, phase: 'finished' }); release(); await pending; await ending;
  await coordinator.observe({ ...turn, phase: 'working' });
  assert.deepEqual(callNames(f.calls), ['available', 'list', 'start', 'end']);
  assert.equal(f.calls.at(-1)[1].turnId, id); assert.equal(f.calls.at(-1)[1].sequence, 2);
  assert.equal(coordinator.snapshot().status, 'ready');
});

test('disabling during a start ends the confirmed result, without starting again', async () => {
  const f = fixture(); let release;
  const original = f.bridge.start;
  f.bridge.start = input => new Promise(resolve => { release = () => original(input).then(resolve); });
  const coordinator = createLiveActivityCoordinator({ bridge: f.bridge }); await coordinator.setEnabled(true);
  const pending = coordinator.observe(turn); await new Promise(resolve => setImmediate(resolve));
  const disabled = coordinator.setEnabled(false); release(); await pending; await disabled;
  assert.deepEqual(callNames(f.calls), ['available', 'list', 'start', 'end']);
  assert.equal(f.calls.at(-1)[1].phase, 'dismissed'); assert.equal(coordinator.snapshot().status, 'disabled');
  await coordinator.observe({ ...turn, phase: 'working' }); assert.equal(f.calls.length, 4);
});

test('a late close callback cannot undo a newer opt-in preference', async () => {
  const f = fixture([item]); let release;
  const original = f.bridge.update;
  f.bridge.update = (input, ending) => ending ? new Promise(resolve => { release = () => original(input, true).then(resolve); }) : original(input, false);
  const coordinator = createLiveActivityCoordinator({ bridge: f.bridge }); await coordinator.setEnabled(true);
  const disabling = coordinator.setEnabled(false); await new Promise(resolve => setImmediate(resolve));
  const enabling = coordinator.setEnabled(true); release(); await disabling; await enabling;
  assert.deepEqual(coordinator.snapshot(), { enabled: true, status: 'ready' });
});

test('only the newest queued observation may start after a slow availability check', async () => {
  const f = fixture(); let release;
  f.bridge.availability = () => new Promise(resolve => { release = () => resolve(true); });
  const coordinator = createLiveActivityCoordinator({ bridge: f.bridge });
  const enabling = coordinator.setEnabled(true); await new Promise(resolve => setImmediate(resolve));
  const a = coordinator.observe(turn), b = coordinator.observe({ ...turn, turnId: other });
  release(); await enabling; await Promise.all([a, b]);
  assert.equal(f.calls.filter(call => call[0] === 'start').length, 1);
  assert.equal(f.calls.find(call => call[0] === 'start')[1].turnId, other);
});

test('a different turn never replaces or ends an existing activity implicitly', async () => {
  const f = fixture([item]); const coordinator = createLiveActivityCoordinator({ bridge: f.bridge });
  await coordinator.setEnabled(true); await coordinator.observe({ ...turn, turnId: other });
  assert.equal(coordinator.snapshot().status, 'conflict');
  await assert.rejects(coordinator.finish({ ...turn, turnId: other, phase: 'finished' }), /otro turno/);
  assert.deepEqual(callNames(f.calls), ['available', 'list']); assert.deepEqual(f.get(), [item]);
  await coordinator.observe({ ...turn, phase: 'working' });
  assert.equal(coordinator.snapshot().activity.phase, 'working');
  assert.equal(coordinator.snapshot().activity.turnId, id);
});

test('a timed-out native start is not retried automatically or after a late callback', async () => {
  let resolveStart; const calls = []; let inventory = [];
  const bridge = createLiveActivityBridge({ installed: true, timeoutMs: 5, call: async (name, args) => {
    calls.push(name); if (name === 'available') return { ok: true, enabled: true };
    if (name === 'list') return { ok: true, items: inventory };
    if (name === 'start') return new Promise(resolve => { resolveStart = () => { inventory = [item]; resolve({ ok: true, id: item.id, items: [item] }); }; });
    return { ok: true, id: args.id };
  } });
  const coordinator = createLiveActivityCoordinator({ bridge }); await coordinator.setEnabled(true);
  await assert.rejects(coordinator.observe(turn), /tiempo/);
  assert.equal(coordinator.snapshot().status, 'uncertain'); resolveStart(); await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(coordinator.observe({ ...turn, phase: 'working' }), /Consulta/);
  assert.equal(calls.filter(name => name === 'start').length, 1);
  await coordinator.refresh(); assert.deepEqual(coordinator.snapshot().activity, item);
});

test('a native update that cannot be confirmed remains uncertain, never guessed', async () => {
  const f = fixture(); const coordinator = createLiveActivityCoordinator({ bridge: f.bridge });
  await coordinator.setEnabled(true); await coordinator.observe(turn);
  f.bridge.update = async input => { f.calls.push(['update', input]); }; // System still reports old phase.
  await assert.rejects(coordinator.observe({ ...turn, phase: 'working' }), /No se confirmó/);
  assert.equal(coordinator.snapshot().status, 'uncertain'); assert.equal(coordinator.snapshot().activity.phase, 'thinking');
});

test('unavailable or ambiguous inventory never starts or closes a guessed activity', async () => {
  const f = fixture([item, { ...item, id: 'activity-2', turnId: other }]);
  const coordinator = createLiveActivityCoordinator({ bridge: f.bridge });
  await coordinator.setEnabled(true); assert.equal(coordinator.snapshot().status, 'conflict');
  await coordinator.setEnabled(false); assert.deepEqual(callNames(f.calls), ['available', 'list']);
  const g = fixture(); g.bridge.availability = async () => false;
  const unavailable = createLiveActivityCoordinator({ bridge: g.bridge }); await unavailable.setEnabled(true);
  await assert.rejects(unavailable.observe(turn), /no está disponible/); assert.deepEqual(g.calls, []);
});
