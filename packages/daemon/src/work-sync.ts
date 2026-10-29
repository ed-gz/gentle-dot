import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readdir, rename, lstat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { canonicalWorkManifest, parseWorkSyncManifest, parseWorkSyncRequest, parseWorkResult, WORK_SYNC_LIMITS, type WorkSyncManifest, type WorkSyncReceipt, type WorkSyncReply, type WorkSyncRequest, type WorkProcessing, type WorkResult } from '@gentle-dot/protocol';

const digest = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
type RecordFile = { manifest: WorkSyncManifest; manifestHash: string; receipt?: WorkSyncReceipt; processing?: WorkProcessing };

/** Only fixed, non-sensitive messages may cross the processing boundary. */
export class WorkProcessorFailure extends Error {
  readonly reason: 'versions-too-large' | 'model-context-too-small';
  constructor(reason: WorkProcessorFailure['reason']) { super(reason === 'versions-too-large' ? 'Las versiones anteriores superan 200000 caracteres. Conserva los originales y crea otro trabajo con sólo las versiones necesarias.' : 'El contenido completo no cabe en el presupuesto conservador del modelo seleccionado. Conserva los originales y prepara trabajos más pequeños.'); this.reason = reason; }
}
export type WorkProcessor = (input: { directory: string; manifest: WorkSyncManifest; receipt: WorkSyncReceipt }, signal: AbortSignal) => Promise<WorkResult>;
class WorkStorageError extends Error {
  readonly code: 'invalid' | 'conflict' | 'quota' | 'missing';
  constructor(code: WorkStorageError['code'], message: string) { super(message); this.code = code; }
}
async function syncDirectory(path: string): Promise<void> { const fd = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { await fd.sync(); } finally { await fd.close(); } }
async function privateDirectory(path: string): Promise<void> {
  try { await mkdir(path, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const st = await lstat(path); if (!st.isDirectory() || st.isSymbolicLink() || (typeof process.getuid === 'function' && st.uid !== process.getuid())) throw new Error('Unsafe storage directory');
}
async function readPrivate(path: string): Promise<Buffer> {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { if (!(await fd.stat()).isFile()) throw new Error('Unsafe file'); return await fd.readFile(); } finally { await fd.close(); }
}
/** Verify an attachment with bounded memory, without following links or blocking on a FIFO. */
async function matchesPrivateFile(path: string, expectedBytes: number, expectedHash: string): Promise<boolean> {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await fd.stat();
    if (!before.isFile() || before.size !== expectedBytes) return false;
    const hash = createHash('sha256'); const buffer = Buffer.allocUnsafe(256 * 1024);
    let offset = 0;
    while (offset < expectedBytes) {
      const { bytesRead } = await fd.read(buffer, 0, Math.min(buffer.length, expectedBytes - offset), offset);
      if (!bytesRead) return false;
      hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
    }
    const after = await fd.stat(); const current = await lstat(path);
    return current.isFile() && !current.isSymbolicLink()
      && current.dev === before.dev && current.ino === before.ino
      && current.size === after.size && current.mtimeMs === after.mtimeMs && current.ctimeMs === after.ctimeMs
      && after.dev === before.dev && after.ino === before.ino && after.size === before.size
      && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs
      && hash.digest('hex') === expectedHash;
  } finally { await fd.close(); }
}
async function atomicRecord(directory: string, value: RecordFile): Promise<void> {
  const path = join(directory, `manifest-${randomUUID()}.tmp`);
  const fd = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await fd.writeFile(JSON.stringify(value)); await fd.sync(); } finally { await fd.close(); }
  try { await rename(path, join(directory, 'manifest.json')); await syncDirectory(directory); } finally { await unlink(path).catch(() => {}); }
}

/** Serialized durable store, independent of the live Pi session. No imported content executes. */
export class WorkSyncStore {
  private readonly directory: string;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly processor?: WorkProcessor;
  private readonly jobs = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private closed = false;
  constructor(directory: string, processor?: WorkProcessor) { this.directory = directory; this.processor = processor; }
  async close(): Promise<void> { this.closed = true; for (const job of this.jobs.values()) job.controller.abort(); await Promise.all([...this.jobs.values()].map(job => job.promise)); await this.queue; }
  handle(owner: string, request: WorkSyncRequest): Promise<WorkSyncReply> {
    // The namespace comes only from authenticated server state, never from a frame.
    const task = this.queue.then(async () => {
      const base = { type: 'work_sync_reply' as const, requestId: request.requestId, transferId: request.transferId };
      try {
        if (!parseWorkSyncRequest(request)) throw new WorkStorageError('invalid', 'Solicitud de transferencia no válida.');
        return { ...base, ...await this.run(owner, request) } as WorkSyncReply;
      } catch (error) {
        return { ...base, state: 'error' as const, code: error instanceof WorkStorageError ? error.code : 'storage' as const, message: error instanceof WorkStorageError ? error.message : 'El host no pudo confirmar almacenamiento durable. Conserva la copia local.' };
      }
    });
    this.queue = task.catch(() => {}); return task;
  }
  private async load(directory: string): Promise<RecordFile | undefined> {
    let bytes: Buffer;
    try { bytes = await readPrivate(join(directory, 'manifest.json')); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    const raw = JSON.parse(bytes.toString('utf8')) as RecordFile;
    const manifest = parseWorkSyncManifest(raw.manifest);
    if (!manifest || raw.manifestHash !== digest(canonicalWorkManifest(manifest))) throw new Error('Corrupted manifest');
    if (raw.receipt && (raw.receipt.manifestHash !== raw.manifestHash || raw.receipt.workId !== manifest.workId || raw.receipt.revision !== manifest.revision || !Number.isSafeInteger(raw.receipt.committedAt))) throw new Error('Corrupted receipt');
    if (raw.processing?.status === 'ready' && (!parseWorkResult(raw.processing.result) || raw.processing.result.manifestHash !== raw.manifestHash)) throw new Error('Corrupted result');
    return { manifest, manifestHash: raw.manifestHash, ...(raw.receipt ? { receipt: raw.receipt } : {}), ...(raw.processing ? { processing: raw.processing } : {}) };
  }
  private async offsets(directory: string, record: RecordFile): Promise<Record<string, number>> {
    const offsets: Record<string, number> = Object.create(null);
    for (const f of record.manifest.files) {
      try { const st = await lstat(join(directory, f.id)); if (!st.isFile() || st.isSymbolicLink() || st.size > f.bytes) throw new Error('Corrupted attachment'); offsets[f.id] = st.size; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; offsets[f.id] = 0; }
    }
    return offsets;
  }
  private async run(owner: string, request: WorkSyncRequest): Promise<Record<string, unknown>> {
    if (!owner) throw new WorkStorageError('invalid', 'Dispositivo no autenticado.');
    await privateDirectory(this.directory); await syncDirectory(dirname(this.directory));
    const namespace = join(this.directory, digest(owner)); await privateDirectory(namespace); await syncDirectory(this.directory);
    const directory = join(namespace, request.transferId);
    const exists = await lstat(directory).then(st => { if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('Unsafe transfer directory'); return true; }, error => { if (error.code === 'ENOENT') return false; throw error; });
    let record = exists ? await this.load(directory) : undefined;
    if (request.operation === 'begin') {
      if (digest(canonicalWorkManifest(request.manifest)) !== request.manifestHash) throw new WorkStorageError('invalid', 'El manifiesto no coincide con su hash.');
      if (record && record.manifestHash !== request.manifestHash) throw new WorkStorageError('conflict', 'La transferencia ya identifica otro contenido.');
      if (!record) {
        const entries = await readdir(namespace, { withFileTypes: true });
        if (!exists && entries.length >= WORK_SYNC_LIMITS.transfers) throw new WorkStorageError('quota', 'El host admite 100 transferencias por dispositivo.');
        let reserved = request.manifest.files.reduce((sum, f) => sum + f.bytes, 0);
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Unsafe namespace');
          const previous = await this.load(join(namespace, entry.name));
          if (previous?.manifest.workId === request.manifest.workId && previous.manifest.revision === request.manifest.revision) throw new WorkStorageError('conflict', 'Esa revisión ya pertenece a otra transferencia. Recupera el identificador original antes de repetirla.');
          if (previous) reserved += previous.manifest.files.reduce((sum, f) => sum + f.bytes, 0);
        }
        if (reserved > 512 * 1024 * 1024) throw new WorkStorageError('quota', 'El dispositivo alcanzó su cuota de 512 MiB en el host.');
        await privateDirectory(directory); await syncDirectory(namespace);
        record = { manifest: request.manifest, manifestHash: request.manifestHash };
        await atomicRecord(directory, record);
      }
    }
    if (!record) return { state: 'missing' };
    if (request.operation === 'process' || request.operation === 'result') {
      if (!record.receipt) throw new WorkStorageError('conflict', 'Confirma primero todos los archivos del trabajo.');
      if (record.processing?.status === 'running' && !this.jobs.has(directory)) {
        record.processing = { status: 'uncertain', message: 'El host se reinició durante el procesamiento. No se repetirá automáticamente; revisa el trabajo antes de crear otro intento.' };
        await atomicRecord(directory, record);
      }
      if (record.processing) return { state: 'processing', processing: record.processing };
      if (request.operation === 'result') return { state: 'committed', receipt: record.receipt };
      if (request.approvedManifestHash !== record.manifestHash) throw new WorkStorageError('conflict', 'La aprobación no corresponde al contenido confirmado.');
      if (!this.processor || this.closed) throw new WorkStorageError('invalid', 'Este host no tiene disponible el procesador de minutas.');
      if (this.jobs.size) throw new WorkStorageError('quota', 'El host está procesando otra minuta. Vuelve a intentarlo al terminar.');
      for (const file of record.manifest.files) if (!await matchesPrivateFile(join(directory, file.id), file.bytes, file.sha256)) throw new WorkStorageError('conflict', 'Los archivos del host no coinciden con la revisión aprobada. Conserva el original local.');
      record.processing = { status: 'running', message: 'Transcribiendo y preparando un borrador para revisión. No se ejecutarán acciones externas.' };
      await atomicRecord(directory, record);
      const controller = new AbortController(); const processor = this.processor; const committed = record;
      const promise = Promise.resolve().then(async () => {
        let processing: WorkProcessing;
        try {
          const result = parseWorkResult(await processor({ directory, manifest: committed.manifest, receipt: committed.receipt! }, controller.signal));
          if (!result || result.manifestHash !== committed.manifestHash || result.evidence.some(e => !committed.manifest.files.some(f => f.id === e.fileId))) throw new Error('El modelo no devolvió una minuta verificable.');
          processing = { status: 'ready', result };
        } catch (error) {
          if (controller.signal.aborted) return;
          processing = { status: 'failed', message: error instanceof WorkProcessorFailure && error.reason === 'versions-too-large' ? 'Las versiones anteriores superan 200000 caracteres. Conserva los originales y crea otro trabajo con sólo las versiones necesarias.' : error instanceof WorkProcessorFailure && error.reason === 'model-context-too-small' ? 'El contenido completo no cabe en el presupuesto conservador del modelo seleccionado. Conserva los originales y prepara trabajos más pequeños.' : 'No se pudo completar una minuta verificable. Comprueba el transcriptor de la PC, ffmpeg y el modelo conectado. Los archivos originales están conservados.' };
        }
        const save = this.queue.then(async () => { committed.processing = processing; await atomicRecord(directory, committed); });
        this.queue = save.catch(() => {}); await save;
      }).catch(() => {}).finally(() => { this.jobs.delete(directory); });
      this.jobs.set(directory, { controller, promise });
      return { state: 'processing', processing: record.processing };
    }
    if (record.receipt) {
      const durable = await open(join(directory, 'manifest.json'), constants.O_RDONLY | constants.O_NOFOLLOW); try { await durable.sync(); } finally { await durable.close(); }
      await syncDirectory(directory); return { state: 'committed', receipt: record.receipt };
    }
    if (request.operation === 'chunk') {
      const file = record.manifest.files.find(f => f.id === request.fileId);
      const data = Buffer.from(request.data, 'base64');
      if (!file || data.length > WORK_SYNC_LIMITS.chunkBytes || request.offset + data.length > file.bytes || data.toString('base64') !== request.data) throw new WorkStorageError('invalid', 'Fragmento de archivo no válido.');
      const path = join(directory, file.id);
      const fd = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      try {
        const st = await fd.stat(); if (!st.isFile()) throw new Error('Unsafe attachment');
        if (request.offset > st.size || (request.offset < st.size && request.offset + data.length > st.size)) throw new WorkStorageError('conflict', 'Consulta el desplazamiento confirmado antes de continuar.');
        if (request.offset < st.size) {
          const prior = Buffer.alloc(data.length); await fd.read(prior, 0, prior.length, request.offset);
          if (!prior.equals(data)) throw new WorkStorageError('conflict', 'Un fragmento repetido contiene otros bytes.');
        } else {
          let written = 0; while (written < data.length) { const result = await fd.write(data, written, data.length - written, request.offset + written); if (!result.bytesWritten) throw new Error('Short write'); written += result.bytesWritten; }
        }
        await fd.sync();
      } finally { await fd.close(); }
      await syncDirectory(directory);
    }
    if (request.operation === 'commit') {
      const offsets = await this.offsets(directory, record);
      for (const f of record.manifest.files) {
        if (offsets[f.id] !== f.bytes) throw new WorkStorageError('conflict', 'Todavía faltan bytes de un archivo.');
        if (!await matchesPrivateFile(join(directory, f.id), f.bytes, f.sha256)) throw new WorkStorageError('conflict', 'La integridad de un archivo no coincide con lo aprobado.');
      }
      record.receipt = { transferId: request.transferId, workId: record.manifest.workId, revision: record.manifest.revision, manifestHash: record.manifestHash, committedAt: Date.now() };
      await atomicRecord(directory, record);
      return { state: 'committed', receipt: record.receipt };
    }
    return { state: 'uploading', manifestHash: record.manifestHash, offsets: await this.offsets(directory, record) };
  }
}
