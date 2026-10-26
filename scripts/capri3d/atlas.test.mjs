import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packFrames } from './atlas.mjs';

test('trims alpha, packs without overlap and writes native canvas/offset/duration contract', () => {
 const rgba = new Uint8Array(4 * 6 * 4);
 rgba.set([255, 0, 0, 255], (2 * 4 + 1) * 4);
 const { manifest, frames } = packFrames([{ name: 'idle', width: 4, height: 6, rgba, durationMs: 83 },
  { name: 'typing', width: 4, height: 6, rgba, durationMs: 1000 }], 'companion/test.png', 4);
 assert.deepEqual(manifest.animations.idle.canvas, { width: 4, height: 6 });
 assert.deepEqual(manifest.animations.idle.frames[0], { x: 0, y: 0, width: 1, height: 1, offsetX: 1, offsetY: 2, durationMs: 83 });
 assert.equal(manifest.animations.typing.frames[0].x, 2);
 assert.equal(manifest.image, 'companion/test.png');
 assert.deepEqual([...frames[0].rgba], [255, 0, 0, 255]);
});
test('empty frames stay transparent; overflow and invalid input fail closed', () => {
 const frame = { name: 'idle', width: 2, height: 2, rgba: new Uint8Array(16), durationMs: 83 };
 assert.equal(packFrames([frame], 'x.png').frames[0].rgba[3], 0);
 assert.throws(() => packFrames([], 'x.png'));
 assert.throws(() => packFrames([{ ...frame, rgba: new Uint8Array(3) }], 'x.png'));
 assert.throws(() => packFrames(Array(121).fill(frame), 'x.png'));
 assert.throws(() => packFrames(Array(10).fill(frame), 'x.png', 2));
});
