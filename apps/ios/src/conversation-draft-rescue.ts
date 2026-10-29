import { exactConversationBase } from './conversation.ts';

/** A writer-specific draft backup in the existing conversation database.
 * It is not an audio receipt and can never authorize a native ACK or delete. */
export type DraftRescue = { schema: 'capri-draft-rescue/v1'; owner: string; sequence: number; baseRevision: number; draft: string; attachedWork?: string };
const PREFIX = 'conversation-draft-rescue:v1:';
const LIMIT = 100;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const natural = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function clean(input: unknown): DraftRescue {
  const value: unknown = structuredClone(input);
  if (!object(value) || Object.keys(value).some(key => !['schema', 'owner', 'sequence', 'baseRevision', 'draft', 'attachedWork'].includes(key))
    || value.schema !== 'capri-draft-rescue/v1' || !uuid(value.owner) || !natural(value.sequence) || value.sequence === 0
    || !natural(value.baseRevision) || typeof value.draft !== 'string' || value.draft.length > 8000
    || (value.attachedWork !== undefined && (typeof value.attachedWork !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.attachedWork)))) {
    throw new Error('El borrador de rescate requiere revisión. Se conservan los datos.');
  }
  return { schema: value.schema, owner: value.owner, sequence: value.sequence, baseRevision: value.baseRevision, draft: value.draft,
    ...(typeof value.attachedWork === 'string' ? { attachedWork: value.attachedWork } : {}) };
}
const same = (a: DraftRescue, b: DraftRescue) => a.owner === b.owner && a.sequence === b.sequence && a.baseRevision === b.baseRevision
  && a.draft === b.draft && a.attachedWork === b.attachedWork;
function transaction<T>(name: string, mode: IDBTransactionMode, operation: (store: IDBObjectStore, done: (result: T) => void, fail: (error: Error) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let db: IDBDatabase | undefined, tx: IDBTransaction | undefined, value: T, produced = false, ended = false, issue: Error | undefined;
    const finish = (error?: Error) => { if (ended) return; ended = true; clearTimeout(timer); db?.close(); if (error) reject(error); else if (produced) resolve(value); else reject(new Error('No se confirmó el rescate del borrador.')); };
    const fail = (error: Error) => { issue = error; if (!tx) { finish(error); return; } try { tx.abort(); } catch { finish(error); } };
    const timer = setTimeout(() => { try { tx?.abort(); } catch { /* Already settled. */ } finish(new Error('El rescate del borrador no respondió.')); }, 8000);
    try {
      const open = indexedDB.open(name, 1);
      open.onupgradeneeded = () => { if (ended) { open.transaction?.abort(); return; } open.result.createObjectStore('conversation'); };
      open.onerror = () => finish(new Error('No pude abrir el rescate del borrador.'));
      open.onblocked = () => finish(new Error('Otra versión mantiene abierta la conversación.'));
      open.onsuccess = () => {
        db = open.result; if (ended) { db.close(); return; } db.onversionchange = () => db?.close();
        try {
          tx = db.transaction('conversation', mode); tx.oncomplete = () => finish();
          tx.onabort = () => finish(issue ?? new Error('No se confirmó el rescate del borrador.'));
          tx.onerror = () => { issue ??= new Error('No se confirmó el rescate del borrador.'); };
          const store = tx.objectStore('conversation');
          if (store.keyPath !== null || store.autoIncrement) throw new Error('El esquema cambió. Se conservan los datos.');
          operation(store, result => { value = result; produced = true; }, fail);
        } catch (error) { fail(error instanceof Error ? error : new Error('No se inició el rescate.')); }
      };
    } catch (error) { finish(error instanceof Error ? error : new Error('No pude abrir el rescate.')); }
  });
}
function safely(fail: (error: Error) => void, fn: () => void) { try { fn(); } catch (error) { fail(error instanceof Error ? error : new Error('No se confirmó el rescate.')); } }

export function createConversationDraftRescue(options: { databaseName?: string } = {}) {
  const name = options.databaseName ?? 'capri-ios-conversation';
  if (!name || name.length > 256) throw new Error('El almacén de borradores no es válido.');
  const range = () => IDBKeyRange.bound(PREFIX, `${PREFIX}\uffff`);
  return {
    async save(input: unknown): Promise<'saved' | 'unchanged' | 'superseded'> {
      const record = clean(input);
      return transaction(name, 'readwrite', (store, done, fail) => {
        const get = store.get(PREFIX + record.owner);
        get.onsuccess = () => safely(fail, () => {
          if (get.result !== undefined) {
            const previous = clean(get.result);
            if (previous.owner !== record.owner) throw new Error('La identidad del borrador cambió.');
            if (previous.sequence > record.sequence) { done('superseded'); return; }
            if (previous.sequence === record.sequence) {
              if (!same(previous, record)) throw new Error('La revisión del borrador contiene otros cambios.');
              done('unchanged'); return;
            }
            store.put(record, PREFIX + record.owner); done('saved'); return;
          }
          const count = store.count(range());
          count.onsuccess = () => safely(fail, () => {
            if (count.result >= LIMIT) throw new Error('Hay demasiados borradores de rescate; revisa los guardados.');
            store.put(record, PREFIX + record.owner); done('saved');
          });
        });
      });
    },
    async list(): Promise<DraftRescue[]> {
      return transaction(name, 'readonly', (store, done, fail) => {
        const records: DraftRescue[] = [], cursor = store.openCursor(range());
        cursor.onsuccess = () => safely(fail, () => {
          const item = cursor.result;
          if (!item) { done(records); return; }
          const record = clean(item.value);
          if (item.key !== PREFIX + record.owner || records.length >= LIMIT) throw new Error('El rescate requiere revisión. Se conservan los datos.');
          records.push(record); item.continue();
        });
      });
    },
    /** Remove only the exact backup after its exact text and attachment are
     * in a later current snapshot. This does not prove or ACK any audio. */
    async retireIfCurrent(input: unknown): Promise<boolean> {
      const expected = clean(input);
      return transaction(name, 'readwrite', (store, done, fail) => {
        const get = store.get(PREFIX + expected.owner);
        get.onsuccess = () => safely(fail, () => {
          if (get.result === undefined || !same(clean(get.result), expected)) { done(false); return; }
          const guard = store.get('conversation-journal:v1');
          guard.onsuccess = () => safely(fail, () => {
            // A reserved future snapshot can still replace current; wait until
            // it resolves before removing any rescue copy.
            if (guard.result !== undefined) { done(false); return; }
            const current = store.get('current');
            current.onsuccess = () => safely(fail, () => {
              const snapshot: unknown = current.result;
              if (!object(snapshot) || !natural(snapshot.revision) || snapshot.revision <= expected.baseRevision
                || snapshot.draft !== expected.draft || snapshot.attachedWork !== expected.attachedWork) { done(false); return; }
              // The composer restores only a fully valid base. A matching draft
              // in a damaged snapshot is not evidence that it can be restored.
              try { exactConversationBase(snapshot); } catch { done(false); return; }
              store.delete(PREFIX + expected.owner); done(true);
            });
          });
        });
      });
    },
    /** Explicitly discard only the exact backup the user reviewed. */
    async discard(input: unknown): Promise<boolean> {
      const expected = clean(input);
      return transaction(name, 'readwrite', (store, done, fail) => {
        const get = store.get(PREFIX + expected.owner);
        get.onsuccess = () => safely(fail, () => {
          if (get.result === undefined || !same(clean(get.result), expected)) { done(false); return; }
          store.delete(PREFIX + expected.owner); done(true);
        });
      });
    },
  };
}
