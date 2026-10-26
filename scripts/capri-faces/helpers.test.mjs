import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gridCell, cutCell, measure, alignFrames, buildManifest } from './helpers.mjs';

test('fractional grid boundaries partition all 1254 pixels without gaps', () => {
 const cells = Array.from({length:16}, (_, i) => gridCell(1254,1254,i));
 assert.deepEqual(cells[0], {x:0,y:0,width:313,height:313});
 assert.equal(cells[3].x+cells[3].width,1254);
 assert.equal(cells.reduce((n,c)=>n+c.width*c.height,0),1254*1254);
 assert.throws(()=>gridCell(1254,1254,16));
});
test('shared scale and eye anchor keep a growing silhouette from moving the face', () => {
 const aligned=alignFrames([
  {bounds:{x:30,y:80,width:200,height:120},anchor:{x:130,y:130}},
  {bounds:{x:0,y:0,width:260,height:240},anchor:{x:130,y:130}},
 ],224);
 assert.equal(aligned[0].scale,aligned[1].scale);
 assert.equal(aligned[0].offsetX+(130-30)*aligned[0].scale,112);
 assert.equal(aligned[1].offsetX+130*aligned[1].scale,112);
 assert.equal(aligned[0].offsetY+50*aligned[0].scale,aligned[1].offsetY+130*aligned[1].scale);
});
test('overhanging art is recovered without retaining a neighbour fragment', () => {
 const width=128,height=128,pixels=Buffer.alloc(width*height*4);
 const box=(x,y,w,h)=>{for(let j=y;j<y+h;j++)for(let i=x;i<x+w;i++)pixels.set([0,240,50,255],(j*width+i)*4);};
 box(8,8,20,28); // Extends below the first 32px row.
 box(8,48,16,16); // Neighbour below the cell: must not leak into its crop.
 const cell=cutCell(pixels,width,height,0,32);
 const found=measure(cell.pixels,cell.width,cell.height);
 assert.deepEqual(found.bounds,{x:40,y:40,width:20,height:28});
 assert.throws(()=>measure(Buffer.alloc(16),2,2));
});

test('manifest uses strict Android canvas/frame contract and rejects missing frame indices', () => {
 const manifest=buildManifest(224,64,{idle:[[0,3400],[1,120],[2,80]]});
 assert.equal(manifest.width,1792);assert.equal(manifest.height,1792);
 assert.equal(manifest.image,'companion/capri-faces-v1.png');
 assert.deepEqual(manifest.animations.idle.canvas,{width:224,height:224});
 assert.deepEqual(manifest.animations.idle.frames[1],{x:224,y:0,width:224,height:224,offsetX:0,offsetY:0,durationMs:120});
 assert.throws(()=>buildManifest(224,64,{idle:[[64,100]]}));
});
