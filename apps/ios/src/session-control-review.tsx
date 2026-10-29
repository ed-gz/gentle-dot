import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createDesktopSessionClient, type DesktopConnection } from './desktop-tools.ts';
import type { ToolContext } from './agent-tools.ts';
import './session-control-review.css';

/** Human recovery is available even when the local language model is absent. */
export function SessionControlReview({connection,current,active,busy}:{connection:DesktopConnection;current:()=>DesktopConnection|undefined;active:boolean;busy:boolean}) {
  const client=useMemo(()=>createDesktopSessionClient({getConnection:current}),[connection.url,connection.token,connection.deviceId,current]);
  const [page,setPage]=useState<Awaited<ReturnType<typeof client.listControls>>>();
  const [deliveries,setDeliveries]=useState<Awaited<ReturnType<typeof client.listDeliveries>>>();
  const [open,setOpen]=useState(false),[working,setWorking]=useState(false),[error,setError]=useState('');
  const [review,setReview]=useState<{title:string;details:string}>();
  const decision=useRef<((approved:boolean)=>void)|undefined>(undefined);
  const run=useRef<AbortController|undefined>(undefined), refreshEpoch=useRef(0), returnFocus=useRef<HTMLElement|null>(null), focusPending=useRef(false), dialog=useRef<HTMLDialogElement|null>(null);
  const stillCurrent=useCallback(()=>{const live=current();return !!live && live.url===connection.url && live.token===connection.token && live.deviceId===connection.deviceId;},[current,connection.url,connection.token,connection.deviceId]);
  const refresh=useCallback(async(controlOffset=0,deliveryOffset=0)=>{const epoch=++refreshEpoch.current;try{const [value,sends]=await Promise.all([client.listControls({offset:controlOffset,limit:10}),client.listDeliveries({offset:deliveryOffset,limit:10})]);if(epoch===refreshEpoch.current&&stillCurrent()){setPage(value);setDeliveries(sends);setError('');}}catch(problem){if(epoch===refreshEpoch.current&&stillCurrent())setError(problem instanceof Error?problem.message:'No se pudieron consultar los avisos.');}},[client,stillCurrent]);
  useEffect(()=>{if(active&&!busy)void refresh();},[active,busy,refresh]);
  useEffect(()=>{setReview(undefined);setOpen(false);setPage(undefined);setDeliveries(undefined);setWorking(false);setError('');return ()=>{refreshEpoch.current++;run.current?.abort();run.current=undefined;decision.current?.(false);decision.current=undefined;focusPending.current=false;returnFocus.current=null;};},[client]);
  useEffect(()=>{if(!working&&focusPending.current){focusPending.current=false;const target=returnFocus.current;returnFocus.current=null;if(target)requestAnimationFrame(()=>target.isConnected&&target.focus());}},[working]);
  useEffect(()=>{if(review && dialog.current && !dialog.current.open)dialog.current.showModal();},[review]);
  const finish=(approved:boolean)=>{const resolve=decision.current;decision.current=undefined;setReview(undefined);focusPending.current=true;resolve?.(approved);};
  const inspect=async(id:string,kind:'control'|'delivery')=>{
    if(run.current)return;const controller=new AbortController();run.current=controller;returnFocus.current=document.activeElement as HTMLElement | null;setWorking(true);setError('');
    try {
      const context={signal:controller.signal,askApproval:async request=>{if(controller.signal.aborted||!stillCurrent())return false;return new Promise<boolean>(resolve=>{decision.current=resolve;setReview({title:request.title,details:request.details});});}} as ToolContext;
      if(kind==='control') await client.resolveControl({id},context); else await client.resolveDelivery({clientMessageId:id},context);
      await refresh(page?.offset??0,deliveries?.offset??0);
    } catch(problem) {if(!controller.signal.aborted&&stillCurrent())setError(problem instanceof Error?problem.message:'No se pudo revisar el aviso.');}
    finally {if(run.current===controller){run.current=undefined;if(!controller.signal.aborted&&stillCurrent())setWorking(false);}}
  };
  const extra=deliveries?.items ?? [];
  const total=(page?.total??0)+(deliveries?.total??0);
  if(!active || (!total && !open && !error))return null;
  return <section className="session-control-review" aria-label="Avisos de sesión">
    <button type="button" className="session-control-review-trigger" onClick={()=>{setOpen(value=>!value);if(!open)void refresh();}}>Avisos</button>
    {open?<div className="session-control-review-list"><p>Revisa el estado en la laptop antes de cerrar un aviso. Cerrar no vuelve a enviar.</p>
      {error?<p role="alert">{error}</p>:null}
      {page?.total && deliveries?.total?<p>Un mismo envío puede aparecer en ambas listas; su revisión cierra los registros vinculados.</p>:null}
      {!page?.items.length&&!extra.length?<p>No hay avisos para esta laptop.</p>:null}
      {page?.total ? <strong>Controles de sesión</strong> : null}
      {page?.items.map(item=><button type="button" key={`control-${item.id}`} disabled={working} onClick={()=>void inspect(item.id,'control')}>{item.kind==='prompt'?'Instrucción':item.kind==='answer'?'Respuesta':'Detener'} · {item.sessionId}<span>{item.state==='unconfirmed'?'Sin confirmar':'En curso o sin comprobante'}</span></button>)}
      {page && page.offset>0?<button type="button" onClick={()=>void refresh(Math.max(0,page.offset-10),deliveries?.offset??0)}>Controles anteriores</button>:null}
      {page?.nextOffset!==undefined?<button type="button" onClick={()=>void refresh(page.nextOffset,deliveries?.offset??0)}>Más controles</button>:null}
      {deliveries?.total ? <strong>Envíos del agente</strong> : null}
      {extra.map(item=><button type="button" key={`delivery-${item.id}`} disabled={working} onClick={()=>void inspect(item.id,'delivery')}>Instrucción · {item.sessionId}<span>{item.state==='unconfirmed'?'Sin confirmar':'En curso o sin comprobante'}</span></button>)}
      {deliveries && deliveries.offset>0?<button type="button" onClick={()=>void refresh(page?.offset??0,Math.max(0,deliveries.offset-10))}>Envíos anteriores</button>:null}
      {deliveries?.nextOffset!==undefined?<button type="button" onClick={()=>void refresh(page?.offset??0,deliveries.nextOffset)}>Más envíos</button>:null}
    </div>:null}
    {review?<dialog ref={dialog} aria-label={review.title} className="session-control-review-dialog" onCancel={event=>{event.preventDefault();finish(false);}} onKeyDown={event=>{
      if(event.key==='Escape'){event.preventDefault();finish(false);return;}
      if(event.key==='Tab'){const focusable=Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),[tabindex="0"]'));if(!focusable.length)return;const index=focusable.indexOf(document.activeElement as HTMLElement);if(event.shiftKey && index<=0){event.preventDefault();focusable.at(-1)?.focus();}else if(!event.shiftKey && index===focusable.length-1){event.preventDefault();focusable[0]?.focus();}}
    }}><h2>{review.title}</h2><p>Comprueba el servicio y este contenido exacto. La operación anterior todavía podría estar procesándose.</p><pre tabIndex={0}>{review.details}</pre><div><button type="button" autoFocus onClick={()=>finish(false)}>Volver</button><button type="button" onClick={()=>finish(true)}>Cerrar aviso</button></div></dialog>:null}
  </section>;
}
