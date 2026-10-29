import { Hash } from 'fast-sha256';

const CHUNK = 256 * 1024;

/** Hash an immutable Blob without creating a whole-file ArrayBuffer. */
export async function blobSHA256(blob: Blob, signal?: AbortSignal): Promise<string> {
  if (!(blob instanceof Blob)) throw new Error('No se pudo verificar el archivo.');
  const hash = new Hash();
  try {
    for (let offset = 0; offset < blob.size; offset += CHUNK) {
      signal?.throwIfAborted();
      const length = Math.min(CHUNK, blob.size - offset);
      const bytes = new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());
      signal?.throwIfAborted();
      if (bytes.length !== length) throw new Error('No se pudieron leer todos los bytes del archivo.');
      hash.update(bytes);
    }
    signal?.throwIfAborted();
    return Array.from(hash.digest(), byte => byte.toString(16).padStart(2, '0')).join('');
  } finally { hash.clean(); }
}
