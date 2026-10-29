import { httpsReceiptState, boundedReceiptState, nativeSHA256 } from './device-bridge.ts';
import { localIdentifier } from './local-identifiers.ts';
import { createSessionJournal, sessionOperationKey, type SessionAttempt, type SessionJournal } from './desktop-session-journal.ts';

export type SessionControl = { kind:'abort'|'answer'|'prompt'|'create'|'close'|'duplicate'|'revoke'; host:string; paneId:string; sessionId:string; instanceId:string; payload:Record<string,unknown>; deviceId?:string };
export function createControlJournal():SessionJournal { return createSessionJournal('capri-ios-session-control-journal'); }
function controlKey(value:SessionControl):string {
  const id=value.kind==='answer' ? value.payload.requestId : value.kind==='revoke' ? value.payload.policyId : value.kind==='prompt' ? value.payload.operationDigest : value.kind==='create' ? 'host-create' : null;
  if(value.kind==='prompt' && (typeof id!=='string' || !/^[a-f0-9]{64}$/.test(id))) throw new Error('Identidad de instrucción inválida.');
  if(['answer','revoke'].includes(value.kind) && (typeof id!=='string' || !id || id.length>256)) throw new Error('Pregunta inválida.');
  return JSON.stringify([value.kind,id]);
}
/** Reserve before transport, retaining identical control operations across views/restarts. */
export async function runSessionControl<T>(journal:SessionJournal, value:SessionControl, before:()=>void, dispatch:(receipt:{receiptId:string;receiptOwner:string})=>Promise<T>, receiptState:typeof httpsReceiptState = httpsReceiptState, identity?:{id:string;owner:string}, timeoutMs?:number, awaitDelivery = false):Promise<T> {
  const text=controlKey(value), key=sessionOperationKey(value.host,value.paneId,value.sessionId,text);
  if(await journal.find(key)) throw new Error('Esta acción ya está en curso o sin confirmar. Revisa la sesión; el aviso sigue bloqueado mientras no haya comprobante terminal y revisión.');
  const id=identity?.id ?? localIdentifier(),attempt:SessionAttempt={id,owner:identity?.owner ?? localIdentifier(),key,host:value.host,...(value.deviceId?{deviceId:value.deviceId}:{}),paneId:value.paneId,sessionId:value.sessionId,instanceId:value.instanceId,text,deliverAs:'followUp',state:'prepared',createdAt:Date.now(),nativeReceipt:1,control:{kind:value.kind,payload:structuredClone(value.payload)}};
  try {await journal.begin(attempt);} catch(error) {try{await journal.cancelBeforeDispatch(attempt);}catch{} throw error;}
  try {before();await journal.dispatching(id);before();} catch(error) {try{await journal.cancelBeforeDispatch(attempt);}catch{throw new Error('No se inició el transporte, pero no se confirmó la cancelación local.');}throw error;}
  let result:T;
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {
    const pending=dispatch({receiptId:id,receiptOwner:attempt.owner});
    result=timeoutMs === undefined ? await pending : await Promise.race([pending,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Tiempo de espera agotado.')),timeoutMs);})]);
  } catch {if (await boundedReceiptState(id,attempt.owner,receiptState)==='terminal') try{await journal.recoverUnconfirmed({...attempt,state:'dispatching'});}catch{} throw new Error('No se confirmó si la sesión recibió la acción. Revisa la sesión antes de repetir.');} finally {if(timer) clearTimeout(timer);}
  try {if(awaitDelivery) await journal.recoverUnconfirmed({...attempt,state:'dispatching'}); else await journal.delivered(id,value.instanceId);} catch {throw new Error('El host respondió, pero no se pudo guardar el resultado. Revisa la sesión antes de repetir.');}
  return result;
}

export async function recoverSessionControl(journal:SessionJournal,item:SessionAttempt, receiptState:typeof httpsReceiptState = httpsReceiptState):Promise<SessionAttempt> {
  if (item.state!=='dispatching' || item.nativeReceipt!==1) throw new Error('Este control no tiene comprobante nativo verificable; permanece bloqueado.');
  if (await boundedReceiptState(item.id,item.owner,receiptState)!=='terminal') throw new Error('El transporte no tiene comprobante terminal verificable; permanece bloqueado.');
  await journal.recoverUnconfirmed(item);
  const current=await journal.find(item.key);
  if (!current || current.id!==item.id || current.owner!==item.owner || current.state!=='unconfirmed') throw new Error('El control cambió durante la recuperación.');
  return current;
}

export async function promptDigest(text:string):Promise<string> {
  if (globalThis.crypto?.subtle) return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
  return nativeSHA256(text);
}
