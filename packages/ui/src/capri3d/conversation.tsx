// Question, outcome and action-ticker choreography adapted from capri-desktop (MIT): https://github.com/mochiiwuff/capri-desktop
import type { CompanionSessionSnapshot } from "../companion-sessions.ts";
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
/** The single matcher for "this exact request is still live": same identity, answerable confirm, unexpired. */
export function pendingApproval(approvals: AgentApproval[], cue: { id: string; paneId?: string; sessionId?: string }): AgentApproval | undefined {
 return approvals.find(a => cue.id === `question:${a.id}` && a.paneId === cue.paneId && a.sessionId === cue.sessionId && a.answerable && (a.kind ?? "confirm") === "confirm" && Date.parse(a.expiresAt) > Date.now());
}
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
/** Deduplicate equivalent masks, but never suppress a native layout change. */
export function createOverlayPublisher(publish: (mask: number[], layout: {bubble:boolean;input:boolean}) => void) {
 let previous: {body:number[];mask:number[];bubble:boolean;input:boolean} | undefined;
 return (body:number[], bubble:boolean, input:boolean) => {
  const sameBody=previous && body.length===previous.body.length && body.every((cell,i)=>cell===previous!.body[i]);
  if(sameBody && previous!.bubble===bubble && previous!.input===input)return;
  const mask=overlayMask(sameBody ? previous!.body : body,bubble,input);
  const sameMask=previous && mask.every((cell,i)=>cell===previous!.mask[i]);
  const changed=!previous || previous.bubble!==bubble || previous.input!==input || !sameMask;
  previous={body:sameBody ? previous!.body : body,mask,bubble,input};
  if(changed)publish(mask,{bubble,input});
 };
}
export interface Speech {
 id:string; text:string; showMore?:boolean; approvalKey?:string;
 question?:boolean; confirmation?:boolean; sender?:string; channel?:string; privateMessage?:boolean; body?:string;
}
export interface CapriOutcome { kind: "done" | "error"; at: number }
export interface CapriQuestion {
 id: string; paneId?: string; sessionId?: string;
 target?: { rect: { x:number; y:number; width:number; height:number }; label:string };
}
interface Props {
 question?: CapriQuestion;
 enteredQuestions?: Set<string>;
 outcome?: CapriOutcome;
 reduced?: boolean;
 visible?: boolean;
 state: DotState; send: Send; open: boolean; close(): void; more(): void;
 speech?: Speech;
 approval?: AgentApproval;
 answer?(action: OrchestrationAction): Promise<void>;
 onLayout(bubble:boolean,input:boolean): void;
 onGesture?(gesture: Gesture): void;
 activity?: CompanionSessionSnapshot["sessions"][number]["activity"];
 episodeKey?: string;
 onThinkingSpeech?(text: string): void;
}
export function CapriConversation({state,send,open,close,more,speech,approval,answer,onLayout,onGesture,activity,episodeKey,onThinkingSpeech,outcome,reduced=false,visible=true,question,enteredQuestions}:Props) {
 const localEntered=useRef(new Set<string>());
 const history=enteredQuestions ?? localEntered.current;
 const questionKey=question ? JSON.stringify([question.id,question.paneId,question.sessionId]) : undefined;
 const [entering,setEntering]=useState<string>();
 const questionLayer=useRef<HTMLDivElement>(null);
 // Native animationend avoids synthetic vendor-prefix detection in older WebKit/jsdom.
 // Completion is driven by CSS, with no hidden-surface timer or replay on target refresh.
 useEffect(()=>{
  const node=questionLayer.current;
  if(!node)return;
  const end=(event:Event)=>{if(event.target===node)setEntering(undefined);};
  node.addEventListener("animationend",end);
  return()=>node.removeEventListener("animationend",end);
 },[questionKey,visible]);
 useEffect(()=>{
  setEntering(undefined);
  if(!questionKey)return;
  const seen=history.has(questionKey);
  history.add(questionKey);
  if(history.size>64)history.delete(history.values().next().value!);
  if(visible && !reduced && !seen)setEntering(questionKey);
 },[questionKey,visible,reduced,history]);
 // One bounded exposure sheet, not a render loop. Hidden/occluded episodes are consumed,
 // never replayed when the surface returns. Native visibility unmounts this component too.
 const [fxKey,setFxKey]=useState<string>();
 const [impact,setImpact]=useState(false);
 const consumed=useRef<string | undefined>(undefined);
 const outcomeKey=outcome ? `${outcome.kind}:${outcome.at}` : undefined;
 useEffect(()=>{
  setFxKey(undefined);setImpact(false);
  if(!outcomeKey || !outcome)return;
  if(!visible){consumed.current=outcomeKey;return;}
  if(consumed.current===outcomeKey)return;
  consumed.current=outcomeKey;
  const elapsed=Math.max(0,Date.now()-outcome.at);
  if(elapsed>=700)return;
  setFxKey(outcomeKey);
  if(reduced)return; // Instant static cue; no sweep, flash, knockback or FX timer.
  setImpact(outcome.kind==="error" && elapsed<120);
  const flash=outcome.kind==="error" && elapsed<120 ? setTimeout(()=>setImpact(false),120-elapsed) : undefined;
  const end=setTimeout(()=>setFxKey(undefined),700-elapsed);
  return()=>{clearTimeout(flash);clearTimeout(end);};
 },[outcomeKey,visible,reduced]);
 const fx=visible && fxKey===outcomeKey && outcome;
 const delaySummary=fx && fx.kind==="done" && !reduced;
 const action=activity?.phase === "working" ? activity.lastAction : undefined;
 const validAction=action && action.verb.length<=16 && action.subject.length<=64 && Number.isFinite(Date.parse(action.at)) ? action : undefined;
 const actionKey=validAction ? JSON.stringify([episodeKey,validAction.verb,validAction.subject,validAction.at]) : undefined;
 const [quiet,setQuiet]=useState(0);
 const say=useRef(onThinkingSpeech);say.current=onThinkingSpeech;
 useEffect(()=>{
  setQuiet(0);
  if(!actionKey || !validAction)return;
  const since=Date.parse(validAction.at);
  let said=0;
  const tick=()=>{
   const seconds=Math.max(0,Math.floor((Date.now()-since)/1000));
   setQuiet(seconds);
   if(seconds>=120 && said<2){said=2;say.current?.("No está trabada, está pensando");}
   else if(seconds>=40 && said<1){said=1;say.current?.("Lo estoy pensando con calma.");}
  };
  tick();const timer=setInterval(tick,1000);
  return()=>clearInterval(timer);
 },[actionKey]);
// Sessions with older adapters still report coder verbs; the ticker shows them as supervisor narration.
const SUPERVISOR_VERBS=new Map(["LEO,CONSULTO","BUSCO,EXAMINO","EDITO,SUPERVISO","ESCRIBO,SUPERVISO","EJECUTO,DIRIJO"].map(pair=>pair.split(",") as [string,string]));
const ticker=validAction ? quiet>=15 ? `PIENSO… ${quiet}s` : `${SUPERVISOR_VERBS.get(validAction.verb) ?? validAction.verb} ${validAction.subject}` : undefined;
 const voice=useVoice(state,send,{inputOnly:true,enabled:open});
 const [draft,setDraft]=useState(""),[error,setError]=useState<string>(),[pending,setPending]=useState(false);
 const [shown,setShown]=useState(speech);
 const [leaving,setLeaving]=useState(false);
 const [showGestures,setShowGestures]=useState(false);
 const [answered,setAnswered]=useState<string>();
 const [receipt,setReceipt]=useState<string>();
 const sending=useRef(false);
 const approvalKey=approval ? JSON.stringify([approval.paneId,approval.sessionId,approval.id]) : undefined;
 const currentKey=useRef(approvalKey);
 // Removal is expected after answering; only a different request invalidates its receipt.
 if(approvalKey)currentKey.current=approvalKey;
 const mounted=useRef(true);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 const dismissedSpeech=useRef<string | undefined>(undefined);
 useEffect(()=>{if(approvalKey){setError(undefined);setReceipt(undefined);dismissedSpeech.current=undefined;}},[approvalKey]);
 useEffect(()=>{if(!receipt)return;const timer=setTimeout(()=>setReceipt(undefined),1500);return()=>clearTimeout(timer);},[receipt]);
 const [,expire]=useState(0);
 useEffect(()=>{
  if(!approval)return;
  const remaining=Date.parse(approval.expiresAt)-Date.now();
  if(!Number.isFinite(remaining)||remaining<=0)return;
  const timer=setTimeout(()=>expire(n=>n+1),remaining);
  return()=>clearTimeout(timer);
 },[approval?.id,approval?.expiresAt]);
 const input=useRef<HTMLInputElement>(null);
 const confirmation=approval && answered!==approvalKey && confirmationAction(approval,true)?approval:undefined;
 useEffect(()=>{
  setShown(speech?.approvalKey===dismissedSpeech.current && dismissedSpeech.current!==undefined ? undefined : speech);setLeaving(false);if(!speech)return;
  const duration=speechDuration(speech.text);
  const fade=setTimeout(()=>setLeaving(true),Math.max(0,duration-180));
  const timer=setTimeout(()=>setShown(undefined),duration);
  return()=>{clearTimeout(timer);clearTimeout(fade);};
 },[speech?.id,speech?.text,speech?.showMore,speech?.approvalKey]);
 useEffect(()=>{if(open)input.current?.focus();},[open]);
 useEffect(()=>{if(!voice.draft)return;setDraft(voice.draft.text);voice.draftTaken(voice.draft.id);},[voice.draft,voice.draftTaken]);
 const bubble=Boolean(shown || confirmation || receipt || ticker);
 useEffect(()=>{onLayout(bubble,open);},[bubble,open,onLayout]);
 useEffect(()=>()=>onLayout(false,false),[onLayout]);
 const respond=async(approved:boolean)=>{
  if(!confirmation || !answer || sending.current)return;
  const action=confirmationAction(confirmation,approved);if(!action)return;
  const key=approvalKey;
  sending.current=true;setPending(true);setError(undefined);
  try {
   await answer(action);
   if(mounted.current && currentKey.current===key){
    setAnswered(key);setReceipt("Respuesta enviada");
    dismissedSpeech.current=key;
    setShown(value=>value?.approvalKey===dismissedSpeech.current ? undefined : value);
   }
  }
  catch (error) {if(mounted.current && currentKey.current===key)setError(error instanceof Error && error.message ? (error.message.startsWith("No se pudo responder") ? error.message : `No se pudo responder: ${error.message}`) : "No se pudo responder. Volvé a intentarlo o abrí el panel.");}
  finally {sending.current=false;if(mounted.current)setPending(false);}
 };
 const pointing=visible && question && !(question.id===`question:${approval?.id}` && answered===approvalKey);
 // Global logical target -> body-local edge. Never move the native corner window.
 const rect=question?.target?.rect;
 const dx=rect ? rect.x+rect.width/2-(window.screenX+window.innerWidth/2) : 0;
 const dy=rect ? rect.y+rect.height/2-(window.screenY+(bubble?BUBBLE_HEIGHT:0)+BODY_HEIGHT/2) : 0;
 const scale=Math.min(62/Math.max(1,Math.abs(dx)),90/Math.max(1,Math.abs(dy)));
 const edge={x:72+dx*scale,y:102+dy*scale};
 return <>
  {pointing && <div ref={questionLayer} className="capri3d-question" data-entering={entering===questionKey} data-reduced-motion={reduced} aria-hidden="true" style={{pointerEvents:"none"}}>
   {rect ? <><svg className="capri3d-pointing" viewBox="0 0 144 204" fill="none" stroke="currentColor" strokeWidth="1.5">
    <line x1={dx<0?36:108} y1="90" x2={edge.x} y2={edge.y} strokeDasharray="4 4"/>
    <path transform={`translate(${edge.x},${edge.y})`} d="M-7 -3v-4h4M3 -7h4v4M7 3v4h-4M-3 7h-4v-4"/>
   </svg><span className="capri3d-point-label">{question.target!.label}</span></> : <span className="capri3d-point-label">SEÑALO</span>}
  </div>}
  {fx && <div className="capri3d-outcome" key={outcomeKey} data-outcome={fx.kind} data-reduced-motion={reduced} aria-hidden="true" style={{pointerEvents:"none"}}>
   {fx.kind==="done" ? <><div className="capri3d-speed-lines"/><div className="capri3d-shockwave"/><div className="capri3d-celebratory-cut"/></> : impact && <div className="capri3d-impact"/>}
  </div>}
  {ticker && <div className="capri3d-action" data-thinking={quiet>=15} aria-live="off">{ticker}</div>}
  {Boolean((shown && !delaySummary) || confirmation || receipt) && <div className="capri3d-speech" data-with-action={Boolean(ticker)} data-leaving={leaving && !confirmation && !receipt} role="status" aria-live="polite">
   <div className="capri3d-speech-frame" aria-hidden="true"/>
   <span className="capri3d-speech-text">{receipt || (pending && confirmation ? "Enviando respuesta…" : confirmation ? excerpt(`${confirmation.title} ${confirmation.message}`) : shown?.sender ? <><strong>{shown.sender}</strong>{shown.privateMessage ? <span className="capri3d-muted"> (privado)</span> : shown.channel ? <> <span className="capri3d-muted">en </span><span className="capri3d-channel">{shown.channel}</span></> : null}:<br/>{excerpt(shown.body ?? "")}</> : excerpt(shown?.text ?? ""))}{!confirmation && !receipt && shown?.confirmation && <span className="capri3d-check" aria-hidden="true">✓</span>}</span>
   {confirmation ? <div className="capri3d-confirm">
    <button type="button" disabled={pending} onClick={()=>void respond(false)}>Rechazar</button>
    <button type="button" disabled={pending} onClick={()=>void respond(true)}>Aprobar</button>
   </div> : !receipt && !shown?.question && shown?.showMore !== false && <button type="button" className="capri3d-more" onClick={more}>Ver más</button>}
   {error && <span role="alert">{error}</span>}
  </div>}
  {open && <form className="capri3d-chat" onSubmit={event=>{
   event.preventDefault();const text=draft.trim();if(!text || pending)return;
   if(send({type:"send",text,requestId:newRequestId()})===false){setError("Sin conexión. Tu mensaje sigue aquí.");return;}
   voice.sent();setDraft("");setError(undefined);input.current?.focus();
  }} onKeyDown={event=>{if(event.key==="Escape"){event.preventDefault();voice.cancel();close();}}}>
   <div className="capri3d-chat-header">
    <span className="capri3d-wordmark"><span className="capri3d-brand-marks" aria-hidden="true"><i/><i/></span>CAPRI</span>
    {(error || voice.note || voice.phase!=="idle") ? <span className="capri3d-chat-note" role="status">{error || voice.note || (voice.phase==="recording"?"Escuchando…":"Transcribiendo…")}</span> : onGesture && (showGestures ? <select autoFocus aria-label="Gesto de Capri" value="" onChange={event=>{onGesture(event.target.value as Gesture);setShowGestures(false);input.current?.focus();}}><option value="" disabled>Gestos…</option>{Object.entries(gestures).map(([id,label])=><option key={id} value={id}>{label}</option>)}</select> : <button type="button" aria-label="Gestos de Capri" aria-expanded={false} onClick={()=>setShowGestures(true)}>Gestos</button>)}
    <button type="button" className="capri3d-close" aria-label="Cerrar entrada" onClick={()=>{voice.cancel();close();}}>×</button>
   </div>
   <div className="capri3d-quick-row">
   {!draft.trim() && <>
    <button type="button" className="capri3d-history" aria-label="Historial" title="Historial" onClick={more}>
     <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M3 4v5h5M3.5 9a9 9 0 1 1-.1 6M12 7v5l3 3"/></svg>
    </button>
    <span className="capri3d-input-divider" aria-hidden="true"/>
   </>}
   <label className="capri3d-input"><span className="sr-only">Mensaje para Dot</span><input ref={input} value={draft} onChange={event=>{voice.typed();setDraft(event.target.value);}} onKeyDown={event=>{if(event.key==="Enter" && !event.nativeEvent.isComposing){event.preventDefault();event.currentTarget.form?.requestSubmit();}}} placeholder="Escríbele a Capri…" /></label>
   <button type="button" data-recording={voice.phase==="recording"} aria-label={voice.phase==="recording"?"Terminar dictado":voice.phase==="transcribing"?"Transcribiendo audio":"Hablar"} disabled={!voice.mic?.available || voice.phase==="transcribing"} title={voice.mic && !voice.mic.available?voice.mic.reason:undefined} onClick={()=>voice.phase==="recording"?voice.stop():voice.start()}>
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/></svg>
   </button>
   <button type="submit" className="capri3d-send" aria-label="Enviar" disabled={!draft.trim() || state.connection!=="open"}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m5 12 7-7 7 7M12 5v15"/></svg></button>
   </div>
  </form>}
 </>;
}
