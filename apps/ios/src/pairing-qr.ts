import { invoke, isTauri } from '@tauri-apps/api/core';
import { parseInvitation, type Invitation } from './device-pairing.ts';
import { hashSourceBytes, MAX_DOCUMENT_BYTES, validateDocument } from './perception.ts';
import { localIdentifier } from './local-identifiers.ts';

export const MAX_PAIRING_IMAGE_BYTES = MAX_DOCUMENT_BYTES;
export type ScannedInvitation = { invitation: Invitation; link: string };
type ScanSource = { name: string; type: string; size: number; sha256: string };
type ScanCall = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
const native: ScanCall = async (command, args) => {
  if (!isTauri()) throw new Error('Lee el QR desde Capri instalada en el iPhone. Aquí puedes pegar una invitación.');
  try { return await invoke(`plugin:perception|${command}`, args); }
  catch { throw new Error('No se pudo leer el QR en esta instalación. Comprueba otra vez o pega la invitación.'); }
};
export function validatePairingImage(file: Pick<File, 'name' | 'type' | 'size'>): void {
  validateDocument(file);
  if (file.type === 'application/pdf') throw new Error('Elige una foto o captura del QR, no un PDF.');
}
export function parseScannedInvitation(value: unknown, expected: ScanSource): ScannedInvitation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('La lectura del QR no es válida.');
  const reply = value as Record<string, unknown>;
  if (reply.ok !== true) {
    const errors: Record<string, string> = {
      invalid_image: 'No pude abrir la imagen. Usa una foto o captura de hasta 12 MiB.',
      too_many_codes: 'Hay demasiados códigos. Recorta la foto para mostrar sólo el QR de Gentle Dot.',
      invalid_code: 'El QR no contiene una invitación válida de Gentle Dot.',
      not_foreground: 'Vuelve a Capri y selecciona otra vez la foto del QR.',
      busy: 'Hay otra lectura de QR en curso. Espera un momento e intenta de nuevo.',
      cancelled: 'Lectura cancelada. No se vinculó ningún equipo.',
      scan_timeout: 'La lectura tardó demasiado. Acerca el QR o usa una captura nítida.',
    };
    throw new Error(errors[String(reply.error)] ?? 'No pude leer el QR. Prueba con otra foto o pega la invitación.');
  }
  const source = reply.source as Partial<{ name: string; mimeType: string; size: number; sha256: string }> | null;
  if (reply.engine !== 'apple-vision' || !source || source.name !== expected.name || source.mimeType !== expected.type
    || source.size !== expected.size || source.sha256 !== expected.sha256 || !/^[a-f0-9]{64}$/.test(expected.sha256))
    throw new Error('La lectura no corresponde a la foto seleccionada. Intenta de nuevo.');
  if (!Array.isArray(reply.codes) || reply.codes.length > 16 || reply.codes.some(code => typeof code !== 'string' || !code.length || code.length > 4096))
    throw new Error('La lectura del QR no es válida.');
  if (!reply.codes.length) throw new Error('No encontré un QR legible. Acerca la cámara o elige una captura nítida.');
  const invitations = new Map<string, Invitation>();
  for (const code of reply.codes) {
    try { const invitation = parseInvitation(code); invitations.set(JSON.stringify([invitation.origin, invitation.code]), invitation); }
    catch { /* Unrelated QR content is never opened, rendered or treated as authorization. */ }
  }
  if (!invitations.size) throw new Error('Ese QR no es una invitación de Gentle Dot. Abre el QR de vinculación en tu laptop.');
  if (invitations.size !== 1) throw new Error('La foto contiene varias invitaciones. Recórtala para elegir sólo tu equipo.');
  const invitation = [...invitations.values()][0]!;
  return { invitation, link: `gentledot://pair?${new URLSearchParams({ url: invitation.origin, code: invitation.code, name: invitation.name })}` };
}
export async function scanPairingCode(file: File, call: ScanCall = native, signal?: AbortSignal, requestId = localIdentifier()): Promise<ScannedInvitation> {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(requestId)) throw new Error('Identificador de lectura inválido.');
  signal?.throwIfAborted();
  validatePairingImage(file);
  const buffer = await file.arrayBuffer();
  signal?.throwIfAborted();
  if (buffer.byteLength !== file.size) throw new Error('La imagen cambió durante la lectura. Selecciónala otra vez.');
  const bytes = new Uint8Array(buffer);
  const sha256 = await hashSourceBytes(bytes);
  signal?.throwIfAborted();
  const parts: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 8192) parts.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
  const result = await call('scan_pairing_code', { request: { requestId, base64: btoa(parts.join('')), mimeType: file.type, fileName: file.name } });
  signal?.throwIfAborted();
  return parseScannedInvitation(result, { name: file.name, type: file.type, size: file.size, sha256 });
}
export async function cancelPairingCode(requestId: string, call: ScanCall = native): Promise<void> {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(requestId)) throw new Error('Identificador de lectura inválido.');
  const result = await call('cancel_pairing_code', { requestId });
  if (!result || typeof result !== 'object' || Array.isArray(result) || (result as Record<string, unknown>).ok !== true) throw new Error('No se confirmó el cierre de la lectura.');
}
