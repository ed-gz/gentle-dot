import { hashSourceBytes } from './perception.ts';
import { parseNativeVoiceReceipt, type NativeVoiceReceipt } from './native-voice-receipts.ts';

export type SessionVoiceDraft = { revision: number; text: string };
const destinationOK = (s: string) => /^session:[a-f0-9]{64}$/.test(s);
const MAX = 8000;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function readDraft(value: unknown): SessionVoiceDraft {
  if (value === undefined) return { revision: 0, text: '' };
  if (!object(value) || Object.keys(value).some(k => !['revision','text'].includes(k)) || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1 || typeof value.text !== 'string' || value.text.length > MAX) throw new Error('El borrador de la sesión requiere revisión.');
  return { revision: value.revision as number, text: value.text };
}
function transact<T>(name: string, mode: IDBTransactionMode, work: (store: IDBObjectStore, done: (value: T) => void, fail: (err: Error) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let db: IDBDatabase | undefined, tx: IDBTransaction | undefined, result: T, ready = false, finished = false, issue: Error | undefined;
    const finish = (error?: Error) => { if (finished) return; finished = true; clearTimeout(timer); db?.close(); error ? reject(error) : ready ? resolve(result) : reject(new Error('No se confirmó el borrador.')); };
    const fail = (error: Error) => { issue = error; if (!tx) return finish(error); try { tx.abort(); } catch { finish(error); } };
    const timer = setTimeout(() => { try { tx?.abort(); } catch {} finish(new Error('No se confirmó el borrador.')); }, 8000);
    try {
      const open = indexedDB.open(name, 1);
      open.onupgradeneeded = () => { if (finished) { open.transaction?.abort(); return; } open.result.createObjectStore('drafts'); };
      open.onerror = () => finish(new Error('No se abrió el borrador de la sesión.'));
      open.onblocked = () => finish(new Error('Otra versión mantiene abierta la sesión.'));
      open.onsuccess = () => {
        db = open.result; if (finished) { db.close(); return; } db.onversionchange = () => db?.close();
        try {
          tx = db.transaction('drafts', mode); tx.oncomplete = () => finish(); tx.onabort = () => finish(issue ?? new Error('No se confirmó el borrador.')); tx.onerror = () => { issue ??= new Error('No se confirmó el borrador.'); };
          const store = tx.objectStore('drafts'); if (store.keyPath !== null || store.autoIncrement) throw new Error('El almacén de sesión cambió.');
          work(store, value => { result = value; ready = true; }, fail);
        } catch (error) { fail(error instanceof Error ? error : new Error('No se confirmó el borrador.')); }
      };
    } catch (error) { finish(error instanceof Error ? error : new Error('No se abrió el borrador.')); }
  });
}
const safely = (fail: (e: Error) => void, fn: () => void) => { try { fn(); } catch (e) { fail(e instanceof Error ? e : new Error('No se confirmó el borrador.')); } };
type Marker = { schema: 'capri-session-voice-delivery/v1'; sessionId: string; destination: string; receiptSHA256: string; revision: number; draftSHA256: string };
class ExistingDelivery extends Error {}
function validMarker(value: unknown, id: string, destination: string, hash: string): Marker {
  if (!object(value) || Object.keys(value).some(k => !['schema','sessionId','destination','receiptSHA256','revision','draftSHA256'].includes(k)) || value.schema !== 'capri-session-voice-delivery/v1' || value.sessionId !== id || value.destination !== destination || value.receiptSHA256 !== hash || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1 || typeof value.draftSHA256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.draftSHA256)) throw new Error('El dictado de esta sesión cambió. Se conserva para revisión.');
  return value as Marker;
}
const digestText = (text: string) => hashSourceBytes(new TextEncoder().encode(text));
export function createSessionVoiceDrafts(options: { databaseName?: string } = {}) {
  const name = options.databaseName ?? 'capri-ios-session-voice-drafts';
  if (!name || name.length > 256) throw new Error('Almacén no válido.');
  const key = (destination: string) => { if (!destinationOK(destination)) throw new Error('Destino de sesión no válido.'); return `draft:${destination}`; };
  async function verified(destination: string, receipt: NativeVoiceReceipt): Promise<SessionVoiceDraft | undefined> {
    const target = key(destination); if (receipt.audio.destination !== destination) throw new Error('El dictado pertenece a otra sesión.');
    const hash = await digestText(JSON.stringify(receipt)), id = receipt.audio.id.toLowerCase(), markerKey = `delivery:${id}`;
    const sample = await transact<{ marker: Marker; draft: SessionVoiceDraft } | undefined>(name, 'readonly', (store, done, fail) => {
      const mark = store.get(markerKey); mark.onsuccess = () => safely(fail, () => {
        if (mark.result === undefined) { done(undefined); return; }
        const marker = validMarker(mark.result, id, destination, hash), get = store.get(target);
        get.onsuccess = () => safely(fail, () => { const draft = readDraft(get.result); if (draft.revision < marker.revision) throw new Error('No se confirmó el borrador de esta sesión.'); done({ marker, draft }); });
      });
    });
    if (!sample) return undefined;
    if (sample.draft.revision === sample.marker.revision && await digestText(sample.draft.text) !== sample.marker.draftSHA256) throw new Error('El borrador de esta sesión cambió.');
    // Hashing is asynchronous. Re-read the same marker and complete draft in
    // one transaction before accepting the evidence or allowing cleanup.
    return transact(name, 'readonly', (store, done, fail) => {
      const mark = store.get(markerKey); mark.onsuccess = () => safely(fail, () => {
        const marker = validMarker(mark.result, id, destination, hash), get = store.get(target);
        get.onsuccess = () => safely(fail, () => {
          const draft = readDraft(get.result);
          if (marker.revision !== sample.marker.revision || marker.draftSHA256 !== sample.marker.draftSHA256 || draft.revision !== sample.draft.revision || draft.text !== sample.draft.text) throw new Error('El borrador cambió durante la revisión.');
          done(draft);
        });
      });
    });
  }
  return {
    async delivered(destination: string, input: NativeVoiceReceipt): Promise<boolean> {
      return (await verified(destination, parseNativeVoiceReceipt(input))) !== undefined;
    },
    async read(destination: string): Promise<SessionVoiceDraft> {
      const target = key(destination);
      return transact(name, 'readonly', (store, done, fail) => { const req = store.get(target); req.onsuccess = () => safely(fail, () => done(readDraft(req.result))); });
    },
    async save(destination: string, expected: SessionVoiceDraft, text: string): Promise<SessionVoiceDraft> {
      const target = key(destination); if (!Number.isSafeInteger(expected.revision) || expected.revision < 0 || typeof expected.text !== 'string' || typeof text !== 'string' || text.length > MAX) throw new Error('Borrador no válido.');
      return transact(name, 'readwrite', (store, done, fail) => { const req = store.get(target); req.onsuccess = () => safely(fail, () => {
        const current = readDraft(req.result); if (current.revision !== expected.revision || current.text !== expected.text) throw new Error('El borrador cambió en otra ventana.');
        const next = { revision: current.revision + 1, text }; if (!Number.isSafeInteger(next.revision)) throw new Error('Revisión no válida.'); store.put(next, target); done(next);
      }); });
    },
    async deliver(destination: string, input: NativeVoiceReceipt, expected: SessionVoiceDraft): Promise<{ draft: SessionVoiceDraft; alreadyDelivered: boolean }> {
      const target = key(destination), receipt = parseNativeVoiceReceipt(input); if (receipt.audio.destination !== destination) throw new Error('El dictado pertenece a otra sesión.');
      const hash = await hashSourceBytes(new TextEncoder().encode(JSON.stringify(receipt))); const id = receipt.audio.id.toLowerCase(), markerKey = `delivery:${id}`;
      if (!Number.isSafeInteger(expected.revision) || expected.revision < 0 || typeof expected.text !== 'string' || expected.text.length > MAX) throw new Error('Borrador no válido.');
      // Retry the exact durable delivery before calculating a new insertion:
      // the current draft may already contain the dictation and be full.
      const delivered = await verified(destination, receipt);
      if (delivered) return { draft: delivered, alreadyDelivered: true };
      const proposed = `${expected.text}${expected.text.trim() ? '\n' : ''}${receipt.transcript.text}`;
      if (proposed.length > MAX) {
        // A different window may have delivered the same receipt after the
        // initial read. Only its fully verified marker can resolve the retry.
        const concurrent = await verified(destination, receipt);
        if (concurrent) return { draft: concurrent, alreadyDelivered: true };
        throw new Error('El dictado no cabe completo. Se conserva para revisión.');
      }
      const draftSHA256 = await digestText(proposed);
      try {
        return await transact(name, 'readwrite', (store, done, fail) => { const mark = store.get(markerKey); mark.onsuccess = () => safely(fail, () => {
          if (mark.result !== undefined) throw new ExistingDelivery('El dictado ya fue entregado.');
          const get = store.get(target); get.onsuccess = () => safely(fail, () => {
            const current = readDraft(get.result); if (current.revision !== expected.revision || current.text !== expected.text) throw new Error('El borrador cambió en otra ventana. El dictado se conserva.');
            const draft = { revision: current.revision + 1, text: proposed }; if (!Number.isSafeInteger(draft.revision)) throw new Error('Revisión no válida.');
            store.put(draft, target); store.put({ schema: 'capri-session-voice-delivery/v1', sessionId: id, destination, receiptSHA256: hash, revision: draft.revision, draftSHA256 }, markerKey); done({ draft, alreadyDelivered: false });
          });
        }); });
      } catch (error) {
        if (!(error instanceof ExistingDelivery)) throw error;
        const draft = await verified(destination, receipt);
        if (!draft) throw new Error('No se confirmó el dictado.');
        return { draft, alreadyDelivered: true };
      }
    },
  };
}
