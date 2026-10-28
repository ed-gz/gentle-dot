#!/usr/bin/env node
// Personal bytes live in a PRIVATE release asset, never in the source repository.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

const maximum = 5 * 1024 * 1024;
const defaultOutput = fileURLToPath(new URL('../public/personal-art/', import.meta.url));
function require(condition, message) { if (!condition) throw new Error(message); }
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
export function validatePersonalPNG(bytes, expectedSHA256) {
  require(/^[a-f0-9]{64}$/.test(expectedSHA256), 'Expected a lowercase SHA-256 fingerprint.');
  require(bytes.length >= 57 && bytes.length <= maximum, 'PNG must be nonempty and at most 5 MiB.');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  require(sha256 === expectedSHA256, 'Personal artwork SHA-256 mismatch.');
  require(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'Expected PNG signature.');
  let offset = 8, ended = false, header = false; const data = [];
  while (offset < bytes.length) {
    require(offset + 12 <= bytes.length, 'Truncated PNG chunk.');
    const length = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8), end = offset + length + 12;
    require(end <= bytes.length && /^[A-Za-z]{4}$/.test(type), 'Invalid PNG chunk bounds or type.');
    require(crc32(bytes.subarray(offset + 4, end - 4)) === bytes.readUInt32BE(end - 4), 'Invalid PNG chunk CRC.');
    if (!header) {
      require(type === 'IHDR' && length === 13 && bytes.readUInt32BE(offset + 8) === 240 && bytes.readUInt32BE(offset + 12) === 420 &&
        bytes[offset + 16] === 8 && bytes[offset + 17] === 6 && bytes.subarray(offset + 18, offset + 21).every(value => value === 0), 'Expected 240×420, non-interlaced RGBA8 PNG.');
      header = true;
    } else require(type !== 'IHDR', 'Duplicate PNG header.');
    require(!['acTL', 'fcTL', 'fdAT'].includes(type), 'Expected the static personal rig PNG, not APNG.');
    if (type === 'IDAT') data.push(bytes.subarray(offset + 8, end - 4));
    if (type === 'IEND') { require(length === 0 && end === bytes.length, 'Invalid PNG end.'); ended = true; }
    offset = end;
  }
  require(ended && data.length > 0, 'Incomplete PNG.');
  const pixels = inflateSync(Buffer.concat(data), { maxOutputLength: 420 * (240 * 4 + 1) });
  require(pixels.length === 420 * (240 * 4 + 1), 'Invalid decoded PNG size.');
  for (let y = 0; y < 420; y++) require(pixels[y * (240 * 4 + 1)] <= 4, 'Invalid PNG row filter.');
  return { schemaVersion: 1, file: 'capri-full.png', sha256, size: bytes.length, width: 240, height: 420 };
}
export function stagePersonalArtwork(bytes, expectedSHA256, output = defaultOutput) {
  const manifest = validatePersonalPNG(bytes, expectedSHA256);
  mkdirSync(output, { recursive: true, mode: 0o700 });
  writeFileSync(join(output, 'capri-full.png.tmp'), bytes, { mode: 0o600 });
  writeFileSync(join(output, 'manifest.json.tmp'), JSON.stringify(manifest) + '\n', { mode: 0o600 });
  renameSync(join(output, 'capri-full.png.tmp'), join(output, 'capri-full.png'));
  renameSync(join(output, 'manifest.json.tmp'), join(output, 'manifest.json'));
  return manifest;
}
export function verifyPersonalArtwork(directory, expectedSHA256) {
  require(statSync(join(directory, 'manifest.json')).size <= 2048, 'Oversized personal manifest.');
  require(statSync(join(directory, 'capri-full.png')).size <= maximum, 'Oversized personal PNG.');
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
  const expected = validatePersonalPNG(readFileSync(join(directory, 'capri-full.png')), expectedSHA256);
  require(JSON.stringify(manifest) === JSON.stringify(expected), 'Personal artwork manifest mismatch.');
  return expected;
}
export function downloadPrivateArtwork(repository, assetID, expectedSHA256, output = defaultOutput) {
  require(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository), 'Invalid private artwork repository.');
  require(/^[1-9][0-9]{0,15}$/.test(assetID), 'Invalid private release asset ID.');
  require(/^[a-f0-9]{64}$/.test(expectedSHA256), 'Invalid artwork fingerprint.');
  const api = (...args) => execFileSync('gh', ['api', ...args], { maxBuffer: maximum + 1024, timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
  const repo = JSON.parse(api(`repos/${repository}`));
  require(repo.private === true && repo.full_name.toLowerCase() === repository.toLowerCase(), 'Personal builds require a PRIVATE repository.');
  const asset = JSON.parse(api(`repos/${repository}/releases/assets/${assetID}`));
  require(asset.name === 'capri-full.png' && asset.state === 'uploaded' && asset.size > 0 && asset.size <= maximum, 'Unexpected personal release asset.');
  if (asset.digest) require(asset.digest === `sha256:${expectedSHA256}`, 'Release asset digest mismatch.');
  return stagePersonalArtwork(api(`repos/${repository}/releases/assets/${assetID}`, '-H', 'Accept: application/octet-stream'), expectedSHA256, output);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (command === 'stage' && args.length >= 2 && args.length <= 3) {
      require(statSync(args[0]).size <= maximum, 'Oversized personal PNG.');
      stagePersonalArtwork(readFileSync(args[0]), args[1], args[2]);
    } else if (command === 'verify' && args.length === 2) verifyPersonalArtwork(...args);
    else if (command === 'download' && args.length >= 3 && args.length <= 4) downloadPrivateArtwork(...args);
    else throw new Error('Usage: personal-art.mjs stage PNG SHA256 [OUTPUT] | verify DIRECTORY SHA256 | download PRIVATE_REPO ASSET_ID SHA256 [OUTPUT]');
    console.log('Personal Capri artwork verified (240×420); no image bytes printed.');
  } catch (error) { console.error(error instanceof Error && !('stderr' in error) ? error.message : 'Private artwork provisioning failed.'); process.exitCode = 1; }
}
