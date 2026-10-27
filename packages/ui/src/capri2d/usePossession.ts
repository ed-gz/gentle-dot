// capri-desktop window choreography (MIT); see ./LICENSE. Only dot owns native IPC.
import {invoke,isTauri} from '@tauri-apps/api/core';
import {useEffect,useRef,useState,type RefObject} from 'react';
import {PossessionDriver,type PossessionGuards} from './possession.ts';
import type {RoamFeed} from './roam.ts';
export function usePossession(enabled:boolean,connected:boolean,guards:PossessionGuards,source:RefObject<{feed?:RoamFeed;received:number}>){ 
 const driver=useRef(new PossessionDriver());
 const latest=useRef({connected,guards});latest.current={connected,guards};
 const [active,setActive]=useState(false);
 useEffect(()=>{
  if(!enabled||!isTauri())return;
  let live=true,busy=false,requested=false;
  const tick=async()=>{
   if(!live||busy)return;
   const {connected,guards}=latest.current;
   const {feed,received}=source.current;
   const wants=!!feed&&driver.current.step(feed,Date.now(),{...guards,paused:guards.paused||!connected,stale:Date.now()-received>5000},Math.random());
   if(!wants&&!requested)return;
   requested=wants;
   busy=true;
   try{
    const state=await invoke<{possessionActive:boolean}>('desktop_companion_interaction',{active:false,possession:{start:wants,connected,blocked:!wants,reduced:!!guards.reduced}});
    if(live)setActive(wants&&state.possessionActive===true);
   }catch{driver.current.abort();if(live)setActive(false);}
   finally{busy=false;}
  };
  const timer=setInterval(()=>void tick(),250);
  return()=>{live=false;clearInterval(timer);driver.current.abort();setActive(false);
   void invoke('desktop_companion_interaction',{active:false,possession:{start:false,connected:false,blocked:true,reduced:true}}).catch(()=>{});
  };
 },[enabled,source]);
 return active;
}
