import type { ChatEntry, ChatActivity, Conversation } from './conversation.ts';

export const ARCHIVE_LIMITS = Object.freeze({ entries: 10000, bytes: 64 * 1024 * 1024, entryBytes: 512 * 1024, batch: 500, page: 100, scan: 1000 });
export type ArchiveEntry = Pick<ChatEntry, 'id' | 'engine' | 'role' | 'state' | 'text' | 'at' | 'localCancelled' | 'replyTo'> & { scope: string; activities?: ChatActivity[] };
export type ArchiveRecord = ArchiveEntry & { key: string; sequence: number; storedAt: number; updatedAt: number; bytes: number; snapshotRevision: number };
export type ArchiveStats = { entries: number; bytes: number; nextSequence: number; maximumEntries: number; maximumBytes: number };
export type ArchiveWrite = ArchiveStats & { inserted: number; updated: number; unchanged: number };
export type ArchiveQuery = { cursor?: string; limit?: number; scope?: string; engine?: ChatEntry['engine']; roles?: ChatEntry['role'][] };
export type ArchivePage = { entries: ArchiveRecord[]; hasMore: boolean; cursor?: string; scanned: number };
type Metadata = { entries: number; bytes: number; nextSequence: number };
type Cursor = { at: number; sequence: number; filter: string };
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const natural = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const safeText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max;
const byteLength = (text: string) => new TextEncoder().encode(text).byteLength;
const TIMEOUT = 12000;

export class ArchiveError extends Error {
  readonly code: 'invalid' | 'quota' | 'unavailable' | 'corrupt';
  constructor(code: ArchiveError['code'], message: string) { super(message); this.name = 'ArchiveError'; this.code = code; }
}
export function archiveScope(entry: Pick<ChatEntry, 'id' | 'engine'>): string {
  if (entry.engine === 'iphone') return 'iphone:main';
  if (entry.id.startsWith('host:')) {
    const hostEnd = entry.id.indexOf('|'); const conversationEnd = entry.id.indexOf('|', hostEnd + 1);
    if (hostEnd > 5 && conversationEnd > hostEnd + 1) {
      try {
        const url = new URL(entry.id.slice(5, hostEnd));
        if (url.protocol === 'wss:' && !url.username && !url.password && !url.search && !url.hash) return entry.id.slice(0, conversationEnd);
      } catch { /* Historical data without a verified host identity stays explicitly unscoped. */ }
    }
  }
  return 'gentle:unscoped';
}
function validScope(value: unknown): value is string { return safeText(value, 2048) && Boolean(value.trim()) && !/[\u0000-\u001f\u007f]/.test(value); }
/** Only conversation content crosses this boundary. No draft, connection object or credential field. */
export function archiveEntry(value: unknown, scope?: string): ArchiveEntry {
  if (!object(value) || !safeText(value.id, 4096) || !value.id || !['iphone','gentle'].includes(String(value.engine)) || !['user','assistant','notice'].includes(String(value.role)) || !['complete','pending','interrupted'].includes(String(value.state)) || !safeText(value.text, 32000) || !natural(value.at) || value.at > 8_640_000_000_000_000) throw new ArchiveError('invalid', 'Un mensaje no cumple el esquema del archivo. Conserva el original; no se truncó.');
  const source = scope ?? archiveScope(value as ChatEntry); if (!validScope(source)) throw new ArchiveError('invalid', 'El origen de conversación no es válido.');
  const entry: ArchiveEntry = { id: value.id, scope: source, engine: value.engine as ChatEntry['engine'], role: value.role as ChatEntry['role'], state: value.state as ChatEntry['state'], text: value.text, at: value.at };
  if (entry.engine === 'iphone' && value.localCancelled === true) entry.localCancelled = true;
  if (value.replyTo !== undefined) {
    if (entry.engine !== 'iphone' || entry.role !== 'assistant' || source !== 'iphone:main' || !uuid(entry.id) || !uuid(value.replyTo) || entry.id === value.replyTo) throw new ArchiveError('invalid', 'El vínculo de la respuesta no es válido. El original se conserva.');
    entry.replyTo = value.replyTo;
  }
  if (value.activities !== undefined) {
    if (!Array.isArray(value.activities) || value.activities.length > 80) throw new ArchiveError('invalid', 'El mensaje contiene demasiadas actividades; no se descartaron silenciosamente.');
    entry.activities = value.activities.map(activity => {
      if (!object(activity) || !safeText(activity.id, 512) || !activity.id || !safeText(activity.title, 1000) || !['read','edit','run','search','memory','delegate','other'].includes(String(activity.kind)) || !['running','done','failed'].includes(String(activity.status)) || (activity.detail !== undefined && !safeText(activity.detail, 4000))) throw new ArchiveError('invalid', 'Una actividad de la conversación no es válida.');
      return { id: activity.id, title: activity.title, kind: activity.kind as ChatActivity['kind'], status: activity.status as ChatActivity['status'], ...(typeof activity.detail === 'string' ? { detail: activity.detail } : {}) };
    });
  }
  if (byteLength(JSON.stringify(entry)) > ARCHIVE_LIMITS.entryBytes) throw new ArchiveError('quota', 'El mensaje supera 512 KiB. Exporta o conserva su fuente; no se guardó parcialmente.');
  return entry;
}
const keyOf = (entry: ArchiveEntry) => JSON.stringify([entry.engine, entry.scope, entry.id]);
function stored(value: unknown): ArchiveRecord {
  if (!object(value) || !natural(value.sequence) || value.sequence < 1 || !natural(value.storedAt) || !natural(value.updatedAt) || !natural(value.bytes) || !validScope(value.scope) || (value.snapshotRevision !== undefined && !natural(value.snapshotRevision))) throw new ArchiveError('corrupt', 'El archivo contiene un registro inválido. No se sobrescribió.');
  const entry = archiveEntry(value, value.scope);
  if (value.key !== keyOf(entry) || value.bytes !== byteLength(JSON.stringify(entry))) throw new ArchiveError('corrupt', 'La identidad o tamaño del registro archivado no coincide.');
  return { ...entry, key: value.key as string, sequence: value.sequence, storedAt: value.storedAt, updatedAt: value.updatedAt, bytes: value.bytes, snapshotRevision: Number(value.snapshotRevision ?? 0) };
}
function metadata(value: unknown): Metadata {
  if (!object(value) || !natural(value.entries) || !natural(value.bytes) || !natural(value.nextSequence) || value.nextSequence < 1) throw new ArchiveError('corrupt', 'No se pudo verificar la cuota del archivo. No se reemplazó su contenido.');
  return { entries: value.entries, bytes: value.bytes, nextSequence: value.nextSequence };
}
export function memoryTerms(query: string): string[] {
  if (typeof query !== 'string' || query.length > 200) throw new ArchiveError('invalid', 'La búsqueda admite hasta 200 caracteres.');
  const terms = normalize(query).trim().split(/\s+/u).filter(Boolean);
  if (!terms.length || terms.length > 12) throw new ArchiveError('invalid', 'Escribe entre 1 y 12 términos para buscar mensajes.');
  return [...new Set(terms)];
}
function normalize(text: string): string { return text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('es'); }
export function matchesMemory(entry: ArchiveEntry, terms: readonly string[]): boolean { const text = normalize(entry.text); return terms.every(term => text.includes(term)); }
function encoded(cursor: Cursor): string { const bytes = new TextEncoder().encode(JSON.stringify(cursor)); let raw = ''; for (const byte of bytes) raw += String.fromCharCode(byte); return btoa(raw); }
function decoded(value: string, filter: string): Cursor {
  try {
    if (value.length > 8192) throw new Error();
    const cursor = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(value), char => char.charCodeAt(0))));
    if (!object(cursor) || !natural(cursor.at) || !natural(cursor.sequence) || cursor.sequence < 1 || cursor.filter !== filter) throw new Error();
    return { at: cursor.at, sequence: cursor.sequence, filter };
  } catch { throw new ArchiveError('invalid', 'El cursor no corresponde a esta búsqueda u origen. Empieza desde la primera página.'); }
}

export function createConversationArchive(options: { databaseName?: string; maximumEntries?: number; maximumBytes?: number } = {}) {
  const name = options.databaseName ?? 'capri-ios-conversation-archive';
  const maximumEntries = options.maximumEntries ?? ARCHIVE_LIMITS.entries; const maximumBytes = options.maximumBytes ?? ARCHIVE_LIMITS.bytes;
  if (!natural(maximumEntries) || maximumEntries < 1 || maximumEntries > ARCHIVE_LIMITS.entries || !natural(maximumBytes) || maximumBytes < 1 || maximumBytes > ARCHIVE_LIMITS.bytes) throw new ArchiveError('invalid', 'Cuota de archivo inválida.');
  const stats = (meta: Metadata): ArchiveStats => ({ ...meta, maximumEntries, maximumBytes });
  async function access<T>(mode: IDBTransactionMode, action: (tx: IDBTransaction, done: (result: T) => void, fail: (error: unknown) => void) => void): Promise<T> {
    if (!globalThis.indexedDB) throw new ArchiveError('unavailable', 'El archivo offline no está disponible. Conserva la conversación antes de cerrar.');
    return new Promise((resolve, reject) => {
      let database: IDBDatabase | undefined; let transaction: IDBTransaction | undefined; let finished = false; let result: T; let produced = false;
      const fail = (error: unknown) => { if (finished) return; finished = true; clearTimeout(timer); try { transaction?.abort(); } catch { /* Already complete. */ } database?.close(); reject(error); };
      const timer = setTimeout(() => fail(new ArchiveError('unavailable', 'El archivo offline no confirmó la operación. No elimines la copia visible.')), TIMEOUT);
      let opening: IDBOpenDBRequest;
      try { opening = indexedDB.open(name, 1); } catch (error) { fail(error); return; }
      opening.onupgradeneeded = () => {
        if (finished) { opening.transaction?.abort(); return; }
        const entries = opening.result.createObjectStore('entries', { keyPath: 'key' }); entries.createIndex('time', ['at','sequence'], { unique: true });
        opening.result.createObjectStore('metadata').put({ entries: 0, bytes: 0, nextSequence: 1 }, 'state');
      };
      opening.onerror = () => fail(opening.error ?? new ArchiveError('unavailable', 'No se pudo abrir el archivo offline.'));
      opening.onblocked = () => fail(new ArchiveError('unavailable', 'Otra versión de Capri mantiene abierto el archivo.'));
      opening.onsuccess = () => {
        database = opening.result; if (finished) { database.close(); return; } database.onversionchange = () => database?.close();
        try {
          transaction = database.transaction(['entries','metadata'], mode);
          transaction.onerror = () => fail(transaction?.error ?? new ArchiveError('unavailable', 'El archivo no pudo guardar la operación.'));
          transaction.onabort = () => fail(transaction?.error ?? new ArchiveError('unavailable', 'Se canceló la operación del archivo.'));
          transaction.oncomplete = () => { if (finished) return; if (!produced) { fail(new ArchiveError('corrupt', 'El archivo no devolvió un resultado.')); return; } finished = true; clearTimeout(timer); database?.close(); resolve(result); };
          action(transaction, value => { result = value; produced = true; }, fail);
        } catch (error) { fail(error); }
      };
    });
  }
  function read<T>(request: IDBRequest<T>, success: (value: T) => void, fail: (error: unknown) => void) {
    request.onerror = () => fail(request.error ?? new ArchiveError('unavailable', 'No se pudo leer el archivo.'));
    request.onsuccess = () => { try { success(request.result); } catch (error) { fail(error); } };
  }
  async function upsert(values: readonly ChatEntry[], scope?: string, visibleWindow?: readonly ChatEntry[], snapshotRevision?: number): Promise<ArchiveWrite> {
    if (snapshotRevision !== undefined && !natural(snapshotRevision)) throw new ArchiveError('invalid', 'Revisión de archivo inválida.');
    if (!Array.isArray(values) || values.length > ARCHIVE_LIMITS.batch) throw new ArchiveError('invalid', 'Guarda hasta 500 mensajes por transacción.');
    if (visibleWindow !== undefined && (!Array.isArray(visibleWindow) || visibleWindow.length > 120)) throw new ArchiveError('invalid', 'La ventana visible admite hasta 120 mensajes.');
    const windowKeys = visibleWindow?.map(value => keyOf(archiveEntry(value, scope)));
    const safe = [...new Map(values.map(value => { const entry = archiveEntry(value, scope); return [keyOf(entry), entry] as const; })).values()];
    return access('readwrite', (tx, done, fail) => {
      const entries = tx.objectStore('entries'); const metas = tx.objectStore('metadata');
      read(metas.get('state'), value => {
        const meta = metadata(value); let inserted = 0; let updated = 0; let unchanged = 0; let offset = 0;
        const next = () => {
          const candidate = safe[offset++];
          if (!candidate) {
            metas.put(meta, 'state');
            const complete = () => done({ ...stats(meta), inserted, updated, unchanged });
            if (!windowKeys) { complete(); return; }
            let index = 0;
            const verifyWindow = () => {
              const key = windowKeys[index++];
              if (key === undefined) { metas.put({ keys: windowKeys, savedAt: Date.now(), revision: snapshotRevision ?? 0 }, 'window'); complete(); return; }
              read(entries.get(key), raw => {
                if (raw === undefined) throw new ArchiveError('corrupt', 'La ventana contiene un mensaje que no fue archivado.');
                const visible = stored(raw);
                // Unchanged visible entries may not occur in this write batch.
                // Fence them at the snapshot revision in the same transaction.
                if (snapshotRevision !== undefined && snapshotRevision > visible.snapshotRevision) entries.put({ ...visible, snapshotRevision });
                verifyWindow();
              }, fail);
            };
            verifyWindow(); return;
          }
          read(entries.get(keyOf(candidate)), raw => {
            const previous = raw === undefined ? undefined : stored(raw);
            if (snapshotRevision !== undefined && previous && snapshotRevision < previous.snapshotRevision) throw new ArchiveError('invalid', 'Una revisión antigua no puede reemplazar un mensaje archivado más reciente.');
            if (previous?.replyTo && candidate.replyTo !== previous.replyTo) throw new ArchiveError('invalid', 'El vínculo de una respuesta archivada cambió. Se conserva el original.');
            // Arrival order and original event time stay stable when a stream completes later.
            const entry = previous ? { ...candidate, at: previous.at } : candidate;
            const bytes = byteLength(JSON.stringify(entry));
            const identical = previous && JSON.stringify(archiveEntry(previous, previous.scope)) === JSON.stringify(entry);
            if (identical) {
              // The content may be unchanged while the durable snapshot advances.
              // Fence that revision too, otherwise a competing writer with the
              // same revision could later change an apparently older record.
              if (snapshotRevision !== undefined && snapshotRevision > previous.snapshotRevision) entries.put({ ...previous, snapshotRevision });
              unchanged++; next(); return;
            }
            if (snapshotRevision !== undefined && previous && snapshotRevision === previous.snapshotRevision) throw new ArchiveError('invalid', 'La revisión archivada ya contiene otro mensaje.');
            const count = meta.entries + (previous ? 0 : 1); const total = meta.bytes - (previous?.bytes ?? 0) + bytes;
            if (count > maximumEntries || total > maximumBytes) throw new ArchiveError('quota', `El archivo alcanzó su cuota (${maximumEntries} mensajes / ${maximumBytes} bytes). Exporta el historial y conserva los mensajes pendientes; no se borró nada automáticamente.`);
            const now = Date.now(); const record: ArchiveRecord = { ...entry, key: keyOf(entry), sequence: previous?.sequence ?? meta.nextSequence++, storedAt: previous?.storedAt ?? now, updatedAt: now, bytes, snapshotRevision: snapshotRevision ?? previous?.snapshotRevision ?? 0 };
            entries.put(record); meta.entries = count; meta.bytes = total; if (previous) updated++; else inserted++; next();
          }, fail);
        };
        if (snapshotRevision === undefined) next();
        else read(metas.get('window'), window => {
          if (window !== undefined && (!object(window) || (window.revision !== undefined && !natural(window.revision)))) throw new ArchiveError('corrupt', 'La revisión de la ventana no es válida.');
          if (object(window) && snapshotRevision < Number(window.revision ?? 0)) throw new ArchiveError('invalid', 'La ventana archivada ya tiene una revisión más reciente.');
          if (object(window) && windowKeys && snapshotRevision === Number(window.revision ?? 0) && JSON.stringify(window.keys) !== JSON.stringify(windowKeys)) throw new ArchiveError('invalid', 'La revisión archivada ya contiene otra ventana.');
          next();
        }, fail);
      }, fail);
    });
  }
  async function page(options: ArchiveQuery = {}, query?: string): Promise<ArchivePage> {
    const limit = options.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > ARCHIVE_LIMITS.page || (options.scope !== undefined && !validScope(options.scope)) || (options.engine !== undefined && !['iphone','gentle'].includes(options.engine)) || (options.roles !== undefined && (!Array.isArray(options.roles) || options.roles.length > 3 || options.roles.some(role => !['user','assistant','notice'].includes(role))))) throw new ArchiveError('invalid', 'Filtros o tamaño de página inválidos.');
    const terms = query === undefined ? undefined : memoryTerms(query);
    const filter = JSON.stringify({ engine: options.engine, scope: options.scope, roles: options.roles ? [...new Set(options.roles)].sort() : undefined, terms });
    const boundary = options.cursor === undefined ? undefined : decoded(options.cursor, filter);
    return access('readonly', (tx, done, fail) => {
      const range = boundary ? IDBKeyRange.upperBound([boundary.at, boundary.sequence], true) : undefined;
      const request = tx.objectStore('entries').index('time').openCursor(range, 'prev'); const entries: ArchiveRecord[] = []; let scanned = 0; let last: Cursor | undefined;
      request.onerror = () => fail(request.error);
      request.onsuccess = () => {
        try {
          const cursor = request.result;
          if (!cursor || entries.length >= limit || scanned >= ARCHIVE_LIMITS.scan) { done({ entries: entries.reverse(), scanned, hasMore: Boolean(cursor), ...(cursor && last ? { cursor: encoded(last) } : {}) }); return; }
          const entry = stored(cursor.value); scanned++; last = { at: entry.at, sequence: entry.sequence, filter };
          if ((!options.scope || entry.scope === options.scope) && (!options.engine || entry.engine === options.engine) && (!options.roles || options.roles.includes(entry.role)) && (!terms || matchesMemory(entry, terms))) entries.push(entry);
          cursor.continue();
        } catch (error) { fail(error); }
      };
    });
  }
  /** Both stores carry a monotonic revision: either commit may succeed alone. */
  function restoreState(fallback: Pick<Conversation, 'entries' | 'revision'>): Promise<{ entries: ChatEntry[]; preserved: ChatEntry[]; revision: number }> {
    if (!Array.isArray(fallback.entries) || fallback.entries.length > 120 || (fallback.revision !== undefined && !natural(fallback.revision))) return Promise.reject(new ArchiveError('invalid', 'Ventana de recuperación inválida.'));
    const safe = fallback.entries.map(entry => archiveEntry(entry));
    const fallbackRevision = fallback.revision ?? 0;
    return access('readonly', (tx, done, fail) => read(tx.objectStore('metadata').get('window'), value => {
      let archivedKeys: string[] | undefined, archivedRevision = 0;
      if (value !== undefined) {
        if (!object(value) || !natural(value.savedAt) || !Array.isArray(value.keys) || value.keys.length > 120 || value.keys.some(key => typeof key !== 'string' || key.length > 8192) || (value.revision !== undefined && !natural(value.revision))) throw new ArchiveError('corrupt', 'La ventana archivada no es válida.');
        archivedKeys = value.keys as string[]; archivedRevision = Number(value.revision ?? 0);
      }
      // A newer secondary snapshot exists after an archive quota failure. A newer
      // archive window exists after a crash before the secondary snapshot commit.
      const keys = archivedKeys && archivedRevision >= fallbackRevision ? [...archivedKeys] : safe.map(keyOf);
      const fallbacks = new Map(safe.map(entry => [keyOf(entry), entry]));
      const result: ChatEntry[] = []; let index = 0; let revision = Math.max(fallbackRevision, archivedRevision);
      const next = () => {
        const key = keys[index++]; if (key === undefined) { done({ entries: result.slice(-120), preserved: result, revision }); return; }
        read(tx.objectStore('entries').get(key), raw => {
          const archived = raw === undefined ? undefined : stored(raw), legacy = fallbacks.get(key);
          const recordRevision = archived ? Math.max(archived.snapshotRevision, archivedKeys?.includes(key) ? archivedRevision : 0) : -1;
          revision = Math.max(revision, recordRevision);
          const entry = legacy && fallbackRevision > recordRevision ? legacy : archived ?? legacy;
          if (!entry) throw new ArchiveError('corrupt', 'La ventana archivada perdió un mensaje; se conserva la copia visible.');
          const prior = fallback.entries.find(candidate => candidate.id === entry.id && candidate.engine === entry.engine && candidate.text === entry.text);
          result.push({ id: entry.id, engine: entry.engine, role: entry.role, text: entry.text, at: entry.at,
            ...(entry.localCancelled ? { localCancelled: true } : {}),
            ...(entry.replyTo ? { replyTo: entry.replyTo } : {}),
            ...(typeof prior?.transportText === 'string' && prior.transportText.length <= 32000 ? { transportText: prior.transportText } : {}),
            state: entry.state === 'pending' ? 'interrupted' : entry.state,
            ...(entry.activities ? { activities: entry.activities.map(activity => ({ ...activity, status: activity.status === 'running' ? 'failed' as const : activity.status })) } : {}) });
          next();
        }, fail);
      };
      // Revision ordering cannot discard a legacy message that was never archived.
      // Capture absent IDs first; expose all preserved copies separately before
      // pruning the visible 120, so migration cannot silently drop an orphan.
      const candidates = safe.map(keyOf).filter(key => !keys.includes(key));
      const orphans: string[] = []; let candidateIndex = 0;
      const recoverOrphans = () => {
        const key = candidates[candidateIndex++];
        if (key === undefined) { keys.unshift(...orphans); next(); return; }
        read(tx.objectStore('entries').get(key), raw => { if (raw === undefined) orphans.push(key); else stored(raw); recoverOrphans(); }, fail);
      };
      recoverOrphans();
    }, fail));
  }
  return {
    upsert, restoreState,
    restoreWindow: async (entries: readonly ChatEntry[]) => (await restoreState({ entries: [...entries] })).entries,
    page: (options?: ArchiveQuery) => page(options),
    search: (query: string, options?: ArchiveQuery) => page(options, query),
    stats: () => access<ArchiveStats>('readonly', (tx, done, fail) => read(tx.objectStore('metadata').get('state'), value => done(stats(metadata(value))), fail)),
    load: (key: string) => {
      if (typeof key !== 'string' || key.length > 8192) return Promise.reject(new ArchiveError('invalid', 'Referencia de archivo inválida.'));
      return access<ArchiveRecord | undefined>('readonly', (tx, done, fail) => read(tx.objectStore('entries').get(key), value => done(value === undefined ? undefined : stored(value)), fail));
    },
    /** One readonly transaction exports a coherent snapshot. No automatic deletion follows. */
    export: () => access<{ blob: Blob; stats: ArchiveStats }>('readonly', (tx, done, fail) => read(tx.objectStore('metadata').get('state'), value => {
      const meta = stats(metadata(value)); const chunks: string[] = [JSON.stringify({ schema: 'capri-conversation-archive/v1', exportedAt: Date.now(), entries: meta.entries, contentBytes: meta.bytes }) + '\n'];
      const cursor = tx.objectStore('entries').index('time').openCursor(); let count = 0;
      cursor.onerror = () => fail(cursor.error);
      cursor.onsuccess = () => { try { if (!cursor.result) { if (count !== meta.entries) throw new ArchiveError('corrupt', 'El inventario del archivo no coincide.'); done({ blob: new Blob(chunks, { type: 'application/x-ndjson' }), stats: meta }); return; } chunks.push(JSON.stringify(stored(cursor.result.value)) + '\n'); count++; cursor.result.continue(); } catch (error) { fail(error); } };
    }, fail)),
  };
}

export const conversationArchive = createConversationArchive();
/** Confirm archival writes before releasing any queued copy of a pruned visible message. */
export const archiveConversation = conversationArchive.upsert;
export const loadArchivedEntry = conversationArchive.load;
export const pageConversationArchive = conversationArchive.page;
export const searchConversationArchive = conversationArchive.search;
export const exportConversationArchive = conversationArchive.export;
