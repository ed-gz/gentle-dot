import {describe,it,expect} from 'vitest';
import {RoamDirector,perchCandidates,type RoamFeed} from '../src/capri2d/roam.ts';
const feed:RoamFeed={laptop:{x:0,y:0,width:1200,height:800},region:{x:0,y:0,width:1000,height:700},x:0,y:0,width:100,height:100,herdr:true};
const grid={columns:10,rows:7,scores:Array(70).fill(5000)};
describe('blank footprint perches',()=>{
 it('retains flat center waiting-for-input spots and rejects noisy neighbors',()=>{
  const scores=[...grid.scores];scores[35]=0;scores[36]=0;
  const points=perchCandidates({...feed,blankGrid:{...grid,scores}});
  expect(points).toEqual([[512,300],[600,300]]);
  expect(new RoamDirector().step({...feed,blankGrid:{...grid,scores}},0,{})).toMatchObject({x:512,y:300,resting:'sit'});
 });
 it('falls back only to top corner bands inside the configured right band',()=>{
  expect(perchCandidates({...feed,blankGrid:grid})).toEqual([[740,12],[888,12]]);
  const scores=[...grid.scores];scores[35]=0;
  expect(perchCandidates({...feed,blankGrid:{...grid,scores}})).toEqual([[740,12],[888,12]]);
 });
 it('requires the whole body to be blank and rejects malformed scores',()=>{
  expect(perchCandidates({...feed,width:144,blankGrid:{...grid,scores:Array(70).fill(NaN)}})).toEqual([[740,12],[844,12]]);
  expect(perchCandidates({...feed,width:144,blankGrid:{...grid,scores:grid.scores.slice(1)}})).toHaveLength(2);
 });
 it('revalidates native shortlists after the actual placement inset and band clipping',()=>{
  const scores=[...grid.scores];scores[35]=0;scores[36]=0;
  expect(perchCandidates({...feed,blankGrid:{...grid,scores,perches:[[0,0],[900,500]]}})).toEqual([[512,300],[600,300]]);
  expect(perchCandidates({...feed,blankGrid:{...grid,scores,perches:[[500,300],[600,300]]}})).toEqual([[512,300],[600,300]]);
 });
 it('retains top-left only when the configured permitted band actually includes it',()=>{
  expect(perchCandidates({...feed,roamZone:{xRatio:0},blankGrid:grid})).toEqual([[12,12],[160,12],[740,12],[888,12]]);
 });
 it('validates real 24px cells across the whole 144x204 body',()=>{
  const scores=Array(40*30).fill(5000);
  for(let row=8;row<21;row++)for(let col=22;col<34;col++)scores[row*40+col]=0;
  const actual={...feed,width:144,height:204,region:{x:0,y:0,width:960,height:720},blankGrid:{columns:40,rows:30,scores}};
  const points=perchCandidates(actual)!;
  expect(points.length).toBeGreaterThan(2);
  for(const [x,y] of points){expect(x).toBeGreaterThanOrEqual(528);expect(x+144).toBeLessThanOrEqual(816);expect(y).toBeGreaterThanOrEqual(192);expect(y+204).toBeLessThanOrEqual(504);}
  for(const guard of ['composer','question','approval','sleeping','paused','stale'] as const)expect(new RoamDirector().step(actual,0,{[guard]:true})).toBeUndefined();
 });
 it('bottom-aligns center perches to the blank cell and always sits there',()=>{
  const actual={...feed,height:80,blankGrid:{...grid,scores:Array(70).fill(0)}};
  const points=perchCandidates(actual)!;
  expect(points.some(([,y])=>y===320)).toBe(true);
  const director=new RoamDirector();
  for(let step=0;step<4;step++)expect(director.step(actual,step*18001,{})?.resting).toBe('sit');
 });
 it('keeps laptop and band intersections; absent capture fails open to old circuit',()=>{
  const scores=Array(70).fill(0);
  for(const [x,y] of perchCandidates({...feed,blankGrid:{...grid,scores}})!) {expect(x).toBeGreaterThanOrEqual(500);expect(x+100).toBeLessThanOrEqual(1000);expect(y+100).toBeLessThanOrEqual(700);}
  expect(perchCandidates(feed)).toBeUndefined();
 });
});
