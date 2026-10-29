import { archiveEntry, conversationArchive, type ArchiveWrite } from './conversation-archive.ts';
import { CONVERSATION_JOURNAL_KEY, canonicalConversationSnapshot, type ChatEntry, type Conversation } from './conversation.ts';
import { NATIVE_VOICE_DELIVERY_PREFIX, nativeVoiceMarker, nativeVoiceSnapshotSHA256, validateNativeVoiceDelivery, verifyNativeVoiceDelivery, type NativeVoiceDeliveryIntent } from './native-voice-delivery.ts';

/** Coordinator for the existing conversation and archive schemas.
 * The caller must bind each in-memory snapshot to the exact base
 * from which it was captured; reading a new base just before saving does not
 * prove that an older snapshot includes its changes. Concurrent writers which
 * bypass this journal can still alter the archive between verification and
 * window commit. It never executes tools or acknowledges native work. */
type Archive = { upsert(entries: readonly ChatEntry[], scope?: string, visible?: readonly ChatEntry[], revision?: number): Promise<ArchiveWrite>; verifyExactBatch(entries: readonly ChatEntry[], revision: number): Promise<boolean> };
export type ConversationJournal = { schema: 'capri-conversation-journal/v1'; id: string; baseRevision: number; base?: Conversation; revision: number; snapshot: Conversation; pending: ChatEntry[]; voiceDelivery?: NativeVoiceDeliveryIntent; voiceSnapshotSHA256?: string };
/** A receipt is evidence of a past commit, not proof that its contents are
 * still current. Only the most recent receipt is retained. It must not be used
 * to acknowledge native results or delete audio. */
export type JournalCommit = { id: string; revision: number; alreadyCommitted: boolean };
/** A deterministic rejection before this begin request can write a new
 * reservation. Other errors may be uncertain and must retain their ID. */
export class JournalReservationRejected extends Error {
  constructor(message: string) { super(message); this.name = 'JournalReservationRejected'; }
}
export class JournalReservationConflict extends JournalReservationRejected {
  constructor(message: string) { super(message); this.name = 'JournalReservationConflict'; }
}
const JOURNAL = CONVERSATION_JOURNAL_KEY, COMMITTED = 'conversation-journal:last-committed:v1';
const LIMIT = 10_000, MAX_BYTES = 64 * 1024 * 1024;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const natural = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => same(item, b[index]));
  if (!object(a) || !object(b)) return false;
  const left = Object.keys(a).sort(), right = Object.keys(b).sort();
  return left.length === right.length && left.every((key, index) => key === right[index] && same(a[key], b[key]));
}
function cleanConversation(value: unknown): Conversation {
  if (!object(value) || Object.keys(value).some(key => !['entries', 'draft', 'attachedWork', 'revision'].includes(key)) || !Array.isArray(value.entries)
    || value.entries.length > 120 || typeof value.draft !== 'string' || value.draft.length > 8000 || (value.revision !== undefined && !natural(value.revision))) throw new Error('La conversación requiere revisión; no se modificó.');
  const normalized = canonicalConversationSnapshot(value as Conversation);
  if (!same(value, normalized)) throw new Error('La conversación contiene datos que no se pueden conservar; no se modificó.');
  return normalized;
}
function cleanPending(value: unknown): ChatEntry[] {
  if (!Array.isArray(value) || value.length > LIMIT) throw new Error('Hay demasiados mensajes pendientes; conserva la fuente y exporta antes de continuar.');
  const keys = new Set<string>();
  return value.map(item => {
    if (!object(item) || Object.keys(item).some(key => !['id', 'engine', 'role', 'state', 'text', 'at', 'localCancelled', 'replyTo', 'activities', 'transportText', 'branchUnverified'].includes(key))) throw new Error('Un mensaje pendiente requiere revisión; no se modificó.');
    const archived = archiveEntry(item); const { scope, ...entry } = archived;
    if (item.transportText !== undefined && (typeof item.transportText !== 'string' || item.transportText.length > 32000)) throw new Error('El transporte de un mensaje no es válido.');
    const normalized: ChatEntry = { ...entry, ...(typeof item.transportText === 'string' ? { transportText: item.transportText } : {}) };
    if (!same(item, normalized)) throw new Error('Un mensaje pendiente contiene campos que no se pueden conservar.');
    const key = JSON.stringify([entry.engine, scope, entry.id]);
    if (keys.has(key)) throw new Error('La reserva contiene un mensaje duplicado.');
    keys.add(key); return normalized;
  });
}
/** Preserve the exact allowlisted entries for a losing writer's rescue copy. */
export function canonicalPendingConversationEntries(value: unknown): ChatEntry[] { return cleanPending(value); }
function entryKey(value: ChatEntry): string { const entry = archiveEntry(value); return JSON.stringify([entry.engine, entry.scope, entry.id]); }
function includeVisible(pending: ChatEntry[], visible: ChatEntry[]): ChatEntry[] {
  const result = [...pending], byKey = new Map(result.map(entry => [entryKey(entry), entry])), seen = new Set<string>();
  for (const entry of visible) {
    const key = entryKey(entry), existing = byKey.get(key);
    if (seen.has(key)) throw new Error('La ventana contiene mensajes duplicados; se conserva la fuente.');
    seen.add(key);
    if (existing && !same(existing, entry)) throw new Error('La ventana y el archivo pendiente difieren; se conservan ambas copias.');
    if (!existing) { result.push(entry); byKey.set(key, entry); }
  }
  return cleanPending(result);
}
function includeBase(pending: ChatEntry[], base: Conversation | undefined, visible: ChatEntry[]): ChatEntry[] {
  const result = [...pending], byKey = new Map(result.map(entry => [entryKey(entry), entry])), visibleKeys = new Set(visible.map(entryKey));
  for (const entry of base?.entries ?? []) {
    const key = entryKey(entry), existing = byKey.get(key);
    if (!existing) { result.push(entry); byKey.set(key, entry); continue; }
    if (!visibleKeys.has(key) && !same(entry, existing)) throw new Error('Un mensaje podado difiere de su base; se conservan ambas copias.');
    if ((entry.replyTo && entry.replyTo !== existing.replyTo) || (entry.localCancelled && !existing.localCancelled)
      || (entry.transportText !== undefined && entry.transportText !== existing.transportText)) throw new Error('El mensaje anterior contiene datos que no coinciden; se conservan ambas copias.');
  }
  return cleanPending(result);
}
function validate(value: unknown): ConversationJournal {
  if (!object(value) || Object.keys(value).some(key => !['schema', 'id', 'baseRevision', 'base', 'revision', 'snapshot', 'pending', 'voiceDelivery', 'voiceSnapshotSHA256'].includes(key))
    || value.schema !== 'capri-conversation-journal/v1' || !uuid(value.id) || !natural(value.baseRevision) || value.baseRevision >= Number.MAX_SAFE_INTEGER
    || !natural(value.revision) || value.revision <= value.baseRevision) throw new Error('La reserva de conversación es inválida; no se eliminó.');
  const base = value.base === undefined ? undefined : cleanConversation(value.base);
  const snapshot = cleanConversation(value.snapshot), pending = cleanPending(value.pending);
  if ((base?.revision ?? 0) !== value.baseRevision) throw new Error('La base reservada no coincide; no se eliminó.');
  if (snapshot.revision !== value.revision) throw new Error('La revisión reservada no coincide; no se eliminó.');
  if (includeVisible(pending, snapshot.entries).length !== pending.length) throw new Error('La reserva perdió mensajes visibles; no se eliminó.');
  if (includeBase(pending, base, snapshot.entries).length !== pending.length) throw new Error('La reserva perdió mensajes anteriores; no se eliminó.');
  const voiceDelivery = value.voiceDelivery === undefined ? undefined : validateNativeVoiceDelivery(value.voiceDelivery, snapshot.draft);
  if (voiceDelivery ? typeof value.voiceSnapshotSHA256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.voiceSnapshotSHA256) : value.voiceSnapshotSHA256 !== undefined) throw new Error('La huella del borrador no es válida.');
  const result: ConversationJournal = { schema: value.schema, id: value.id, baseRevision: value.baseRevision, ...(base ? { base } : {}), revision: value.revision, snapshot, pending, ...(voiceDelivery ? { voiceDelivery, voiceSnapshotSHA256: value.voiceSnapshotSHA256 as string } : {}) };
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > MAX_BYTES) throw new Error('La reserva supera el límite; conserva y exporta la conversación.');
  return result;
}
function transaction<T>(name: string, mode: IDBTransactionMode, work: (store: IDBObjectStore, done: (value: T) => void, fail: (error: Error) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let db: IDBDatabase | undefined, tx: IDBTransaction | undefined, result: T, produced = false, settled = false, issue: Error | undefined;
    const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); db?.close(); if (error) reject(error); else if (produced) resolve(result); else reject(new Error('No se confirmó la reserva.')); };
    const fail = (error: Error) => { issue = error; if (!tx) { finish(error); return; } try { tx.abort(); } catch { finish(error); } };
    const timer = setTimeout(() => { try { tx?.abort(); } catch { /* Already closed. */ } finish(new Error('La reserva no respondió. Las fuentes se conservan.')); }, 12000);
    try {
      const opening = indexedDB.open(name, 1);
      opening.onupgradeneeded = () => { if (settled) { opening.transaction?.abort(); return; } opening.result.createObjectStore('conversation'); };
      opening.onerror = () => finish(new Error('No se pudo abrir la conversación.'));
      opening.onblocked = () => finish(new Error('Otra versión mantiene abierta la conversación.'));
      opening.onsuccess = () => {
        db = opening.result; if (settled) { db.close(); return; } db.onversionchange = () => db?.close();
        try {
          tx = db.transaction('conversation', mode); tx.oncomplete = () => finish();
          tx.onabort = () => finish(issue ?? new Error('La reserva no se confirmó.'));
          tx.onerror = () => { issue ??= new Error('La reserva no se confirmó.'); };
          const store = tx.objectStore('conversation');
          if (store.keyPath !== null || store.autoIncrement) throw new Error('El esquema cambió; los datos se conservan.');
          work(store, value => { result = value; produced = true; }, fail);
        } catch (error) { fail(error instanceof Error ? error : new Error('No se pudo iniciar la reserva.')); }
      };
    } catch (error) { finish(error instanceof Error ? error : new Error('No se pudo abrir la conversación.')); }
  });
}
function safely(fail: (error: Error) => void, action: () => void) { try { action(); } catch (error) { fail(error instanceof Error ? error : new Error('No se confirmó la operación.')); } }
function matchesBase(value: unknown, base: Conversation | undefined): boolean {
  if (value === undefined || base === undefined) return value === undefined && base === undefined;
  return same(cleanConversation(value), base);
}

export function createConversationJournal(options: { databaseName?: string; archive?: Archive } = {}) {
  const name = options.databaseName ?? 'capri-ios-conversation', archive = options.archive ?? conversationArchive;
  if (!name || name.length > 256) throw new Error('El almacén de conversación no es válido.');
  async function pending(): Promise<ConversationJournal | undefined> {
    return transaction(name, 'readonly', (store, done, fail) => {
      const request = store.get(JOURNAL);
      request.onsuccess = () => safely(fail, () => done(request.result === undefined ? undefined : validate(request.result)));
    });
  }
  async function pendingForResume(): Promise<ConversationJournal | undefined> {
    return transaction(name, 'readonly', (store, done, fail) => {
      const request = store.get(JOURNAL);
      request.onsuccess = () => safely(fail, () => {
        if (request.result === undefined) { done(undefined); return; }
        const journal = validate(request.result), current = store.get('current');
        current.onsuccess = () => safely(fail, () => {
          if (!matchesBase(current.result, journal.base)) throw new Error('La conversación cambió antes del archivo; la reserva se conserva.');
          done(journal);
        });
      });
    });
  }
  return {
    /** Reserve the exact base and persist the entire snapshot plus every
     * pending message before performing any archive write. */
    async begin(input: { id: string; baseRevision: number; base?: Conversation; snapshot: Conversation; pending: ChatEntry[]; nextRevision?: number; voiceDelivery?: NativeVoiceDeliveryIntent }): Promise<ConversationJournal> {
      let safe: ConversationJournal;
      try {
        const original = structuredClone(input), snapshot = cleanConversation(original.snapshot);
        const base = original.base === undefined ? undefined : cleanConversation(original.base);
        const pending = includeBase(includeVisible(cleanPending(original.pending), snapshot.entries), base, snapshot.entries);
        // A prior archive commit may have survived a crash while the visible
        // window remained older. The caller may advance past that recovered
        // revision, but only while binding the complete, unchanged window base.
        const revision = original.nextRevision ?? original.baseRevision + 1;
        const voiceSnapshotSHA256 = original.voiceDelivery ? await nativeVoiceSnapshotSHA256(snapshot) : undefined;
        safe = validate({ schema: 'capri-conversation-journal/v1', id: original.id, baseRevision: original.baseRevision,
          ...(base ? { base } : {}), snapshot, pending, revision, ...(original.voiceDelivery ? { voiceDelivery: original.voiceDelivery, voiceSnapshotSHA256 } : {}) });
        if (safe.voiceDelivery) await verifyNativeVoiceDelivery(safe.voiceDelivery);
      } catch (error) {
        throw new JournalReservationRejected(error instanceof Error ? error.message : 'La reserva no es válida; se conservan las copias.');
      }
      return transaction(name, 'readwrite', (store, done, fail) => {
        const previous = store.get(JOURNAL);
        previous.onsuccess = () => safely(fail, () => {
          if (previous.result !== undefined) {
            const existing = validate(previous.result);
            if (same(existing, safe)) {
              const current = store.get('current');
              current.onsuccess = () => safely(fail, () => {
                if (!matchesBase(current.result, safe.base)) throw new Error('La conversación cambió; la reserva se conserva para revisión.');
                done(existing);
              }); return;
            }
            throw new JournalReservationConflict('Hay una reserva pendiente; recupérala antes de guardar otra.');
          }
          const current = store.get('current');
          current.onsuccess = () => safely(fail, () => {
            if (!matchesBase(current.result, safe.base)) throw new JournalReservationConflict('La conversación cambió; conserva el borrador y vuelve a cargarla.');
            const marker = store.get(COMMITTED);
            marker.onsuccess = () => safely(fail, () => {
              if (marker.result !== undefined && (!object(marker.result) || Object.keys(marker.result).some(key => !['id', 'revision'].includes(key)) || !uuid(marker.result.id) || !natural(marker.result.revision))) throw new Error('La confirmación anterior no es válida; se conserva para revisión.');
              if (object(marker.result) && marker.result.id === safe.id) throw new Error('Esta identidad ya se confirmó; no se reutilizó.');
              if (safe.voiceDelivery) {
                const delivered = store.get(NATIVE_VOICE_DELIVERY_PREFIX + safe.voiceDelivery.sessionId);
                delivered.onsuccess = () => safely(fail, () => {
                  if (delivered.result !== undefined) throw new JournalReservationConflict('Este dictado ya tiene una entrega registrada.');
                  store.put(safe, JOURNAL); done(safe);
                }); return;
              }
              store.put(safe, JOURNAL); done(safe);
            });
          });
        });
      });
    },
    pending,
    /** Every batch is replayable. On quota, failure or termination the full
     * journal remains durable; no second revision can be reserved. */
    async resume(id: string): Promise<JournalCommit> {
      if (!uuid(id)) throw new Error('La identidad de reserva no es válida.');
      const journal = await pendingForResume();
      if (!journal) {
        return transaction(name, 'readonly', (store, done, fail) => {
          const marker = store.get(COMMITTED);
          marker.onsuccess = () => safely(fail, () => {
            if (!object(marker.result) || marker.result.id !== id || !natural(marker.result.revision)) throw new Error('No encontré la reserva. No se asumió una confirmación.');
            done({ id, revision: marker.result.revision, alreadyCommitted: true });
          });
        });
      }
      if (journal.id !== id) throw new Error('La reserva pertenece a otra operación.');
      if (journal.voiceDelivery) {
        await verifyNativeVoiceDelivery(journal.voiceDelivery);
        if (await nativeVoiceSnapshotSHA256(journal.snapshot) !== journal.voiceSnapshotSHA256) throw new Error('La huella del borrador reservado no coincide.');
      }
      for (let offset = 0; offset < Math.max(1, journal.pending.length); offset += 500) {
        await archive.upsert(journal.pending.slice(offset, offset + 500), undefined, offset + 500 >= journal.pending.length ? journal.snapshot.entries : undefined, journal.revision);
      }
      // The archive preserves the original timestamp on update and excludes
      // transport aliases. Compare its actual durable projection before the
      // journal can be released; a disagreement leaves both copies available.
      for (let offset = 0; offset < journal.pending.length; offset += 500) {
        if (!await archive.verifyExactBatch(journal.pending.slice(offset, offset + 500), journal.revision)) throw new Error('El archivo no conservó exactamente un mensaje; la reserva permanece para revisión.');
      }
      return transaction(name, 'readwrite', (store, done, fail) => {
        const request = store.get(JOURNAL);
        request.onsuccess = () => safely(fail, () => {
          if (request.result === undefined) {
            const marker = store.get(COMMITTED);
            marker.onsuccess = () => safely(fail, () => {
              if (!object(marker.result) || marker.result.id !== id || marker.result.revision !== journal.revision) throw new Error('La reserva ya no coincide; conserva las copias.');
              done({ id, revision: journal.revision, alreadyCommitted: true });
            }); return;
          }
          if (!same(validate(request.result), journal)) throw new Error('La reserva cambió; conserva las copias.');
          const current = store.get('current');
          current.onsuccess = () => safely(fail, () => {
            if (!matchesBase(current.result, journal.base)) throw new Error('La conversación cambió durante el archivo; la reserva se conserva.');
            const commit = () => {
              store.put(journal.snapshot, 'current');
              if (journal.voiceDelivery && journal.voiceSnapshotSHA256) store.put(nativeVoiceMarker(journal.voiceDelivery, journal.revision, journal.voiceSnapshotSHA256), NATIVE_VOICE_DELIVERY_PREFIX + journal.voiceDelivery.sessionId);
              store.put({ id, revision: journal.revision }, COMMITTED); store.delete(JOURNAL);
              done({ id, revision: journal.revision, alreadyCommitted: false });
            };
            if (journal.voiceDelivery) {
              const previous = store.get(NATIVE_VOICE_DELIVERY_PREFIX + journal.voiceDelivery.sessionId);
              previous.onsuccess = () => safely(fail, () => { if (previous.result !== undefined) throw new Error('La entrega del dictado ya existe; la reserva se conserva.'); commit(); });
            } else commit();
          });
        });
      });
    },
  };
}
