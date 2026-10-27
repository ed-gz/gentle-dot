import {describe,it,expect} from 'vitest';
import {PossessionDriver} from '../src/capri2d/possession.ts';
const feed={laptop:{x:1920,y:0,width:1536,height:864},region:{x:2000,y:40,width:1200,height:760},x:3000,y:40,width:144,height:204,herdr:true};
describe('window possession',()=>{
 it('uses feed geometry only at a HERDR perch and probability gates rare sessions',()=>{
  const d=new PossessionDriver();
  expect(d.step(feed,0,{perched:true},.9)).toBe(false);
  expect(d.step(feed,1,{perched:true},0)).toBe(false);
  expect(d.step(feed,600001,{perched:true},0)).toBe(true);
  expect(d.rect).toEqual(feed.region);
  expect(d.step(feed,607000,{perched:true},0)).toBe(false);
  expect(d.step(feed,608000,{perched:true},0)).toBe(false);
 });
 it('fails closed on guards, reduced motion, non HERDR, stale or changed geometry',()=>{
  for(const guard of ['question','approval','composer','intro','reduced','stale','sleeping']){
   expect(new PossessionDriver().step(feed,0,{perched:true,[guard]:true},0)).toBe(false);
  }
  expect(new PossessionDriver().step({...feed,herdr:false},0,{perched:true},0)).toBe(false);
  expect(new PossessionDriver().step(feed,0,{perched:false},0)).toBe(false);
  expect(new PossessionDriver().step({...feed,y:300},0,{perched:true},0)).toBe(false);
  expect(new PossessionDriver().step({...feed,region:{...feed.region,width:4000}},0,{perched:true},0)).toBe(false);
  const d=new PossessionDriver();expect(d.step(feed,0,{perched:true},0)).toBe(true);
  expect(d.step({...feed,region:{...feed.region,x:2100}},100,{perched:true},0)).toBe(false);
 });
});
