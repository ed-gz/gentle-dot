import { ATTACHMENT_LIMITS } from '@gentle-dot/protocol';
import { validDaemonUrl } from './local-state.ts';

type SavedFile = { name: string; type: string; lastModified: number; blob: Blob };
type Draft = { revision: number; files: SavedFile[]; bytes: number };
const DATABASE = 'capri-ios-session-files';
const MAX_DRAFTS = 100;
const MAX_BYTES = 250 * 1024 * 1024;
const queues = new Map<string, Promise<void>>();

function ordered<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const next = (queues.get(key) ?? Promise.resolve()).then(operation);
  const tail = next.then(() => {}, () => {});
  queues.set(key, tail);
  void tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
  return next;
}

function validateFiles(files: readonly SavedFile[]): number {
  if (!Array.isArray(files) || files.length > ATTACHMENT_LIMITS.files) throw new Error('Máximo 10 archivos por borrador.');
  let bytes = 0;
  for (const file of files) {
    if (!file || !(file.blob instanceof Blob) || typeof file.name !== 'string' || !file.name.trim()
      || file.name.length > 1024 || /[\u0000-\u001f\u007f]/.test(file.name)
      || typeof file.type !== 'string' || file.type.length > 255 || !Number.isSafeInteger(file.lastModified)
      || file.blob.size > ATTACHMENT_LIMITS.fileBytes) throw new Error('El archivo del borrador no es válido.');
    bytes += file.blob.size;
  }
  if (bytes > ATTACHMENT_LIMITS.messageBytes) throw new Error('Los adjuntos de una sesión pueden sumar hasta 50 MiB.');
  return bytes;
}

function read(value: unknown): Draft {
  if (value === undefined) return { revision: 0, files: [], bytes: 0 };
  const draft = value as Draft;
  if (!draft || !Number.isSafeInteger(draft.revision) || draft.revision < 1 || validateFiles(draft.files) !== draft.bytes) {
    throw new Error('No se pudo recuperar el borrador de adjuntos.');
  }
  return draft;
}

function access<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore, result: (value: T) => void, fail: (error: unknown) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let database: IDBDatabase | undefined, transaction: IDBTransaction | undefined;
    let settled = false, result: T;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true; clearTimeout(timer); database?.close();
      if (error) reject(error); else resolve(result);
    };
    const fail = (error: unknown) => { try { transaction?.abort(); } catch { /* Already settled. */ } finish(error); };
    const timer = setTimeout(() => fail(new Error('El almacenamiento de adjuntos no respondió.')), 8000);
    try {
      const opening = indexedDB.open(DATABASE, 1);
      opening.onupgradeneeded = () => {
        if (settled) { opening.transaction?.abort(); return; }
        opening.result.createObjectStore('drafts');
      };
      opening.onblocked = () => fail(new Error('Cierra la otra versión de Capri para guardar adjuntos.'));
      opening.onerror = () => fail(opening.error ?? new Error('No se pudo abrir el almacenamiento de adjuntos.'));
      opening.onsuccess = () => {
        database = opening.result;
        if (settled) { database.close(); return; }
        database.onversionchange = () => database?.close();
        try {
          transaction = database.transaction('drafts', mode);
          transaction.oncomplete = () => finish();
          transaction.onabort = () => finish(transaction?.error ?? new Error('No se guardaron los adjuntos.'));
          transaction.onerror = () => fail(transaction?.error ?? new Error('No se guardaron los adjuntos.'));
          operation(transaction.objectStore('drafts'), value => { result = value; }, fail);
        } catch (error) { fail(error); }
      };
    } catch (error) { fail(error); }
  });
}

/** One editor owns its revision. Queued writes survive unmount; another editor cannot overwrite it. */
export function sessionAttachmentDraft(url: string, paneId: string, sessionId: string) {
  if ([paneId, sessionId].some(id => !id || id.length > 256 || /[\u0000-\u001f\u007f]/.test(id))) throw new Error('Sesión no válida.');
  const key = JSON.stringify([validDaemonUrl(url), paneId, sessionId]);
  let revision: number | undefined;
  return {
    load: () => ordered(key, async () => {
      const draft = await access<Draft>('readonly', (store, result, fail) => {
        const request = store.get(key);
        request.onsuccess = () => { try { result(read(request.result)); } catch (error) { fail(error); } };
      });
      revision = draft.revision;
      return draft.files.map(file => new File([file.blob], file.name, { type: file.type, lastModified: file.lastModified }));
    }),
    save: async (files: File[]) => {
      const saved = files.map(file => ({ name: file.name, type: file.type, lastModified: file.lastModified, blob: file.slice() }));
      const bytes = validateFiles(saved);
      return ordered(key, async () => {
        if (revision === undefined) throw new Error('Recupera el borrador antes de modificar sus adjuntos.');
        const next = await access<number>('readwrite', (store, result, fail) => {
          const request = store.get(key);
          request.onsuccess = () => {
            try {
              const previous = read(request.result);
              if (previous.revision !== revision) throw new Error('Los adjuntos cambiaron en otra vista. Vuelve a abrir esta sesión para revisarlos.');
              const all = store.getAll();
              all.onsuccess = () => {
                try {
                  const drafts = all.result.map(read);
                  const count = drafts.filter(item => item.files.length).length - Number(previous.files.length > 0) + Number(saved.length > 0);
                  const total = drafts.reduce((sum, item) => sum + item.bytes, 0) - previous.bytes + bytes;
                  if (count > MAX_DRAFTS || total > MAX_BYTES) throw new Error('No hay espacio para más borradores de adjuntos. Quita archivos de otras sesiones.');
                  // Keep a small revision tombstone after clearing: stale editors must not revive old bytes.
                  store.put({ revision: previous.revision + 1, files: saved, bytes }, key);
                  result(previous.revision + 1);
                } catch (error) { fail(error); }
              };
            } catch (error) { fail(error); }
          };
        });
        revision = next;
      });
    },
  };
}
