import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  readSettings, saveSettings, validDaemonUrl,
  validateArtwork, saveArtwork, loadArtwork, deleteArtwork,
} from '../src/local-state.ts';

const saved = value => ({ getItem: () => JSON.stringify(value) });

test('settings default safely for absent, corrupt, and inaccessible storage', () => {
  const expected = { url: '', motion: 'full' };
  for (const storage of [
    { getItem: () => null },
    { getItem: () => '{broken' },
    { getItem: () => { throw new Error('denied'); } },
    ...[null, 0, 'text', [], true].map(saved),
  ]) {
    assert.deepEqual(readSettings(storage), expected);
  }
  const one = readSettings(saved(null));
  one.motion = 'paused';
  assert.deepEqual(readSettings(saved(null)), expected);
});

test('settings preserve only a valid endpoint and recognized motion preference', () => {
  for (const motion of ['full', 'reduced', 'paused']) {
    assert.deepEqual(readSettings(saved({ url: ' wss://CAPRI.example:443/ws ', motion, token: 'secret' })), {
      url: 'wss://capri.example/ws', motion,
    });
  }
  assert.deepEqual(readSettings(saved({ url: 'https://capri.example/ws', motion: 'paused' })), {
    url: '', motion: 'paused',
  });
  assert.deepEqual(readSettings(saved({ url: 23, motion: 'unknown' })), { url: '', motion: 'full' });
});

test('daemon URL validation canonicalizes secure endpoints without credentials', () => {
  assert.equal(validDaemonUrl('  wss://CAPRI.example:443/ws  '), 'wss://capri.example/ws');
  assert.equal(validDaemonUrl('wss://127.0.0.1:4317/ws'), 'wss://127.0.0.1:4317/ws');
  assert.equal(validDaemonUrl('wss://[::1]/ws'), 'wss://[::1]/ws');
  for (const url of [
    '', '/ws', 'ws://capri.example/ws', 'https://capri.example/ws', 'wss:capri.example/ws',
    'wss:///ws', 'wss://', 'wss://user@capri.example/ws', 'wss://user:pass@capri.example/ws',
    'wss://capri.example/ws?token=secret', 'wss://capri.example/ws?',
    'wss://capri.example/ws#token', 'wss://capri.example/ws#', 'wss://@capri.example/ws',
    'wss://capri.\nexample/ws', 'wss://capri.example/w s', 'wss://capri.example\\ws',
  ]) assert.throws(() => validDaemonUrl(url), undefined, url);
});

test('saving settings uses an explicit allowlist and supports independent mode', () => {
  const writes = [];
  const storage = { setItem: (key, value) => writes.push([key, JSON.parse(value)]) };
  assert.equal(saveSettings({
    url: 'wss://CAPRI.example:443/ws', motion: 'reduced',
    token: 'secret', conversation: ['private'], draft: 'private',
  }, storage), true);
  assert.deepEqual(writes, [['capri.ios.settings.v1', { url: 'wss://capri.example/ws', motion: 'reduced' }]]);
  assert.equal(saveSettings({ url: ' ', motion: 'paused' }, storage), true);
  assert.deepEqual(writes.at(-1)[1], { url: '', motion: 'paused' });
  assert.equal(saveSettings({ url: '', motion: 'invalid' }, storage), true);
  assert.deepEqual(writes.at(-1)[1], { url: '', motion: 'full' });
});

test('saving reports storage failures and rejects invalid endpoints without writing', () => {
  const denied = { setItem: () => { throw new Error('quota'); } };
  assert.equal(saveSettings({ url: '', motion: 'full' }, denied), false);
  let writes = 0;
  const storage = { setItem: () => { writes++; } };
  assert.equal(saveSettings({ url: 'wss://capri.example/ws?token=secret', motion: 'full' }, storage), false);
  assert.equal(saveSettings({ url: 'ws://capri.example/ws', motion: 'full' }, storage), false);
  assert.equal(saveSettings(null, storage), false);
  assert.equal(writes, 0);
});

test('artwork bounds enforce PNG MIME, nonempty data, and the exact 5 MiB limit', () => {
  assert.doesNotThrow(() => validateArtwork(new Blob(['png'], { type: 'image/png' })));
  assert.doesNotThrow(() => validateArtwork(new Blob([new Uint8Array(5 * 1024 * 1024)], { type: 'image/png' })));
  for (const blob of [
    new Blob([], { type: 'image/png' }),
    new Blob(['png']),
    new Blob(['png'], { type: 'image/jpeg' }),
    new Blob(['png'], { type: 'image/svg+xml' }),
    new Blob([new Uint8Array(5 * 1024 * 1024 + 1)], { type: 'image/png' }),
    { type: 'image/png', size: 3 }, null,
  ]) assert.throws(() => validateArtwork(blob), /PNG/);
});

test('artwork rejects unsupported storage and invalid saves instead of hanging', async () => {
  assert.equal(globalThis.indexedDB, undefined);
  await assert.rejects(loadArtwork(), /no está disponible/);
  await assert.rejects(deleteArtwork(), /no está disponible/);
  await assert.rejects(saveArtwork(new Blob(['png'], { type: 'image/png' })), /no está disponible/);
  await assert.rejects(saveArtwork(new Blob(['bad'], { type: 'image/jpeg' })), /PNG/);
});
