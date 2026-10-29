// Stages private art from short-lived, step-scoped secrets without printing it.
import { appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { stagePersonalArtwork } from './personal-art.mjs';

try {
  const expected = process.env.CAPRI_TEMP_ART_SHA256 ?? '';
  const parts = ['CAPRI_TEMP_ART_1', 'CAPRI_TEMP_ART_2', 'CAPRI_TEMP_ART_3'].map(name => {
    const value = process.env[name] ?? '';
    if (!value || value.length > 48 * 1024 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('Invalid secret fragment');
    const bytes = Buffer.from(value, 'base64');
    if (bytes.toString('base64') !== value) throw new Error('Invalid base64');
    return bytes;
  });
  const bytes = Buffer.concat(parts);
  const source = process.env.CAPRI_SOURCE_SHA ?? '';
  const envFile = process.env.GITHUB_ENV ?? '';
  if (!/^[a-f0-9]{64}$/.test(expected) || !/^[a-f0-9]{40}$/.test(source) || !envFile ||
      createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('Input mismatch');
  stagePersonalArtwork(bytes, expected);
  appendFileSync(envFile, `CAPRI_PERSONAL_ART_SHA256=${expected}\nCAPRI_SOURCE_SHA=${source}\n`);
  console.log('Personal artwork staged and verified.');
} catch {
  // Never print fragments, image data, SHA inputs or environment values.
  console.error('Personal artwork staging failed.');
  process.exitCode = 1;
}
