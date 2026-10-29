import { exactConversationBase } from './conversation.ts';
import { hashSourceBytes } from './perception.ts';
import { parseNativeVoiceReceipt, type NativeVoiceReceipt } from './native-voice-receipts.ts';

export const NATIVE_VOICE_DELIVERY_PREFIX = 'native-voice-delivery:v1:';
const PREFIX = NATIVE_VOICE_DELIVERY_PREFIX;
export type NativeVoiceDeliveryIntent = { sessionId: string; receiptSHA256: string; priorDraft: string; transcript: string; receipt: NativeVoiceReceipt };
type Marker = { schema: 'capri-native-voice-delivery/v1'; sessionId: string; receiptSHA256: string; snapshotSHA256: string; revision: number };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function marker(input: unknown): Marker {
  if (!object(input) || Object.keys(input).some(key => !['schema', 'sessionId', 'receiptSHA256', 'snapshotSHA256', 'revision'].includes(key))
    || input.schema !== 'capri-native-voice-delivery/v1' || typeof input.sessionId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(input.sessionId)
    || typeof input.receiptSHA256 !== 'string' || !/^[a-f0-9]{64}$/.test(input.receiptSHA256)
    || typeof input.snapshotSHA256 !== 'string' || !/^[a-f0-9]{64}$/.test(input.snapshotSHA256)
    || !Number.isSafeInteger(input.revision) || Number(input.revision) < 1) throw new Error('El estado del dictado requiere revisión. La copia se conserva.');
  return input as Marker;
}
async function identity(input: NativeVoiceReceipt) {
  const receipt = parseNativeVoiceReceipt(input);
  if (receipt.audio.destination !== 'chat') throw new Error('El dictado pertenece a otra conversación.');
  const receiptSHA256 = await hashSourceBytes(new TextEncoder().encode(JSON.stringify(receipt)));
  return { receipt, sessionId: receipt.audio.id.toLowerCase(), receiptSHA256 };
}
export async function prepareNativeVoiceDelivery(input: NativeVoiceReceipt, priorDraft: string): Promise<NativeVoiceDeliveryIntent> {
  const { receipt, sessionId, receiptSHA256 } = await identity(input);
  const intent = { sessionId, receiptSHA256, priorDraft, transcript: receipt.transcript.text, receipt };
  validateNativeVoiceDelivery(intent, `${priorDraft}${priorDraft.trim() ? '\n' : ''}${receipt.transcript.text}`);
  return intent;
}
export function validateNativeVoiceDelivery(input: unknown, draft: string): NativeVoiceDeliveryIntent {
  if (!object(input) || Object.keys(input).some(key => !['sessionId', 'receiptSHA256', 'priorDraft', 'transcript', 'receipt'].includes(key))
    || typeof input.sessionId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(input.sessionId)
    || typeof input.receiptSHA256 !== 'string' || !/^[a-f0-9]{64}$/.test(input.receiptSHA256)
    || typeof input.priorDraft !== 'string' || typeof input.transcript !== 'string' || !input.transcript.length
    || `${input.priorDraft}${input.priorDraft.trim() ? '\n' : ''}${input.transcript}` !== draft || draft.length > 8000) throw new Error('La inserción de voz no coincide con el borrador.');
  const receipt = parseNativeVoiceReceipt(input.receipt);
  if (receipt.audio.destination !== 'chat' || receipt.audio.id.toLowerCase() !== input.sessionId || receipt.transcript.text !== input.transcript) throw new Error('El recibo no coincide con el dictado.');
  return { sessionId: input.sessionId, receiptSHA256: input.receiptSHA256, priorDraft: input.priorDraft, transcript: input.transcript, receipt };
}
/** Verify the stored receipt itself, not merely a separately supplied hash. */
export async function verifyNativeVoiceDelivery(intent: NativeVoiceDeliveryIntent): Promise<void> {
  const actual = await identity(intent.receipt);
  if (actual.sessionId !== intent.sessionId || actual.receiptSHA256 !== intent.receiptSHA256 || actual.receipt.transcript.text !== intent.transcript) throw new Error('El recibo del dictado no coincide. Se conserva para revisión.');
}
export async function nativeVoiceSnapshotSHA256(value: unknown): Promise<string> {
  const snapshot = exactConversationBase(value);
  if (!snapshot) throw new Error('El borrador del dictado requiere revisión.');
  return hashSourceBytes(new TextEncoder().encode(JSON.stringify(snapshot)));
}
export function nativeVoiceMarker(intent: NativeVoiceDeliveryIntent, revision: number, snapshotSHA256: string): Marker {
  return { schema: 'capri-native-voice-delivery/v1', sessionId: intent.sessionId, receiptSHA256: intent.receiptSHA256, snapshotSHA256, revision };
}
function transaction<T>(name: string, mode: IDBTransactionMode, action: (store: IDBObjectStore, done: (value: T) => void, fail: (error: Error) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let db: IDBDatabase | undefined, tx: IDBTransaction | undefined, value: T, produced = false, ended = false, issue: Error | undefined;
    const finish = (error?: Error) => { if (ended) return; ended = true; clearTimeout(timer); db?.close(); if (error) reject(error); else if (produced) resolve(value); else reject(new Error('No se confirmó la entrega del dictado.')); };
    const fail = (error: Error) => { issue = error; if (!tx) { finish(error); return; } try { tx.abort(); } catch { finish(error); } };
    const timer = setTimeout(() => { try { tx?.abort(); } catch { /* Already complete. */ } finish(new Error('No se confirmó la entrega del dictado.')); }, 8000);
    try {
      const open = indexedDB.open(name, 1);
      open.onupgradeneeded = () => { if (ended) { open.transaction?.abort(); return; } open.result.createObjectStore('conversation'); };
      open.onerror = () => finish(new Error('No pude abrir el estado del dictado.'));
      open.onblocked = () => finish(new Error('Otra versión mantiene abierta la conversación.'));
      open.onsuccess = () => {
        db = open.result; if (ended) { db.close(); return; } db.onversionchange = () => db?.close();
        try {
          tx = db.transaction('conversation', mode); tx.oncomplete = () => finish();
          tx.onabort = () => finish(issue ?? new Error('No se confirmó la entrega del dictado.'));
          tx.onerror = () => { issue ??= new Error('No se confirmó la entrega del dictado.'); };
          const store = tx.objectStore('conversation');
          if (store.keyPath !== null || store.autoIncrement) throw new Error('El esquema cambió. Se conservan los datos.');
          action(store, result => { value = result; produced = true; }, fail);
        } catch (error) { fail(error instanceof Error ? error : new Error('No se confirmó la entrega.')); }
      };
    } catch (error) { finish(error instanceof Error ? error : new Error('No se abrió la conversación.')); }
  });
}
function safely(fail: (error: Error) => void, action: () => void) { try { action(); } catch (error) { fail(error instanceof Error ? error : new Error('No se confirmó la entrega.')); } }

/** A marker records an earlier exact insertion; it never deletes a transcript
 * and is not proof that the person has not since edited their message. */
export function createNativeVoiceDelivery(options: { databaseName?: string } = {}) {
  const name = options.databaseName ?? 'capri-ios-conversation';
  if (!name || name.length > 256) throw new Error('El almacén de conversación no es válido.');
  return {
    async delivered(input: NativeVoiceReceipt): Promise<boolean> {
      const { sessionId, receiptSHA256 } = await identity(input);
      const read = () => transaction<{ marker: Marker; current: NonNullable<ReturnType<typeof exactConversationBase>> } | undefined>(name, 'readonly', (store, done, fail) => {
        const get = store.get(PREFIX + sessionId);
        get.onsuccess = () => safely(fail, () => {
          if (get.result === undefined) { done(undefined); return; }
          const prior = marker(get.result);
          if (prior.sessionId !== sessionId || prior.receiptSHA256 !== receiptSHA256) throw new Error('El dictado guardado cambió. Se conserva para revisión.');
          const getCurrent = store.get('current');
          getCurrent.onsuccess = () => safely(fail, () => {
            const current = exactConversationBase(getCurrent.result);
            if (!current || !Number.isSafeInteger(current.revision) || Number(current.revision) < prior.revision) throw new Error('El borrador del dictado requiere revisión.');
            done({ marker: prior, current });
          });
        });
      });
      const captured = await read();
      if (!captured) return false;
      if (captured.current.revision === captured.marker.revision && await nativeVoiceSnapshotSHA256(captured.current) !== captured.marker.snapshotSHA256) throw new Error('El borrador del dictado no coincide con su entrega.');
      // Hashing crosses an async bridge; re-read the exact records so a
      // concurrent write cannot make the checked snapshot stale unnoticed.
      const after = await read();
      if (!after || JSON.stringify(after) !== JSON.stringify(captured)) throw new Error('El borrador cambió durante la revisión del dictado.');
      return true;
    },

  };
}
