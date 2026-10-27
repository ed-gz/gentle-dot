import { describe, expect, it } from 'vitest';
import { RoamDirector, type RoamFeed } from '../src/capri2d/roam.ts';
const feed:RoamFeed={laptop:{x:0,y:0,width:1536,height:864},region:{x:100,y:100,width:900,height:600},x:1400,y:600,width:144,height:204,herdr:true};
describe('laptop-only HERDR roaming',()=>{
 it('keeps every perch in the right half and honors a configured band',()=>{
  for(const ratio of [0.5,0.65]) {
   const d=new RoamDirector();
   for(let i=0;i<4;i++) {
    const p=d.step({...feed,roamZone:{xRatio:ratio}},i*20000,{})!;
    expect(p.x).toBeGreaterThanOrEqual(feed.region.x+feed.region.width*ratio);
    expect(p.x+feed.width).toBeLessThanOrEqual(1000);
   }
  }
 });
 it('excludes the left 30 percent of narrow HERDR windows',()=>{
  const d=new RoamDirector();const narrow={...feed,region:{x:100,y:100,width:600,height:600}};
  for(let i=0;i<4;i++) expect(d.step(narrow,i*20000,{})!.x).toBeGreaterThanOrEqual(280);
 });
 it('fails closed when the permitted band cannot fit the body',()=>{
  expect(new RoamDirector().step({...feed,region:{x:100,y:100,width:180,height:600}},0,{})).toBeUndefined();
 });
 it('uses the configured band at exactly 700px and rejects invalid configuration',()=>{
  const wide={...feed,region:{x:100,y:100,width:700,height:600},roamZone:{xRatio:0.6}};
  expect(new RoamDirector().step(wide,0,{})!.x).toBe(520);
  for(const xRatio of [NaN,Infinity,-0.1,1]) expect(new RoamDirector().step({...wide,roamZone:{xRatio}},0,{})).toBeUndefined();
  // Without HERDR, the existing laptop bottom-band fallback is unchanged.
  expect(new RoamDirector().step({...feed,herdr:false},0,{})!.x).toBe(100);
 });
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
