import { localIdentifier } from './local-identifiers.ts';
import { createSessionJournal, sessionOperationKey, type SessionAttempt, type SessionJournal } from './desktop-session-journal.ts';

export type SessionControl = { kind:'abort'|'answer'; host:string; paneId:string; sessionId:string; instanceId:string; payload:Record<string,unknown>; deviceId?:string };
export function createControlJournal():SessionJournal { return createSessionJournal('capri-ios-session-control-journal'); }
function controlKey(value:SessionControl):string {
  const id=value.kind==='answer' ? value.payload.requestId : null;
  if(value.kind==='answer' && (typeof id!=='string' || !id || id.length>256)) throw new Error('Pregunta inválida.');
  return JSON.stringify([value.kind,id]);
}
/** Reserve before transport, retaining identical control operations across views/restarts. */
export async function runSessionControl<T>(journal:SessionJournal, value:SessionControl, before:()=>void, dispatch:()=>Promise<T>):Promise<T> {
  const text=controlKey(value), key=sessionOperationKey(value.host,value.paneId,value.sessionId,text);
  if(await journal.find(key)) throw new Error('Esta acción ya está en curso o sin confirmar. Revisa la sesión antes de repetirla.');
  const id=localIdentifier(),attempt:SessionAttempt={id,owner:localIdentifier(),key,host:value.host,...(value.deviceId?{deviceId:value.deviceId}:{}),paneId:value.paneId,sessionId:value.sessionId,instanceId:value.instanceId,text,deliverAs:'followUp',state:'prepared',createdAt:Date.now(),control:{kind:value.kind,payload:structuredClone(value.payload)}};
  try {await journal.begin(attempt);} catch(error) {try{await journal.cancelBeforeDispatch(attempt);}catch{} throw error;}
  try {before();await journal.dispatching(id);before();} catch(error) {try{await journal.cancelBeforeDispatch(attempt);}catch{throw new Error('No se inició el transporte, pero no se confirmó la cancelación local.');}throw error;}
  let result:T;
  try {result=await dispatch();} catch {try{await journal.unconfirmed(id);}catch{} throw new Error('No se confirmó si la sesión recibió la acción. Revisa la sesión antes de repetir.');}
  try {await journal.delivered(id,value.instanceId);} catch {throw new Error('El host respondió, pero no se pudo guardar el resultado. Revisa la sesión antes de repetir.');}
  return result;
}
