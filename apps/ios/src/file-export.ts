import { deviceInvoke, requireNative, type DeviceInvoker, type NativeReply } from './device-bridge.ts';

export const FILE_EXPORT_LIMIT = 256 * 1024 * 1024;
const CHUNK = 256 * 1024;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export type FileExportResult = { status: 'exported'; name: string; size: number; sha256: string } | { status: 'cancelled' };
export type FileExportOptions = { signal?: AbortSignal; expectedSHA256?: string };

/** A suggested export name only: never mutate the stored attachment's name. */
export function exportFileName(original: string): string {
  let name = (typeof original === 'string' ? original.split(/[/\\]/).at(-1) ?? '' : '')
    .replace(/[\p{Cc}\p{Cf}:]/gu, '_').trim();
  if (!name || /^[.]+$/.test(name)) name = 'archivo';
  if (name.startsWith('.')) name = 'capri' + name;
  const extension = name.match(/\.[A-Za-z0-9][A-Za-z0-9_-]{0,15}$/)?.[0] ?? '';
  const base = extension ? name.slice(0, -extension.length) : name;
  const budget = 240 - new TextEncoder().encode(extension).length;
  let clipped = '', bytes = 0;
  for (const character of base) {
    const width = new TextEncoder().encode(character).length;
    if (bytes + width > budget) break;
    clipped += character; bytes += width;
  }
  return (clipped || 'archivo') + extension;
}

function base64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let index = 0; index < bytes.length; index += 8192) parts.push(String.fromCharCode(...bytes.subarray(index, index + 8192)));
  return btoa(parts.join(''));
}
function identifier(reply: NativeReply & { id?: string }): string {
  requireNative(reply);
  if (!reply.id || !uuid.test(reply.id)) throw new Error('No se pudo preparar la exportación nativa.');
  return reply.id;
}
/** Explicit human export only, never a model tool. The caller retains its original
 * Blob. Native preparation is not export success; only the picker delegate is. */
export async function exportNativeFile(blob: Blob, name: string, options: FileExportOptions = {}, call: DeviceInvoker = deviceInvoke): Promise<FileExportResult> {
  if (!(blob instanceof Blob) || blob.size > FILE_EXPORT_LIMIT) throw new Error('La exportación admite hasta 256 MiB.');
  if (!name || new TextEncoder().encode(name).length > 240 || name.startsWith('.') || /[/\\:\p{Cc}\p{Cf}]/u.test(name)) throw new Error('Usa un nombre de archivo sin rutas ni caracteres de control.');
  if (options.expectedSHA256 !== undefined && !/^[a-f0-9]{64}$/.test(options.expectedSHA256)) throw new Error('La huella original del archivo no es válida.');
  const signal = options.signal;
  signal?.throwIfAborted();
  let hashId: string | undefined, exportId: string | undefined;
  const cancel = () => { if (exportId) void call('export_cancel', { id: exportId }).catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    // Two bounded passes avoid loading a whole audio/archive into JS memory. The
    // second pass is independently hashed while native writes the protected file.
    hashId = identifier(await call<NativeReply & { id?: string }>('crypto_hash_begin', {}));
    signal?.throwIfAborted();
    for (let offset = 0; offset < blob.size; offset += CHUNK) {
      const bytes = new Uint8Array(await blob.slice(offset, offset + CHUNK).arrayBuffer());
      signal?.throwIfAborted();
      requireNative(await call('crypto_hash_update', { id: hashId, data: base64(bytes) }));
      signal?.throwIfAborted();
    }
    const digest = requireNative(await call<NativeReply & { hex?: string }>('crypto_hash_finish', { id: hashId }));
    if (!digest.hex || !/^[a-f0-9]{64}$/.test(digest.hex)) throw new Error('No se pudo comprobar la huella del archivo.');
    const sha256 = digest.hex;
    if (options.expectedSHA256 !== undefined && sha256 !== options.expectedSHA256) throw new Error('Los bytes no coinciden con el archivo original; no se abrió el selector.');
    signal?.throwIfAborted();
    exportId = identifier(await call<NativeReply & { id?: string }>('export_begin', { name, size: blob.size, sha256 }));
    signal?.throwIfAborted();
    for (let offset = 0; offset < blob.size; offset += CHUNK) {
      const bytes = new Uint8Array(await blob.slice(offset, offset + CHUNK).arrayBuffer());
      signal?.throwIfAborted();
      const reply = requireNative(await call<NativeReply & { written?: number }>('export_write', { id: exportId, offset, data: base64(bytes) }));
      if (reply.written !== offset + bytes.length) throw new Error('El archivo temporal no confirmó todos los bytes.');
      signal?.throwIfAborted();
    }
    signal?.throwIfAborted();
    const result = requireNative(await call<NativeReply & { exported?: boolean; cancelled?: boolean }>('export_present', { id: exportId }));
    // A real success callback wins a concurrent cancel: do not deny a copy that
    // the system already confirmed. No other reply may imply successful export.
    if (result.exported === true && result.cancelled === false) return { status: 'exported', name, size: blob.size, sha256 };
    if (result.exported === false && result.cancelled === true) return { status: 'cancelled' };
    throw new Error('El selector de Archivos no confirmó la exportación.');
  } finally {
    signal?.removeEventListener('abort', cancel);
    // Idempotent on native completion. A lost bridge reply never starts a second
    // export; orphan sources expire or are removed at the next native launch.
    await Promise.allSettled([
      ...(exportId ? [call('export_cancel', { id: exportId })] : []),
      ...(hashId ? [call('crypto_hash_cancel', { id: hashId })] : []),
    ]);
  }
}
