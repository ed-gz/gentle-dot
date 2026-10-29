/** Experimental, isolated turn store. It does not read or mutate the current
 * conversation or execute tools. Every mutation is a single IDB transaction;
 * snapshots are read-only and can never be written back as replacements. */
export type IsolatedTurn = {
  id: string;
  role: 'user' | 'assistant';
  engine: 'iphone';
  state: 'pending' | 'complete' | 'interrupted';
  text: string;
  at: number;
  replyTo?: string;
  localCancelled?: true;
};
export type IsolatedTurnSnapshot = { revision: number; entries: IsolatedTurn[] };
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const natural = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const LIMIT = 120;

function canonical(value: unknown): IsolatedTurn {
  if (!object(value) || Object.keys(value).some(key => !['id','role','engine','state','text','at','replyTo','localCancelled'].includes(key))
    || !uuid(value.id) || !['user','assistant'].includes(String(value.role)) || value.engine !== 'iphone'
    || !['pending','complete','interrupted'].includes(String(value.state)) || typeof value.text !== 'string'
    || value.text.length > 32000 || !natural(value.at) || value.at > 8_640_000_000_000_000
    || (value.localCancelled !== undefined && value.localCancelled !== true)
    || (value.role === 'assistant' ? !uuid(value.replyTo) || value.replyTo === value.id : value.replyTo !== undefined)
    || (value.localCancelled === true && (value.role !== 'assistant' || value.state !== 'interrupted'))
    || (value.role === 'user' && (value.state !== 'complete' || !value.text.trim()))) {
    throw new Error('El turno aislado no es válido; no se modificó el registro.');
  }
  return { id: value.id, role: value.role as IsolatedTurn['role'], engine: 'iphone', state: value.state as IsolatedTurn['state'], text: value.text, at: value.at, ...(typeof value.replyTo === 'string' ? { replyTo: value.replyTo } : {}), ...(value.localCancelled === true ? { localCancelled: true } : {}) };
}
function snapshot(value: unknown): IsolatedTurnSnapshot {
  if (value === undefined) return { revision: 0, entries: [] };
  if (!object(value) || Object.keys(value).some(key => !['revision','entries'].includes(key)) || !natural(value.revision) || !Array.isArray(value.entries) || value.entries.length > LIMIT) throw new Error('El registro de turnos es inválido; no se sobrescribió.');
  const entries = value.entries.map(canonical);
  if (new Set(entries.map(entry => entry.id)).size !== entries.length) throw new Error('El registro contiene turnos duplicados; no se sobrescribió.');
  if (entries.some(entry => entry.role === 'assistant' && !entries.some(request => request.id === entry.replyTo && request.role === 'user'))) throw new Error('El registro perdió la solicitud original; no se sobrescribió.');
  return { revision: value.revision, entries };
}
const same = (a: IsolatedTurn, b: IsolatedTurn) => JSON.stringify(a) === JSON.stringify(b);

export function createIsolatedTurnStore(options: { databaseName?: string; maximumEntries?: number } = {}) {
  const name = options.databaseName ?? 'capri-ios-isolated-turns-v1';
  const maximum = options.maximumEntries ?? LIMIT;
  if (typeof name !== 'string' || !name || name.length > 256 || !natural(maximum) || maximum < 2 || maximum > LIMIT) throw new Error('Configuración de turnos inválida.');
  function transaction<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore, current: IsolatedTurnSnapshot) => T): Promise<T> {
    return new Promise((resolve, reject) => {
      let database: IDBDatabase | undefined, tx: IDBTransaction | undefined, settled = false, result: T;
      let produced = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true; clearTimeout(timer); database?.close();
        if (error !== undefined) reject(error); else if (produced) resolve(result); else reject(new Error('No se confirmó el registro de turnos.'));
      };
      const fail = (error: unknown) => { try { tx?.abort(); } catch { /* Already finished. */ } finish(error); };
      const timer = setTimeout(() => fail(new Error('El registro de turnos no respondió; conserva las copias originales.')), 8000);
      let opening: IDBOpenDBRequest;
      try { opening = indexedDB.open(name, 1); } catch (error) { finish(error); return; }
      opening.onupgradeneeded = () => { if (settled) { opening.transaction?.abort(); return; } opening.result.createObjectStore('turns'); };
      opening.onerror = () => finish(opening.error ?? new Error('No pude abrir el registro de turnos.'));
      opening.onblocked = () => finish(new Error('Otra versión mantiene abierto el registro de turnos.'));
      opening.onsuccess = () => {
        database = opening.result; if (settled) { database.close(); return; }
        database.onversionchange = () => database?.close();
        try {
          tx = database.transaction('turns', mode);
          tx.oncomplete = () => finish();
          tx.onabort = () => finish(tx?.error ?? new Error('No se confirmó la operación de turnos.'));
          tx.onerror = () => finish(tx?.error ?? new Error('No se confirmó la operación de turnos.'));
          const store = tx.objectStore('turns'), request = store.get('current');
          request.onerror = () => fail(request.error ?? new Error('No pude leer el registro de turnos.'));
          request.onsuccess = () => { try { result = action(store, snapshot(request.result)); produced = true; } catch (error) { fail(error); } };
        } catch (error) { fail(error); }
      };
    });
  }
  return {
    read: () => transaction('readonly', (_store, current) => current),
    /** expectedRevision must come from the snapshot that preceded the user's
     * append. A conflict rejects rather than replacing any existing turn. */
    append(expectedRevision: number, userValue: IsolatedTurn, turnValue: IsolatedTurn): Promise<IsolatedTurnSnapshot> {
      let user: IsolatedTurn, turn: IsolatedTurn;
      try { user = canonical(userValue); turn = canonical(turnValue); }
      catch (error) { return Promise.reject(error); }
      if (!natural(expectedRevision) || user.role !== 'user' || turn.role !== 'assistant' || turn.replyTo !== user.id || turn.state !== 'pending' || turn.localCancelled || turn.text || user.id === turn.id) return Promise.reject(new Error('La solicitud y el turno nuevos no son válidos.'));
      return transaction('readwrite', (store, current) => {
        if (current.revision !== expectedRevision) throw new Error('La conversación cambió; conserva la solicitud y vuelve a leer.');
        if (current.entries.some(entry => entry.id === user.id || entry.id === turn.id)) throw new Error('La identidad del turno ya existe.');
        if (current.entries.length + 2 > maximum) throw new Error('El registro alcanzó su límite; no se descartaron turnos.');
        if (current.revision === Number.MAX_SAFE_INTEGER) throw new Error('La revisión agotó su límite.');
        const next = { revision: current.revision + 1, entries: [...current.entries, user, turn] };
        store.put(next, 'current'); return next;
      });
    },
    /** Atomic compare-and-set on both the original user request and answer
     * turn. Later writers cannot replace the resulting whole snapshot. */
    finish(userValue: IsolatedTurn, turnValue: IsolatedTurn, result: { kind: 'answer'; text: string } | { kind: 'cancel' }): Promise<boolean> {
      let user: IsolatedTurn, turn: IsolatedTurn;
      try { user = canonical(userValue); turn = canonical(turnValue); }
      catch (error) { return Promise.reject(error); }
      if (user.role !== 'user' || turn.role !== 'assistant' || turn.replyTo !== user.id || user.id === turn.id || !['pending','interrupted'].includes(turn.state) || turn.localCancelled
        || !result || !['answer','cancel'].includes(result.kind) || (result.kind === 'answer' && (typeof result.text !== 'string' || !result.text.trim() || result.text.length > 32000))) return Promise.reject(new Error('El resultado o su turno original no es válido.'));
      const outcome = result.kind === 'answer' ? { kind: 'answer' as const, text: result.text } : { kind: 'cancel' as const };
      return transaction('readwrite', (store, current) => {
        const actualUser = current.entries.find(entry => entry.id === user.id), index = current.entries.findIndex(entry => entry.id === turn.id);
        if (!actualUser || !same(actualUser, user) || index < 0 || !same(current.entries[index]!, turn)) return false;
        if (current.revision === Number.MAX_SAFE_INTEGER) throw new Error('La revisión agotó su límite.');
        const nextTurn: IsolatedTurn = outcome.kind === 'answer'
          ? { ...turn, role: 'assistant', state: 'complete', text: outcome.text }
          : { ...turn, role: 'assistant', state: 'interrupted', text: 'Respuesta interrumpida.', localCancelled: true };
        const entries = [...current.entries]; entries[index] = nextTurn;
        store.put({ revision: current.revision + 1, entries }, 'current'); return true;
      });
    },
  };
}
