import { localIdentifier } from './local-identifiers.ts';
import { canonicalWorkManifest, parseWorkSyncReply, WORK_SYNC_LIMITS, type WorkSyncManifest, type WorkSyncReply, type WorkSyncRequest, type WorkProcessing } from '@gentle-dot/protocol';
import { beginWorkTransfer, readWork, readWorkFile, readWorkFileSize, readWorkFileSlice, settleWorkTransfer, saveWorkResult, type WorkItem, type WorkTransfer } from './work-inbox.ts';
import { blobSHA256 } from './blob-sha256.ts';
import { Hash } from 'fast-sha256';

export type WorkExchange = (request: WorkSyncRequest) => Promise<WorkSyncReply>;
async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  if (!globalThis.crypto?.subtle) return (await import('./device-bridge.ts')).nativeSHA256Bytes(bytes);
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
async function storedSHA256(workId: string, fileId: string, size: number, signal?: AbortSignal): Promise<string> {
  if (await readWorkFileSize(workId, fileId) !== size) throw new Error('Falta un archivo local o sus bytes cambiaron.');
  const hash = new Hash();
  try {
    for (let offset = 0; offset < size; offset += 256 * 1024) {
      signal?.throwIfAborted();
      const bytes = await readWorkFileSlice(workId, fileId, offset, Math.min(256 * 1024, size - offset));
      signal?.throwIfAborted(); hash.update(bytes);
    }
    return Array.from(hash.digest(), byte => byte.toString(16).padStart(2, '0')).join('');
  } finally { hash.clean(); }
}
export async function prepareWorkTransfer(item: WorkItem, host: string, getFile?: typeof readWorkFile, signal?: AbortSignal): Promise<WorkTransfer> {
  signal?.throwIfAborted();
  if (item.status !== 'approved') throw new Error('Aprueba el contenido exacto antes de enviarlo al host.');
  const manifest: WorkSyncManifest = { schema: 1, workId: item.id, revision: item.revision, title: item.title, kind: item.kind, instruction: item.instruction, files: [] };
  for (const file of item.files) {
    const blob = getFile ? await getFile(item.id, file.id) : undefined;
    if (getFile && (!blob || blob.size !== file.size)) throw new Error('Falta un archivo local o sus bytes cambiaron.');
    const sha = blob ? await blobSHA256(blob, signal) : await storedSHA256(item.id, file.id, file.size, signal);
    manifest.files.push({ id: file.id, name: file.name, mime: file.type.split(';')[0]!.trim(), bytes: file.size, sha256: sha, role: 'attachment' });
  }
  for (const version of item.versions) {
    signal?.throwIfAborted();
    const bytes = new TextEncoder().encode(version.text);
    manifest.files.push({ id: `version-${version.id}`, name: `version-${version.id}.txt`, mime: 'text/plain', bytes: bytes.length, sha256: await sha256(bytes), role: 'version', createdAt: version.createdAt });
  }
  return { host, transferId: localIdentifier(), manifest, manifestHash: await sha256(new TextEncoder().encode(canonicalWorkManifest(manifest))) };
}
function base64(bytes: Uint8Array): string {
  let binary = ''; for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192)); return btoa(binary);
}
export function createWorkDispatcher(exchange: WorkExchange, host: string) {
  const active = new Set<string>();
  async function run(item: WorkItem, fresh: boolean, signal?: AbortSignal): Promise<WorkItem> {
    const transfer = item.transfer;
    if (!transfer || transfer.host !== host) throw new Error('Conecta el mismo host al que aprobaste transferir este trabajo.');
    if (!fresh && !['sending', 'uncertain', 'sent'].includes(item.status)) throw new Error('Esta revisión no tiene una transferencia recuperable.');
    if (active.has(item.id)) throw new Error('Este trabajo ya se está transfiriendo.');
    active.add(item.id);
    type Operation = WorkSyncRequest extends infer R ? R extends WorkSyncRequest ? Omit<R, 'type' | 'requestId' | 'transferId'> : never : never;
    const request = async (operation: Operation): Promise<WorkSyncReply> => {
      signal?.throwIfAborted();
      const message = { ...operation, type: 'work_sync' as const, requestId: localIdentifier(), transferId: transfer.transferId } as WorkSyncRequest;
      const reply = parseWorkSyncReply(await exchange(message));
      if (!reply || reply.requestId !== message.requestId || reply.transferId !== transfer.transferId) throw new Error('El host no devolvió una confirmación correlacionada.');
      if (reply.state === 'error') throw new Error(reply.message);
      if (reply.state === 'uploading' && reply.manifestHash !== transfer.manifestHash) throw new Error('El host conserva otra versión de esta transferencia.');
      return reply;
    };
    try {
      let reply = await request(fresh ? { operation: 'begin', manifest: transfer.manifest, manifestHash: transfer.manifestHash } : { operation: 'status' });
      if (reply.state === 'committed') return await settleWorkTransfer(item.id, transfer.transferId, reply.receipt);
      if (reply.state === 'missing') throw new Error('El host no encuentra esta transferencia. Conserva la copia local y vuelve a revisar antes de reintentar.');
      if (reply.state !== 'uploading') throw new Error('El host no confirmó la transferencia.');
      for (const file of transfer.manifest.files) {
        const version = file.role === 'version' ? item.versions.find(v => `version-${v.id}` === file.id) : undefined;
        const blob = file.role === 'version' && version ? new Blob([version.text], { type: 'text/plain' }) : undefined;
        const actualHash = file.role === 'version' ? (blob && blob.size === file.bytes ? await blobSHA256(blob, signal) : undefined) : await storedSHA256(item.id, file.id, file.bytes, signal);
        if (actualHash !== file.sha256) throw new Error('Los bytes locales ya no coinciden con la versión aprobada.');
        let offset = reply.offsets[file.id];
        if (offset === undefined || offset > file.bytes) throw new Error('El desplazamiento confirmado por el host no es válido.');
        while (offset < file.bytes) {
          const length = Math.min(WORK_SYNC_LIMITS.chunkBytes, file.bytes - offset);
          const bytes = blob ? new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer()) : await readWorkFileSlice(item.id, file.id, offset, length);
          const next = await request({ operation: 'chunk', fileId: file.id, offset, data: base64(bytes) });
          if (next.state !== 'uploading' || next.offsets[file.id] !== offset + bytes.length) throw new Error('El host no confirmó los bytes del archivo.');
          reply = next; offset += bytes.length;
        }
      }
      const committed = await request({ operation: 'commit' });
      if (committed.state !== 'committed') throw new Error('El host todavía no confirmó el almacenamiento completo.');
      return await settleWorkTransfer(item.id, transfer.transferId, committed.receipt);
    } catch (error) {
      await settleWorkTransfer(item.id, transfer.transferId, error instanceof Error ? error.message : 'Entrega sin confirmar.').catch(() => {});
      throw error;
    } finally { active.delete(item.id); }
  }
  async function processing(id: string, approvedManifestHash?: string, signal?: AbortSignal): Promise<WorkProcessing | undefined> {
    const item = await readWork(id); const transfer = item.transfer;
    if (item.status !== 'sent' || !transfer?.receipt || transfer.host !== host) throw new Error('El host debe confirmar esta versión antes de procesarla.');
    if (approvedManifestHash !== undefined && approvedManifestHash !== transfer.manifestHash) throw new Error('La aprobación de procesamiento pertenece a otra versión.');
    const message: WorkSyncRequest = { type: 'work_sync', requestId: localIdentifier(), transferId: transfer.transferId, ...(approvedManifestHash === undefined ? { operation: 'result' } : { operation: 'process', approvedManifestHash }) };
    signal?.throwIfAborted();
    const reply = parseWorkSyncReply(await exchange(message));
    if (!reply || reply.requestId !== message.requestId || reply.transferId !== transfer.transferId) throw new Error('El host no confirmó el estado del procesamiento.');
    if (reply.state === 'error') throw new Error(reply.message);
    if (reply.state === 'committed') return undefined;
    if (reply.state !== 'processing') throw new Error('El host no devolvió el estado de la minuta.');
    if (reply.processing.status === 'ready' && reply.processing.result.manifestHash !== transfer.manifestHash) throw new Error('La minuta corresponde a otra versión del material.');
    if (reply.processing.status === 'ready') await saveWorkResult(item.id, transfer.transferId, reply.processing.result);
    return reply.processing;
  }
  return {
    async send(id: string, revision: number, approvedManifestHash?: string, signal?: AbortSignal): Promise<WorkItem> {
      signal?.throwIfAborted();
      const item = await readWork(id);
      if (item.revision !== revision) throw new Error('El trabajo cambió. Revisa la versión actual antes de enviar.');
      const transfer = await prepareWorkTransfer(item, host, undefined, signal);
      if (approvedManifestHash !== undefined && transfer.manifestHash !== approvedManifestHash) throw new Error('El contenido cambió después de aprobar la transferencia. Revisa de nuevo antes de enviar.');
      signal?.throwIfAborted();
      return run(await beginWorkTransfer(id, revision, transfer), true, signal);
    },
    async recover(id: string, signal?: AbortSignal): Promise<WorkItem> { return run(await readWork(id), false, signal); },
    /** Invoke only from the user's explicit action to process this exact committed revision. */
    process(id: string, approvedManifestHash: string, signal?: AbortSignal): Promise<WorkProcessing | undefined> { return processing(id, approvedManifestHash, signal); },
    result(id: string): Promise<WorkProcessing | undefined> { return processing(id); },
  };
}
