import type { UploadedFile } from '@gentle-dot/protocol';
import { deviceInvoke, requireNative, type DeviceInvoker, type NativeReply } from './device-bridge.ts';
import type { DesktopConnection } from './desktop-tools.ts';
import { validDaemonUrl } from './local-state.ts';

const MAXIMUM = 25 * 1024 * 1024, CHUNK = 256 * 1024;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const uploadIdentifier = /^[A-Za-z0-9_-]{8,64}$/;
const digest = /^[a-f0-9]{64}$/;
type Reply = NativeReply & { id?: string; hex?: string; written?: number; status?: number; body?: string };
const bytes = (value: string) => new TextEncoder().encode(value).length;
function encoded(value: Uint8Array): string {
  const parts: string[] = [];
  for (let offset = 0; offset < value.length; offset += 8192) parts.push(String.fromCharCode(...value.subarray(offset, offset + 8192)));
  return btoa(parts.join(''));
}
function id(reply: Reply): string {
  requireNative(reply);
  if (!reply.id || !uuid.test(reply.id)) throw new Error('No se pudo preparar el adjunto en el iPhone.');
  return reply.id;
}

/** Human composer only. No prompt is sent here; an upload receipt is not a task result.
 * Every native stage belongs to one captured host/pane/session and original Blob. */
export async function uploadSessionFile(connection: DesktopConnection, paneId: string, sessionId: string, file: File,
  options: { uploadId?: string; signal?: AbortSignal; current(): DesktopConnection | undefined }, call: DeviceInvoker = deviceInvoke): Promise<UploadedFile> {
  const captured = { ...connection }, endpoint = new URL(validDaemonUrl(captured.url));
  if (endpoint.pathname !== '/ws' || !captured.token || /\s/.test(captured.token) || bytes(captured.token) > 4096
    || !paneId || bytes(paneId) > 256 || !sessionId || bytes(sessionId) > 256 || /[\p{Cc}]/u.test(paneId + sessionId)
    || !(file instanceof Blob) || file.size > MAXIMUM || !file.name || bytes(file.name) > 1024 || /[\p{Cc}]/u.test(file.name)
    || (options.uploadId !== undefined && !uploadIdentifier.test(options.uploadId))) throw new Error('Usa un adjunto de hasta 25 MiB y una sesión vinculada válida.');
  endpoint.protocol = 'https:'; endpoint.pathname = '/upload';
  const { signal } = options;
  function check() {
    signal?.throwIfAborted();
    const live = options.current();
    if (!live || live.url !== captured.url || live.token !== captured.token || live.deviceId !== captured.deviceId) throw new Error('Cambió la laptop vinculada; no se envió la instrucción.');
  }
  check();
  let hashId: string | undefined, transferId: string | undefined;
  const cancel = () => { if (transferId) void call('session_upload_cancel', { id: transferId }).catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    // Both passes are bounded: no whole-file ArrayBuffer or base64 payload.
    hashId = id(await call<Reply>('crypto_hash_begin', {})); check();
    for (let offset = 0; offset < file.size; offset += CHUNK) {
      const data = encoded(new Uint8Array(await file.slice(offset, offset + CHUNK).arrayBuffer())); check();
      requireNative(await call('crypto_hash_update', { id: hashId, data })); check();
    }
    const hash = requireNative(await call<Reply>('crypto_hash_finish', { id: hashId })).hex;
    if (!hash || !digest.test(hash)) throw new Error('No se pudo verificar el archivo.');
    check();
    transferId = id(await call<Reply>('session_upload_begin', { url: endpoint.href, token: captured.token,
      paneId, sessionId, name: file.name, size: file.size, sha256: hash, ...(options.uploadId ? { uploadId: options.uploadId } : {}) }));
    check();
    for (let offset = 0; offset < file.size; offset += CHUNK) {
      const data = new Uint8Array(await file.slice(offset, offset + CHUNK).arrayBuffer()); check();
      const reply = requireNative(await call<Reply>('session_upload_write', { id: transferId, offset, data: encoded(data) }));
      if (reply.written !== offset + data.length) throw new Error('El iPhone no confirmó todos los bytes del adjunto.');
      check();
    }
    check();
    let aborted: (() => void) | undefined;
    const request = call<Reply>('session_upload_send', { id: transferId });
    const response = requireNative(await (signal ? Promise.race([request, new Promise<never>((_, reject) => {
      aborted = () => reject(signal.reason); signal.addEventListener('abort', aborted, { once: true });
      if (signal.aborted) aborted();
    })]) : request).finally(() => { if (aborted) signal?.removeEventListener('abort', aborted); }));
    check();
    if (typeof response.body !== 'string' || bytes(response.body) > 16 * 1024) throw new Error('La laptop no confirmó el adjunto.');
    let receipt: unknown;
    try { receipt = JSON.parse(response.body); } catch { throw new Error('La laptop no devolvió un recibo de adjunto válido.'); }
    if (response.status !== 200) throw new Error('La laptop rechazó el archivo; conserva la selección y revisa la conexión o los límites.');
    const value = receipt as Partial<UploadedFile> | null;
    if (!value || typeof value.uploadId !== 'string' || !uploadIdentifier.test(value.uploadId)
      || (options.uploadId && options.uploadId !== value.uploadId) || typeof value.name !== 'string' || !value.name || value.name.length > 120
      || value.name.startsWith('.') || /[/\\\p{Cc}\p{Cf}]/u.test(value.name) || value.size !== file.size
      || !['application/octet-stream', 'application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(value.mime ?? '')
      || value.path !== `uploads/${value.uploadId}/${value.name}`) throw new Error('El recibo no corresponde al adjunto enviado.');
    return { uploadId: value.uploadId, name: value.name, mime: value.mime!, size: value.size, path: value.path };
  } finally {
    signal?.removeEventListener('abort', cancel);
    await Promise.allSettled([
      ...(transferId ? [call('session_upload_cancel', { id: transferId })] : []),
      ...(hashId ? [call('crypto_hash_cancel', { id: hashId })] : []),
    ]);
  }
}
