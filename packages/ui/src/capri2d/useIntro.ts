// Spawn orchestration adapted from capri-desktop (MIT); see ./LICENSE.
import { invoke, isTauri } from '@tauri-apps/api/core';
import { useEffect, useRef, useState } from 'react';

/** Only the existing dot window talks to native. The disposable overlay has zero IPC grants. */
export function useIntro(enabled: boolean, connected: boolean, blocked: boolean, reduced: boolean) {
 const latest = useRef({connected,blocked,reduced}); latest.current={connected,blocked,reduced};
 const [active,setActive]=useState(false);
 const activeRef=useRef(active);activeRef.current=active;
 useEffect(()=>{
  if (!enabled || !connected || !isTauri()) return;
  let live=true, timer:ReturnType<typeof setTimeout>|undefined, inFlight=false, skip=false, dispatched=false;
  const deadline=performance.now()+10500;
  const send=async()=>{
   if (!live || inFlight) return;
   inFlight=true;dispatched=true;
   try {
    const state=await invoke<{introActive:boolean}>('desktop_companion_interaction',{
     active:false,intro:{...latest.current,skip},
    });
    if(live) setActive(state.introActive===true);
   } catch { if(live)setActive(false); }
   finally { inFlight=false; if(live&&performance.now()<deadline)timer=setTimeout(()=>void send(),250); else if(live)setActive(false); }
  };
  let consumeClick=false;
  const click=(event:Event)=>{
   if(event.type==='click'&&consumeClick){consumeClick=false;event.preventDefault();event.stopImmediatePropagation();return;}
   if(!activeRef.current)return;
   event.preventDefault();event.stopImmediatePropagation();
   consumeClick=true;skip=true;activeRef.current=false;setActive(false);void send();
  };
  window.addEventListener('pointerdown',click,true);
  window.addEventListener('click',click,true);
  // React StrictMode's mount/cleanup probe must not consume the service latch.
  timer=setTimeout(()=>void send(),0);
  return()=>{
   live=false;clearTimeout(timer);setActive(false);window.removeEventListener('pointerdown',click,true);window.removeEventListener('click',click,true);
   // Fail closed on unmount/reload/disconnect; native heartbeat watchdog is a second fence.
   if(dispatched)void invoke('desktop_companion_interaction',{active:false,intro:{connected:false,blocked:true,reduced:true,skip:true}}).catch(()=>{});
  };
 },[enabled,connected]);
 useEffect(()=>{
  if(active)document.documentElement.dataset.capriIntro='true';
  else delete document.documentElement.dataset.capriIntro;
  return()=>{delete document.documentElement.dataset.capriIntro;};
 },[active]);
 return active;
}
