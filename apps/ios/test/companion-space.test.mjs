import assert from 'node:assert/strict';
import { test } from 'node:test';
import { phonePerches } from '../src/companion-space.ts';
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
