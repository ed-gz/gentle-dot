import { invoke, isTauri } from '@tauri-apps/api/core';
import { blobSHA256 } from './blob-sha256.ts';

export type SecretScope = 'daemon-pairing' | 'daemon-manual' | 'external-connections';
export type NativeReply = { ok: boolean; error?: string; message?: string };
export type HTTPSRequest = { url: string; method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD'; headers: Record<string, string>; body?: string };
export type HTTPSResponse = { status: number; body: string; headers: Record<string, string> };
export type SharedFile = { id: string; name: string; mime: string; size: number; sha256: string };
export type SharedImport = { schemaVersion: 1; id: string; createdAt: number; title: string; notes: string; files: SharedFile[] };
export type DeviceInvoker = <T extends NativeReply>(command: string, request: Record<string, unknown>) => Promise<T>;

/** Preserve the native failure category without exposing request data or credentials. */
export class DeviceBridgeError extends Error {
  readonly code: string | undefined;
  constructor(code: string | undefined, message: string) { super(message); this.code = code; this.name = 'DeviceBridgeError'; }
}

/** The only web→native entry point. Never log requests or failures containing credentials. */
export const deviceInvoke: DeviceInvoker = async <T extends NativeReply>(command: string, request: Record<string, unknown>): Promise<T> => {
  if (!isTauri()) throw new Error('Esta función requiere Capri instalado en el iPhone.');
  let value: T;
  try { value = await invoke<T>(`plugin:device-bridge|${command}`, { request }); }
  catch { throw new Error('El puente nativo no completó la operación.'); }
  if (!value || typeof value.ok !== 'boolean') throw new Error('Respuesta nativa inválida.');
  return value;
};
export function requireNative<T extends NativeReply>(reply: T): T {
  if (!reply.ok) throw new DeviceBridgeError(reply.error, reply.message || 'La operación nativa no se completó.');
  return reply;
}
export async function secretGet(scope: SecretScope, account: string): Promise<string | null> {
  const reply = requireNative(await deviceInvoke<NativeReply & { value?: string }>('secret_get', { scope, account }));
  return typeof reply.value === 'string' ? reply.value : null;
}
export async function secretSet(scope: SecretScope, account: string, value: string): Promise<void> {
  if (!value || new TextEncoder().encode(value).length > 16384) throw new Error('La credencial supera 16 KiB.');
  requireNative(await deviceInvoke('secret_set', { scope, account, value }));
}
export async function secretDelete(scope: SecretScope, account: string): Promise<void> {
  requireNative(await deviceInvoke('secret_delete', { scope, account }));
}
export async function httpsRequest(request: HTTPSRequest): Promise<HTTPSResponse> {
  const reply = requireNative(await deviceInvoke<NativeReply & Partial<HTTPSResponse>>('https_request', request));
  if (!Number.isInteger(reply.status) || reply.status! < 100 || reply.status! > 599 || typeof reply.body !== 'string' || !reply.headers) throw new Error('Respuesta HTTPS inválida.');
  return { status: reply.status!, body: reply.body, headers: reply.headers };
}
export async function oauthAuthorize(authorizationUrl: string, callbackScheme = 'capri-auth'): Promise<string> {
  const reply = requireNative(await deviceInvoke<NativeReply & { callbackUrl?: string }>('oauth_authorize', { authorizationUrl, callbackScheme }));
  if (typeof reply.callbackUrl !== 'string' || new URL(reply.callbackUrl).protocol !== `${callbackScheme.toLowerCase()}:`) throw new Error('Callback de autorización inválido.');
  return reply.callbackUrl;
}
export async function oauthCancel(): Promise<void> { requireNative(await deviceInvoke('oauth_cancel', {})); }
/** Explicit account-setup UI only. Never expose navigation as a model tool. */
export async function openExternalURL(url: string): Promise<void> {
  const target = new URL(url);
  if (target.protocol !== 'https:' || target.username || target.password || target.hash) throw new Error('Se requiere una dirección HTTPS válida.');
  requireNative(await deviceInvoke('open_external_url', { url: target.href }));
}
export async function registeredURLSchemes(): Promise<string[]> {
  const reply = requireNative(await deviceInvoke<NativeReply & { schemes?: unknown }>('registered_url_schemes', {}));
  if (!Array.isArray(reply.schemes) || reply.schemes.some(value => typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9+.-]{2,127}$/.test(value))) throw new Error('No se pudieron comprobar los callbacks de esta instalación.');
  return reply.schemes;
}
export async function nativeRandom(length: number): Promise<string> {
  const reply = requireNative(await deviceInvoke<NativeReply & { data?: string }>('crypto_random', { length }));
  if (!reply.data || !/^[A-Za-z0-9_-]+$/.test(reply.data)) throw new Error('No se pudo obtener aleatoriedad segura.');
  return reply.data;
}
export async function nativeSHA256(data: string): Promise<string> {
  const reply = requireNative(await deviceInvoke<NativeReply & { hex?: string }>('crypto_sha256', { data }));
  if (!reply.hex || !/^[a-f0-9]{64}$/.test(reply.hex)) throw new Error('No se pudo calcular la huella.');
  return reply.hex;
}
export async function nativeSHA256Bytes(bytes: Uint8Array, call: DeviceInvoker = deviceInvoke): Promise<string> {
  if (bytes.byteLength > 50 * 1024 * 1024) throw new Error('El archivo supera 50 MiB.');
  const begin = requireNative(await call<NativeReply & { id?: string }>('crypto_hash_begin', {}));
  if (!begin.id || !/^[0-9a-f-]{36}$/.test(begin.id)) throw new Error('No se pudo iniciar la verificación.');
  const id = begin.id;
  try {
    for (let offset = 0; offset < bytes.byteLength; offset += 256 * 1024) {
      const chunk = bytes.subarray(offset, Math.min(offset + 256 * 1024, bytes.byteLength));
      // Avoid spreading a 256KiB array into one call (WebKit argument-stack overflow).
      const parts: string[] = [];
      for (let index = 0; index < chunk.length; index += 8192) parts.push(String.fromCharCode(...chunk.subarray(index, index + 8192)));
      requireNative(await call('crypto_hash_update', { id, data: btoa(parts.join('')) }));
    }
    const finish = requireNative(await call<NativeReply & { hex?: string }>('crypto_hash_finish', { id }));
    if (!finish.hex || !/^[a-f0-9]{64}$/.test(finish.hex)) throw new Error('No se pudo verificar el archivo.');
    return finish.hex;
  } finally {
    // Idempotent after finish. Cleanup failure cannot replace the original result/error;
    // the native digest state also expires automatically after two idle minutes.
    try { await call('crypto_hash_cancel', { id }); } catch { /* no file bytes retained */ }
  }
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
export function validSharedImport(value: unknown): value is SharedImport {
  if (!object(value) || value.schemaVersion !== 1 || typeof value.id !== 'string' || !uuid.test(value.id) ||
      !Number.isSafeInteger(value.createdAt) || (value.createdAt as number) <= 0 || typeof value.title !== 'string' || !value.title.trim() || Array.from(value.title).length > 120 ||
      typeof value.notes !== 'string' || Array.from(value.notes).length > 8000 || !Array.isArray(value.files) || value.files.length < 1 || value.files.length > 10) return false;
  const ids = new Set<string>(); let total = 0;
  for (const file of value.files) {
    if (!object(file) || typeof file.id !== 'string' || !uuid.test(file.id) || ids.has(file.id) || typeof file.name !== 'string' || !file.name || Array.from(file.name).length > 255 ||
        typeof file.mime !== 'string' || file.mime.length > 128 || !Number.isSafeInteger(file.size) || (file.size as number) <= 0 || (file.size as number) > 25 * 1024 * 1024 ||
        typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) return false;
    ids.add(file.id); total += file.size as number;
  }
  return total <= 50 * 1024 * 1024;
}
export async function listSharedImports(call: DeviceInvoker = deviceInvoke): Promise<SharedImport[]> {
  const reply = requireNative(await call<NativeReply & { items?: unknown }>('share_list', {}));
  if (!Array.isArray(reply.items) || reply.items.length > 100 || !reply.items.every(validSharedImport)) throw new Error('La bandeja compartida contiene un manifiesto inválido.');
  return reply.items;
}
export async function readSharedFile(item: SharedImport, file: SharedFile, call: DeviceInvoker = deviceInvoke): Promise<File> {
  if (!validSharedImport(item) || !item.files.some(candidate => candidate.id === file.id && candidate.sha256 === file.sha256 && candidate.size === file.size)) throw new Error('Adjunto compartido inválido.');
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  for (let offset = 0; offset < file.size;) {
    const length = Math.min(256 * 1024, file.size - offset);
    const reply = requireNative(await call<NativeReply & { data?: string }>('share_read', { id: item.id, fileId: file.id, offset, length }));
    if (typeof reply.data !== 'string' || reply.data.length > Math.ceil(length / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(reply.data)) throw new Error('El adjunto llegó incompleto.');
    const binary = atob(reply.data);
    if (binary.length !== length) throw new Error('El adjunto llegó incompleto.');
    chunks.push(Uint8Array.from(binary, char => char.charCodeAt(0))); offset += length;
  }
  const result = new File(chunks, file.name, { type: file.mime, lastModified: item.createdAt });
  // Verify reconstructed bytes even on WKWebView origins without WebCrypto.
  if (await blobSHA256(result) !== file.sha256) throw new Error('El adjunto no coincide con su huella. El original se conserva.');
  return result;
}
export async function acknowledgeSharedImport(id: string, call: DeviceInvoker = deviceInvoke): Promise<void> {
  if (!uuid.test(id)) throw new Error('Identificador de importación inválido.');
  requireNative(await call('share_ack', { id }));
}
/** `save` must deduplicate on sourceId and resolve only after its IDB transaction commits. */
export async function importSharedItem(item: SharedImport,
  save: (input: { sourceId: string; item: SharedImport; files: File[] }) => Promise<void>, call: DeviceInvoker = deviceInvoke): Promise<void> {
  if (!validSharedImport(item)) throw new Error('Importación inválida.');
  const files: File[] = [];
  for (const file of item.files) files.push(await readSharedFile(item, file, call));
  await save({ sourceId: `share:${item.id}`, item, files });
  await acknowledgeSharedImport(item.id, call);
}

/** A damaged item must not prevent independent, later items from being recovered. */
export async function recoverImportBatch(items: SharedImport[], importItem: (item: SharedImport) => Promise<void>): Promise<{ recovered: number; failures: { title: string; message: string }[] }> {
  const failures: { title: string; message: string }[] = [];
  let recovered = 0;
  for (const item of items) {
    try { await importItem(item); recovered++; }
    catch (error) { failures.push({ title: item.title, message: error instanceof Error ? error.message : 'No se pudo completar la importación.' }); }
  }
  return { recovered, failures };
}
