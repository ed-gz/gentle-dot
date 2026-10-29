import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPresenceTransition } from '../src/companion-presence-transition.ts';

test('hide plays the shared vanish and stays visible until its transparent frame', () => {
  const presence = createPresenceTransition();
  const initial = presence.request(false, 1000, true);
  assert.equal(initial.visible, true); assert.equal(initial.transitioning, true);
  assert.deepEqual(initial.cues, ['vanish']);
  const collapse = presence.sample(1100);
  assert.equal(collapse.pose.collapse, 1); assert.deepEqual(collapse.cues, []);
  assert.equal(presence.sample(1249).visible, true);
  assert.deepEqual(presence.sample(1250), { visible: false, transitioning: false, targetVisible: false, cues: [] });
  assert.deepEqual(presence.sample(9000).cues, []);
});

test('show uses only the shared arrival and completes without playing vanish', () => {
  const presence = createPresenceTransition(false);
  const first = presence.request(true, 1000, true);
  assert.equal(first.visible, true); assert.equal(first.transitioning, true);
  assert.deepEqual(first.cues, ['arrive']);
  assert.equal(first.pose.collapse, 1);
  assert.deepEqual(presence.sample(1100).cues, []);
  assert.equal(presence.sample(1541).transitioning, true);
  assert.deepEqual(presence.sample(1542), { visible: true, transitioning: false, targetVisible: true, cues: [] });
});

test('rapid reversals replace the previous timeline and repeated requests do not restart it', () => {
  const presence = createPresenceTransition();
  presence.request(false, 1000, true);
  assert.deepEqual(presence.request(true, 1100, true).cues, ['arrive']);
  assert.deepEqual(presence.request(true, 1200, true).cues, []);
  assert.equal(presence.sample(1642).transitioning, false);
  presence.request(false, 2000, true);
  assert.deepEqual(presence.request(true, 2050, true).cues, ['arrive']);
  assert.deepEqual(presence.request(false, 2100, true).cues, ['vanish']);
  assert.equal(presence.sample(2350).visible, false);
});

test('reduced motion and lifecycle interruptions settle to the requested final state', () => {
  const presence = createPresenceTransition();
  assert.deepEqual(presence.request(false, 1000, false), { visible: false, transitioning: false, targetVisible: false, cues: [] });
  assert.equal(presence.request(true, 1100, true).transitioning, true);
  assert.deepEqual(presence.settle(), { visible: true, transitioning: false, targetVisible: true, cues: [] });
  assert.deepEqual(presence.sample(1200).cues, []);
  presence.request(false, 1300, true);
  assert.deepEqual(presence.request(false, 1350, false), { visible: false, transitioning: false, targetVisible: false, cues: [] });
});

test('a missed frame cannot leave the layer animating or replay a stale effect', () => {
  const presence = createPresenceTransition(); presence.request(false, 1000, true);
  assert.deepEqual(presence.sample(10000), { visible: false, transitioning: false, targetVisible: false, cues: [] });
  presence.request(true, 11000, true);
  assert.deepEqual(presence.sample(20000), { visible: true, transitioning: false, targetVisible: true, cues: [] });
  assert.throws(() => presence.sample(NaN), /reloj/);
});
