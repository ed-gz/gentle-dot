import { deviceInvoke, requireNative, secretGet, secretSet, type NativeReply } from './device-bridge.ts';
import { localIdentifier } from './local-identifiers.ts';

export type Invitation = { origin: string; code: string; name: string };
export type PairedConnection = { url: string; token: string; deviceId: string; name: string };
export type PairingResult = { connection: PairedConnection; persisted: boolean; message?: string };
export class PairingRejected extends Error {}

/** Same public contract as Android pairing; no Android runtime or master credential. */
export function privateOrigin(input: string): string {
  if (/[\u0000-\u0020\u007f\\?#]/.test(input)) throw new Error('Dirección privada inválida.');
  let url: URL;
  try { url = new URL(input); } catch { throw new Error('Dirección privada inválida.'); }
  if (url.protocol !== 'https:' || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+\.ts\.net$/.test(url.hostname) || url.username || url.password || url.port || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) throw new Error('Usa el origen HTTPS privado de Tailscale, sin ruta ni credenciales.');
  return url.origin;
}
export function parseInvitation(input: string): Invitation {
  if (input.length > 4096) throw new Error('Invitación demasiado larga.');
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw new Error('Invitación inválida.'); }
  if (url.protocol !== 'gentledot:' || url.hostname !== 'pair' || url.username || url.password || url.port || url.hash || (url.pathname && url.pathname !== '/')) throw new Error('Abre una invitación gentledot://pair de tu laptop.');
  const allowed = new Set(['url', 'code', 'name']);
  for (const key of url.searchParams.keys()) if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) throw new Error('La invitación contiene campos inválidos.');
  const origin = privateOrigin(url.searchParams.get('url') ?? '');
  const code = url.searchParams.get('code') ?? '';
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(code)) throw new Error('Código de invitación inválido.');
  const name = Array.from((url.searchParams.get('name') || 'Gentle Dot').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim()).slice(0, 80).join('') || 'Gentle Dot';
  return { origin, code, name };
}
export function validConnection(value: unknown, origin: string): value is PairedConnection {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<PairedConnection>;
  return item.url === `${privateOrigin(origin).replace('https:', 'wss:')}/ws` && typeof item.token === 'string' && /^[A-Za-z0-9_-]{32,1024}$/.test(item.token) &&
    typeof item.deviceId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(item.deviceId) && typeof item.name === 'string' && Array.from(item.name).length <= 80;
}
export function pairingMessage(status?: number, code?: string): string {
  if (status === 403) return 'La laptop no aprobó la vinculación.';
  if (status === 400 || status === 401 || status === 410) return 'La invitación expiró o ya se usó. Genera otra en Gentle Dot.';
  if (status === 409) return code === 'PAIRING_IN_PROGRESS' ? 'La laptop ya está revisando esta invitación.' : 'Se alcanzó el límite de dispositivos vinculados.';
  if (status === 429) return 'Hay demasiados intentos. Espera antes de volver a vincular.';
  if (status === 503) return 'La laptop no pudo guardar el acceso del dispositivo.';
  return 'No se confirmó la vinculación. Revisa Tailscale y la aprobación en la laptop.';
}
export async function pairDevice(invitation: Invitation, deviceName = 'Capri iPhone', attemptId = localIdentifier()): Promise<PairingResult> {
  const origin = privateOrigin(invitation.origin);
  const name = Array.from(deviceName.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim()).slice(0, 80).join('') || 'Capri iPhone';
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(attemptId)) throw new Error('Identidad de vinculación inválida.');
  const reply = await deviceInvoke<NativeReply & { connection?: unknown; persisted?: boolean; status?: number }>('pair_device', { origin, code: invitation.code, deviceName: name, attemptId });
  if (!reply.ok) {
    const message = reply.message || pairingMessage(reply.status, reply.error);
    if ([400, 401, 403, 410, 429].includes(reply.status ?? 0)) throw new PairingRejected(message);
    throw new Error(message);
  }
  if (!validConnection(reply.connection, origin) || typeof reply.persisted !== 'boolean') throw new Error('La laptop devolvió una credencial inválida.');
  return { connection: reply.connection, persisted: reply.persisted, ...(reply.message ? { message: reply.message } : {}) };
}
/** A candidate is recoverable only by its exact precommitted attempt ID. */
export async function restorePairingAttempt(origin: string, attemptId: string, get: typeof secretGet = secretGet): Promise<PairedConnection | null> {
  origin = privateOrigin(origin);
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(attemptId)) throw new Error('Identidad de vinculación inválida.');
  const text = await get('daemon-pairing', `attempt:${attemptId}`);
  if (text === null) return null;
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('El acceso del intento no es válido.'); }
  if (!validConnection(value, origin)) throw new Error('El acceso del intento corresponde a otro host.');
  return value;
}
export async function restorePairing(origin: string): Promise<PairedConnection | null> {
  origin = privateOrigin(origin);
  const text = await secretGet('daemon-pairing', origin);
  if (text === null) return null;
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('La credencial guardada no es válida.'); }
  if (!validConnection(value, origin)) throw new Error('La credencial guardada corresponde a otro host.');
  return value;
}
export async function persistPairing(origin: string, connection: PairedConnection): Promise<void> {
  origin = privateOrigin(origin);
  if (!validConnection(connection, origin)) throw new Error('La credencial no corresponde a este host.');
  await secretSet('daemon-pairing', origin, JSON.stringify(connection));
}
/** Never deletes local access while host revocation remains unconfirmed. */
export async function unpairDevice(origin: string, token?: string): Promise<void> {
  const reply = await deviceInvoke('unpair_device', { origin: privateOrigin(origin), ...(token ? { token } : {}) });
  requireNative(reply);
}
