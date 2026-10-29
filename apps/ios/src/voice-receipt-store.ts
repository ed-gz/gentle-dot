import { hashSourceBytes, parseVoiceTranscript, type VoiceTranscript } from './perception.ts';

/** Isolated prototype. This is not the current chat or Herdr draft store and
 * never acknowledges or deletes native audio. Applying a receipt updates its
 * own destination draft and the receipt together in one IndexedDB transaction.
 * It does not authenticate native audio or prove the current app draft was
 * saved. The fixed 100-record limit needs a retention policy before use.
 * Discard removes text logically; IndexedDB may retain old physical pages. */
export type VoiceReceiptInput = {
  ownerId: string;
  destination: string;
  audioSHA256: string;
  audioBytes: number;
  transcript: VoiceTranscript;
};
export type VoiceReceipt = VoiceReceiptInput & { sessionId: string; inputSHA256: string; state: 'pending' | 'applied'; version: number; createdAt: number; appliedRevision?: number };
/** Discard removes all recognized words/timestamps, while the digest fences a
 * lost callback from recreating the same discarded receipt. */
export type VoiceReceiptTombstone = { sessionId: string; ownerId: string; destination: string; audioSHA256: string; audioBytes: number; inputSHA256: string; state: 'discarded'; version: number; createdAt: number };
export type StoredVoiceReceipt = VoiceReceipt | VoiceReceiptTombstone;
export type VoiceReceiptDraft = { destination: string; text: string; revision: number };
const LIMIT = 100;
const MAX_AUDIO_BYTES = 128 * 1024 * 1024;
const id = (value: unknown): value is string => typeof value === 'string' && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value);
const destinationOK = (value: unknown): value is string => typeof value === 'string' && (value === 'chat' || /^session:[a-f0-9]{64}$/.test(value));
const natural = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));

function canonicalInput(value: unknown): VoiceReceiptInput {
  // Snapshot caller-owned objects before validation so getters or later
  // mutation cannot change a destination or transcript after it is checked.
  value = structuredClone(value);
  if (!object(value) || !exactKeys(value, ['ownerId', 'destination', 'audioSHA256', 'audioBytes', 'transcript'])
    || !id(value.ownerId) || !destinationOK(value.destination) || typeof value.audioSHA256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.audioSHA256) || !natural(value.audioBytes) || value.audioBytes < 1 || value.audioBytes > MAX_AUDIO_BYTES
    || !object(value.transcript) || !id(value.transcript.sessionId)
    || value.ownerId.toLowerCase() === value.transcript.sessionId.toLowerCase()) throw new Error('La transcripción o su destino no son válidos.');
  const t = value.transcript;
  if (!exactKeys(t, ['sessionId', 'text', 'segments', 'durationSeconds', 'locale', 'source'])
    || !Array.isArray(t.segments) || t.segments.some(part => !object(part) || !exactKeys(part, ['text', 'startSeconds', 'endSeconds']))) throw new Error('La transcripción contiene campos no válidos.');
  // Validate the original evidence before it can become a durable receipt.
  const parsed = parseVoiceTranscript({ ...t, ok: true }, String(t.sessionId));
  return { ownerId: value.ownerId.toLowerCase(), destination: value.destination, audioSHA256: value.audioSHA256,
    audioBytes: value.audioBytes, transcript: { ...parsed, sessionId: parsed.sessionId.toLowerCase() } };
}
function stored(value: unknown): StoredVoiceReceipt {
  if (!object(value) || !id(value.sessionId) || value.sessionId !== value.sessionId.toLowerCase() || !id(value.ownerId) || value.ownerId !== value.ownerId.toLowerCase()
    || value.sessionId === value.ownerId || !destinationOK(value.destination) || typeof value.audioSHA256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.audioSHA256)
    || !natural(value.audioBytes) || value.audioBytes < 1 || value.audioBytes > MAX_AUDIO_BYTES
    || typeof value.inputSHA256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.inputSHA256)
    || !['pending', 'applied', 'discarded'].includes(String(value.state)) || !natural(value.version) || value.version < 1
    || !natural(value.createdAt) || value.createdAt < 1
    || (value.state === 'applied' ? !natural(value.appliedRevision) || value.appliedRevision < 1 : value.appliedRevision !== undefined)) throw new Error('El recibo guardado no es válido; se conserva para revisión.');
  if (value.state === 'discarded') {
    if (!exactKeys(value, ['sessionId', 'ownerId', 'destination', 'audioSHA256', 'audioBytes', 'inputSHA256', 'state', 'version', 'createdAt'])) throw new Error('El recibo descartado no es válido.');
    return { sessionId: value.sessionId, ownerId: value.ownerId, destination: value.destination, audioSHA256: value.audioSHA256, audioBytes: value.audioBytes,
      inputSHA256: value.inputSHA256, state: 'discarded', version: value.version, createdAt: value.createdAt };
  }
  if (!exactKeys(value, ['sessionId', 'ownerId', 'destination', 'audioSHA256', 'audioBytes', 'transcript', 'inputSHA256', 'state', 'version', 'createdAt', 'appliedRevision'])) throw new Error('El recibo guardado contiene campos no válidos.');
  const input = canonicalInput({ ownerId: value.ownerId, destination: value.destination, audioSHA256: value.audioSHA256,
    audioBytes: value.audioBytes, transcript: value.transcript });
  if (input.transcript.sessionId !== value.sessionId) throw new Error('El recibo no corresponde al dictado original.');
  return { ...input, sessionId: value.sessionId, inputSHA256: value.inputSHA256, state: value.state as VoiceReceipt['state'], version: value.version, createdAt: value.createdAt,
    ...(value.state === 'applied' ? { appliedRevision: value.appliedRevision as number } : {}) };
}
function draft(value: unknown, destination: string): VoiceReceiptDraft {
  if (value === undefined) return { destination, text: '', revision: 0 };
  if (!object(value) || !exactKeys(value, ['destination', 'text', 'revision']) || value.destination !== destination
    || typeof value.text !== 'string' || value.text.length > 8000 || !natural(value.revision)) throw new Error('El borrador guardado no es válido; se conserva para revisión.');
  return { destination, text: value.text, revision: value.revision };
}
function inputOf(record: VoiceReceipt): VoiceReceiptInput {
  return { ownerId: record.ownerId, destination: record.destination, audioSHA256: record.audioSHA256,
    audioBytes: record.audioBytes, transcript: record.transcript };
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const inputHash = (input: VoiceReceiptInput) => hashSourceBytes(new TextEncoder().encode(JSON.stringify(input)));
/** Canonicalize before crossing an asynchronous boundary; callers still must
 * independently verify the matching native recording and reader lease. */
export async function prepareVoiceReceiptInput(value: VoiceReceiptInput): Promise<{ input: VoiceReceiptInput; inputSHA256: string }> {
  const input = canonicalInput(value);
  return { input, inputSHA256: await inputHash(input) };
}
async function verify(record: StoredVoiceReceipt): Promise<StoredVoiceReceipt> {
  if (record.state !== 'discarded' && await inputHash(inputOf(record)) !== record.inputSHA256) throw new Error('La huella del recibo no coincide; se conserva para revisión.');
  return record;
}

export function createVoiceReceiptStore(options: { databaseName?: string } = {}) {
  const name = options.databaseName ?? 'capri-ios-voice-receipts-v1';
  if (!name || name.length > 256) throw new Error('El almacén de recibos no es válido.');
  function transaction<T>(mode: IDBTransactionMode, work: (tx: IDBTransaction, done: (value: T) => void, fail: (error: Error) => void) => void): Promise<T> {
    return new Promise((resolve, reject) => {
      let db: IDBDatabase | undefined, tx: IDBTransaction | undefined, result: T, produced = false, settled = false, problem: Error | undefined;
      const finish = (error?: Error) => {
        if (settled) return; settled = true; clearTimeout(timer); db?.close();
        if (error) reject(error); else if (produced) resolve(result); else reject(new Error('No se confirmó el recibo de voz.'));
      };
      const fail = (error: Error) => {
        problem = error;
        if (!tx) { finish(error); return; }
        try { tx.abort(); } catch { finish(error); }
      };
      const timer = setTimeout(() => { try { tx?.abort(); } catch { /* Already settled. */ } finish(new Error('El almacenamiento de voz no respondió.')); }, 8000);
      try {
        const opening = indexedDB.open(name, 1);
        opening.onupgradeneeded = () => {
          if (settled) { opening.transaction?.abort(); return; }
          const receipts = opening.result.createObjectStore('receipts', { keyPath: 'sessionId' });
          // A single native owner identifies one voice command. Different
          // session IDs must not duplicate the same command or destination.
          receipts.createIndex('owner', 'ownerId', { unique: true });
          opening.result.createObjectStore('drafts', { keyPath: 'destination' });
        };
        opening.onerror = () => finish(new Error('No pude abrir el almacenamiento de voz.'));
        opening.onblocked = () => finish(new Error('Otra versión mantiene abierto el almacenamiento de voz.'));
        opening.onsuccess = () => {
          db = opening.result; if (settled) { db.close(); return; }
          db.onversionchange = () => db?.close();
          try {
            tx = db.transaction(['receipts', 'drafts'], mode);
            tx.oncomplete = () => finish();
            tx.onabort = () => finish(problem ?? new Error('No se confirmó el almacenamiento de voz.'));
            tx.onerror = () => { problem ??= new Error('No se confirmó el almacenamiento de voz.'); };
            const receipts = tx.objectStore('receipts'), drafts = tx.objectStore('drafts');
            if (receipts.keyPath !== 'sessionId' || !receipts.indexNames.contains('owner') || receipts.index('owner').keyPath !== 'ownerId'
              || !receipts.index('owner').unique || drafts.keyPath !== 'destination') throw new Error('El esquema del archivo de voz cambió. Se conservan los datos anteriores.');
            work(tx, value => { result = value; produced = true; }, fail);
          } catch (error) { fail(error instanceof Error ? error : new Error('No pude abrir la transacción de voz.')); }
        };
      } catch (error) { finish(error instanceof Error ? error : new Error('No pude abrir el almacenamiento de voz.')); }
    });
  }
  function guardCallback<T>(fail: (error: Error) => void, work: () => T): T | undefined {
    try { return work(); } catch (error) { fail(error instanceof Error ? error : new Error('No se guardó la voz.')); }
  }
  return {
    /** Idempotent only for the exact same native session, owner, destination,
     * source audio identity and full timed transcript. */
    async put(value: VoiceReceiptInput): Promise<StoredVoiceReceipt> {
      const { input, inputSHA256: digest } = await prepareVoiceReceiptInput(value);
      return transaction('readwrite', (tx, done, fail) => {
        const store = tx.objectStore('receipts'), get = store.get(input.transcript.sessionId);
        get.onsuccess = () => guardCallback(fail, () => {
          if (get.result !== undefined) {
            const existing = stored(get.result);
            if (existing.inputSHA256 !== digest || existing.ownerId !== input.ownerId || existing.destination !== input.destination
              || existing.audioSHA256 !== input.audioSHA256 || existing.audioBytes !== input.audioBytes
              || (existing.state !== 'discarded' && !same(inputOf(existing), input))) throw new Error('Ese dictado ya está vinculado a otro contenido. No se reemplazó.');
            done(existing); return;
          }
          const count = store.count();
          count.onsuccess = () => guardCallback(fail, () => {
            if (count.result >= LIMIT) throw new Error('Hay demasiados recibos de voz sin archivar.');
            const next: VoiceReceipt = { ...input, sessionId: input.transcript.sessionId, inputSHA256: digest, state: 'pending', version: 1, createdAt: Date.now() };
            const add = store.add(next); add.onsuccess = () => done(next);
          });
        });
      });
    },
    async get(sessionId: string): Promise<StoredVoiceReceipt | undefined> {
      if (!id(sessionId)) return Promise.reject(new Error('El dictado no es válido.'));
      const value = await transaction<StoredVoiceReceipt | undefined>('readonly', (tx, done, fail) => {
        const get = tx.objectStore('receipts').get(sessionId.toLowerCase());
        get.onsuccess = () => guardCallback(fail, () => done(get.result === undefined ? undefined : stored(get.result)));
      });
      return value ? verify(value) : undefined;
    },
    async list(destination: string): Promise<StoredVoiceReceipt[]> {
      if (!destinationOK(destination)) return Promise.reject(new Error('El destino no es válido.'));
      const items = await transaction<StoredVoiceReceipt[]>('readonly', (tx, done, fail) => {
        const all = tx.objectStore('receipts').getAll();
        all.onsuccess = () => guardCallback(fail, () => {
          if (!Array.isArray(all.result) || all.result.length > LIMIT) throw new Error('El archivo de voz no es válido; se conserva para revisión.');
          done(all.result.map(stored).filter(item => item.destination === destination).sort((a, b) => a.createdAt - b.createdAt));
        });
      });
      // Native SHA fallback has a bounded number of concurrent slots.
      const verified: StoredVoiceReceipt[] = [];
      for (const item of items) verified.push(await verify(item));
      return verified;
    },
    readDraft(destination: string): Promise<VoiceReceiptDraft> {
      if (!destinationOK(destination)) return Promise.reject(new Error('El destino no es válido.'));
      return transaction('readonly', (tx, done, fail) => {
        const get = tx.objectStore('drafts').get(destination);
        get.onsuccess = () => guardCallback(fail, () => done(draft(get.result, destination)));
      });
    },
    /** Explicit draft changes use revision CAS; they cannot replace a newer
     * insertion or a concurrently edited draft. */
    saveDraft(expected: VoiceReceiptDraft, text: string): Promise<VoiceReceiptDraft> {
      let snapshot: VoiceReceiptDraft;
      try { snapshot = structuredClone(expected); } catch (error) { return Promise.reject(error); }
      if (!snapshot || !destinationOK(snapshot.destination) || typeof snapshot.text !== 'string' || snapshot.text.length > 8000 || !natural(snapshot.revision)
        || typeof text !== 'string' || text.length > 8000) return Promise.reject(new Error('El borrador no es válido.'));
      const wanted: VoiceReceiptDraft = { destination: snapshot.destination, text: snapshot.text, revision: snapshot.revision };
      return transaction('readwrite', (tx, done, fail) => {
        const store = tx.objectStore('drafts'), get = store.get(wanted.destination);
        get.onsuccess = () => guardCallback(fail, () => {
          const current = draft(get.result, wanted.destination);
          if (!same(current, wanted)) throw new Error('El borrador cambió; conserva ambos contenidos y vuelve a leer.');
          if (current.revision >= Number.MAX_SAFE_INTEGER) throw new Error('La revisión alcanzó su límite.');
          const next = { destination: current.destination, text, revision: current.revision + 1 };
          const put = store.put(next); put.onsuccess = () => done(next);
        });
      });
    },
    /** Explicit gesture, one transaction. Retrying an already applied receipt
     * returns its state without inserting the transcript again. */
    async apply(expected: VoiceReceipt, expectedDraft: VoiceReceiptDraft): Promise<{ receipt: VoiceReceipt; draft: VoiceReceiptDraft; alreadyApplied: boolean }> {
      const wanted = stored(structuredClone(expected));
      if (wanted.state === 'discarded') throw new Error('El recibo fue descartado.');
      const snapshot = structuredClone(expectedDraft);
      if (!snapshot || !destinationOK(snapshot.destination) || snapshot.destination !== wanted.destination
        || typeof snapshot.text !== 'string' || snapshot.text.length > 8000 || !natural(snapshot.revision)) return Promise.reject(new Error('El destino del borrador no coincide.'));
      const wantedDraft: VoiceReceiptDraft = { destination: snapshot.destination, text: snapshot.text, revision: snapshot.revision };
      await verify(wanted);
      return transaction('readwrite', (tx, done, fail) => {
        const receipts = tx.objectStore('receipts'), drafts = tx.objectStore('drafts');
        const get = receipts.get(wanted.sessionId);
        get.onsuccess = () => guardCallback(fail, () => {
          const current = stored(get.result);
          if (current.state === 'discarded' || current.inputSHA256 !== wanted.inputSHA256 || !same(inputOf(current), inputOf(wanted)) || current.createdAt !== wanted.createdAt) throw new Error('El recibo cambió; no se aplicó la transcripción.');
          const getDraft = drafts.get(current.destination);
          getDraft.onsuccess = () => guardCallback(fail, () => {
            const currentDraft = draft(getDraft.result, current.destination);
            if (current.state === 'applied') {
              if (!(same(current, wanted) || (wanted.state === 'pending' && current.version === wanted.version + 1))) throw new Error('La revisión del recibo no coincide.');
              done({ receipt: current, draft: currentDraft, alreadyApplied: true }); return;
            }
            if (current.state !== 'pending' || !same(current, wanted)) throw new Error('El recibo cambió; no se aplicó la transcripción.');
            if (!same(currentDraft, wantedDraft)) throw new Error('El borrador cambió; no se aplicó la transcripción.');
            const text = `${currentDraft.text}${currentDraft.text.trim() ? '\n' : ''}${current.transcript.text}`;
            if (text.length > 8000) throw new Error('La transcripción no cabe en el borrador. El recibo se conserva.');
            if (currentDraft.revision >= Number.MAX_SAFE_INTEGER || current.version >= Number.MAX_SAFE_INTEGER) throw new Error('La revisión alcanzó su límite.');
            const nextDraft = { destination: current.destination, text, revision: currentDraft.revision + 1 };
            const nextReceipt: VoiceReceipt = { ...current, state: 'applied', version: current.version + 1, appliedRevision: nextDraft.revision };
            drafts.put(nextDraft); const put = receipts.put(nextReceipt); put.onsuccess = () => done({ receipt: nextReceipt, draft: nextDraft, alreadyApplied: false });
          });
        });
      });
    },
    async discard(expected: StoredVoiceReceipt): Promise<VoiceReceiptTombstone> {
      const wanted = stored(structuredClone(expected));
      await verify(wanted);
      return transaction('readwrite', (tx, done, fail) => {
        const store = tx.objectStore('receipts'), get = store.get(wanted.sessionId);
        get.onsuccess = () => guardCallback(fail, () => {
          const current = stored(get.result);
          if (current.state === 'discarded') {
            if (same(current, wanted) || (wanted.state === 'pending' && current.ownerId === wanted.ownerId && current.destination === wanted.destination
              && current.audioSHA256 === wanted.audioSHA256 && current.audioBytes === wanted.audioBytes && current.inputSHA256 === wanted.inputSHA256
              && current.createdAt === wanted.createdAt && current.version === wanted.version + 1)) { done(current); return; }
            throw new Error('La revisión del recibo descartado no coincide.');
          }
          if (current.state !== 'pending' || !same(current, wanted) || current.version >= Number.MAX_SAFE_INTEGER) throw new Error('El recibo cambió; no se descartó.');
          const next: VoiceReceiptTombstone = { sessionId: current.sessionId, ownerId: current.ownerId, destination: current.destination,
            audioSHA256: current.audioSHA256, audioBytes: current.audioBytes, inputSHA256: current.inputSHA256,
            state: 'discarded', version: current.version + 1, createdAt: current.createdAt };
          const put = store.put(next); put.onsuccess = () => done(next);
        });
      });
    },
  };
}
