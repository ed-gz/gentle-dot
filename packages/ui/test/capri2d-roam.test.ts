import { describe, expect, it } from 'vitest';
import { RoamDirector, type RoamFeed } from '../src/capri2d/roam.ts';
const feed:RoamFeed={laptop:{x:0,y:0,width:1536,height:864},region:{x:100,y:100,width:900,height:600},x:1400,y:600,width:144,height:204,herdr:true};
describe('laptop-only HERDR roaming',()=>{
 it('enters HERDR then schedules ledge perches and relocation',()=>{
  const d=new RoamDirector();const first=d.step(feed,0,{});expect(first).toMatchObject({resting:'sit'});
  expect(first!.x).toBeGreaterThanOrEqual(100);expect(first!.x+144).toBeLessThanOrEqual(1000);
  expect(d.step(feed,1000,{})).toBeUndefined();
  const second=d.step(feed,20000,{});expect(second!.x).not.toBe(first!.x);
 });
 it('holds for composer, questions, approvals and sleep without consuming entry',()=>{
  for(const guard of ['composer','question','approval','sleeping'] as const){
   const d=new RoamDirector();expect(d.step(feed,0,{[guard]:true})).toBeUndefined();expect(d.step(feed,1,{})).toBeDefined();
  }
 });
 it('pauses at least ten minutes after dragging',()=>{
  const d=new RoamDirector();d.dragged(50);expect(d.step(feed,600049,{})).toBeUndefined();expect(d.step(feed,600050,{})).toBeDefined();
 });
 it('uses a static entry in reduced motion, and clamps even malicious/external geometry',()=>{
  const d=new RoamDirector();const outside={...feed,region:{x:1500,y:0,width:900,height:900}};
  const pos=d.step(outside,0,{reduced:true})!;expect(pos.x+144).toBeLessThanOrEqual(1536);expect(pos.y+204).toBeLessThanOrEqual(864);
  expect(d.step(outside,600000,{reduced:true})).toBeUndefined();
 });
 it('uses new geometry immediately, but never moves on a stale feed',()=>{
  const d=new RoamDirector();d.step(feed,0,{});expect(d.step({...feed,region:{x:200,y:200,width:700,height:500}},100,{})).toBeDefined();
  expect(d.step(feed,30000,{stale:true})).toBeUndefined();
 });
});
