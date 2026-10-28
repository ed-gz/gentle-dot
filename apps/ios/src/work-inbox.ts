export type WorkStatus = 'local' | 'prepared' | 'approved' | 'sending' | 'sent' | 'uncertain' | 'failed';
export type WorkItem = {
  id: string;
  title: string;
  kind: 'task' | 'meeting';
  instruction: string;
  createdAt: number;
  updatedAt: number;
  status: WorkStatus;
  revision: number;
  files: { id: string; name: string; type: string; size: number }[];
  versions: { id: string; text: string; createdAt: number }[];
  error?: string;
};
export type WorkInput = {
  title: string;
  kind: WorkItem['kind'];
  instruction: string;
  files?: File[];
};

const DATABASE = 'capri-ios-work-inbox';
const ITEMS = 'items';
const FILES = 'files';
const TIMEOUT_MS = 8000;
const MIB = 1024 * 1024;
export const WORK_LIMITS = Object.freeze({
  items: 100, files: 10, fileBytes: 25 * MIB, totalFileBytes: 50 * MIB,
  title: 120, instruction: 8000, versions: 100, versionText: 200_000,
});

const transitions: Record<WorkStatus, readonly WorkStatus[]> = {
  local: ['prepared'],
  prepared: ['local', 'approved'],
  approved: ['local', 'prepared', 'sending'],
  sending: ['sent', 'uncertain', 'failed'],
  sent: [],
  uncertain: ['local', 'prepared'],
  failed: ['local', 'prepared'],
};

function textWithin(value: string, limit: number, label: string, required = false): string {
  if (typeof value !== 'string') throw new Error(`${label} no válido.`);
  const trimmed = value.trim();
  if ((required && !trimmed) || trimmed.length > limit) {
    throw new Error(`${label}: ${required ? 'de 1 a' : 'máximo'} ${limit} caracteres.`);
  }
  return trimmed;
}

/** File names and MIME types are metadata, not proof of content safety. Never execute attachments. */
export function validateWorkFiles(files: readonly File[]): void {
  if (!Array.isArray(files) || files.length > WORK_LIMITS.files) throw new Error('Máximo 10 archivos por trabajo.');
  let total = 0;
  for (const file of files) {
    if (!(file instanceof File)) throw new Error('Adjunta archivos válidos.');
    if (!file.name.trim() || file.name.length > 255 || /[\u0000-\u001f\u007f]/.test(file.name)) {
      throw new Error('El nombre del archivo no es válido.');
    }
    const mime = file.type.split(';')[0]?.trim() ?? '';
    if (!/^(audio|text|image)\/[a-z0-9.+_-]+$/.test(mime) && !['application/pdf', 'application/json', 'application/x-subrip'].includes(mime)) {
      throw new Error('Adjunta audio, texto, PDF o imágenes con un tipo de archivo reconocido.');
    }
    if (file.size === 0 || file.size > WORK_LIMITS.fileBytes) throw new Error('Cada archivo debe contener datos y pesar hasta 25 MiB.');
    total += file.size;
  }
  if (total > WORK_LIMITS.totalFileBytes) throw new Error('Los archivos de un trabajo pueden sumar hasta 50 MiB.');
}

/** Return only supported fields; connection credentials are never part of the inbox schema. */
export function validateWorkInput(input: WorkInput): WorkInput & { files: File[] } {
  if (!input || (input.kind !== 'task' && input.kind !== 'meeting')) throw new Error('Tipo de trabajo no válido.');
  const title = textWithin(input.title, WORK_LIMITS.title, 'Título', true);
  const instruction = textWithin(input.instruction, WORK_LIMITS.instruction, 'Instrucción');
  const files = input.files ?? [];
  validateWorkFiles(files);
  return { title, kind: input.kind, instruction, files: [...files] };
}

export function assertWorkRevision(item: WorkItem, expectedRevision: number): void {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || item.revision !== expectedRevision) {
    throw new Error('El trabajo cambió. Recarga la bandeja antes de continuar.');
  }
}

function nextRevision(item: WorkItem, now: number): WorkItem {
  // Do not propagate arbitrary data from an object or an older local schema.
  return {
    id: item.id, title: item.title, kind: item.kind, instruction: item.instruction,
    createdAt: item.createdAt, updatedAt: Math.max(now, item.updatedAt),
    status: item.status, revision: item.revision + 1,
    files: item.files.map(file => ({ id: file.id, name: file.name, type: file.type, size: file.size })),
    versions: item.versions.map(version => ({ id: version.id, text: version.text, createdAt: version.createdAt })),
  };
}

function assertEditable(item: WorkItem): void {
  if (item.status === 'sending' || item.status === 'sent') {
    throw new Error('Un trabajo enviado o en curso no se puede editar. Crea otro trabajo para una nueva instrucción.');
  }
}

/** Pure state transition. "sent" requires an explicit acknowledgement checked by the caller. */
export function transitionWorkItem(item: WorkItem, nextStatus: WorkStatus, now = Date.now()): WorkItem {
  if (!transitions[item.status]?.includes(nextStatus)) throw new Error(`Cambio de estado no permitido: ${item.status} → ${nextStatus}.`);
  if (nextStatus === 'prepared' && !item.instruction.trim() && item.files.length === 0 && item.versions.length === 0) {
    throw new Error('Añade una instrucción, un archivo o una versión antes de preparar el trabajo.');
  }
  const next = nextRevision(item, now);
  next.status = nextStatus;
  return next;
}

export function reviseWorkItem(item: WorkItem, instruction: string, now = Date.now()): WorkItem {
  assertEditable(item);
  const next = nextRevision(item, now);
  next.instruction = textWithin(instruction, WORK_LIMITS.instruction, 'Instrucción');
  next.status = 'local';
  return next;
}

export function addWorkVersionItem(item: WorkItem, text: string, versionId: string, now = Date.now()): WorkItem {
  assertEditable(item);
  const content = textWithin(text, WORK_LIMITS.versionText, 'Versión', true);
  if (item.versions.length >= WORK_LIMITS.versions) throw new Error('Este trabajo ya tiene 100 versiones.');
  if (!versionId || item.versions.some(version => version.id === versionId)) throw new Error('Identificador de versión no válido.');
  const next = nextRevision(item, now);
  next.versions.push({ id: versionId, text: content, createdAt: now });
  next.status = 'local';
  return next;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error('La bandeja local no está disponible.')); return; }
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    };
    const timeout = setTimeout(() => fail(new Error('La bandeja local no respondió.')), TIMEOUT_MS);
    try {
      const request = indexedDB.open(DATABASE, 1);
      request.onupgradeneeded = () => {
        if (settled) { request.transaction?.abort(); return; }
        try {
          const database = request.result;
          if (!database.objectStoreNames.contains(ITEMS)) database.createObjectStore(ITEMS, { keyPath: 'id' });
          if (!database.objectStoreNames.contains(FILES)) database.createObjectStore(FILES);
        } catch (error) { request.transaction?.abort(); fail(error); }
      };
      request.onerror = () => fail(request.error ?? new Error('No se pudo abrir la bandeja local.'));
      request.onblocked = () => fail(new Error('La bandeja está ocupada. Cierra otras ventanas de Capri.'));
      request.onsuccess = () => {
        const database = request.result;
        if (settled) { database.close(); return; }
        settled = true;
        clearTimeout(timeout);
        database.onversionchange = () => database.close();
        resolve(database);
      };
    } catch (error) { fail(error); }
  });
}

type TransactionAction<T> = (transaction: IDBTransaction, result: (value: T) => void, fail: (error: unknown) => void) => void;

async function transact<T>(mode: IDBTransactionMode, action: TransactionAction<T>): Promise<T> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction | undefined;
    let result: T;
    let hasResult = false;
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { transaction?.abort(); } catch { /* It may already be aborted. */ }
      database.close();
      reject(error);
    };
    const timeout = setTimeout(() => fail(new Error('La bandeja local no respondió.')), TIMEOUT_MS);
    try {
      transaction = database.transaction([ITEMS, FILES], mode);
      transaction.onabort = () => fail(transaction?.error ?? new Error('Se canceló el cambio de la bandeja.'));
      transaction.onerror = () => fail(transaction?.error ?? new Error('No se pudo actualizar la bandeja local.'));
      transaction.oncomplete = () => {
        if (settled) return;
        if (!hasResult) { fail(new Error('La bandeja no devolvió un resultado.')); return; }
        settled = true;
        clearTimeout(timeout);
        database.close();
        resolve(result);
      };
      action(transaction, value => { result = value; hasResult = true; }, fail);
    } catch (error) { fail(error); }
  });
}

function whenReady<T>(request: IDBRequest<T>, success: (value: T) => void, fail: (error: unknown) => void): void {
  request.onerror = () => fail(request.error ?? new Error('No se pudo leer la bandeja local.'));
  request.onsuccess = () => { try { success(request.result); } catch (error) { fail(error); } };
}

function requireItem(value: WorkItem | undefined): WorkItem {
  if (!value) throw new Error('El trabajo ya no existe.');
  return value;
}

function updateWork(id: string, expectedRevision: number, update: (item: WorkItem) => WorkItem): Promise<WorkItem> {
  return transact('readwrite', (transaction, result, fail) => {
    const store = transaction.objectStore(ITEMS);
    whenReady<WorkItem | undefined>(store.get(id), current => {
      const item = requireItem(current);
      assertWorkRevision(item, expectedRevision);
      const next = update(item);
      store.put(next);
      result(next);
    }, fail);
  });
}

export function listWork(): Promise<WorkItem[]> {
  return transact('readonly', (transaction, result, fail) => {
    whenReady<WorkItem[]>(transaction.objectStore(ITEMS).getAll(), items => {
      // Preserve "sending" across reloads. A caller must resolve uncertain delivery explicitly.
      result(items.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)));
    }, fail);
  });
}

export async function createWork(input: WorkInput): Promise<WorkItem> {
  const safe = validateWorkInput(input);
  const now = Date.now();
  const item: WorkItem = {
    id: crypto.randomUUID(), title: safe.title, kind: safe.kind, instruction: safe.instruction,
    createdAt: now, updatedAt: now, status: 'local', revision: 1,
    files: safe.files.map(file => ({ id: crypto.randomUUID(), name: file.name, type: file.type, size: file.size })),
    versions: [],
  };
  return transact('readwrite', (transaction, result, fail) => {
    const store = transaction.objectStore(ITEMS);
    whenReady(store.count(), count => {
      if (count >= WORK_LIMITS.items) throw new Error('La bandeja admite 100 trabajos. Elimina uno antes de crear otro.');
      store.add(item);
      for (let i = 0; i < safe.files.length; i++) {
        transaction.objectStore(FILES).add(safe.files[i], [item.id, item.files[i]!.id]);
      }
      result(item);
    }, fail);
  });
}

export function readWorkFile(workId: string, fileId: string): Promise<Blob | undefined> {
  return transact('readonly', (transaction, result, fail) => {
    whenReady<Blob | undefined>(transaction.objectStore(FILES).get([workId, fileId]), blob => {
      if (blob !== undefined && !(blob instanceof Blob)) throw new Error('El archivo local no es válido.');
      result(blob);
    }, fail);
  });
}

export function reviseWork(id: string, expectedRevision: number, instruction: string): Promise<WorkItem> {
  return updateWork(id, expectedRevision, item => reviseWorkItem(item, instruction));
}

export function addWorkVersion(id: string, expectedRevision: number, text: string): Promise<WorkItem> {
  return updateWork(id, expectedRevision, item => addWorkVersionItem(item, text, crypto.randomUUID()));
}

/** Call only after the relevant user action or explicit daemon acknowledgement; never on socket open. */
export function transitionWork(id: string, expectedRevision: number, nextStatus: WorkStatus): Promise<WorkItem> {
  return updateWork(id, expectedRevision, item => transitionWorkItem(item, nextStatus));
}

export function deleteWork(id: string, expectedRevision: number): Promise<void> {
  return transact('readwrite', (transaction, result, fail) => {
    const store = transaction.objectStore(ITEMS);
    whenReady<WorkItem | undefined>(store.get(id), current => {
      const item = requireItem(current);
      assertWorkRevision(item, expectedRevision);
      if (item.status === 'sending') throw new Error('Resuelve el envío en curso antes de eliminar el trabajo.');
      for (const file of item.files) transaction.objectStore(FILES).delete([id, file.id]);
      store.delete(id);
      result(undefined);
    }, fail);
  });
}
