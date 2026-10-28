/** Personal builds carry the same PNG used by the desktop rig. No network URL or credentials. */
const MAX_ART_BYTES = 5 * 1024 * 1024;
const missing = 'Esta instalación no contiene el arte de Capri.';
type Manifest = { schemaVersion: 1; file: 'capri-full.png'; sha256: string; size: number; width: 240; height: 420 };
type Options = { fetch?: typeof fetch; hash?: (bytes: Uint8Array<ArrayBuffer>) => Promise<string>; signal?: AbortSignal };

function manifest(value: unknown): Manifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('El manifiesto de Capri no es válido.');
  const item = value as Record<string, unknown>;
  if (item.schemaVersion !== 1 || item.file !== 'capri-full.png' || item.width !== 240 || item.height !== 420 ||
      typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.size) ||
      (item.size as number) < 57 || (item.size as number) > MAX_ART_BYTES) throw new Error('El manifiesto de Capri no es válido.');
  return item as Manifest;
}
async function bounded(response: Response, maximum: number): Promise<Uint8Array<ArrayBuffer>> {
  if (!response.ok) throw new Error(missing);
  const declared = response.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximum)) throw new Error('El arte empaquetado supera su límite.');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('No se pudo leer el arte empaquetado.');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength;
      if (size > maximum) throw new Error('El arte empaquetado supera su límite.');
      chunks.push(next.value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  if (!globalThis.crypto?.subtle) return (await import('./device-bridge.ts')).nativeSHA256Bytes(bytes);
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** undefined means a generic source preview has no bundled art; malformed or missing declared art is an error. */
export async function loadPackagedArtwork(options: Options = {}): Promise<Blob | undefined> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (options.signal?.aborted) abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, 8000);
  const request = options.fetch ?? globalThis.fetch;
  const init: RequestInit = { signal: controller.signal, credentials: 'omit', redirect: 'error', cache: 'no-store' };
  try {
    const response = await request('./personal-art/manifest.json', init);
    if (response.status === 404) return undefined;
    const item = manifest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await bounded(response, 2048))));
    const bytes = await bounded(await request('./personal-art/capri-full.png', init), item.size);
    const header = new DataView(bytes.buffer);
    if (bytes.byteLength !== item.size || bytes.byteLength < 57 ||
        ![137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value) ||
        header.getUint32(8) !== 13 || header.getUint32(12) !== 0x49484452 ||
        header.getUint32(16) !== 240 || header.getUint32(20) !== 420 ||
        await (options.hash ?? sha256)(bytes) !== item.sha256) throw new Error('El arte empaquetado no coincide con el original de Capri.');
    if (controller.signal.aborted) throw new Error('Se interrumpió la carga del arte de Capri.');
    return new Blob([bytes], { type: 'image/png' });
  } finally { clearTimeout(timeout); options.signal?.removeEventListener('abort', abort); }
}
