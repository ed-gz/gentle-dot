import { canonicalPendingConversationEntries } from './conversation-journal.ts';
import { exactConversationBase, type ChatEntry, type Conversation } from './conversation.ts';
import { conversationArchive } from './conversation-archive.ts';

/** An independent writer's uncommitted changes. This copy is not a receipt
 * and never authorizes delivery, native acknowledgement or automatic merging. */
export type WriteRescue = { schema:'capri-conversation-write-rescue/v1'; owner:string; sequence:number; baseRevision:number; draft:string; attachedWork?:string; entries:ChatEntry[] };
const PREFIX = 'conversation-write-rescue:v1:';
const MAX_COPIES = 100;
const MAX_BYTES = 64 * 1024 * 1024;
const uuid = (v:unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const natural = (v:unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const object = (v:unknown): v is Record<string,unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function same(a:unknown,b:unknown):boolean {
  if (Object.is(a,b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item,index)=>same(item,b[index]));
  if (!object(a) || !object(b)) return false;
  const keys=Object.keys(a).sort(), other=Object.keys(b).sort();
  return keys.length===other.length && keys.every((key,index)=>key===other[index] && same(a[key],b[key]));
}
function clean(input:unknown): WriteRescue {
  const value:unknown=structuredClone(input);
  if (!object(value) || Object.keys(value).some(key=>!['schema','owner','sequence','baseRevision','draft','attachedWork','entries'].includes(key)) ||
      value.schema!=='capri-conversation-write-rescue/v1' || !uuid(value.owner) || !natural(value.sequence) || value.sequence===0 || !natural(value.baseRevision) ||
      typeof value.draft!=='string' || value.draft.length>8000 || (value.attachedWork!==undefined && (typeof value.attachedWork!=='string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.attachedWork)))) throw new Error('La copia de conversación requiere revisión. Se conservan los datos.');
  const result:WriteRescue={schema:value.schema,owner:value.owner,sequence:value.sequence,baseRevision:value.baseRevision,draft:value.draft,
    ...(typeof value.attachedWork==='string'?{attachedWork:value.attachedWork}:{}),entries:canonicalPendingConversationEntries(value.entries)};
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength>MAX_BYTES) throw new Error('La copia supera el límite; conserva y exporta la conversación abierta.');
  return result;
}
function transaction<T>(name:string, mode:IDBTransactionMode, action:(store:IDBObjectStore,done:(v:T)=>void,fail:(e:Error)=>void)=>void):Promise<T> {
  return new Promise((resolve,reject)=>{
    let db:IDBDatabase|undefined,tx:IDBTransaction|undefined,result:T,produced=false,ended=false,issue:Error|undefined;
    const finish=(error?:Error)=>{if(ended)return;ended=true;clearTimeout(timer);db?.close();if(error)reject(error);else if(produced)resolve(result);else reject(new Error('No se confirmó la copia.'));};
    const fail=(error:Error)=>{issue=error;if(!tx){finish(error);return;}try{tx.abort();}catch{finish(error);}};
    const timer=setTimeout(()=>{try{tx?.abort();}catch{}finish(new Error('La copia de conversación no respondió.'));},8000);
    try {
      const open=indexedDB.open(name,1);
      open.onupgradeneeded=()=>{if(ended){open.transaction?.abort();return;}open.result.createObjectStore('conversation');};
      open.onerror=()=>finish(new Error('No se pudo abrir la copia de conversación.'));
      open.onblocked=()=>finish(new Error('Otra versión mantiene abierta la conversación.'));
      open.onsuccess=()=>{db=open.result;if(ended){db.close();return;}db.onversionchange=()=>db?.close();try{
        tx=db.transaction('conversation',mode);tx.oncomplete=()=>finish();tx.onabort=()=>finish(issue??new Error('No se confirmó la copia.'));tx.onerror=()=>{issue??=new Error('No se confirmó la copia.');};
        const store=tx.objectStore('conversation');if(store.keyPath!==null||store.autoIncrement)throw new Error('El esquema de conversación cambió.');
        action(store,v=>{result=v;produced=true;},fail);
      }catch(error){fail(error instanceof Error?error:new Error('No se inició la copia.'));}};
    }catch(error){finish(error instanceof Error?error:new Error('No se pudo abrir la copia.'));}
  });
}
function safely(fail:(error:Error)=>void,action:()=>void){try{action();}catch(error){fail(error instanceof Error?error:new Error('No se confirmó la copia.'));}}
export function createConversationWriteRescue(options:{databaseName?:string; archive?:Pick<typeof conversationArchive,'verifyExactBatch'>}={}) {
  const name=options.databaseName??'capri-ios-conversation', archive=options.archive??conversationArchive;
  if(!name || name.length>256)throw new Error('El almacén de rescate no es válido.');
  const range=()=>IDBKeyRange.bound(PREFIX,`${PREFIX}\uffff`);
  return {
    async save(input:unknown):Promise<'saved'|'unchanged'|'superseded'> {
      const record=clean(input);
      return transaction(name,'readwrite',(store,done,fail)=>{
        const read=store.get(PREFIX+record.owner);read.onsuccess=()=>safely(fail,()=>{
          if(read.result!==undefined){const prior=clean(read.result);if(prior.owner!==record.owner)throw new Error('El dueño de la copia cambió.');
            if(prior.sequence>record.sequence){done('superseded');return;}
            if(prior.sequence===record.sequence){if(!same(prior,record))throw new Error('La copia contiene otros cambios.');done('unchanged');return;}
            store.put(record,PREFIX+record.owner);done('saved');return;
          }
          const count=store.count(range());count.onsuccess=()=>safely(fail,()=>{if(count.result>=MAX_COPIES)throw new Error('Hay demasiadas copias pendientes; revisa y exporta antes de continuar.');store.put(record,PREFIX+record.owner);done('saved');});
        });
      });
    },
    async list():Promise<WriteRescue[]> {
      return transaction(name,'readonly',(store,done,fail)=>{
        const records:WriteRescue[]=[],cursor=store.openCursor(range());cursor.onsuccess=()=>safely(fail,()=>{
          const item=cursor.result;if(!item){done(records);return;}const record=clean(item.value);
          if(item.key!==PREFIX+record.owner||records.length>=MAX_COPIES)throw new Error('Las copias requieren revisión. Se conservan los datos.');
          records.push(record);item.continue();
        });
      });
    },
    /** Verification occurs before the transaction; a cooperating archive writer
     * must hold the conversation reservation while changing any record. */
    async retireIfCommitted(input:unknown,snapshot:Conversation):Promise<boolean> {
      const expected=clean(input), canonical=exactConversationBase(snapshot);
      if(!canonical || !natural(canonical.revision) || canonical.revision<=expected.baseRevision || canonical.draft!==expected.draft || canonical.attachedWork!==expected.attachedWork)return false;
      for(let i=0;i<expected.entries.length;i+=500) if(!await archive.verifyExactBatch(expected.entries.slice(i,i+500),canonical.revision))return false;
      return transaction(name,'readwrite',(store,done,fail)=>{
        const read=store.get(PREFIX+expected.owner);read.onsuccess=()=>safely(fail,()=>{
          if(read.result===undefined||!same(clean(read.result),expected)){done(false);return;}
          const guard=store.get('conversation-journal:v1');guard.onsuccess=()=>safely(fail,()=>{
            if(guard.result!==undefined){done(false);return;}
            const current=store.get('current');current.onsuccess=()=>safely(fail,()=>{
              if(!same(exactConversationBase(current.result),canonical)){done(false);return;}
              store.delete(PREFIX+expected.owner);done(true);
            });
          });
        });
      });
    },
    async discard(input:unknown):Promise<boolean> {
      const expected=clean(input);
      return transaction(name,'readwrite',(store,done,fail)=>{const read=store.get(PREFIX+expected.owner);read.onsuccess=()=>safely(fail,()=>{
        if(read.result===undefined||!same(clean(read.result),expected)){done(false);return;}store.delete(PREFIX+expected.owner);done(true);
      });});
    },
  };
}
