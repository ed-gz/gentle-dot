import { useEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./notification-card.css";

interface Props {
 children: ReactNode;
 summary: string;
 body?: string;
 prominent?: boolean;
 avatar?: string;
 dismissed?: boolean;
 leaving?: boolean;
 withAction?: boolean;
 reduced?: boolean;
 onAcknowledge?(): void;
}

export type NotificationCardSize = "compact" | "medium" | "full";

/** Text only: do not measure DOM nodes or infer actionable requests from their labels. */
export function notificationCardSize(summary: string, body = "", prominent = false): NotificationCardSize {
 if (prominent) return "full";
 const titleLength = summary.trim().length;
 const bodyLength = body.trim().length;
 if (titleLength <= 40 && bodyLength === 0) return "compact";
 return titleLength + bodyLength <= 160 ? "medium" : "full";
}

/** Pure presentation: an acknowledgement is never an approval or a session answer. */
export function CapriNotificationCard({children,summary,body,prominent=false,avatar,dismissed=false,leaving=false,withAction=false,reduced=false,onAcknowledge}:Props) {
 const [failed,setFailed]=useState<string>();
 if(dismissed)return null;
 return <div className="capri3d-speech capri-comic-card" data-size={notificationCardSize(summary,body,prominent)} data-with-action={withAction} data-leaving={leaving} data-reduced-motion={reduced} role="status" aria-live="polite">
  <div className="capri3d-speech-frame" aria-hidden="true"/>
  {avatar && avatar!==failed && <img className="capri-comic-avatar" src={avatar} alt="Capri" onError={()=>setFailed(avatar)}/>}
  <header className="capri-comic-header"><b className="capri-comic-brand">CAPRI</b></header>
  <div className="capri-comic-content">{children}</div>
  {onAcknowledge && <button className="capri-comic-ack" type="button" onClick={onAcknowledge}>Entendido</button>}
 </div>;
}

/** Only the pre-existing dot allowlist can supply this personal cutout. No filesystem URLs. */
export function useNotificationAvatar() {
 const [avatar,setAvatar]=useState<string>();
 useEffect(()=>{
  let live=true;
  let url:string|undefined;
  void invoke<ArrayBuffer|number[]>("capri2d_asset",{name:"capri-full.png"}).then(bytes=>{
   if(!live)return;
   const buffer=bytes instanceof ArrayBuffer ? bytes : new Uint8Array(bytes).buffer;
   url=URL.createObjectURL(new Blob([buffer],{type:"image/png"}));
   setAvatar(url);
  }).catch(()=>{/* Missing personal art is a supported configuration. */});
  return()=>{live=false;if(url)URL.revokeObjectURL(url);};
 },[]);
 return avatar;
}
