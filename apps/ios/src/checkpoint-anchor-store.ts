/** Independent durable link to the original conversation turn. No prompt,
 * proposal or credential is copied into this store. Each mutation uses CAS. */
export type AnchorState = 'preparing' | 'ready' | 'running' | 'resuming' | 'awaitingForeground' | 'interrupted' | 'budgetExhausted' | 'answer' | 'answerCommitted' | 'cancelled' | 'executingForeground' | 'uncertainForeground';
export type CheckpointAnchor = { id: string; userId: string; fingerprint: string; requestFingerprint: string; version: number; state: AnchorState; nativeRevision?: string; answerFingerprint?: string };
export interface CheckpointAnchorStore {
  create(anchor: Omit<CheckpointAnchor, 'version'>): Promise<CheckpointAnchor>;
  get(id: string): Promise<CheckpointAnchor | undefined>;
  list(): Promise<CheckpointAnchor[]>;
  compareAndSwap(expected: CheckpointAnchor, changes: Partial<Pick<CheckpointAnchor, 'state' | 'nativeRevision' | 'answerFingerprint'>>): Promise<CheckpointAnchor>;
  remove(expected: CheckpointAnchor): Promise<void>;
}
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const states = new Set<AnchorState>(['preparing','ready','running','resuming','awaitingForeground','interrupted','budgetExhausted','answer','answerCommitted','cancelled','executingForeground','uncertainForeground']);
function valid(value: unknown): value is CheckpointAnchor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (Object.keys(value).some(key => !['id', 'userId', 'fingerprint', 'requestFingerprint', 'version', 'state', 'nativeRevision', 'answerFingerprint'].includes(key))) return false;
  const item = value as Partial<CheckpointAnchor>;
  return uuid(item.id) && uuid(item.userId) && item.id !== item.userId && hash(item.fingerprint) && hash(item.requestFingerprint) && Number.isSafeInteger(item.version) && Number(item.version) > 0 && states.has(item.state as AnchorState)
    && (item.state === 'preparing' ? item.nativeRevision === undefined : uuid(item.nativeRevision))
    && (item.state === 'answerCommitted' ? hash(item.answerFingerprint) : item.answerFingerprint === undefined);
}
function same(a: CheckpointAnchor, b: CheckpointAnchor): boolean {
  return a.id === b.id && a.userId === b.userId && a.fingerprint === b.fingerprint && a.requestFingerprint === b.requestFingerprint && a.version === b.version && a.state === b.state && a.nativeRevision === b.nativeRevision && a.answerFingerprint === b.answerFingerprint;
}
function transact<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore, finish: (value: T) => void, fail: (error: Error) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let db: IDBDatabase | undefined, tx: IDBTransaction | undefined, result: T, error: Error | undefined, settled = false;
    const finish = (problem?: Error) => { if (settled) return; settled = true; clearTimeout(timer); db?.close(); problem ? reject(problem) : resolve(result); };
    const fail = (problem: Error) => { error = problem; try { tx?.abort(); } catch { finish(problem); } };
    const timer = setTimeout(() => { try { tx?.abort(); } catch { /* Already finished. */ } finish(new Error('El ancla de conversación no respondió.')); }, 8000);
    try {
      const opening = indexedDB.open('capri-ios-agent-anchors', 1);
      opening.onupgradeneeded = () => { if (settled) { opening.transaction?.abort(); return; } opening.result.createObjectStore('anchors', { keyPath: 'id' }); };
      opening.onerror = () => finish(new Error('No pude abrir las anclas de conversación.'));
      opening.onblocked = () => finish(new Error('Otra versión de Capri mantiene las anclas abiertas.'));
      opening.onsuccess = () => {
        db = opening.result;
        if (settled) { db.close(); return; }
        db.onversionchange = () => db?.close();
        try {
          tx = db.transaction('anchors', mode);
          tx.oncomplete = () => finish();
          tx.onabort = () => finish(error ?? new Error('No se confirmó el ancla de conversación.'));
          tx.onerror = () => { error ??= new Error('No se confirmó el ancla de conversación.'); };
          work(tx.objectStore('anchors'), value => { result = value; }, fail);
        } catch { finish(new Error('No pude iniciar el almacenamiento del análisis.')); }
      };
    } catch { finish(new Error('No pude abrir las anclas de conversación.')); }
  });
}
export const checkpointAnchorStore: CheckpointAnchorStore = {
  create(anchor) {
    const value = { ...anchor, version: 1 };
    if (!valid(value) || value.state !== 'preparing') return Promise.reject(new Error('El ancla inicial no es válida.'));
    return transact('readwrite', (store, done, fail) => {
      const count = store.count();
      count.onsuccess = () => {
        if (count.result >= 20) { fail(new Error('Hay demasiados análisis sin revisar.')); return; }
        const request = store.add(value);
        request.onsuccess = () => done(value);
        request.onerror = () => fail(new Error('El turno ya tiene un análisis o no se pudo guardar.'));
      };
      count.onerror = () => fail(new Error('No pude comprobar los análisis guardados.'));
    });
  },
  get(id) {
    if (!uuid(id)) return Promise.reject(new Error('La identidad del turno no es válida.'));
    return transact('readonly', (store, done, fail) => {
      const request = store.get(id);
      request.onsuccess = () => { if (request.result === undefined) done(undefined); else if (valid(request.result)) done(request.result); else fail(new Error('El ancla guardada no es válida.')); };
      request.onerror = () => fail(new Error('No pude consultar el ancla.'));
    });
  },
  list() {
    return transact('readonly', (store, done, fail) => {
      const request = store.getAll();
      request.onsuccess = () => { if (!Array.isArray(request.result) || request.result.length > 20 || !request.result.every(valid)) fail(new Error('Las anclas guardadas no son válidas.')); else done(request.result); };
      request.onerror = () => fail(new Error('No pude consultar las anclas.'));
    });
  },
  compareAndSwap(expected, changes) {
    if (!valid(expected)) return Promise.reject(new Error('El ancla esperada no es válida.'));
    if (!changes || typeof changes !== 'object' || Array.isArray(changes) || Object.keys(changes).some(key => !['state', 'nativeRevision', 'answerFingerprint'].includes(key))) return Promise.reject(new Error('Los cambios del ancla no son válidos.'));
    const transitions: Record<AnchorState, AnchorState[]> = {
      preparing: ['ready'], ready: ['running'], running: ['ready', 'resuming', 'awaitingForeground', 'interrupted', 'budgetExhausted', 'answer', 'cancelled', 'executingForeground', 'uncertainForeground'],
      resuming: ['ready', 'interrupted', 'budgetExhausted'], interrupted: ['resuming', 'cancelled'], awaitingForeground: ['cancelled'],
      budgetExhausted: ['cancelled'], answer: ['answerCommitted'], answerCommitted: [], cancelled: [],
      executingForeground: ['uncertainForeground'], uncertainForeground: [],
    };
    if (!changes.state || !transitions[expected.state].includes(changes.state)) return Promise.reject(new Error('La transición del análisis no es válida.'));
    const next = { ...expected, ...changes, version: expected.version + 1 };
    if (!valid(next)) return Promise.reject(new Error('La nueva revisión del ancla no es válida.'));
    return transact('readwrite', (store, done, fail) => {
      const read = store.get(expected.id);
      read.onsuccess = () => {
        if (!valid(read.result) || !same(read.result, expected)) { fail(new Error('El turno cambió; consulta su estado antes de continuar.')); return; }
        const write = store.put(next);
        write.onsuccess = () => done(next);
        write.onerror = () => fail(new Error('No pude guardar la revisión del turno.'));
      };
      read.onerror = () => fail(new Error('No pude comprobar la revisión del turno.'));
    });
  },
  remove(expected) {
    if (!valid(expected) || !['answerCommitted', 'cancelled'].includes(expected.state)) return Promise.reject(new Error('El ancla todavía conserva trabajo pendiente.'));
    return transact('readwrite', (store, done, fail) => {
      const read = store.get(expected.id);
      read.onsuccess = () => {
        if (!valid(read.result) || !same(read.result, expected)) { fail(new Error('El turno cambió; el ancla se conserva.')); return; }
        const request = store.delete(expected.id);
        request.onsuccess = () => done(undefined);
        request.onerror = () => fail(new Error('No pude retirar el ancla confirmada.'));
      };
      read.onerror = () => fail(new Error('No pude comprobar el ancla.'));
    });
  },
};
