import { describe, expect, it } from 'vitest';
import { atlasAnimationForBehavior, validateAtlas } from '../src/capri3d/mobile-atlas.ts';

describe('personal mobile atlas contract', () => {
 const fixture = () => ({ width: 2, height: 2, image: 'companion/capri-3d-core-v1.png', animations: {
  idle: { canvas: { width: 4, height: 6 }, frames: [{ x: 0, y: 0, width: 2, height: 2, offsetX: 1, offsetY: 2, durationMs: 83 }] },
 } });
 it('accepts a tiny synthetic native manifest', () => {
  expect(validateAtlas(fixture()).animations.idle!.frames[0]!.offsetY).toBe(2);
 });
 it('rejects invalid later frames, image paths, bounds and excessive frame counts', () => {
  const invalid = fixture();invalid.animations.idle.frames.push({ ...invalid.animations.idle.frames[0]!, x: 2 });
  expect(() => validateAtlas(invalid)).toThrow();
  expect(() => validateAtlas({ ...fixture(), image: 'https://example.com/private.png' })).toThrow();
  const oversized = fixture();oversized.animations.idle.frames = Array(121).fill(oversized.animations.idle.frames[0]);
  expect(() => validateAtlas(oversized)).toThrow();
 });
 it('uses the desktop behavior mapping, never travel or random clips', () => {
  const expected = { idle: 'idle', agentWorking: 'thinking', readingReply: 'thinking', userTyping: 'typing', attention: 'greeting', done: 'laughing', error: 'error', submitted: 'talking' } as const;
  for (const [state, name] of Object.entries(expected))
   expect(atlasAnimationForBehavior(state as keyof typeof expected)).toBe(name);
  expect(atlasAnimationForBehavior('readingReply', 'reply')).toBe('talking');
 });
});
