#!/usr/bin/env node
// User-owned sources remain in ignored .cache. Requires the already-installed ImageMagick.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { cutCell, measure, alignFrames, buildManifest } from './helpers.mjs';
import { sheets, expressions, sequences } from './catalog.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const output=resolve(root,'packages/theme-capri/src/assets');
const inspection=resolve(root,'scripts/capri-faces/inspection');
mkdirSync(inspection,{recursive:true});
const size=224,cells=[];
const magick=args=>execFileSync('magick',args,{maxBuffer:32*1024*1024});
for(const sheet of sheets) {
 const source=resolve(root,`.cache/capri-face-sprites/source/${sheet}.png`);
 const dimensions=magick(['identify','-format','%w %h',source]).toString();
 if(dimensions!=='1254 1254')throw new Error(`Unexpected dimensions: ${sheet}: ${dimensions}`);
 const rgba=magick([source,'-depth','8','rgba:-']);
 for(let i=0;i<16;i++) {
  const cell=cutCell(rgba,1254,1254,i);
  const geometry=measure(cell.pixels,cell.width,cell.height);
  cells.push({cell,...geometry});
 }
}
const aligned=alignFrames(cells,size);
const frames=[];
for(let i=0;i<cells.length;i++) {
 const {cell,bounds}=cells[i],{scale,offsetX,offsetY}=aligned[i];
 const path=resolve(inspection,`${String(i).padStart(2,'0')}.png`);
 execFileSync('magick',['-size',`${cell.width}x${cell.height}`,'-depth','8','rgba:-',
  '-crop',`${bounds.width}x${bounds.height}+${bounds.x}+${bounds.y}`,'+repage',
  '-filter','Lanczos','-resize',`${Math.round(bounds.width*scale)}x${Math.round(bounds.height*scale)}!`,
  '-background','none','-gravity','northwest','-extent',`${size}x${size}${-Math.round(offsetX)>=0?'+':''}${-Math.round(offsetX)}${-Math.round(offsetY)>=0?'+':''}${-Math.round(offsetY)}`,path],{input:cell.pixels,maxBuffer:32*1024*1024});
 frames.push(path);
}
magick(['montage',...frames,'-tile','8x8','-geometry',`${size}x${size}+0+0`,'-background','none',resolve(output,'capri-faces-v1.png')]);
const manifest=buildManifest(size,64,sequences);
manifest.catalog=cells.map((_,i)=>({sheet:sheets[Math.floor(i/16)],cell:i%16+1,name:expressions[Math.floor(i/16)][i%16]}));
writeFileSync(resolve(output,'capri-faces-v1.json'),JSON.stringify(manifest,null,2)+'\n');
// Four contact sheets contain the exact 64 rendered crops used by the atlas.
for(let s=0;s<4;s++)magick(['montage',...frames.slice(s*16,s*16+16),'-tile','4x4','-geometry',`${size}x${size}+4+4`,'-background','#27272f',resolve(inspection,`${sheets[s]}.png`)]);
console.log(`64 faces → ${manifest.width}×${manifest.height}; ${readFileSync(resolve(output,'capri-faces-v1.png')).length} bytes`);
