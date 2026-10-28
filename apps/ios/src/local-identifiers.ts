/** randomUUID may be absent on a custom WKWebView origin; random bytes remain required. */
export function localIdentifier(random: Pick<Crypto, 'getRandomValues'> & Partial<Pick<Crypto, 'randomUUID'>> = globalThis.crypto): string {
  if (typeof random?.randomUUID === 'function') return random.randomUUID();
  if (typeof random?.getRandomValues !== 'function') throw new Error('No se pudo generar un identificador seguro en este dispositivo.');
  const bytes = random.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
