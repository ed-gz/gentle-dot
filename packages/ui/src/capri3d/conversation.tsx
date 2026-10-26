import { useEffect, useRef, useState } from "react";
import type { DotState } from "../store.ts";
import { newRequestId, type Send } from "../components/types.ts";
import { useVoice } from "../useVoice.ts";
import type { AgentApproval, OrchestrationAction } from "../orchestration.ts";
import { speechDuration } from "./choreography.ts";
import { gestures, type Gesture } from "./gestures.ts";
import "./conversation.css";

export const BUBBLE_HEIGHT = 152;
export const INPUT_HEIGHT = 88;
export function excerpt(text: string) { const clean=text.replace(/\s+/g," ").trim(); return clean.length>160?`${clean.slice(0,159)}…`:clean; }
/** Never infer consent from labels; only the existing answerable boolean-confirm contract qualifies. */
export function confirmationAction(approval: AgentApproval, approved: boolean): OrchestrationAction | undefined {
 const expires = Date.parse(approval.expiresAt);
 if (!approval.answerable || (approval.kind ?? "confirm") !== "confirm" || !Number.isFinite(expires) || expires <= Date.now()) return;
 return { action:"answer",paneId:approval.paneId,sessionId:approval.sessionId,requestId:approval.id,approved };
}
/** Compact body size on screen; the renderer still draws 240×340 and its 24×34 mask is scale-free. */
export const BODY_WIDTH = 144;
export const BODY_HEIGHT = 204;
/** Reproject the body mask into the expanded surface, then union the visible UI hit regions. */
export function overlayMask(mask: number[], bubble: boolean, input: boolean): number[] {
 if (!bubble && !input) return mask;
 const width=320, top=bubble?BUBBLE_HEIGHT:0, height=BODY_HEIGHT+top+(input?INPUT_HEIGHT:0);
 const left0=(width-BODY_WIDTH)/2, cellX=BODY_WIDTH/24, cellY=BODY_HEIGHT/34;
 return Array.from({length:816},(_,i)=>{
  const x=(i%24+0.5)*width/24,y=(Math.floor(i/24)+0.5)*height/34;
  if (bubble && x>=20 && x<=300 && y>=4 && y<=top) return 1;
  if (input && x>=4 && x<=316 && y>=top+BODY_HEIGHT) return 1;
  const left=(i%24)*width/24, upper=Math.floor(i/24)*height/34;
  const x0=Math.max(0,Math.floor((left-left0)/cellX)), x1=Math.min(23,Math.floor((left+width/24-left0)/cellX));
  const y0=Math.max(0,Math.floor((upper-top)/cellY)), y1=Math.min(33,Math.floor((upper+height/34-top)/cellY));
  for(let row=y0;row<=y1;row++) for(let col=x0;col<=x1;col++) if(mask[row*24+col]) return 1;
  return 0;
 });
}
interface Props {
 state: DotState; send: Send; open: boolean; close(): void; more(): void;
 speech?: {id:string;text:string};
 approval?: AgentApproval;
 answer?(action: OrchestrationAction): Promise<void>;
 onLayout(bubble:boolean,input:boolean): void;
 onGesture?(gesture: Gesture): void;
}
export function CapriConversation({state,send,open,close,more,speech,approval,answer,onLayout,onGesture}:Props) {
 const voice=useVoice(state,send,{inputOnly:true,enabled:open});
 const [draft,setDraft]=useState(""),[error,setError]=useState<string>(),[pending,setPending]=useState(false);
 const [shown,setShown]=useState(speech);
 const [leaving,setLeaving]=useState(false);
 const [answered,setAnswered]=useState<string>();
 const [,expire]=useState(0);
 useEffect(()=>{
  if(!approval)return;
  const remaining=Date.parse(approval.expiresAt)-Date.now();
  if(!Number.isFinite(remaining)||remaining<=0)return;
  const timer=setTimeout(()=>expire(n=>n+1),remaining);
  return()=>clearTimeout(timer);
 },[approval?.id,approval?.expiresAt]);
 const input=useRef<HTMLInputElement>(null);
 const confirmation=approval && answered!==approval.id && confirmationAction(approval,true)?approval:undefined;
 useEffect(()=>{
  setShown(speech);setLeaving(false);if(!speech)return;
  const duration=speechDuration(speech.text);
  const fade=setTimeout(()=>setLeaving(true),Math.max(0,duration-180));
  const timer=setTimeout(()=>setShown(undefined),duration);
  return()=>{clearTimeout(timer);clearTimeout(fade);};
 },[speech?.id,speech?.text]);
 useEffect(()=>{if(open)input.current?.focus();},[open]);
 useEffect(()=>{if(!voice.draft)return;setDraft(voice.draft.text);voice.draftTaken(voice.draft.id);},[voice.draft,voice.draftTaken]);
 const bubble=Boolean(shown || confirmation);
 useEffect(()=>{onLayout(bubble,open);return()=>onLayout(false,false);},[bubble,open,onLayout]);
 const respond=async(approved:boolean)=>{
  if(!confirmation || !answer || pending)return;
  const action=confirmationAction(confirmation,approved);if(!action)return;
  setPending(true);setError(undefined);
  try { await answer(action);setAnswered(confirmation.id); }
  catch {setError("No se pudo responder. Volvé a intentarlo o abrí el panel.");}
  finally {setPending(false);}
 };
 return <>
  {bubble && <div className="capri3d-speech" data-leaving={leaving && !confirmation} role="status" aria-live="polite">
   <span>{excerpt(confirmation ? `${confirmation.title} ${confirmation.message}` : shown!.text)}</span>
   {confirmation ? <div className="capri3d-confirm">
    <button type="button" disabled={pending} onClick={()=>void respond(true)}>Sí</button>
    <button type="button" disabled={pending} onClick={()=>void respond(false)}>No</button>
   </div> : <button type="button" className="capri3d-more" onClick={more}>Ver más</button>}
   {error && <span role="alert">{error}</span>}
  </div>}
  {open && <form className="capri3d-chat" onSubmit={event=>{
   event.preventDefault();const text=draft.trim();if(!text || pending)return;
   if(send({type:"send",text,requestId:newRequestId()})===false){setError("Sin conexión. Tu mensaje sigue aquí.");return;}
   voice.sent();setDraft("");setError(undefined);
  }} onKeyDown={event=>{if(event.key==="Escape"){event.preventDefault();voice.cancel();close();}}}>
   <label className="capri3d-input"><span className="sr-only">Mensaje para Dot</span><input ref={input} value={draft} onChange={event=>{voice.typed();setDraft(event.target.value);}} placeholder="Escribile o hablale…" /></label>
   <button type="button" aria-label={voice.phase==="recording"?"Terminar dictado":"Hablar"} disabled={!voice.mic?.available || voice.phase==="transcribing"} title={voice.mic && !voice.mic.available?voice.mic.reason:undefined} onClick={()=>voice.phase==="recording"?voice.stop():voice.start()}>
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/></svg>
   </button>
   <button type="submit" aria-label="Enviar" disabled={!draft.trim() || state.connection!=="open"}>➤</button>
   <button type="button" aria-label="Cerrar entrada" onClick={()=>{voice.cancel();close();}}>×</button>
   {onGesture && <select aria-label="Gesto de Capri" value="" onChange={event=>onGesture(event.target.value as Gesture)}><option value="" disabled>Gestos…</option>{Object.entries(gestures).map(([id,label])=><option key={id} value={id}>{label}</option>)}</select>}
   {(error || voice.note || voice.phase!=="idle") && <span className="capri3d-chat-note" role="status">{error || voice.note || (voice.phase==="recording"?"Escuchando…":"Transcribiendo…")}</span>}
  </form>}
 </>;
}
