import { canonicalConversationSnapshot, type Conversation } from './conversation.ts';
import { hashSourceBytes } from './perception.ts';
import { prepareVoiceReceiptInput, type VoiceReceiptInput } from './voice-receipt-store.ts';

/** This operation uses the real chat database and its existing version-1
 * object store, but is not yet called by the UI or authorized to ACK audio.
 * An immutable receipt retains only the transcript and hashes, never a copy
 * of unrelated draft text. Hashes are assertions, not authentication; once
 * the draft changes they cannot prove that old text is still available. The
 * existing conversation writer accepts a higher-revision stale snapshot, so
 * it can overwrite an insertion after this transaction commits. An applied
 * intent is therefore not proof that text is present and must never trigger
 * an audio ACK. Activation still needs native source/lease matching,
 * cancellation fencing, cross-window and in-memory coordination, an explicit
 * retention/discard policy and an accessible recovery view. */
export type VoiceChatBase = { draft: string; revision: number };
export type VoiceChatCommit = {
  schema: 'capri-voice-chat-commit/v1';
  input: VoiceReceiptInput;
  inputSHA256: string;
  baseRevision: number;
  baseDraftSHA256: string;
  appliedRevision: number;
  committedDraftSHA256: string;
};
export type VoiceChatResult = { receipt: VoiceChatCommit; currentDraft: string; currentRevision: number; alreadyApplied: boolean };
export type VoiceChatRestore = { currentDraft: string; currentRevision: number; outcome: 'inserted' | 'matching-text' | 'replayed-action' };
export type VoiceChatRestoreIntent = { schema: 'capri-voice-chat-restore/v2'; actionId: string; sessionId: string; inputSHA256: string; state: 'pending' }
  | { schema: 'capri-voice-chat-restore/v2'; actionId: string; sessionId: string; inputSHA256: string; state: 'applied';
      baseRevision: number; appliedRevision: number; baseDraftSHA256: string; resultDraftSHA256: string; outcome: 'inserted' | 'matching-text' };
const MAX_RECEIPTS = 100;
const natural = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value);
// JSON escaping preserves lone UTF-16 surrogates; raw TextEncoder would map
// them to U+FFFD and make distinct JavaScript drafts share the same digest.
const digest = (text: string) => hashSourceBytes(new TextEncoder().encode(JSON.stringify(text)));
const receiptKey = (id: string) => `voice-receipt:${id}`;
const ownerKey = (id: string) => `voice-owner:${id}`;
const restoreKey = (id: string) => `voice-restore:${id}`;
function deepSame(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => deepSame(item, b[i]));
  if (!object(a) || !object(b)) return false;
  const ak = Object.keys(a).sort(), bk = Object.keys(b).sort();
  return ak.length === bk.length && ak.every((key, i) => key === bk[i] && deepSame(a[key], b[key]));
}
function current(value: unknown): Conversation {
  if (value === undefined) return { entries: [], draft: '', revision: 0 };
  if (!object(value) || Object.keys(value).some(key => !['entries', 'draft', 'revision', 'attachedWork'].includes(key))
    || !Array.isArray(value.entries) || value.entries.length > 120 || typeof value.draft !== 'string' || value.draft.length > 8000
    || (value.revision !== undefined && !natural(value.revision))) throw new Error('La conversación guardada no es válida; no se modificó.');
  const normalized = canonicalConversationSnapshot(value as Conversation);
  if (!deepSame(normalized, value)) throw new Error('La conversación requiere revisión; no se descartaron campos.');
  return normalized;
}
function validReceipt(value: unknown): value is VoiceChatCommit {
  if (!object(value) || Object.keys(value).sort().join(',') !== ['appliedRevision','baseRevision','baseDraftSHA256','committedDraftSHA256','input','inputSHA256','schema'].sort().join(',')
    || value.schema !== 'capri-voice-chat-commit/v1' || !object(value.input) || typeof value.inputSHA256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.inputSHA256)
    || !natural(value.baseRevision) || !natural(value.appliedRevision) || value.appliedRevision !== value.baseRevision + 1
    || typeof value.baseDraftSHA256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.baseDraftSHA256)
    || typeof value.committedDraftSHA256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.committedDraftSHA256)) return false;
  return true;
}
function validRestore(value: unknown): value is VoiceChatRestoreIntent {
  if (!object(value) || value.schema !== 'capri-voice-chat-restore/v2' || !uuid(value.actionId) || value.actionId !== value.actionId.toLowerCase()
    || !uuid(value.sessionId) || value.sessionId !== value.sessionId.toLowerCase() || typeof value.inputSHA256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.inputSHA256)) return false;
  const base = ['schema', 'actionId', 'sessionId', 'inputSHA256', 'state'];
  if (value.state === 'pending') return Object.keys(value).sort().join(',') === base.sort().join(',');
  if (value.state !== 'applied' || !['inserted', 'matching-text'].includes(String(value.outcome)) || !natural(value.baseRevision) || !natural(value.appliedRevision)
    || value.appliedRevision !== value.baseRevision + (value.outcome === 'inserted' ? 1 : 0)
    || typeof value.baseDraftSHA256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.baseDraftSHA256)
    || typeof value.resultDraftSHA256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.resultDraftSHA256)) return false;
  return Object.keys(value).sort().join(',') === [...base, 'baseRevision', 'appliedRevision', 'baseDraftSHA256', 'resultDraftSHA256', 'outcome'].sort().join(',');
}
async function verifyReceipt(value: VoiceChatCommit, sessionId: string): Promise<VoiceChatCommit> {
  const { input, inputSHA256 } = await prepareVoiceReceiptInput(value.input);
  if (input.destination !== 'chat' || input.transcript.sessionId !== sessionId.toLowerCase() || inputSHA256 !== value.inputSHA256
    || !deepSame(input, value.input)) throw new Error('La evidencia guardada no coincide; se conserva para revisión.');
  return { ...value, input };
}
function transact<T>(databaseName: string, mode: IDBTransactionMode,
  work: (store: IDBObjectStore, done: (value: T) => void, fail: (error: Error) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let db: IDBDatabase | undefined, tx: IDBTransaction | undefined, result: T, produced = false, settled = false, issue: Error | undefined;
    const finish = (error?: Error) => {
      if (settled) return; settled = true; clearTimeout(timer); db?.close();
      if (error) reject(error); else if (produced) resolve(result); else reject(new Error('No se confirmó la escritura del dictado.'));
    };
    const fail = (error: Error) => { issue = error; if (!tx) { finish(error); return; } try { tx.abort(); } catch { finish(error); } };
    const timer = setTimeout(() => { try { tx?.abort(); } catch { /* Already closed. */ } finish(new Error('El guardado del dictado no respondió.')); }, 8000);
    try {
      // Do not change schema version: all current Capri readers use v1.
      const open = indexedDB.open(databaseName, 1);
      open.onupgradeneeded = () => { if (settled) { open.transaction?.abort(); return; } open.result.createObjectStore('conversation'); };
      open.onerror = () => finish(new Error('No pude abrir la conversación para guardar el dictado.'));
      open.onblocked = () => finish(new Error('Otra versión mantiene abierta la conversación.'));
      open.onsuccess = () => {
        db = open.result; if (settled) { db.close(); return; }
        db.onversionchange = () => db?.close();
        try {
          tx = db.transaction('conversation', mode);
          tx.oncomplete = () => finish();
          tx.onabort = () => finish(issue ?? new Error('No se confirmó el guardado del dictado.'));
          tx.onerror = () => { issue ??= new Error('No se confirmó el guardado del dictado.'); };
          const store = tx.objectStore('conversation');
          if (store.keyPath !== null || store.autoIncrement) throw new Error('El esquema de conversación cambió; se conservan los datos.');
          work(store, value => { result = value; produced = true; }, fail);
        } catch (error) { fail(error instanceof Error ? error : new Error('No pude iniciar el guardado del dictado.')); }
      };
    } catch (error) { finish(error instanceof Error ? error : new Error('No pude abrir la conversación.')); }
  });
}
function safely(fail: (error: Error) => void, action: () => void) {
  try { action(); } catch (error) { fail(error instanceof Error ? error : new Error('No se guardó el dictado.')); }
}

export function createVoiceChatCommit(options: { databaseName?: string } = {}) {
  const name = options.databaseName ?? 'capri-ios-conversation';
  if (!name || name.length > 256) throw new Error('El almacén de conversación no es válido.');
  return {
    /** Atomically stores transcript, draft and revision-bound hashes; no audio is
     * removed and no native acknowledgement is issued by this method. */
    async apply(inputValue: VoiceReceiptInput, baseValue: VoiceChatBase): Promise<VoiceChatResult> {
      const inputSnapshot = structuredClone(inputValue), base = structuredClone(baseValue);
      if (!base || typeof base.draft !== 'string' || base.draft.length > 8000 || !natural(base.revision)) throw new Error('La revisión del borrador no es válida.');
      const { input, inputSHA256 } = await prepareVoiceReceiptInput(inputSnapshot);
      if (input.destination !== 'chat') throw new Error('Este dictado no pertenece a la conversación principal.');
      const merged = `${base.draft}${base.draft.trim() ? '\n' : ''}${input.transcript.text}`;
      if (merged.length > 8000) throw new Error('La transcripción no cabe en el borrador. El audio se conserva.');
      const baseDraftSHA256 = await digest(base.draft);
      const committedDraftSHA256 = await digest(merged);
      return transact(name, 'readwrite', (store, done, fail) => {
        const getOwner = store.get(ownerKey(input.ownerId));
        getOwner.onsuccess = () => safely(fail, () => {
          const existingOwner = getOwner.result;
          if (existingOwner !== undefined && existingOwner !== input.transcript.sessionId) throw new Error('El dueño de este dictado ya corresponde a otra grabación.');
          const getReceipt = store.get(receiptKey(input.transcript.sessionId));
          getReceipt.onsuccess = () => safely(fail, () => {
            const prior = getReceipt.result;
            const getCurrent = store.get('current');
            getCurrent.onsuccess = () => safely(fail, () => {
              const old = current(getCurrent.result), revision = old.revision ?? 0;
              if (prior !== undefined) {
                if (existingOwner !== input.transcript.sessionId || !validReceipt(prior) || prior.inputSHA256 !== inputSHA256 || !deepSame(prior.input, input)
                  || prior.baseRevision !== base.revision || prior.appliedRevision !== base.revision + 1
                  || prior.baseDraftSHA256 !== baseDraftSHA256 || prior.committedDraftSHA256 !== committedDraftSHA256) throw new Error('El recibo no coincide; se conserva para revisión.');
                done({ receipt: prior, currentDraft: old.draft, currentRevision: revision, alreadyApplied: true }); return;
              }
              if (existingOwner !== undefined) throw new Error('Falta el recibo vinculado; se conservan los datos.');
              if (revision !== base.revision || old.draft !== base.draft) throw new Error('El borrador cambió; conserva el audio y vuelve a revisar.');
              if (revision >= Number.MAX_SAFE_INTEGER) throw new Error('La revisión alcanzó su límite.');
              const count = store.count(IDBKeyRange.bound('voice-receipt:', 'voice-receipt:\uffff'));
              count.onsuccess = () => safely(fail, () => {
                if (count.result >= MAX_RECEIPTS) throw new Error('El archivo de dictados alcanzó su límite; el audio se conserva.');
                const next: Conversation = { ...old, draft: merged, revision: revision + 1 };
                const receipt: VoiceChatCommit = { schema: 'capri-voice-chat-commit/v1', input, inputSHA256, baseRevision: revision,
                  baseDraftSHA256, appliedRevision: revision + 1, committedDraftSHA256 };
                store.put(next, 'current'); store.put(receipt, receiptKey(input.transcript.sessionId));
                const owner = store.put(input.transcript.sessionId, ownerKey(input.ownerId));
                owner.onsuccess = () => done({ receipt, currentDraft: next.draft, currentRevision: revision + 1, alreadyApplied: false });
              });
            });
          });
        });
      });
    },
    /** Persist an action identity before attempting recovery. This stores no
     * draft or transcript copy and does not apply text or acknowledge audio.
     * Callers must discover and reuse unresolved actions after interruption:
     * this API permits several action IDs per receipt. The bounded history has
     * no compaction, and its draft hashes remain potentially sensitive. */
    async prepareRestore(receiptValue: VoiceChatCommit, actionId: string): Promise<VoiceChatRestoreIntent> {
      const receipt = structuredClone(receiptValue);
      if (!validReceipt(receipt) || !object(receipt.input) || !object(receipt.input.transcript) || !uuid(receipt.input.transcript.sessionId) || !uuid(actionId)) throw new Error('La recuperación no es válida.');
      const verified = await verifyReceipt(receipt, receipt.input.transcript.sessionId);
      const action = actionId.toLowerCase(), sessionId = verified.input.transcript.sessionId;
      return transact(name, 'readwrite', (store, done, fail) => {
        const getReceipt = store.get(receiptKey(sessionId));
        getReceipt.onsuccess = () => safely(fail, () => {
          if (!deepSame(getReceipt.result, verified)) throw new Error('El recibo cambió; no se preparó la recuperación.');
          const owner = store.get(ownerKey(verified.input.ownerId));
          owner.onsuccess = () => safely(fail, () => {
            if (owner.result !== sessionId) throw new Error('El dueño del dictado cambió; no se preparó.');
            const existing = store.get(restoreKey(action));
            existing.onsuccess = () => safely(fail, () => {
              if (existing.result !== undefined) {
                if (!validRestore(existing.result) || existing.result.actionId !== action || existing.result.sessionId !== sessionId || existing.result.inputSHA256 !== verified.inputSHA256) throw new Error('La identidad de recuperación ya corresponde a otra acción.');
                done(existing.result); return;
              }
              const count = store.count(IDBKeyRange.bound('voice-restore:', 'voice-restore:\uffff'));
              count.onsuccess = () => safely(fail, () => {
                if (count.result >= MAX_RECEIPTS) throw new Error('El historial de recuperaciones alcanzó su límite; el dictado se conserva.');
                const intent: VoiceChatRestoreIntent = { schema: 'capri-voice-chat-restore/v2', actionId: action, sessionId, inputSHA256: verified.inputSHA256, state: 'pending' };
                const put = store.put(intent, restoreKey(action)); put.onsuccess = () => done(intent);
              });
            });
          });
        });
      });
    },
    /** A user gesture may append a saved dictation to the exact current draft.
     * Reusing its durable actionId returns the prior outcome without reapplying.
     * A matching text line is reported separately; it is not proof of origin. */
    async restore(receiptValue: VoiceChatCommit, baseValue: VoiceChatBase, actionId: string): Promise<VoiceChatRestore> {
      const receipt = structuredClone(receiptValue), base = structuredClone(baseValue);
      if (!validReceipt(receipt) || !object(receipt.input) || !object(receipt.input.transcript) || !uuid(receipt.input.transcript.sessionId)
        || !base || typeof base.draft !== 'string' || base.draft.length > 8000 || !natural(base.revision) || !uuid(actionId)) throw new Error('La recuperación no es válida.');
      const verified = await verifyReceipt(receipt, receipt.input.transcript.sessionId);
      const text = verified.input.transcript.text;
      const present = base.draft === text || base.draft.startsWith(`${text}\n`) || base.draft.endsWith(`\n${text}`) || base.draft.includes(`\n${text}\n`);
      const merged = present ? base.draft : `${base.draft}${base.draft.trim() ? '\n' : ''}${text}`;
      const baseDraftSHA256 = await digest(base.draft), resultDraftSHA256 = await digest(merged);
      const action = actionId.toLowerCase(), sessionId = verified.input.transcript.sessionId;
      return transact(name, 'readwrite', (store, done, fail) => {
        const getReceipt = store.get(receiptKey(sessionId));
        getReceipt.onsuccess = () => safely(fail, () => {
          if (!deepSame(getReceipt.result, verified)) throw new Error('El recibo cambió; no se recuperó el dictado.');
          const getOwner = store.get(ownerKey(verified.input.ownerId));
          getOwner.onsuccess = () => safely(fail, () => {
            if (getOwner.result !== sessionId) throw new Error('El dueño del dictado cambió; no se recuperó.');
            const getAction = store.get(restoreKey(action));
            getAction.onsuccess = () => safely(fail, () => {
              const intent = getAction.result;
              if (!validRestore(intent) || intent.actionId !== action || intent.sessionId !== sessionId || intent.inputSHA256 !== verified.inputSHA256) throw new Error('Falta la intención durable de recuperación.');
              const getCurrent = store.get('current');
              getCurrent.onsuccess = () => safely(fail, () => {
                const old = current(getCurrent.result), revision = old.revision ?? 0;
                if (intent.state === 'applied') { done({ currentDraft: old.draft, currentRevision: revision, outcome: 'replayed-action' }); return; }
                if (old.draft !== base.draft || revision !== base.revision) throw new Error('El borrador cambió; vuelve a revisar el dictado.');
                if (merged.length > 8000) throw new Error('El dictado no cabe en el borrador. La transcripción se conserva.');
                if (!present && revision >= Number.MAX_SAFE_INTEGER) throw new Error('La revisión alcanzó su límite.');
                const next: Conversation = present ? old : { ...old, draft: merged, revision: revision + 1 };
                const marker: VoiceChatRestoreIntent = { ...intent, state: 'applied', baseRevision: revision, appliedRevision: revision + (present ? 0 : 1),
                  outcome: present ? 'matching-text' : 'inserted', baseDraftSHA256, resultDraftSHA256 };
                if (!present) store.put(next, 'current');
                const write = store.put(marker, restoreKey(action));
                write.onsuccess = () => done({ currentDraft: next.draft, currentRevision: revision + (present ? 0 : 1), outcome: marker.outcome });
              });
            });
          });
        });
      });
    },
    /** Snapshot discovery only. An applied action records a prior event, not
     * whether the user has since edited or removed the dictation. */
    async listRestores(receiptValue: VoiceChatCommit): Promise<VoiceChatRestoreIntent[]> {
      const receipt = structuredClone(receiptValue);
      if (!validReceipt(receipt) || !object(receipt.input) || !object(receipt.input.transcript) || !uuid(receipt.input.transcript.sessionId)) throw new Error('La recuperación no es válida.');
      const verified = await verifyReceipt(receipt, receipt.input.transcript.sessionId), sessionId = verified.input.transcript.sessionId;
      return transact(name, 'readonly', (store, done, fail) => {
        const getReceipt = store.get(receiptKey(sessionId));
        getReceipt.onsuccess = () => safely(fail, () => {
          if (!deepSame(getReceipt.result, verified)) throw new Error('El recibo cambió; se conservan los datos.');
          const owner = store.get(ownerKey(verified.input.ownerId));
          owner.onsuccess = () => safely(fail, () => {
            if (owner.result !== sessionId) throw new Error('El dueño del dictado cambió.');
            const result: VoiceChatRestoreIntent[] = [];
            let count = 0;
            const cursor = store.openCursor(IDBKeyRange.bound('voice-restore:', 'voice-restore:\uffff'));
            cursor.onsuccess = () => safely(fail, () => {
              const item = cursor.result;
              if (!item) { done(result); return; }
              if (++count > MAX_RECEIPTS || !validRestore(item.value) || item.key !== restoreKey(item.value.actionId)) throw new Error('El historial de recuperaciones no es válido.');
              if (item.value.sessionId === sessionId) {
                if (item.value.inputSHA256 !== verified.inputSHA256) throw new Error('La recuperación no corresponde al dictado.');
                result.push(item.value);
              }
              item.continue();
            });
          });
        });
      });
    },
    /** Inspection is a snapshot: another window can change records during
     * hashing. Never use this alone to acknowledge or delete native audio. */
    async inspect(sessionId: string): Promise<VoiceChatCommit | undefined> {
      if (!uuid(sessionId)) throw new Error('El dictado no es válido.');
      const value = await transact<VoiceChatCommit | undefined>(name, 'readonly', (store, done, fail) => {
        const request = store.get(receiptKey(sessionId.toLowerCase()));
        request.onsuccess = () => safely(fail, () => {
          if (request.result === undefined) { done(undefined); return; }
          if (!validReceipt(request.result)) throw new Error('El recibo guardado no es válido.');
          const receipt = request.result;
          if (!object(receipt.input) || !uuid(receipt.input.ownerId)) throw new Error('El propietario del recibo no es válido.');
          const owner = store.get(ownerKey(receipt.input.ownerId.toLowerCase()));
          owner.onsuccess = () => safely(fail, () => {
            if (owner.result !== sessionId.toLowerCase()) throw new Error('La identidad del recibo no coincide; se conserva para revisión.');
            done(receipt);
          });
        });
      });
      if (!value) return undefined;
      return verifyReceipt(value, sessionId);
    },
    /** Discovery for a future recovery view; it does not apply text or ACK. */
    async list(): Promise<VoiceChatCommit[]> {
      const values = await transact<VoiceChatCommit[]>(name, 'readonly', (store, done, fail) => {
        const found: VoiceChatCommit[] = [];
        const request = store.openCursor(IDBKeyRange.bound('voice-receipt:', 'voice-receipt:\uffff'));
        request.onsuccess = () => safely(fail, () => {
          const cursor = request.result;
          if (!cursor) { done(found); return; }
          if (found.length >= MAX_RECEIPTS || !validReceipt(cursor.value) || !object(cursor.value.input)
            || !uuid(cursor.value.input.ownerId) || !object(cursor.value.input.transcript) || !uuid(cursor.value.input.transcript.sessionId)
            || cursor.key !== receiptKey(cursor.value.input.transcript.sessionId.toLowerCase())) throw new Error('El archivo de dictados no es válido; se conserva para revisión.');
          const value = cursor.value;
          const owner = store.get(ownerKey(value.input.ownerId.toLowerCase()));
          owner.onsuccess = () => safely(fail, () => {
            if (owner.result !== value.input.transcript.sessionId.toLowerCase()) throw new Error('La identidad de un dictado no coincide; se conserva para revisión.');
            found.push(value); cursor.continue();
          });
        });
      });
      // WKWebView may hash through a limited native bridge; do not exhaust its
      // slots by verifying every stored receipt simultaneously.
      const verified: VoiceChatCommit[] = [];
      for (const value of values) verified.push(await verifyReceipt(value, value.input.transcript.sessionId));
      verified.sort((a, b) => a.appliedRevision - b.appliedRevision);
      if (verified.some((item, index) => index > 0 && item.appliedRevision === verified[index - 1]!.appliedRevision)) throw new Error('Dos dictados comparten revisión; se conservan para revisión.');
      return verified;
    },
  };
}
