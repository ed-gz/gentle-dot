import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFramePacer } from '../src/frame-pacer.ts';

test('normal display frames retain the existing animation cadence', () => {
  const pacer = createFramePacer();
  for (let now = 0; now < 1000; now += 16) { assert.equal(pacer.ready(now), true); pacer.submitted(now); }
});
test('a compositor stall leaves a bounded interval for input and storage without stopping animation', () => {
  const pacer = createFramePacer(); pacer.submitted(0);
  assert.equal(pacer.ready(100), false);
  assert.equal(pacer.ready(200), false);
  assert.equal(pacer.ready(236), true);
  pacer.submitted(236);
  assert.equal(pacer.ready(736), false);
  assert.equal(pacer.ready(986), true);
});
test('streaming updates cannot remove an active cooldown; resuming does not count hidden time as GPU cost', () => {
  const pacer = createFramePacer(); pacer.submitted(0); pacer.ready(100);
  pacer.wake(); assert.equal(pacer.ready(120), false);
  assert.equal(pacer.ready(236), true); pacer.submitted(236);
  pacer.wake(); assert.equal(pacer.ready(100000), true);
});
test('fast frames recover the original cadence after a temporary stall', () => {
  const pacer = createFramePacer(); pacer.submitted(0); pacer.ready(100);
  let now = 500;
  for (let index = 0; index < 25; index++) { assert.equal(pacer.ready(now), true); pacer.submitted(now); pacer.ready(now + 16); now += 300; }
  pacer.submitted(now); assert.equal(pacer.ready(now + 16), true);
});
