import type { Operation } from './external-actions.ts';
export type GmailOperation = Extract<Operation, { kind: 'gmail.message' }>;
export type MailAttachment = { name: string; mime: string; bytes: Uint8Array };
export function base64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 8192) chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
  return btoa(chunks.join(''));
}
const utf8 = (text: string) => new TextEncoder().encode(text);
const folded = (encoded: string) => encoded.match(/.{1,76}/g)?.join('\r\n') ?? '';
function mailbox(value: string): string {
  if (!/^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$/.test(value) || value.length > 254) throw new Error('Usa direcciones de correo ASCII completas, sin nombres ni saltos de línea.');
  return value;
}
function mailboxes(name: string, values: string[]): string {
  return `${name}: ` + values.map(mailbox).join(',\r\n ');
}
function encodedWords(text: string): string {
  const words: string[] = []; let current = '';
  for (const char of text) {
    if (utf8(current + char).length > 42) { words.push(`=?UTF-8?B?${base64(utf8(current))}?=`); current = ''; }
    current += char;
  }
  if (current) words.push(`=?UTF-8?B?${base64(utf8(current))}?=`);
  return words.join('\r\n ');
}
/** Builds RFC822 MIME with no user-controlled raw headers and base64url for Gmail. */
export function gmailRaw(operation: GmailOperation, sender: string, attachments: MailAttachment[], boundary: string): string {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(boundary) || /[\r\n\u0000]/.test(operation.subject) || operation.subject.length > 500 || attachments.length > 5) throw new Error('Mensaje MIME inválido.');
  const headers = [mailboxes('From', [sender]), mailboxes('To', operation.to),
    ...(operation.cc.length ? [mailboxes('Cc', operation.cc)] : []), ...(operation.bcc.length ? [mailboxes('Bcc', operation.bcc)] : []),
    `Subject: ${encodedWords(operation.subject)}`, `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${boundary}@capri.invalid>`, 'MIME-Version: 1.0'];
  const plain = ['Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', folded(base64(utf8(operation.text)))].join('\r\n');
  let message: string;
  if (!attachments.length) message = headers.join('\r\n') + '\r\n' + plain;
  else {
    const parts = [plain];
    for (const file of attachments) {
      if (/[\r\n\u0000]/.test(file.name) || !/^[A-Za-z0-9.+_-]+\/[A-Za-z0-9.+_-]+$/.test(file.mime)) throw new Error('Adjunto MIME inválido.');
      const filename = encodeURIComponent(file.name).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
      // RFC2231 continuations keep physical header lines bounded for long Unicode names.
      const segments = filename.match(/(?:%[A-F0-9]{2}|[^%]){1,30}/g) ?? ['adjunto'];
      const disposition = 'Content-Disposition: attachment;\r\n ' + segments.map((part, index) => `filename*${index}*=${index === 0 ? "UTF-8''" : ''}${part}`).join(';\r\n ');
      parts.push([`Content-Type: ${file.mime}`, disposition, 'Content-Transfer-Encoding: base64', '', folded(base64(file.bytes))].join('\r\n'));
    }
    message = headers.join('\r\n') + `\r\nContent-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n` +
      parts.map(part => `--${boundary}\r\n${part}\r\n`).join('') + `--${boundary}--\r\n`;
  }
  return base64(utf8(message)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function gmailReadable(value: unknown): unknown {
  if (!value || typeof value !== 'object') throw new Error('Mensaje de Gmail inválido.');
  const message = value as Record<string, unknown>; const content: { mime: string; text: string; truncated: boolean }[] = [];
  const attachments: { name: string; mime: string; size: number; attachmentId?: string }[] = [];
  let total = 0; let visited = 0;
  const object = (input: unknown): input is Record<string, unknown> => !!input && typeof input === 'object' && !Array.isArray(input);
  function part(input: unknown, depth = 0): void {
    if (!object(input) || depth > 12 || ++visited > 200) return;
    const mime = typeof input.mimeType === 'string' ? input.mimeType : 'application/octet-stream';
    if (object(input.body) && typeof input.body.data === 'string' && ['text/plain', 'text/html'].includes(mime) && total < 40000) {
      const raw = input.body.data.replace(/-/g, '+').replace(/_/g, '/');
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(raw)) throw new Error('Contenido de Gmail inválido.');
      const decoded = new TextDecoder().decode(Uint8Array.from(atob(raw), char => char.charCodeAt(0)));
      const text = decoded.slice(0, 40000 - total); total += text.length;
      content.push({ mime, text, truncated: text.length < decoded.length });
    }
    if (typeof input.filename === 'string' && input.filename && object(input.body)) attachments.push({ name: input.filename, mime, size: typeof input.body.size === 'number' ? input.body.size : 0,
      ...(typeof input.body.attachmentId === 'string' ? { attachmentId: input.body.attachmentId } : {}) });
    if (Array.isArray(input.parts)) input.parts.forEach(child => part(child, depth + 1));
  }
  part(message.payload);
  const headers = object(message.payload) && Array.isArray(message.payload.headers) ? message.payload.headers.filter(header => object(header) && typeof header.name === 'string' && ['from', 'to', 'cc', 'subject', 'date'].includes(header.name.toLowerCase())).map(header => ({ name: header.name, value: header.value })) : [];
  return { id: message.id, threadId: message.threadId, snippet: message.snippet, headers, content, attachments, truncated: total >= 40000 || visited > 200, untrustedContent: true };
}
