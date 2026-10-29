import { localIdentifier } from './local-identifiers.ts';
import type { Proposal } from './minute-proposals.ts';
import { blobSHA256 } from './blob-sha256.ts';
import { Hash } from 'fast-sha256';
import { canonicalWorkManifest, parseWorkSyncManifest, parseWorkResult, type WorkSyncManifest, type WorkSyncReceipt, type WorkResult } from '@gentle-dot/protocol';
export type WorkTransfer = { host: string; transferId: string; manifest: WorkSyncManifest; manifestHash: string; receipt?: WorkSyncReceipt };
export type WorkStatus = 'local' | 'prepared' | 'approved' | 'sending' | 'sent' | 'uncertain' | 'failed';
export type MinuteApproval = { kind: 'result' | 'version'; revision: number; approvedAt: number; snapshot: string; versionId?: string };
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
  transfer?: WorkTransfer;
  result?: WorkResult;
  /** Previous host drafts, oldest first. Each remains a draft requiring review. */
  resultHistory?: WorkResult[];
  /** Local human approval only; never authorizes a transfer or an external action. */
  minuteApproval?: MinuteApproval;
  minuteProposals?: Proposal[];
  /** Only a held review/execution lease may release this barrier. */
  minuteActionLock?: { proposalId: string; leaseId: string };
  source?: { id: string; hash: string };
};
export type WorkInput = {
  title: string;
  kind: WorkItem['kind'];
  instruction: string;
  files?: File[];
};
type ChunkFile = { id: string; name: string; type: string; size: number; sha256: string };
type ChunkPointer = { kind: 'chunks-v1'; sourceId: string; fileId: string; size: number; sha256: string };
type ChunkStage = { kind: 'chunk-stage-v1'; size: number; sha256: string; published: boolean; refs?: number };
const CHUNK_BYTES = 256 * 1024;
function chunkReferences(stage: ChunkStage, pointer: Pick<ChunkPointer, 'size' | 'sha256'>): number {
  if (stage.kind !== 'chunk-stage-v1' || stage.size !== pointer.size || stage.sha256 !== pointer.sha256 || !stage.published || !Number.isSafeInteger(stage.refs) || stage.refs! < 1 || stage.refs! > WORK_LIMITS.items * WORK_LIMITS.files) throw new Error('No se pueden verificar las referencias del archivo. Los datos se conservan.');
  return stage.refs!;
}
function isChunkPointer(value: unknown): value is ChunkPointer {
  const p = value as Partial<ChunkPointer> | null;
  return !!p && p.kind === 'chunks-v1' && typeof p.sourceId === 'string' && /^(?:share|document):[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(p.sourceId)
    && typeof p.fileId === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(p.fileId)
    && Number.isSafeInteger(p.size) && p.size! > 0 && p.size! <= WORK_LIMITS.fileBytes
    && typeof p.sha256 === 'string' && /^[a-f0-9]{64}$/.test(p.sha256);
}

const DATABASE = 'capri-ios-work-inbox';
const ITEMS = 'items';
const FILES = 'files';
const TIMEOUT_MS = 8000;
const MIB = 1024 * 1024;
export const WORK_LIMITS = Object.freeze({
  items: 100, files: 10, fileBytes: 25 * MIB, totalFileBytes: 50 * MIB,
  title: 120, instruction: 8000, versions: 100, versionText: 200_000, resultHistory: 20,
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
  if (files.some(file => !(file instanceof File))) throw new Error('Adjunta archivos válidos.');
  validateWorkMetadata(files);
}
function validateWorkMetadata(files: readonly { name: string; type: string; size: number }[]): void {
  if (!Array.isArray(files) || files.length > WORK_LIMITS.files) throw new Error('Máximo 10 archivos por trabajo.');
  let total = 0;
  for (const file of files) {
    if (typeof file.name !== 'string' || !file.name.trim() || file.name.length > 255 || /[\u0000-\u001f\u007f]/.test(file.name)) {
      throw new Error('El nombre del archivo no es válido.');
    }
    const mime = typeof file.type === 'string' ? file.type.split(';')[0]?.trim() ?? '' : '';
    if (!/^(audio|text|image)\/[a-z0-9.+_-]+$/.test(mime) && !['application/pdf', 'application/json', 'application/x-subrip'].includes(mime)) {
      throw new Error('Adjunta audio, texto, PDF o imágenes con un tipo de archivo reconocido.');
    }
    if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > WORK_LIMITS.fileBytes) throw new Error('Cada archivo debe contener datos y pesar hasta 25 MiB.');
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
    ...(item.transfer ? { transfer: structuredClone(item.transfer) } : {}),
    ...(item.result ? { result: structuredClone(item.result) } : {}),
    ...(item.resultHistory ? { resultHistory: structuredClone(item.resultHistory) } : {}),
    ...(item.minuteProposals ? { minuteProposals: structuredClone(item.minuteProposals) } : {}),
    ...(item.source ? { source: { id: item.source.id, hash: item.source.hash } } : {}),
  };
}

/** A locally approved minute must still equal the exact reviewed content and revision. */
export function validMinuteApproval(item: WorkItem): boolean {
  const approval = item.minuteApproval;
  if (!approval || item.kind !== 'meeting' || approval.revision !== item.revision || !Number.isSafeInteger(approval.approvedAt) || approval.approvedAt < 0 || typeof approval.snapshot !== 'string') return false;
  if (approval.kind === 'result') {
    const result = item.result && parseWorkResult(item.result);
    return item.status === 'sent' && !!item.transfer?.receipt && !!result && approval.versionId === undefined && approval.snapshot === JSON.stringify(result);
  }
  if (approval.kind === 'version') {
    const version = item.versions.at(-1);
    return item.status !== 'sent' && item.status !== 'sending' && !!parseWorkResult(item.result) && !!version && approval.versionId === version.id && approval.snapshot === version.text;
  }
  return false;
}

export function approveMinuteItem(item: WorkItem, kind: MinuteApproval['kind'], versionId?: string, now = Date.now()): WorkItem {
  if (item.kind !== 'meeting' || !Number.isSafeInteger(now) || now < 0) throw new Error('No se puede aprobar esta minuta.');
  let snapshot: string;
  if (kind === 'result') {
    const result = item.result && parseWorkResult(item.result);
    if (item.status !== 'sent' || !item.transfer?.receipt || !result || versionId !== undefined) throw new Error('La minuta ya no está disponible para revisión.');
    snapshot = JSON.stringify(result);
  } else if (kind === 'version') {
    const version = item.versions.at(-1);
    if (item.status === 'sent' || item.status === 'sending' || !parseWorkResult(item.result) || !version || version.id !== versionId) throw new Error('La versión ya no está disponible para revisión.');
    snapshot = version.text;
  } else throw new Error('No se puede aprobar esta minuta.');
  const next = nextRevision(item, now);
  next.minuteApproval = { kind, revision: next.revision, approvedAt: now, snapshot, ...(versionId ? { versionId } : {}) };
  return next;
}

export function assertNoMinuteActionLock(item: WorkItem): void {
  if (item.minuteActionLock) throw new Error('Hay una acción de la minuta en revisión o sin confirmación. Conserva el trabajo y revisa su estado antes de modificarlo.');
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
  if (nextStatus === 'local' || nextStatus === 'prepared') delete next.transfer;
  return next;
}

export function reviseWorkItem(item: WorkItem, instruction: string, now = Date.now()): WorkItem {
  assertEditable(item);
  const next = nextRevision(item, now);
  next.instruction = textWithin(instruction, WORK_LIMITS.instruction, 'Instrucción');
  next.status = 'local';
  delete next.transfer;
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
  delete next.transfer;
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
function whenImportActive(transaction: IDBTransaction, sourceId: string, generation: number, run: () => void, fail: (error: unknown) => void): void {
  whenReady<unknown>(transaction.objectStore(FILES).get(['cancel', sourceId]), cancelled => {
    if (cancelled !== undefined) throw new Error('La importación está cancelada. El original se conserva.');
    whenReady<unknown>(transaction.objectStore(FILES).get(['generation', sourceId]), current => {
      if (generationValue(current) !== generation) throw new Error('La importación anterior fue cancelada. El original se conserva.');
      run();
    }, fail);
  }, fail);
}
function generationValue(value: unknown): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) >= Number.MAX_SAFE_INTEGER) throw new Error('No se puede verificar la importación pendiente. El original se conserva.');
  return value as number;
}
function importSourceId(value: string): string {
  if (!/^(?:share|document):[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)) throw new Error('El identificador de la importación no es válido.');
  return value.toLowerCase();
}
/** Verify reference counts against actual stored pointers before reclaiming bytes. */
function verifyChunkReferences(tx: IDBTransaction, target: ChunkPointer, expected: number, done: () => void, fail: (error: unknown) => void): void {
  const files = tx.objectStore(FILES); let references = 0;
  const request = files.openKeyCursor();
  request.onerror = () => fail(request.error);
  request.onsuccess = () => {
    try {
      const cursor = request.result;
      if (!cursor) {
        if (references !== expected) throw new Error('Las referencias del archivo no coinciden. Se conservan los datos.');
        done(); return;
      }
      const key = cursor.key;
      if (!Array.isArray(key) || key.length !== 2 || key[0] === 'cancel' || key[0] === 'generation') { cursor.continue(); return; }
      whenReady<Blob | ChunkPointer | undefined>(files.get(key), value => {
        if (value !== undefined && !(value instanceof Blob) && !isChunkPointer(value)) throw new Error('No se pueden verificar las referencias del archivo. Se conservan los datos.');
        if (isChunkPointer(value) && value.sourceId === target.sourceId && value.fileId === target.fileId) {
          if (value.size !== target.size || value.sha256 !== target.sha256) throw new Error('Las referencias del archivo son incompatibles. Se conservan los datos.');
          references++;
        }
        cursor.continue();
      }, fail);
    } catch (error) { fail(error); }
  };
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
      assertNoMinuteActionLock(item);
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

export function readWork(id: string): Promise<WorkItem> {
  return transact('readonly', (transaction, result, fail) => {
    whenReady<WorkItem | undefined>(transaction.objectStore(ITEMS).get(id), value => result(requireItem(value)), fail);
  });
}

/** Freeze the approved bytes/revision before the first network operation. */
export function beginWorkTransfer(id: string, expectedRevision: number, transfer: WorkTransfer): Promise<WorkItem> {
  return updateWork(id, expectedRevision, item => {
    if (item.status !== 'approved') throw new Error('Revisa y aprueba esta versión antes de transferirla.');
    const manifest = parseWorkSyncManifest(transfer.manifest);
    if (!manifest || manifest.workId !== item.id || manifest.revision !== item.revision || manifest.title !== item.title || manifest.instruction !== item.instruction || manifest.kind !== item.kind || !/^[a-f0-9]{64}$/.test(transfer.manifestHash) || !/^[a-zA-Z0-9_-]{1,128}$/.test(transfer.transferId) || !transfer.host || transfer.host.length > 500) throw new Error('La transferencia no corresponde a la versión aprobada.');
    const next = transitionWorkItem(item, 'sending');
    next.transfer = { host: transfer.host, transferId: transfer.transferId, manifest: JSON.parse(canonicalWorkManifest(manifest)), manifestHash: transfer.manifestHash };
    return next;
  });
}

/** A late reply can settle only its immutable transfer, never a newly edited or retried item. */
export async function settleWorkTransfer(id: string, transferId: string, outcome: WorkSyncReceipt | string): Promise<WorkItem> {
  const current = await readWork(id);
  return updateWork(id, current.revision, item => {
    const transfer = item.transfer;
    if (!transfer || transfer.transferId !== transferId || !['sending', 'uncertain', 'sent'].includes(item.status)) throw new Error('La confirmación pertenece a otra revisión del trabajo.');
    if (item.status === 'sent') return item;
    const next = nextRevision(item, Date.now());
    if (typeof outcome === 'string') { next.status = 'uncertain'; next.error = outcome.slice(0, 500); return next; }
    if (outcome.transferId !== transferId || outcome.workId !== item.id || outcome.revision !== transfer.manifest.revision || outcome.manifestHash !== transfer.manifestHash || !Number.isSafeInteger(outcome.committedAt) || outcome.committedAt < 0) throw new Error('La confirmación del host no coincide con el contenido aprobado.');
    next.status = 'sent'; next.transfer!.receipt = { ...outcome }; return next;
  });
}

/** Receiving a draft is not approving its contents or any suggested external action. */
export async function saveWorkResult(id: string, transferId: string, value: WorkResult): Promise<WorkItem> {
  const result = parseWorkResult(value); if (!result) throw new Error('La minuta recibida no es válida.');
  // Defense in depth if a future protocol parser changes its normalization.
  if (value.evidence.some(e => (e.startMs === undefined) !== (e.endMs === undefined)
    || (e.startMs !== undefined && e.endMs !== undefined && e.endMs <= e.startMs))) {
    throw new Error('La evidencia contiene un intervalo temporal incompleto o inválido.');
  }
  const current = await readWork(id);
  return updateWork(id, current.revision, item => {
    if (item.status !== 'sent' || !item.transfer?.receipt || item.transfer.transferId !== transferId || item.transfer.manifestHash !== result.manifestHash) throw new Error('La minuta no corresponde a esta transferencia confirmada.');
    for (const evidence of result.evidence) {
      const file = item.transfer.manifest.files.find(candidate => candidate.id === evidence.fileId && candidate.role === 'attachment');
      const textSource = file && (file.mime.startsWith('text/') || file.mime === 'application/x-subrip' || /\.(?:srt|vtt)$/i.test(file.name));
      if (!file || (evidence.source === 'desktop-transcriber' ? !file.mime.startsWith('audio/') : !textSource)) {
        throw new Error('La evidencia no corresponde a un archivo de origen confirmado para esta reunión.');
      }
    }
    if (item.result && JSON.stringify(item.result) === JSON.stringify(result)) return item;
    // Older installations have no resultHistory. Retain the prior draft before
    // replacing it; if the bounded history is full, preserve every existing copy.
    const history = item.resultHistory ?? [];
    if (!Array.isArray(history) || history.length > WORK_LIMITS.resultHistory || history.some(value => !parseWorkResult(value)) || (item.result && !parseWorkResult(item.result))) throw new Error('No se pudo verificar el historial de minutas. Se conservan los datos originales.');
    if (item.result && history.length >= WORK_LIMITS.resultHistory) throw new Error('Este trabajo alcanzó el límite de borradores. Conserva las versiones antes de generar otra.');
    const next = nextRevision(item, Date.now());
    if (item.result) next.resultHistory = [...history, structuredClone(item.result)];
    next.result = result; return next;
  });
}

/** A correction starts a new local revision, retaining the source receipt/evidence in the draft text. */
export async function createWorkFromResult(id: string, expectedRevision: number): Promise<WorkItem> {
  return transact('readwrite', (transaction, result, fail) => {
    const store = transaction.objectStore(ITEMS);
    whenReady<WorkItem | undefined>(store.get(id), value => {
      const source = requireItem(value); assertWorkRevision(source, expectedRevision);
      if (!source.result || !source.transfer?.receipt) throw new Error('Primero recupera la minuta del host.');
      whenReady(store.count(), count => {
        if (count >= WORK_LIMITS.items) throw new Error('La bandeja admite 100 trabajos. Elimina uno antes de crear otro.');
        const now = Date.now(); const nextId = localIdentifier();
        const draft = JSON.stringify({ sourceWorkId: id, receipt: source.transfer!.receipt, result: source.result }, null, 2);
        if (draft.length > WORK_LIMITS.versionText) throw new Error('La minuta supera el límite de una versión editable. Conserva el original y prepara una corrección separada.');
        const next: WorkItem = { id: nextId, title: source.title, kind: source.kind, instruction: source.instruction, createdAt: now, updatedAt: now, revision: 1, status: 'local', files: source.files.map(file => ({ ...file })), versions: [{ id: localIdentifier(), text: draft, createdAt: now }], result: structuredClone(source.result) };
        let pending = source.files.length;
        const finish = () => { store.add(next); result(next); };
        if (!pending) { finish(); return; }
        for (const file of source.files) whenReady<Blob | ChunkPointer | undefined>(transaction.objectStore(FILES).get([id, file.id]), blob => {
          if (!(blob instanceof Blob) && !isChunkPointer(blob) || blob.size !== file.size) throw new Error('Falta un adjunto original para conservar la trazabilidad.');
          const files = transaction.objectStore(FILES);
          const copy = () => { files.add(blob, [nextId, file.id]); if (--pending === 0) finish(); };
          if (isChunkPointer(blob)) {
            const key = ['stage', blob.sourceId, blob.fileId];
            whenReady<ChunkStage | undefined>(files.get(key), stage => {
              if (!stage) throw new Error('Falta el registro del archivo. Se conserva el original.');
              files.put({ ...stage, refs: chunkReferences(stage, blob) + 1 }, key); copy();
            }, fail);
          } else copy();
        }, fail);
      }, fail);
    }, fail);
  });
}

async function insertWork(input: WorkInput, source?: WorkItem['source']): Promise<WorkItem> {
  const safe = validateWorkInput(input);
  const now = Date.now();
  const item: WorkItem = {
    id: localIdentifier(), title: safe.title, kind: safe.kind, instruction: safe.instruction,
    createdAt: now, updatedAt: now, status: 'local', revision: 1,
    files: safe.files.map(file => ({ id: localIdentifier(), name: file.name, type: file.type, size: file.size })),
    versions: [],
    ...(source ? { source } : {}),
  };
  return transact('readwrite', (transaction, result, fail) => {
    const store = transaction.objectStore(ITEMS);
    whenReady<WorkItem[]>(store.getAll(), items => {
      const existing = source ? items.find(item => item.source?.id === source.id) : undefined;
      if (existing) {
        if (existing.source!.hash !== source!.hash) throw new Error('El mismo identificador de importación contiene datos diferentes. Conserva ambos originales antes de reintentar.');
        result(existing); return;
      }
      if (items.length >= WORK_LIMITS.items) throw new Error('La bandeja admite 100 trabajos. Elimina uno antes de crear otro.');
      store.add(item);
      for (let i = 0; i < safe.files.length; i++) {
        transaction.objectStore(FILES).add(safe.files[i], [item.id, item.files[i]!.id]);
      }
      result(item);
    }, fail);
  });
}

export function createWork(input: WorkInput): Promise<WorkItem> { return insertWork(input); }

/** Share Extension acknowledgement must wait for this promise's durable IDB transaction. */
export async function createImportedWork(sourceId: string, input: WorkInput): Promise<WorkItem> {
  if (!/^(?:share|document):[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(sourceId)) throw new Error('El identificador de la importación no es válido.');
  const safe = validateWorkInput(input);
  const digest = async (bytes: ArrayBuffer) => {
    if (!globalThis.crypto?.subtle) return (await import('./device-bridge.ts')).nativeSHA256Bytes(new Uint8Array(bytes));
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  };
  const files = [];
  for (const file of safe.files) files.push({ name: file.name, type: file.type, size: file.size, hash: await blobSHA256(file) });
  const content = JSON.stringify({ title: safe.title, kind: safe.kind, instruction: safe.instruction, files });
  const hash = await digest(new TextEncoder().encode(content).buffer);
  return insertWork(safe, { id: sourceId.toLowerCase(), hash });
}

/** Persist native imports in bounded chunks; the native original remains until publication succeeds. */
export async function createStreamedImportedWork(sourceId: string, input: {
  title: string; kind: WorkItem['kind']; instruction: string; files: ChunkFile[];
}, read: (file: ChunkFile, offset: number, length: number) => Promise<Uint8Array>, signal?: AbortSignal): Promise<WorkItem> {
  sourceId = importSourceId(sourceId);
  if (input.kind !== 'task' && input.kind !== 'meeting') throw new Error('Tipo de trabajo no válido.');
  const title = textWithin(input.title, WORK_LIMITS.title, 'Título', true);
  const instruction = textWithin(input.instruction, WORK_LIMITS.instruction, 'Instrucción');
  if (!Array.isArray(input.files)) throw new Error('Los archivos compartidos no son válidos.');
  const files = input.files.map(file => Object.freeze({ id: file.id, name: file.name, type: file.type, size: file.size, sha256: file.sha256 }));
  const kind = input.kind;
  validateWorkMetadata(files);
  if (!files.length || new Set(files.map(file => file.id)).size !== files.length || files.some(file => !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(file.id) || !/^[a-f0-9]{64}$/.test(file.sha256))) throw new Error('Los archivos compartidos no son válidos.');
  const digest = new Hash();
  const content = JSON.stringify({ title, kind, instruction, files: files.map(f => ({ name: f.name, type: f.type, size: f.size, hash: f.sha256 })) });
  const sourceHash = Array.from(digest.update(new TextEncoder().encode(content)).digest(), byte => byte.toString(16).padStart(2, '0')).join(''); digest.clean();
  const generation = await transact<number>('readonly', (tx, done, fail) => {
    const store = tx.objectStore(FILES);
    whenReady<unknown>(store.get(['cancel', sourceId]), cancelled => {
      if (cancelled !== undefined) throw new Error('La importación está cancelada. El original se conserva.');
      whenReady<unknown>(store.get(['generation', sourceId]), value => done(generationValue(value)), fail);
    }, fail);
  });
  for (const file of files) {
    signal?.throwIfAborted();
    const stageKey = ['stage', sourceId, file.id];
    await transact('readwrite', (tx, done, fail) => {
      const store = tx.objectStore(FILES);
      whenImportActive(tx, sourceId, generation, () => whenReady<ChunkStage | undefined>(store.get(stageKey), stage => {
        if (stage && (stage.kind !== 'chunk-stage-v1' || stage.size !== file.size || stage.sha256 !== file.sha256)) throw new Error('La importación pendiente contiene otros datos. Se conserva el original.');
        if (!stage) store.add({ kind: 'chunk-stage-v1', size: file.size, sha256: file.sha256, published: false } satisfies ChunkStage, stageKey);
        done(undefined);
      }, fail), fail);
    });
    const hash = new Hash();
    try {
      for (let offset = 0; offset < file.size; offset += CHUNK_BYTES) {
        signal?.throwIfAborted(); const length = Math.min(CHUNK_BYTES, file.size - offset);
        const bytes = await read(file, offset, length); signal?.throwIfAborted();
        if (!(bytes instanceof Uint8Array) || bytes.byteLength !== length) throw new Error('El archivo compartido llegó incompleto. Se conserva el original.');
        hash.update(bytes);
        await transact('readwrite', (tx, done, fail) => {
          const store = tx.objectStore(FILES); const key = ['chunk', sourceId, file.id, offset];
          whenImportActive(tx, sourceId, generation, () => whenReady<ChunkStage | undefined>(store.get(stageKey), stage => {
            if (!stage || stage.kind !== 'chunk-stage-v1' || stage.size !== file.size || stage.sha256 !== file.sha256) throw new Error('La importación cambió. Se conserva el original.');
            whenReady<Uint8Array | undefined>(store.get(key), existing => {
              if (existing !== undefined) {
                if (!(existing instanceof Uint8Array) || existing.byteLength !== bytes.byteLength || existing.some((byte, index) => byte !== bytes[index])) throw new Error('Un fragmento guardado contiene otros datos. Se conserva el original.');
              } else {
                if (stage.published) throw new Error('Falta un fragmento publicado. Se conserva el original.');
                store.add(bytes, key);
              }
              done(undefined);
            }, fail);
          }, fail), fail);
        });
      }
      if (Array.from(hash.digest(), byte => byte.toString(16).padStart(2, '0')).join('') !== file.sha256) throw new Error('El adjunto no coincide con su huella. El original se conserva.');
    } finally { hash.clean(); }
  }
  signal?.throwIfAborted();
  const now = Date.now();
  const item: WorkItem = { id: localIdentifier(), title, kind, instruction, createdAt: now, updatedAt: now, status: 'local', revision: 1,
    files: files.map(file => ({ id: localIdentifier(), name: file.name, type: file.type, size: file.size })), versions: [], source: { id: sourceId, hash: sourceHash } };
  return transact('readwrite', (tx, done, fail) => {
    const items = tx.objectStore(ITEMS), fileStore = tx.objectStore(FILES);
    whenImportActive(tx, sourceId, generation, () => whenReady<WorkItem[]>(items.getAll(), existing => {
      const prior = existing.find(value => value.source?.id === sourceId);
      if (prior) { if (prior.source?.hash !== sourceHash) throw new Error('El mismo identificador de importación contiene datos diferentes. Conserva ambos originales antes de reintentar.'); done(prior); return; }
      if (existing.length >= WORK_LIMITS.items) throw new Error('La bandeja admite 100 trabajos. Elimina uno antes de crear otro.');
      let pending = files.length;
      files.forEach((file, index) => whenReady<ChunkStage | undefined>(fileStore.get(['stage', sourceId, file.id]), stage => {
        if (!stage || stage.kind !== 'chunk-stage-v1' || stage.size !== file.size || stage.sha256 !== file.sha256) throw new Error('La importación cambió. Se conserva el original.');
        // Validate the actual persisted chunks inside this publication transaction,
        // so a partial write or corruption cannot cause native acknowledgement.
        const hash = new Hash();
        const verify = (offset: number) => {
          if (offset === file.size) {
            const actual = Array.from(hash.digest(), byte => byte.toString(16).padStart(2, '0')).join(''); hash.clean();
            if (actual !== file.sha256) throw new Error('La copia local no coincide con su huella. Se conserva el original.');
            const refs = stage.published ? chunkReferences(stage, { size: file.size, sha256: file.sha256 }) : 0;
            fileStore.put({ ...stage, published: true, refs: refs + 1 }, ['stage', sourceId, file.id]);
            fileStore.add({ kind: 'chunks-v1', sourceId, fileId: file.id, size: file.size, sha256: file.sha256 } satisfies ChunkPointer, [item.id, item.files[index]!.id]);
            if (--pending === 0) { items.add(item); done(item); }
            return;
          }
          whenReady<Uint8Array | undefined>(fileStore.get(['chunk', sourceId, file.id, offset]), chunk => {
            const length = Math.min(CHUNK_BYTES, file.size - offset);
            if (!(chunk instanceof Uint8Array) || chunk.length !== length) throw new Error('Falta un fragmento local. Se conserva el original.');
            hash.update(chunk); verify(offset + length);
          }, fail);
        };
        verify(0);
      }, fail));
    }, fail), fail);
  });
}

/** Explicitly cancel incomplete staging; published work and native source are untouched. */
export function cancelStreamedImport(sourceId: string): Promise<void> {
  sourceId = importSourceId(sourceId);
  return transact('readwrite', (tx, done, fail) => {
    const files = tx.objectStore(FILES);
    whenReady<unknown>(files.get(['generation', sourceId]), value => {
      files.put(generationValue(value) + 1, ['generation', sourceId]);
      const stages = files.openCursor(IDBKeyRange.bound(['stage', sourceId], ['stage', sourceId, []]));
      files.put(true, ['cancel', sourceId]);
      stages.onerror = () => fail(stages.error);
      stages.onsuccess = () => {
      try {
        const cursor = stages.result;
        if (!cursor) { done(undefined); return; }
        const stage = cursor.value as ChunkStage; const key = cursor.key;
        if (!Array.isArray(key) || typeof key[2] !== 'string' || stage?.kind !== 'chunk-stage-v1' || stage.published !== false || !Number.isSafeInteger(stage.size) || stage.size <= 0 || stage.size > WORK_LIMITS.fileBytes) throw new Error('La importación ya fue publicada o no se puede verificar. Los datos se conservan.');
        files.delete(IDBKeyRange.bound(['chunk', sourceId, key[2], 0], ['chunk', sourceId, key[2], stage.size]));
        cursor.delete(); cursor.continue();
      } catch (error) { fail(error); }
      };
    }, fail);
  });
}
/** Only an explicit retry removes the cancellation fence; the native source must still exist. */
export function resumeStreamedImport(sourceId: string): Promise<void> {
  sourceId = importSourceId(sourceId);
  return transact('readwrite', (tx, done, fail) => {
    const files = tx.objectStore(FILES);
    whenReady<unknown>(files.get(['generation', sourceId]), value => {
      files.put(generationValue(value) + 1, ['generation', sourceId]); files.delete(['cancel', sourceId]); done(undefined);
    }, fail);
  });
}

async function readStoredFile(workId: string, fileId: string): Promise<Blob | ChunkPointer | undefined> {
  return transact('readonly', (transaction, result, fail) => {
    whenReady<Blob | ChunkPointer | undefined>(transaction.objectStore(FILES).get([workId, fileId]), blob => {
      if (blob !== undefined && !(blob instanceof Blob) && !isChunkPointer(blob)) throw new Error('El archivo local no es válido.');
      result(blob);
    }, fail);
  });
}
export async function readWorkFileSize(workId: string, fileId: string): Promise<number | undefined> {
  return (await readStoredFile(workId, fileId))?.size;
}
/** Bounded read for transfers. Old Blob records and new chunk references are supported. */
export async function readWorkFileSlice(workId: string, fileId: string, offset: number, length: number): Promise<Uint8Array> {
  const source = await readStoredFile(workId, fileId);
  if (!source || !Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || length > CHUNK_BYTES || offset + length > source.size) throw new Error('El rango del archivo local no es válido.');
  if (source instanceof Blob) return new Uint8Array(await source.slice(offset, offset + length).arrayBuffer());
  const output = new Uint8Array(length); let copied = 0;
  while (copied < length) {
    const position = offset + copied; const start = Math.floor(position / CHUNK_BYTES) * CHUNK_BYTES;
    const chunk = await transact<Uint8Array | undefined>('readonly', (tx, done, fail) => whenReady(tx.objectStore(FILES).get(['chunk', source.sourceId, source.fileId, start]), done, fail));
    const expected = Math.min(CHUNK_BYTES, source.size - start);
    if (!(chunk instanceof Uint8Array) || chunk.length !== expected) throw new Error('Falta un fragmento del archivo local. Se conserva la información restante.');
    const count = Math.min(length - copied, expected - (position - start));
    output.set(chunk.subarray(position - start, position - start + count), copied); copied += count;
  }
  return output;
}
export async function readWorkFile(workId: string, fileId: string): Promise<Blob | undefined> {
  const source = await readStoredFile(workId, fileId); if (!source || source instanceof Blob) return source;
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  for (let offset = 0; offset < source.size; offset += CHUNK_BYTES) chunks.push(await readWorkFileSlice(workId, fileId, offset, Math.min(CHUNK_BYTES, source.size - offset)) as Uint8Array<ArrayBuffer>);
  const blob = new Blob(chunks);
  if (await blobSHA256(blob) !== source.sha256) throw new Error('El archivo local no coincide con su huella. Se conserva la información restante.');
  return blob;
}

export function reviseWork(id: string, expectedRevision: number, instruction: string): Promise<WorkItem> {
  return updateWork(id, expectedRevision, item => reviseWorkItem(item, instruction));
}

/** Called only by the explicit human review control, with a compare-and-swap revision. */
export function approveMinute(id: string, expectedRevision: number, kind: MinuteApproval['kind'], versionId?: string): Promise<WorkItem> {
  return updateWork(id, expectedRevision, item => approveMinuteItem(item, kind, versionId));
}

export function addWorkVersion(id: string, expectedRevision: number, text: string): Promise<WorkItem> {
  return updateWork(id, expectedRevision, item => addWorkVersionItem(item, text, localIdentifier()));
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
      assertNoMinuteActionLock(item);
      if (item.status === 'sending') throw new Error('Resuelve el envío en curso antes de eliminar el trabajo.');
      const files = transaction.objectStore(FILES);
      let pending = item.files.length;
      const finish = () => { store.delete(id); result(undefined); };
      if (!pending) { finish(); return; }
      for (const file of item.files) whenReady<Blob | ChunkPointer | undefined>(files.get([id, file.id]), value => {
        if (!value || (!(value instanceof Blob) && !isChunkPointer(value)) || value.size !== file.size) throw new Error('No se puede verificar el adjunto. Se conservan los datos.');
        const removePointer = () => { files.delete([id, file.id]); if (--pending === 0) finish(); };
        if (isChunkPointer(value)) {
          const key = ['stage', value.sourceId, value.fileId];
          whenReady<ChunkStage | undefined>(files.get(key), stage => {
            if (!stage) throw new Error('No se puede verificar el archivo. Se conservan los datos.');
            const refs = chunkReferences(stage, value);
            verifyChunkReferences(transaction, value, refs, () => {
              if (refs === 1) {
                files.delete(IDBKeyRange.bound(['chunk', value.sourceId, value.fileId, 0], ['chunk', value.sourceId, value.fileId, value.size]));
                files.delete(key);
              } else files.put({ ...stage, refs: refs - 1 }, key);
              removePointer();
            }, fail);
          }, fail);
        } else removePointer();
      }, fail);
    }, fail);
  });
}
