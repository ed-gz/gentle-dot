import { nativeSHA256 } from './device-bridge.ts';

// A recovery never guesses which conversation owns a voice command. This map
// stores only opaque IDs and the exact destination, never recorded audio/text.
const origins = new Map<string, string>();
const prefix = 'capri.voice.origin.';
const cancellationPrefix = 'capri.voice.cancel-pending.';
const uncertainCancellations = new Set<string>();
const ownerID = (value: string) => /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value);

/** The native bridge may lose a cancellation reply. Keep only the opaque
 * owner so another panel can retry the same cancellation before recording. */
export function markVoiceCancellation(owner: string): void {
  if (!ownerID(owner)) throw new Error('No se pudo identificar el dictado.');
  uncertainCancellations.add(owner);
  try { sessionStorage.setItem(cancellationPrefix + owner, '1'); } catch { /* In-memory protection remains. */ }
}
export function clearVoiceCancellation(owner: string): void {
  uncertainCancellations.delete(owner);
  try { sessionStorage.removeItem(cancellationPrefix + owner); } catch { /* A stale marker can safely be retried later. */ }
}
export function pendingVoiceCancellation(): string | undefined {
  if (uncertainCancellations.size) return uncertainCancellations.values().next().value;
  try {
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (!key?.startsWith(cancellationPrefix)) continue;
      const owner = key.slice(cancellationPrefix.length);
      if (ownerID(owner) && sessionStorage.getItem(key) === '1') { uncertainCancellations.add(owner); return owner; }
    }
  } catch { /* No storage access; use the in-memory set. */ }
  return undefined;
}

export async function sessionVoiceOrigin(destination: string): Promise<string> {
  if (!destination || destination.length > 8192) throw new Error('No se pudo identificar la sesión del dictado.');
  const hash = globalThis.crypto?.subtle
    ? [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(destination)))].map(byte => byte.toString(16).padStart(2, '0')).join('')
    : await nativeSHA256(destination);
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('No se pudo identificar la sesión del dictado.');
  return `session:${hash}`;
}

export function rememberVoiceOrigin(owner: string, origin: string): void {
  if (!owner || !origin || origin.length > 8192) throw new Error('No se pudo identificar el destino del dictado.');
  origins.set(owner, origin);
  try { sessionStorage.setItem(prefix + owner, origin); } catch { /* In-memory origin remains available in this web view. */ }
}
export function voiceOrigin(owner: string): string | undefined {
  if (origins.has(owner)) return origins.get(owner);
  try { const origin = sessionStorage.getItem(prefix + owner); return origin && origin.length <= 8192 ? origin : undefined; }
  catch { return undefined; }
}
export function forgetVoiceOrigin(owner: string): void {
  origins.delete(owner);
  try { sessionStorage.removeItem(prefix + owner); } catch { /* No credential or audio is stored here. */ }
}
