export type LocalSettings = {
  url: string;
  motion: 'full' | 'reduced' | 'paused';
};

const SETTINGS_KEY = 'capri.ios.settings.v1';
const DATABASE = 'capri-ios-local';
const ARTWORK_STORE = 'artwork';
const ARTWORK_KEY = 'capri';
const MAX_ARTWORK_BYTES = 5 * 1024 * 1024;
const STORAGE_TIMEOUT_MS = 8000;

function defaults(): LocalSettings {
  return { url: '', motion: 'full' };
}

/** The endpoint is public configuration; credentials belong only in memory. */
export function validDaemonUrl(input: string): string {
  const value = input.trim();
  if (!/^wss:\/\/[^/]/i.test(value) || /[\u0000-\u0020\\?#]/.test(value) || value.slice(6).split('/')[0]?.includes('@')) {
    throw new Error('Usa wss://host/ws sin credenciales ni parámetros.');
  }
  const url = new URL(value);
  if (url.protocol !== 'wss:' || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw new Error('Usa wss://host/ws sin credenciales ni parámetros.');
  }
  return url.href;
}

function motionSetting(value: unknown): LocalSettings['motion'] {
  return value === 'reduced' || value === 'paused' ? value : 'full';
}

export function readSettings(storage?: Pick<Storage, 'getItem'>): LocalSettings {
  const settings = defaults();
  try {
    const source = storage ?? globalThis.localStorage;
    const raw = source?.getItem(SETTINGS_KEY);
    if (!raw) return settings;
    const saved: unknown = JSON.parse(raw);
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return settings;
    const record = saved as Record<string, unknown>;
    settings.motion = motionSetting(record.motion);
    if (typeof record.url === 'string' && record.url.trim()) {
      try { settings.url = validDaemonUrl(record.url); } catch { /* Ignore an invalid saved endpoint. */ }
    }
  } catch { /* Storage can be unavailable in private or restricted web views. */ }
  return settings;
}

export function saveSettings(settings: LocalSettings, storage?: Pick<Storage, 'setItem'>): boolean {
  try {
    const destination = storage ?? globalThis.localStorage;
    if (!destination) return false;
    // Explicit allowlist: never spread caller data into persistent storage.
    const safe: LocalSettings = {
      url: settings.url.trim() ? validDaemonUrl(settings.url) : '',
      motion: motionSetting(settings.motion),
    };
    destination.setItem(SETTINGS_KEY, JSON.stringify(safe));
    return true;
  } catch {
    return false;
  }
}

/** Dimensions and PNG decoding are checked by the caller before saving. */
export function validateArtwork(blob: Blob): void {
  if (!(blob instanceof Blob) || blob.type !== 'image/png' || blob.size === 0 || blob.size > MAX_ARTWORK_BYTES) {
    throw new Error('El arte debe ser un PNG de hasta 5 MiB.');
  }
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(new Error('El almacenamiento local de arte no está disponible.'));
      return;
    }
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    };
    const timeout = setTimeout(() => fail(new Error('El almacenamiento local no respondió.')), STORAGE_TIMEOUT_MS);
    try {
      const request = indexedDB.open(DATABASE, 1);
      request.onupgradeneeded = () => {
        if (settled) {
          request.transaction?.abort();
          return;
        }
        try {
          if (!request.result.objectStoreNames.contains(ARTWORK_STORE)) request.result.createObjectStore(ARTWORK_STORE);
        } catch (error) {
          request.transaction?.abort();
          fail(error);
        }
      };
      request.onerror = () => fail(request.error ?? new Error('No se pudo abrir el almacenamiento local.'));
      request.onblocked = () => fail(new Error('El almacenamiento local está ocupado. Cierra otras ventanas de Capri.'));
      request.onsuccess = () => {
        const database = request.result;
        if (settled) {
          database.close();
          return;
        }
        settled = true;
        clearTimeout(timeout);
        database.onversionchange = () => database.close();
        resolve(database);
      };
    } catch (error) {
      fail(error);
    }
  });
}

async function artworkTransaction<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction | undefined;
    let request: IDBRequest<T>;
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      database.close();
      if (error) reject(error);
      else resolve(request.result);
    };
    const timeout = setTimeout(() => {
      try { transaction?.abort(); } catch { /* The transaction may already have closed. */ }
      finish(new Error('El almacenamiento local no respondió.'));
    }, STORAGE_TIMEOUT_MS);
    try {
      transaction = database.transaction(ARTWORK_STORE, mode);
      // A successful request is not a durable write until its transaction completes.
      transaction.oncomplete = () => finish();
      transaction.onabort = () => finish(transaction?.error ?? new Error('La operación de almacenamiento se canceló.'));
      transaction.onerror = () => finish(transaction?.error ?? new Error('No se pudo guardar el arte local.'));
      request = operation(transaction.objectStore(ARTWORK_STORE));
      request.onerror = () => finish(request.error ?? new Error('No se pudo acceder al arte local.'));
    } catch (error) {
      try { transaction?.abort(); } catch { /* Nothing remains to abort. */ }
      finish(error);
    }
  });
}

export async function loadArtwork(): Promise<Blob | undefined> {
  const blob: unknown = await artworkTransaction('readonly', store => store.get(ARTWORK_KEY));
  if (blob === undefined) return undefined;
  validateArtwork(blob as Blob);
  return blob as Blob;
}

export async function saveArtwork(blob: Blob): Promise<void> {
  validateArtwork(blob);
  await artworkTransaction('readwrite', store => store.put(blob, ARTWORK_KEY));
}

export async function deleteArtwork(): Promise<void> {
  await artworkTransaction('readwrite', store => store.delete(ARTWORK_KEY));
}
