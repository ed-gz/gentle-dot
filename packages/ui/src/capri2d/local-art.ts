// Personal artwork stays in the local art directory, behind the exact native allowlist.
import {invoke} from '@tauri-apps/api/core';
import {useEffect,useState} from 'react';
export const INTRO_ART = ['capri-full.png','intro-grab.webp','intro-happy.webp','intro-mouth1.webp','intro-mouth2.webp','intro-mouth3.webp','intro-smear.webp','intro-wave1.webp','intro-wave2.webp','intro-wave3.webp','face-calm.png','face-smug.png'] as const;
const CHIP_ART = ['face-many.png'] as const;
export {CHIP_ART};
export function useLocalArt(names: readonly string[], enabled = true) {
 const [sources,setSources]=useState<Record<string,string>>({});
 useEffect(()=>{
  if(!enabled)return;
  let live=true;
  // Preload the bounded frame set once, not on every exposure-sheet beat. Data URLs
  // are window-local and released with React state; no public asset copies/cache.
  for(const name of names)void invoke<ArrayBuffer|number[]>('capri2d_asset',{name}).then(bytes=>{
   if(!live)return;
   const array=bytes instanceof ArrayBuffer?new Uint8Array(bytes):new Uint8Array(bytes);
   let binary='';
   for(const byte of array)binary+=String.fromCharCode(byte);
   const src=`data:image/${name.endsWith('.webp')?'webp':'png'};base64,${btoa(binary)}`;
   setSources(previous=>({...previous,[name]:src}));
  }).catch(()=>{}); // Missing optional art stays absent; never use the legacy atlas.
  return()=>{live=false;};
 },[names,enabled]);
 return sources;
}
