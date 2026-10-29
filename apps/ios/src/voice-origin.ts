import { nativeSHA256 } from './device-bridge.ts';

// A recovery never guesses which conversation owns a voice command. This map
// stores only opaque IDs and the exact destination, never recorded audio/text.
const origins = new Map<string, string>();
const prefix = 'capri.voice.origin.';

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
