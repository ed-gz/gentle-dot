// HERDR ledge intent adapted from capri-desktop (MIT): https://github.com/mochiiwuff/capri-desktop
import { invoke, isTauri } from '@tauri-apps/api/core';
import { useEffect, useRef, useState } from 'react';
import { RoamDirector, type RoamFeed, type RoamGuards, type RoamPosition } from './roam.ts';
export function useRoaming(enabled:boolean,guards:RoamGuards){
 const director=useRef(new RoamDirector());
 const current=useRef(guards);current.current=guards;
 const [pose,setPose]=useState<RoamPosition>();
 const [travelling,setTravelling]=useState(false);
 const dragFlight=useRef(false);
 useEffect(()=>{
  if(!enabled||!isTauri())return;
  let live=true,stop:(()=>void)|undefined,feed:RoamFeed|undefined,received=0,busy=false;
  let arrive:ReturnType<typeof setTimeout>|undefined;
  const step=()=>{
   if(!live||!feed||busy)return;
   const next=director.current.step(feed,Date.now(),{...current.current,stale:Date.now()-received>5000});
   if(!next)return;
   busy=true;
   setPose(next);setTravelling(!current.current.reduced);
   if(arrive)clearTimeout(arrive);
   arrive=setTimeout(()=>{if(live)setTravelling(false);},1000);
   void invoke('desktop_companion_move',{dx:0,dy:0,roamTo:[next.x,next.y]}).catch(()=>{}).finally(()=>{busy=false;});
  };
  void import('@tauri-apps/api/event').then(async({listen})=>{
   const unlisten=await listen<RoamFeed|null>('dot://roam-region',event=>{
    feed=event.payload??undefined;received=Date.now();step();
   });
   if(live)stop=unlisten;else unlisten();
  }).catch(()=>{});
  const timer=setInterval(step,1000);
  return()=>{live=false;stop?.();clearInterval(timer);if(arrive)clearTimeout(arrive);};
 },[enabled]);
 const dragged=()=>{director.current.dragged(Date.now());setTravelling(false);};
 const dragBy=(dx:number,dy:number)=>{
  dragged();
  if(dragFlight.current||current.current.composer||current.current.question||current.current.approval)return;
  dragFlight.current=true;
  void invoke('desktop_companion_move',{dx:Math.max(-512,Math.min(512,Math.round(dx))),dy:Math.max(-512,Math.min(512,Math.round(dy)))}).catch(()=>{}).finally(()=>{dragFlight.current=false;});
 };
 return {pose,travelling,dragged,dragBy};
}
