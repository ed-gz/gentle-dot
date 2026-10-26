import { describe, expect, it } from 'vitest';
import { CAPRI_FACES, faceAnimation } from '../src/faces.ts';
import { readFileSync } from 'node:fs';

describe('phone face atlas',()=>{
 it('catalogs all 64 authored cells once and ships a correctly sized RGBA PNG',()=>{
  expect(CAPRI_FACES.catalog).toHaveLength(64);
  expect(new Set(CAPRI_FACES.catalog.map(c=>c.name)).size).toBe(64);
  const png=readFileSync(new URL('../src/assets/capri-faces-v1.png',import.meta.url));
  expect(png.readUInt32BE(16)).toBe(CAPRI_FACES.width);
  expect(png.readUInt32BE(20)).toBe(CAPRI_FACES.height);
  expect(png[25]).toBe(6); // PNG truecolour + alpha, not a lossy/indexed conversion.
 });
 it('keeps every action on the same 224px canvas and rejects out-of-atlas crops',()=>{
  for(const animation of Object.values(CAPRI_FACES.animations)){
   expect(animation.canvas).toEqual({width:224,height:224});
   expect(animation.frames.length).toBeGreaterThan(0);
   for(const frame of animation.frames){
    expect(frame.width).toBe(224);expect(frame.height).toBe(224);
    expect(frame.offsetX).toBe(0);expect(frame.offsetY).toBe(0);
    expect(frame.x+frame.width).toBeLessThanOrEqual(CAPRI_FACES.width);
    expect(frame.y+frame.height).toBeLessThanOrEqual(CAPRI_FACES.height);
    expect(frame.durationMs).toBeGreaterThanOrEqual(80);
   }
  }
  expect(faceAnimation('unknown-body-pose')).toBe('idle');
  for(const action of ['idle','walk','greeting','working','typing','done','error','thinking','talking','sleep','wake','glitch-transition'])expect(faceAnimation(action)).toBe(action);
 });
});
