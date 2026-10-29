import { invoke, isTauri } from '@tauri-apps/api/core';
import { blobSHA256 } from './blob-sha256.ts';

export type SecretScope = 'daemon-pairing' | 'daemon-manual' | 'external-connections';
export type NativeReply = { ok: boolean; error?: string; message?: string };
export type HTTPSRequest = { url: string; method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD'; headers: Record<string, string>; body?: string; receiptId?: string; receiptOwner?: string };
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
export type HTTPReceiptState = 'missing' | 'active' | 'terminal' | 'cancelledBeforeStart';
function receiptIdentity(id: string, owner: string): void {
  const valid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  if (!valid.test(id) || !valid.test(owner)) throw new Error('Identidad de transporte inválida.');
}
export async function httpsReceiptState(id: string, owner: string, call: DeviceInvoker = deviceInvoke): Promise<HTTPReceiptState> {
  receiptIdentity(id, owner);
  const reply = requireNative(await call<NativeReply & { receiptState?: unknown }>('https_receipt_state', {id,owner}));
  if (!['missing','active','terminal','cancelledBeforeStart'].includes(String(reply.receiptState))) throw new Error('Comprobante nativo inválido.');
  return reply.receiptState as HTTPReceiptState;
}
/** A lost bridge callback must never freeze the UI or imply a terminal task. */
export async function boundedReceiptState(id:string,owner:string,read:typeof httpsReceiptState = httpsReceiptState,timeoutMs=2500):Promise<HTTPReceiptState|undefined> {
  let timer:ReturnType<typeof setTimeout>|undefined;
  try { return await Promise.race([read(id,owner),new Promise<undefined>(resolve=>{timer=setTimeout(()=>resolve(undefined),timeoutMs);})]); }
  catch { return undefined; } finally { if(timer) clearTimeout(timer); }
}
export async function httpsReceiptCancelBeforeStart(id: string, owner: string, call: DeviceInvoker = deviceInvoke): Promise<void> {
  receiptIdentity(id, owner);
  const reply = requireNative(await call<NativeReply & {receiptState?: unknown}>('https_receipt_cancel_before_start',{id,owner}));
  if (reply.receiptState !== 'cancelledBeforeStart') throw new Error('La cancelación no quedó confirmada.');
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
// Swift String.count measures extended grapheme clusters. Match it so a
// decomposed accented title accepted by the native inbox is also importable.
function withinGraphemes(value: string, limit: number): boolean {
  const units = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value) : Array.from(value);
  let count = 0;
  for (const _ of units) if (++count > limit) return false;
  return true;
}
export function validSharedImport(value: unknown): value is SharedImport {
  if (!object(value) || value.schemaVersion !== 1 || typeof value.id !== 'string' || !uuid.test(value.id) ||
      !Number.isSafeInteger(value.createdAt) || (value.createdAt as number) <= 0 || typeof value.title !== 'string' || !value.title.trim() || value.title.length > 65536 ||
      typeof value.notes !== 'string' || value.notes.length > 65536 || new TextEncoder().encode(value.title + value.notes).byteLength > 65536 || !withinGraphemes(value.title, 120) || !withinGraphemes(value.notes, 8000) || !Array.isArray(value.files) || value.files.length < 1 || value.files.length > 10) return false;
  const ids = new Set<string>(); let total = 0;
  for (const file of value.files) {
    if (!object(file) || typeof file.id !== 'string' || !uuid.test(file.id) || ids.has(file.id) || typeof file.name !== 'string' || !file.name || file.name.length > 65536 || !withinGraphemes(file.name, 255) ||
        typeof file.mime !== 'string' || file.mime.length > 128 || !Number.isSafeInteger(file.size) || (file.size as number) <= 0 || (file.size as number) > (file.mime.startsWith('audio/') ? 128 : 25) * 1024 * 1024 ||
        typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) return false;
    ids.add(file.id); total += file.size as number;
  }
  return total <= 256 * 1024 * 1024;
}
export async function listSharedImports(call: DeviceInvoker = deviceInvoke): Promise<SharedImport[]> {
  const report = await listSharedImportReport(call);
  if (report.invalidIds.length) throw new Error('La bandeja compartida contiene un manifiesto inválido.');
  return report.items;
}
/** A failed native manifest is retained and reported separately; healthy items remain recoverable. */
export async function listSharedImportReport(call: DeviceInvoker = deviceInvoke): Promise<{items: SharedImport[]; invalidIds: string[]; pendingCopies: {id: string; bytes: number | null}[]; omittedPending: number}> {
  const reply = requireNative(await call<NativeReply & { items?: unknown; invalidIds?: unknown; pendingCopies?: unknown; omittedPending?: unknown }>('share_list', {}));
  if (!Array.isArray(reply.items) || reply.items.length > 100) throw new Error('La bandeja compartida contiene un manifiesto inválido.');
  const reported = reply.invalidIds ?? [];
  if (!Array.isArray(reported) || reported.length > 100 || reported.some(id => typeof id !== 'string' || !uuid.test(id)) || new Set(reported).size !== reported.length || reply.items.length + reported.length > 100) throw new Error('La bandeja compartida no pudo verificarse. Los originales se conservan.');
  const invalidIds: string[] = [...reported], items: SharedImport[] = [], seen = new Set(invalidIds);
  for (const item of reply.items) {
    if (!object(item) || typeof item.id !== 'string' || !uuid.test(item.id) || seen.has(item.id)) throw new Error('La bandeja compartida contiene un manifiesto inválido.');
    seen.add(item.id);
    if (validSharedImport(item)) items.push(item); else invalidIds.push(item.id);
  }
  const pending = reply.pendingCopies ?? [], omitted = reply.omittedPending ?? 0;
  if (!Array.isArray(pending) || pending.length > 100 || !Number.isSafeInteger(omitted) || Number(omitted) < 0) throw new Error('No se pudo verificar el estado de las copias pendientes.');
  const pendingCopies: {id: string; bytes: number | null}[] = [], pendingIds = new Set<string>();
  for (const value of pending) {
    if (!object(value) || typeof value.id !== 'string' || !uuid.test(value.id) || pendingIds.has(value.id) || (value.bytes !== undefined && value.bytes !== null && (!Number.isSafeInteger(value.bytes) || Number(value.bytes) < 0))) throw new Error('No se pudo verificar el estado de las copias pendientes.');
    pendingIds.add(value.id); pendingCopies.push({id:value.id,bytes:typeof value.bytes === 'number' ? value.bytes : null});
  }
  return {items, invalidIds, pendingCopies, omittedPending: Number(omitted)};
}
export async function readSharedFileChunk(item: SharedImport, file: SharedFile, offset: number, length: number, call: DeviceInvoker = deviceInvoke): Promise<Uint8Array<ArrayBuffer>> {
  if (!validSharedImport(item) || !item.files.some(candidate => candidate.id === file.id && candidate.sha256 === file.sha256 && candidate.size === file.size)
    || !Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length <= 0 || length > 256 * 1024 || offset + length > file.size) throw new Error('Adjunto compartido inválido.');
  const reply = requireNative(await call<NativeReply & { data?: string }>('share_read', { id: item.id, fileId: file.id, offset, length }));
  if (typeof reply.data !== 'string' || reply.data.length > Math.ceil(length / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(reply.data)) throw new Error('El adjunto llegó incompleto.');
  const binary = atob(reply.data);
  if (binary.length !== length) throw new Error('El adjunto llegó incompleto.');
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}
export async function readSharedFile(item: SharedImport, file: SharedFile, call: DeviceInvoker = deviceInvoke): Promise<File> {
  if (!validSharedImport(item) || !item.files.some(candidate => candidate.id === file.id && candidate.sha256 === file.sha256 && candidate.size === file.size)) throw new Error('Adjunto compartido inválido.');
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  for (let offset = 0; offset < file.size;) {
    const length = Math.min(256 * 1024, file.size - offset);
    chunks.push(await readSharedFileChunk(item, file, offset, length, call)); offset += length;
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
/** The caller commits all chunks before returning; a failed save never acknowledges native storage. */
export async function importSharedItemStreamed(item: SharedImport,
  save: (input: { sourceId: string; item: SharedImport; read: (file: SharedFile, offset: number, length: number) => Promise<Uint8Array> }) => Promise<void>, call: DeviceInvoker = deviceInvoke): Promise<void> {
  if (!validSharedImport(item)) throw new Error('Importación inválida.');
  await save({ sourceId: `share:${item.id}`, item, read: (file, offset, length) => readSharedFileChunk(item, file, offset, length, call) });
  await acknowledgeSharedImport(item.id, call);
}

/** A damaged item must not prevent independent, later items from being recovered. */
export async function recoverImportBatch(items: SharedImport[], importItem: (item: SharedImport) => Promise<void>): Promise<{ recovered: number; failures: { id: string; title: string; message: string }[] }> {
  const failures: { id: string; title: string; message: string }[] = [];
  let recovered = 0;
  for (const item of items) {
    try { await importItem(item); recovered++; }
    catch (error) { failures.push({ id: item.id, title: item.title, message: error instanceof Error ? error.message : 'No se pudo completar la importación.' }); }
  }
  return { recovered, failures };
}
