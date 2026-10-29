/** Local journal for model-initiated instructions to a laptop session. No token is stored. */
export type SessionAttempt = {
  id: string; owner: string; key: string; host: string; deviceId?: string; paneId: string; sessionId: string; instanceId: string;
  text: string; deliverAs: 'steer' | 'followUp'; state: 'prepared' | 'dispatching' | 'unconfirmed' | 'delivered' | 'reviewed' | 'cancelled';
  createdAt: number; nativeReceipt?: 1; control?: { kind: 'abort' | 'answer' | 'prompt' | 'create' | 'close' | 'duplicate' | 'revoke'; payload: Record<string, unknown> };
};
export interface SessionJournal {
  find(key: string): Promise<SessionAttempt | null>;
  begin(attempt: SessionAttempt): Promise<void>;
  dispatching(id: string): Promise<void>;
  cancelBeforeDispatch(expected: SessionAttempt): Promise<void>;
  unconfirmed(id: string): Promise<void>;
  recoverUnconfirmed(expected: SessionAttempt): Promise<void>;
  delivered(id: string, instanceId: string): Promise<void>;
  list(host: string): Promise<SessionAttempt[]>;
  page(host:string, offset:number, limit:number):Promise<{items:SessionAttempt[];total:number}>;
  getPending(host:string,id:string):Promise<SessionAttempt | null>;
  confirmControlDelivery(host:string,paneId:string,sessionId:string,instanceId:string,clientMessageId:string):Promise<boolean>;
  reviewed(expected: SessionAttempt): Promise<void>;
}
export function sessionOperationKey(host: string, paneId: string, sessionId: string, text: string) {
  return JSON.stringify([host, paneId, sessionId, text]);
}
const DATABASE = 'capri-ios-session-send-journal';
// Bound unresolved work, never all historical attempts: resolved records are
// retained and must not permanently prevent new instructions.
const MAX_PENDING = 2000;
const unresolved = (state: SessionAttempt['state']) => ['prepared', 'dispatching', 'unconfirmed'].includes(state);
function validate(value: unknown): SessionAttempt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('El registro de envíos no es válido.');
  const item = value as SessionAttempt;
  if (!/^[a-f0-9-]{36}$/.test(item.id) || !/^[a-f0-9-]{36}$/.test(item.owner) || typeof item.host !== 'string' || item.host.length > 2048 ||
      typeof item.paneId !== 'string' || !item.paneId || item.paneId.length > 256 || typeof item.sessionId !== 'string' || !item.sessionId || item.sessionId.length > 256 ||
      typeof item.instanceId !== 'string' || !item.instanceId || item.instanceId.length > 256 || typeof item.text !== 'string' || !item.text.trim() || item.text.length > 16000 ||
      (item.deviceId !== undefined && (typeof item.deviceId !== 'string' || !item.deviceId || item.deviceId.length > 256)) ||
      !['steer', 'followUp'].includes(item.deliverAs) || !['prepared','dispatching','unconfirmed','delivered','reviewed','cancelled'].includes(item.state) ||
      (item.nativeReceipt !== undefined && item.nativeReceipt !== 1) ||
      (item.control !== undefined && (!item.control || !['abort','answer','prompt','create','close','duplicate','revoke'].includes(item.control.kind) || !item.control.payload || typeof item.control.payload !== 'object' || Array.isArray(item.control.payload) || JSON.stringify(item.control).length > 100000)) ||
      !Number.isSafeInteger(item.createdAt) || item.createdAt < 0 || item.key !== sessionOperationKey(item.host, item.paneId, item.sessionId, item.text)) throw new Error('El registro de envíos no es válido.');
  return { id:item.id, owner:item.owner, key:item.key, host:item.host, ...(item.deviceId ? {deviceId:item.deviceId} : {}), paneId:item.paneId, sessionId:item.sessionId, instanceId:item.instanceId, text:item.text, deliverAs:item.deliverAs, state:item.state, createdAt:item.createdAt, ...(item.nativeReceipt ? {nativeReceipt:1 as const} : {}), ...(item.control ? {control:structuredClone(item.control)} : {}) };
}
export function createSessionJournal(databaseName = DATABASE): SessionJournal {
  function transaction<T>(mode: IDBTransactionMode, action: (tx: IDBTransaction, done: (value:T) => void, fail: (error:Error) => void) => void): Promise<T> {
    return new Promise((resolve, reject) => {
      let db: IDBDatabase | undefined, tx: IDBTransaction | undefined, settled = false, produced = false, result: T;
      const finish = (error?: unknown) => { if (settled) return; settled = true; clearTimeout(timer); db?.close(); if (error !== undefined) reject(error); else if (produced) resolve(result); else reject(new Error('No se confirmó el registro de envíos.')); };
      const fail = (error:Error) => { try { tx?.abort(); } catch { /* Already complete. */ } finish(error); };
      const timer = setTimeout(() => fail(new Error('El registro de envíos no respondió.')), 8000);
      let opening: IDBOpenDBRequest;
      try { opening = indexedDB.open(databaseName, 2); } catch (error) { finish(error); return; }
      opening.onupgradeneeded = () => { if (settled) { opening.transaction?.abort(); return; } const db=opening.result; const attempts=db.objectStoreNames.contains('attempts') ? opening.transaction!.objectStore('attempts') : db.createObjectStore('attempts', {keyPath:'id'}); if(!db.objectStoreNames.contains('pending')) db.createObjectStore('pending'); if(!attempts.indexNames.contains('control-delivery')) attempts.createIndex('control-delivery',['host','paneId','sessionId','control.payload.clientMessageId']); };
      opening.onerror = () => finish(opening.error ?? new Error('No se pudo abrir el registro de envíos.'));
      opening.onblocked = () => finish(new Error('Otra ventana bloquea el registro de envíos.'));
      opening.onsuccess = () => {
        db = opening.result; if (settled) { db.close(); return; } db.onversionchange = () => db?.close();
        try {
          tx = db.transaction(['attempts','pending'], mode);
          tx.oncomplete = () => finish(); tx.onabort = () => finish(tx?.error ?? new Error('No se guardó el registro de envíos.')); tx.onerror = () => {};
          action(tx, value => { result=value; produced=true; }, fail);
        } catch (error) { fail(error instanceof Error ? error : new Error('Registro no disponible.')); }
      };
    });
  }
  const find = (key: string) => transaction<SessionAttempt | null>('readonly', (tx, done, fail) => {
    const pending = tx.objectStore('pending').get(key);
    pending.onsuccess = () => {
      if (pending.result === undefined) { done(null); return; }
      const read = tx.objectStore('attempts').get(pending.result);
      read.onsuccess = () => { try { const item = validate(read.result); if (item.key !== key || !unresolved(item.state)) throw new Error('La identidad del envío no coincide.'); done(item); } catch (error) { fail(error as Error); } };
    };
  });
  function change(id: string, update: (item:SessionAttempt) => SessionAttempt, remove: boolean) {
    return transaction<void>('readwrite', (tx, done, fail) => {
      const attempts=tx.objectStore('attempts'), pending=tx.objectStore('pending'), read=attempts.get(id);
      read.onsuccess = () => { try {
        const old=validate(read.result); const current=pending.get(old.key);
        current.onsuccess = () => { try {
          if (current.result !== id || !unresolved(old.state)) throw new Error('El envío ya cambió.');
          const next=validate(update(old)); attempts.put(next); if (remove) pending.delete(old.key); done();
        } catch(error) { fail(error as Error); } };
      } catch(error) { fail(error as Error); } };
    });
  }
  return {
    find,
    async begin(value) {
      const item=validate(value); if (item.state !== 'prepared') throw new Error('El intento no está preparado.');
      return transaction<void>('readwrite', (tx, done, fail) => {
        const attempts=tx.objectStore('attempts'), pending=tx.objectStore('pending'), read=pending.get(item.key);
        read.onsuccess = () => {
          if (read.result !== undefined) { fail(new Error('Esta instrucción ya tiene un envío sin resolver. Revisa el historial antes de continuar.')); return; }
          const count=pending.count(); count.onsuccess=() => {
            if (count.result >= MAX_PENDING) { fail(new Error('Hay demasiados envíos sin resolver; revisa los pendientes antes de continuar.')); return; }
            attempts.add(item); pending.add(item.id, item.key); done();
          };
        };
      });
    },
    dispatching: id => change(id, item => { if (item.state !== 'prepared') throw new Error('El intento ya cambió.'); return {...item,state:'dispatching'}; }, false),
    cancelBeforeDispatch: expected => change(expected.id, item => {
      if (!['prepared','dispatching'].includes(item.state) || JSON.stringify(item) !== JSON.stringify({...validate(expected),state:item.state})) throw new Error('El intento pertenece a otro envío.');
      return {...item,state:'cancelled'};
    }, true),
    unconfirmed: id => change(id, item => { if (item.state !== 'dispatching') throw new Error('El intento ya cambió.'); return {...item,state:'unconfirmed'}; }, false),
    recoverUnconfirmed: expected => change(expected.id, item => { if (item.state !== 'dispatching' || JSON.stringify(item) !== JSON.stringify(validate(expected))) throw new Error('El intento cambió durante la recuperación.'); return {...item,state:'unconfirmed'}; }, false),
    delivered: (id, instanceId) => change(id, item => { if (!['dispatching','unconfirmed'].includes(item.state) || item.instanceId !== instanceId) throw new Error('La confirmación corresponde a otra instancia.'); return {...item,state:'delivered'}; }, true),
    async list(host) {
      return transaction<SessionAttempt[]>('readonly', (tx, done, fail) => {
        const pending=tx.objectStore('pending').getAll(), attempts=tx.objectStore('attempts');
        pending.onsuccess = () => {
          if (!pending.result.length) { done([]); return; }
          const records:SessionAttempt[]=[]; let remaining=pending.result.length;
          for (const id of pending.result) {
            const read=attempts.get(id); read.onsuccess=() => { try {
              const item=validate(read.result); if (!unresolved(item.state)) throw new Error('El registro pendiente no es válido.');
              if (item.host === host) records.push(item);
              if (--remaining === 0) done(records.sort((a,b) => a.createdAt-b.createdAt));
            } catch(error) { fail(error as Error); } };
          }
        };
      });
    },
    page(host,offset,limit) {
      if (!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>20) throw new Error('Rango no válido.');
      return transaction<{items:SessionAttempt[];total:number}>('readonly',(tx,done,fail)=>{
        const cursor=tx.objectStore('pending').openCursor(),attempts=tx.objectStore('attempts'),items:SessionAttempt[]=[];let total=0;
        cursor.onsuccess=()=>{const c=cursor.result;if(!c){done({items,total});return;}const read=attempts.get(c.value);read.onsuccess=()=>{try{const item=validate(read.result);if(!unresolved(item.state)||item.key!==c.key)throw new Error('El registro pendiente no es válido.');if(item.host===host){if(total>=offset&&items.length<limit)items.push(item);total++;}c.continue();}catch(error){fail(error as Error);}};};
      });
    },
    getPending(host,id) {
      return transaction<SessionAttempt | null>('readonly',(tx,done,fail)=>{
        const read=tx.objectStore('attempts').get(id);read.onsuccess=()=>{try{if(!read.result){done(null);return;}const item=validate(read.result);if(item.host!==host||!unresolved(item.state)){done(null);return;}const pending=tx.objectStore('pending').get(item.key);pending.onsuccess=()=>{if(pending.result!==id){fail(new Error('El registro pendiente no es válido.'));return;}done(item);};}catch(error){fail(error as Error);}};
      });
    },
    confirmControlDelivery(host,paneId,sessionId,instanceId,clientMessageId) {
      return transaction<boolean>('readwrite',(tx,done,fail)=>{
        const attempts=tx.objectStore('attempts'),pending=tx.objectStore('pending'),cursor=attempts.index('control-delivery').openCursor(IDBKeyRange.only([host,paneId,sessionId,clientMessageId]));let found:SessionAttempt|undefined,count=0;
        cursor.onsuccess=()=>{const entry=cursor.result;if(entry){try{count++;if(count>1){done(false);return;}found=validate(entry.value);entry.continue();}catch(error){fail(error as Error);}return;}
          const item=found;if(!item||item.state!=='unconfirmed'||item.nativeReceipt!==1||item.control?.kind!=='prompt'||item.instanceId!==instanceId||item.control.payload.clientMessageId!==clientMessageId){done(false);return;}
          const read=pending.get(item.key);read.onsuccess=()=>{if(read.result!==item.id){fail(new Error('El registro pendiente cambió.'));return;}attempts.put({...item,state:'delivered'});pending.delete(item.key);done(true);};
        };
      });
    },
    reviewed: expected => change(expected.id, item => { if (item.state !== 'unconfirmed') throw new Error('El envío sigue en curso o perdió su comprobante de transporte; permanece bloqueado.'); if (JSON.stringify(item) !== JSON.stringify(validate(expected))) throw new Error('El envío cambió después de la revisión.'); return {...item,state:'reviewed'}; }, true),
  };
}
