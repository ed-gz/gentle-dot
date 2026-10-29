import { deviceInvoke, requireNative, type DeviceInvoker, type NativeReply } from './device-bridge.ts';
import { parseInvitation } from './device-pairing.ts';
import type { ScannedInvitation } from './pairing-qr.ts';
import { localIdentifier } from './local-identifiers.ts';

/** Recognition is input, never authorization. The form must still submit explicitly. */
export async function scanPairingCamera(call: DeviceInvoker = deviceInvoke, signal?: AbortSignal, id = localIdentifier()): Promise<ScannedInvitation | null> {
  signal?.throwIfAborted();
  const reply = requireNative(await call<NativeReply & { value?: unknown; cancelled?: unknown }>('pairing_scan', { id }));
  signal?.throwIfAborted();
  if (reply.cancelled === true && reply.value === undefined) return null;
  if (reply.cancelled !== false || typeof reply.value !== 'string') throw new Error('El escáner no devolvió una invitación válida.');
  const invitation = parseInvitation(reply.value);
  return { invitation, link: `gentledot://pair?${new URLSearchParams({ url: invitation.origin, code: invitation.code, name: invitation.name })}` };
}
export async function cancelPairingCamera(id: string): Promise<void> { requireNative(await deviceInvoke('pairing_scan_cancel', { id })); }
