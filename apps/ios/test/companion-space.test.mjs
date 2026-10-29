import assert from 'node:assert/strict';
import { test } from 'node:test';
import { occupiedPhoneSpace, phonePerches, phonePositionFree } from '../src/companion-space.ts';
import { RoamDirector } from '../../../packages/ui/src/capri2d/roam.ts';
test('phone perches avoid text and controls, and closed space has no fallback', () => {
 const area={x:0,y:0,width:358,height:500}, size={width:86,height:122};
 const points=phonePerches(area,size,[{x:0,y:0,width:254,height:500}]);
 assert.ok(points.length>=3); assert.ok(points.every(([x])=>x>259));
 assert.deepEqual(phonePerches(area,size,[area]),[]);
 const roam=new RoamDirector(); const feed={laptop:area,region:area,...size,x:0,y:0,herdr:false,safePerches:points};
 const first=roam.step(feed,0,{}), second=roam.step(feed,18001,{});
 assert.notEqual(first.y,second.y); assert.equal(roam.step({...feed,safePerches:[]},36002,{}),undefined);
});
test('successive perches span the available screen without duplicates', () => {
 const area={x:0,y:0,width:390,height:600}, size={width:86,height:122};
 const points=phonePerches(area,size,[]);
 assert.ok(points.length > 15 && points.length <= 128);
 assert.ok(Math.hypot(points[0][0]-points[1][0], points[0][1]-points[1][1]) > 400);
 assert.equal(new Set(points.map(point=>point.join(','))).size,points.length);
 assert.ok(points.every(([x,y])=>x>=4 && y>=4 && x+size.width<=area.width-4 && y+size.height<=area.height-4));
});
test('irregular gaps beside occupied content are discovered without covering it', () => {
 const area={x:0,y:0,width:360,height:440}, size={width:70,height:100};
 const occupied=[{x:0,y:0,width:360,height:145},{x:0,y:270,width:360,height:170},{x:0,y:145,width:115,height:125},{x:205,y:145,width:155,height:125}];
 const points=phonePerches(area,size,occupied);
 assert.ok(points.length > 0);
 assert.ok(points.every(([x,y])=>x>120 && x+size.width<200 && y>150 && y+size.height<265));
});
test('invalid or too-small geometry produces no destinations', () => {
 const area={x:0,y:0,width:200,height:300};
 assert.deepEqual(phonePerches(area,{width:NaN,height:100},[]),[]);
 assert.deepEqual(phonePerches(area,{width:0,height:100},[]),[]);
 assert.deepEqual(phonePerches(area,{width:201,height:100},[]),[]);
});
test('long panel content is treated as occupied without covering the reserved shelf', () => {
 const priorDocument=globalThis.document, priorFilter=globalThis.NodeFilter;
 let count=0;
 try {
  globalThis.NodeFilter={SHOW_TEXT:4};
  globalThis.document={
   createTreeWalker:()=>({ currentNode:{textContent:'x',parentElement:{closest:()=>null}}, nextNode:()=>count++ < 3001 }),
   createRange:()=>({selectNodeContents(){},getClientRects:()=>[]}),
  };
  const panel={querySelectorAll:()=>[],getBoundingClientRect:()=>({left:0,top:96,width:390,height:500})};
  const occupied=occupiedPhoneSpace(panel,{left:0,top:0,width:390,height:596});
  assert.deepEqual(occupied,[{x:0,y:96,width:390,height:500}]);
  assert.equal(phonePositionFree({x:4,y:4,width:60,height:86},occupied),true);
  assert.equal(phonePositionFree({x:4,y:100,width:60,height:86},occupied),false);
 } finally { globalThis.document=priorDocument; globalThis.NodeFilter=priorFilter; }
});
