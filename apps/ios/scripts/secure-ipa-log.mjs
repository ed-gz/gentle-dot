#!/usr/bin/env node
// Only ciphertext is emitted. CAPRI_TEMP_IPA_KEY must be a random 256-bit key.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

const max = 20 * 1024 * 1024, chunk = 3072;
const keyText = process.env.CAPRI_TEMP_IPA_KEY ?? '';
if (!/^[a-f0-9]{64}$/.test(keyText)) throw new Error('Missing 256-bit encryption key.');
const key = Buffer.from(keyText, 'hex');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

function emit(path) {
  const input = readFileSync(path);
  const source = process.env.CAPRI_SOURCE_SHA ?? '';
  if (!/^[a-f0-9]{40}$/.test(source)) throw new Error('Missing source revision.');
  if (!input.length || input.length > max) throw new Error('IPA size outside allowed bounds.');
  const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(`capri-ipa-log-v1:${source}`, 'utf8'));
  const data = Buffer.concat([cipher.update(input), cipher.final()]), tag = cipher.getAuthTag();
  const count = Math.ceil(data.length / chunk);
  console.log(`CAPRI_ENCRYPTED_IPA_META v1 ${source} ${nonce.toString('hex')} ${tag.toString('hex')} ${data.length} ${sha(data)} ${count}`);
  for (let i = 0; i < count; i++) console.log(`CAPRI_ENCRYPTED_IPA_PART ${i + 1}/${count} ${data.subarray(i * chunk, (i + 1) * chunk).toString('base64')}`);
}

function extract(logPath, outputPath, expectedSource) {
  if (!/^[a-f0-9]{40}$/.test(expectedSource)) throw new Error('Invalid expected source revision.');
  const lines = readFileSync(logPath, 'utf8').split(/\r?\n/);
  const parts = new Map(); let meta;
  for (const line of lines) {
    let match = line.match(/CAPRI_ENCRYPTED_IPA_META v1 ([a-f0-9]{40}) ([a-f0-9]{24}) ([a-f0-9]{32}) ([0-9]+) ([a-f0-9]{64}) ([0-9]+)$/);
    if (match) {
      if (meta) throw new Error('Duplicate metadata.');
      meta = { source: match[1], nonce: match[2], tag: match[3], size: Number(match[4]), hash: match[5], count: Number(match[6]) };
      continue;
    }
    match = line.match(/CAPRI_ENCRYPTED_IPA_PART ([0-9]+)\/([0-9]+) ([A-Za-z0-9+/=]+)$/);
    if (match) {
      const index = Number(match[1]), count = Number(match[2]), encoded = match[3], bytes = Buffer.from(encoded, 'base64');
      if (!Number.isSafeInteger(index) || index < 1 || !Number.isSafeInteger(count) || count > Math.ceil(max / chunk) || index > count ||
          parts.has(index) || bytes.toString('base64') !== encoded || bytes.length > chunk) throw new Error('Invalid or duplicated encrypted part.');
      parts.set(index, { count, bytes });
    }
  }
  if (!meta || meta.source !== expectedSource || !Number.isSafeInteger(meta.size) || meta.size < 1 || meta.size > max ||
      meta.count !== Math.ceil(meta.size / chunk) || parts.size !== meta.count) throw new Error('Missing or invalid encrypted IPA parts.');
  const data = Buffer.concat(Array.from({length: meta.count}, (_, i) => {
    const part = parts.get(i + 1); if (!part || part.count !== meta.count) throw new Error('Missing encrypted IPA part.'); return part.bytes;
  }));
  if (data.length !== meta.size || sha(data) !== meta.hash) throw new Error('Encrypted IPA integrity check failed.');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(meta.nonce, 'hex'));
  decipher.setAAD(Buffer.from(`capri-ipa-log-v1:${expectedSource}`, 'utf8')); decipher.setAuthTag(Buffer.from(meta.tag, 'hex'));
  // Authentication must succeed before any output file is written.
  const plain = Buffer.concat([decipher.update(data), decipher.final()]);
  mkdirSync(dirname(outputPath), { recursive: true });
  const tmp = `${outputPath}.tmp-${randomBytes(8).toString('hex')}`;
  try { writeFileSync(tmp, plain, { mode: 0o600, flag: 'wx' }); renameSync(tmp, outputPath); }
  finally { try { unlinkSync(tmp); } catch {} }
  console.log(`Decrypted IPA: ${outputPath} (${plain.length} bytes; SHA-256 ${sha(plain)})`);
}

try {
  if (process.argv.length === 4 && process.argv[2] === 'emit') emit(process.argv[3]);
  else if (process.argv.length === 6 && process.argv[2] === 'extract') extract(process.argv[3], process.argv[4], process.argv[5]);
  else throw new Error('Usage: secure-ipa-log.mjs emit IPA | extract LOG OUTPUT SOURCE_SHA');
} catch (error) {
  console.error(`Encrypted IPA operation failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exitCode = 1;
}
