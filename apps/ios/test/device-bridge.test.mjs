import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { validSharedImport, listSharedImports, readSharedFile, importSharedItem, recoverImportBatch, nativeSHA256Bytes } from '../src/device-bridge.ts';
import { privateOrigin, parseInvitation, validConnection, pairingMessage } from '../src/device-pairing.ts';

const origin = 'https://workstation.tail1234.ts.net';
const invitation = `gentledot://pair?url=${encodeURIComponent(origin)}&code=${'c'.repeat(24)}&name=Gentle%20Dot`;
const id = 'd5a6e456-7a93-4bcc-b006-4493c78b5b66';
const fileId = 'c623087b-1af4-4b20-a20a-31d33e419171';
const bytes = Buffer.from('Reunión: acuerdo confirmado a los 00:13.');
const manifest = () => ({ schemaVersion: 1, id, title: 'Reunión', notes: 'Conservar evidencia.', createdAt: 1793145600000,
  files: [{ id: fileId, name: 'transcripción.txt', mime: 'text/plain', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }] });

test('pairing accepts only private origins and an unambiguous invitation', () => {
  assert.equal(privateOrigin(origin + '/'), origin);
  assert.deepEqual(parseInvitation(invitation), { origin, code: 'c'.repeat(24), name: 'Gentle Dot' });
  for (const value of ['https://example.com', 'http://workstation.tail1234.ts.net', `${origin}/ws`, `${origin}?token=x`, `${origin}#fragment`, 'https://user@workstation.tail1234.ts.net', 'https://workstation.tail1234.ts.net:444']) assert.throws(() => privateOrigin(value));
  for (const value of [invitation + '&code=duplicate', invitation + '&token=secret', invitation + '#extra', invitation.replace('gentledot:', 'https:'), invitation.replace('c'.repeat(24), 'c'.repeat(101))]) assert.throws(() => parseInvitation(value));
});

test('credentials remain tied to their exact host; approval failures are explicit', () => {
  const credential = { url: origin.replace('https:', 'wss:') + '/ws', token: 't'.repeat(48), deviceId: 'mobile_123', name: 'Capri iPhone' };
  assert.equal(validConnection(credential, origin), true);
  assert.equal(validConnection(credential, 'https://other.tail1234.ts.net'), false);
  assert.equal(validConnection({ ...credential, token: 'bad' }, origin), false);
  assert.match(pairingMessage(403), /no aprobó/);
  assert.match(pairingMessage(409, 'PAIRING_IN_PROGRESS'), /revisando/);
  assert.match(pairingMessage(503), /guardar/);
});

test('shared manifests enforce UUIDs, size limits, hashes, and unique files', async () => {
  const item = manifest(); assert.equal(validSharedImport(item), true);
  for (const bad of [{ ...item, id: '../../escape' }, { ...item, files: [...item.files, ...item.files] }, { ...item, files: [] },
    { ...item, files: [{ ...item.files[0], size: 26 * 1024 * 1024 }] }, { ...item, files: [{ ...item.files[0], sha256: 'bad' }] }, { ...item, notes: 'a'.repeat(8001) }]) assert.equal(validSharedImport(bad), false);
  await assert.rejects(listSharedImports(async () => ({ ok: true, items: [{ ...item, id: '../bad' }] })), /inválido/);
});

test('shared file chunks preserve bytes and reject corruption before any acknowledgement', async () => {
  const item = manifest(); const requests = [];
  const call = async (command, request) => { requests.push({ command, request }); return { ok: true, data: bytes.subarray(request.offset, request.offset + request.length).toString('base64') }; };
  const file = await readSharedFile(item, item.files[0], call);
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), bytes);
  assert.equal(requests.length, 1); assert.equal(requests[0].request.length, bytes.length);
  await assert.rejects(readSharedFile(item, item.files[0], async () => ({ ok: true, data: Buffer.alloc(bytes.length, 97).toString('base64') })), /huella/);
  await assert.rejects(readSharedFile(item, item.files[0], async () => ({ ok: true, data: '' })), /incompleto/);
});

test('shared bytes are verified even when WebCrypto is unavailable', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  try {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined });
    const item = manifest();
    await assert.rejects(readSharedFile(item, item.files[0], async () => ({ ok: true, data: Buffer.alloc(bytes.length, 97).toString('base64') })), /huella/);
  } finally {
    if (original) Object.defineProperty(globalThis, 'crypto', original);
    else delete globalThis.crypto;
  }
});

test('share ACK waits for durable app save and retry uses the same deduplication identity', async () => {
  const item = manifest(); const events = []; const saved = new Set();
  const call = async (command) => { events.push(command); return command === 'share_read' ? { ok: true, data: bytes.toString('base64') } : { ok: true }; };
  await assert.rejects(importSharedItem(item, async () => { events.push('save_failed'); throw new Error('quota'); }, call), /quota/);
  assert.deepEqual(events, ['share_read', 'save_failed']);
  events.length = 0;
  const save = async ({ sourceId, files }) => { assert.equal(files[0].size, bytes.length); saved.add(sourceId); events.push('committed'); };
  await importSharedItem(item, save, call);
  await importSharedItem(item, save, call);
  assert.deepEqual([...saved], [`share:${id}`]);
  assert.deepEqual(events, ['share_read', 'committed', 'share_ack', 'share_read', 'committed', 'share_ack']);
});

test('recovery keeps a damaged share pending while continuing to later shares', async () => {
  const broken = manifest();
  const intact = { ...manifest(), id: '65a6e456-7a93-4bcc-b006-4493c78b5b66', title: 'Audio de la segunda reunión' };
  const events = [];
  const call = async (command, request) => {
    events.push([command, request.id]);
    if (command === 'share_read') return { ok: true, data: (request.id === broken.id ? Buffer.alloc(bytes.length, 97) : bytes).toString('base64') };
    return { ok: true };
  };
  const committed = [];
  const result = await recoverImportBatch([broken, intact], item => importSharedItem(item, async ({ sourceId }) => { committed.push(sourceId); }, call));
  assert.equal(result.recovered, 1);
  assert.deepEqual(result.failures.map(failure => failure.title), ['Reunión']);
  assert.match(result.failures[0].message, /huella/);
  assert.deepEqual(committed, [`share:${intact.id}`]);
  assert.deepEqual(events.filter(([command]) => command === 'share_ack'), [['share_ack', intact.id]]);
});

test('native hash fallback sends bounded binary chunks and cleans up on failures', async () => {
  const source = Uint8Array.from({ length: 700_000 }, (_, index) => index % 256);
  const hash = createHash('sha256'); let chunks = 0; let cancelled = false;
  const actual = await nativeSHA256Bytes(source, async (command, request) => {
    if (command === 'crypto_hash_begin') return { ok: true, id };
    if (command === 'crypto_hash_update') {
      const chunk = Buffer.from(request.data, 'base64'); assert.ok(chunk.length <= 256 * 1024); hash.update(chunk); chunks++;
    }
    if (command === 'crypto_hash_finish') return { ok: true, hex: hash.digest('hex') };
    if (command === 'crypto_hash_cancel') cancelled = true;
    return { ok: true };
  });
  assert.equal(actual, createHash('sha256').update(source).digest('hex'));
  assert.equal(chunks, 3); assert.equal(cancelled, true);
  cancelled = false;
  await assert.rejects(nativeSHA256Bytes(source, async command => {
    if (command === 'crypto_hash_begin') return { ok: true, id };
    if (command === 'crypto_hash_cancel') { cancelled = true; return { ok: true }; }
    return { ok: false, message: 'interrupted' };
  }), /interrupted/);
  assert.equal(cancelled, true);
});

test('XcodeGen configurator adds and embeds extension idempotently without losing existing capabilities', () => {
  const dir = mkdtempSync(join(tmpdir(), 'capri-share-config-'));
  try {
    const path = join(dir, 'project.yml');
    writeFileSync(path, JSON.stringify({ name: 'capri', targets: { capri_iOS: { type: 'application', platform: 'iOS',
      sources: [{ path: 'Sources' }], info: { path: 'capri_iOS/Info.plist', properties: { CFBundleVersion: '42', NSMicrophoneUsageDescription: 'Usar voz', UIBackgroundModes: ['fetch'], BGTaskSchedulerPermittedIdentifiers: ['other.existing.job'] } },
      entitlements: { path: 'capri_iOS/capri_iOS.entitlements', properties: { 'test.existing': true } },
      dependencies: [{ sdk: 'WebKit.framework' }], preBuildScripts: [{ name: 'Build Rust Code', script: 'cargo tauri ios xcode-script' }] } } }));
    const script = new URL('../scripts/configure-share-extension.rb', import.meta.url).pathname;
    for (let i = 0; i < 2; i++) {
      const result = spawnSync('ruby', [script, path, '--spec-only'], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    }
    const parsed = spawnSync('ruby', ['-ryaml', '-rjson', '-e', 'puts JSON.generate(YAML.safe_load(File.read(ARGV[0]), aliases: true))', path], { encoding: 'utf8' });
    assert.equal(parsed.status, 0, parsed.stderr);
    const { targets } = JSON.parse(parsed.stdout);
    assert.equal(targets.capri_iOS.preBuildScripts[0].name, 'Build Rust Code');
    assert.equal(targets.capri_iOS.info.properties.NSMicrophoneUsageDescription, 'Usar voz');
    assert.match(targets.capri_iOS.info.properties.NSLocalNetworkUsageDescription, /laptop que vinculas.*sesiones.*autorizas/);
    assert.match(targets.capri_iOS.info.properties.NSCameraUsageDescription, /cuando eliges.*QR.*capturar.*adjuntarlo/);
    assert.equal(targets.capri_iOS.info.properties.NSPhotoLibraryUsageDescription, undefined);
    assert.deepEqual(targets.capri_iOS.info.properties.UIBackgroundModes, ['fetch', 'processing']);
    assert.deepEqual(targets.capri_iOS.info.properties.BGTaskSchedulerPermittedIdentifiers, ['other.existing.job', '$(PRODUCT_BUNDLE_IDENTIFIER).capri-inference.*']);
    assert.equal(targets.capri_iOS.entitlements.properties['com.apple.developer.background-tasks.continued-processing.gpu'], undefined);
    assert.equal(targets.capri_iOS.entitlements.properties['com.apple.developer.background-tasks.continued-processing.inference'], undefined);
    assert.equal(targets.capri_iOS.entitlements.properties['test.existing'], true);
    assert.equal(targets.capri_iOS.dependencies.filter(item => item.target === 'CapriShare').length, 1);
    assert.equal(targets.capri_iOS.info.properties.CFBundleURLTypes.length, 2);
    assert.deepEqual(targets.capri_iOS.info.properties.CFBundleURLTypes.find(item => item.CFBundleURLName === 'dev.gentledot.capri.mcp-oauth').CFBundleURLSchemes, ['dev.gentledot.capri.auth']);
    assert.equal(targets.CapriShare.type, 'app-extension');
    assert.equal(targets.CapriShare.info.properties.CFBundleVersion, '42');
    assert.deepEqual(targets.CapriShare.entitlements.properties['com.apple.security.application-groups'], targets.capri_iOS.entitlements.properties['com.apple.security.application-groups']);
    assert.match(targets.CapriShare.info.properties.NSExtension.NSExtensionAttributes.NSExtensionActivationRule, /public.audio/);
    assert.doesNotMatch(readFileSync(path, 'utf8'), /TRUEPREDICATE/);
    targets.capri_iOS.info.properties.NSCameraUsageDescription = 'Propósito de cámara personalizado';
    writeFileSync(path, JSON.stringify({ name: 'capri', targets }));
    for (let i = 0; i < 2; i++) {
      const result = spawnSync('ruby', [script, path, '--spec-only'], { encoding: 'utf8', env: { ...process.env, CAPRI_GOOGLE_CLIENT_ID: '123-example.apps.googleusercontent.com' } });
      assert.equal(result.status, 0, result.stderr);
    }
    const google = spawnSync('ruby', ['-ryaml', '-rjson', '-e', 'puts JSON.generate(YAML.safe_load(File.read(ARGV[0]), aliases: true))', path], { encoding: 'utf8' });
    const info = JSON.parse(google.stdout).targets.capri_iOS.info.properties;
    assert.equal(info.NSCameraUsageDescription, 'Propósito de cámara personalizado');
    assert.equal(info.NSMicrophoneUsageDescription, 'Usar voz');
    assert.deepEqual(info.UIBackgroundModes, ['fetch', 'processing']);
    assert.deepEqual(info.BGTaskSchedulerPermittedIdentifiers, ['other.existing.job', '$(PRODUCT_BUNDLE_IDENTIFIER).capri-inference.*']);
    assert.equal(info.CapriGoogleClientID, '123-example.apps.googleusercontent.com');
    assert.equal(info.CFBundleURLTypes.length, 3);
    assert.deepEqual(info.CFBundleURLTypes.find(item => item.CFBundleURLName === 'dev.gentledot.capri.google').CFBundleURLSchemes, ['com.googleusercontent.apps.123-example']);
    const before = readFileSync(path, 'utf8');
    const invalid = spawnSync('ruby', [script, path, '--spec-only'], { encoding: 'utf8', env: { ...process.env, CAPRI_GOOGLE_CLIENT_ID: 'not a client id' } });
    assert.notEqual(invalid.status, 0);
    assert.equal(readFileSync(path, 'utf8'), before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('background task configuration rejects malformed existing plist arrays without rewriting the project', () => {
  const dir = mkdtempSync(join(tmpdir(), 'capri-background-config-'));
  try {
    const path = join(dir, 'project.yml');
    const script = new URL('../scripts/configure-share-extension.rb', import.meta.url).pathname;
    for (const invalid of [
      { UIBackgroundModes: 'processing' },
      { UIBackgroundModes: [42] },
      { BGTaskSchedulerPermittedIdentifiers: 'unexpected' },
      { BGTaskSchedulerPermittedIdentifiers: [false] },
    ]) {
      const original = JSON.stringify({ targets: { capri_iOS: { type: 'application', platform: 'iOS', info: { properties: invalid } } } });
      writeFileSync(path, original);
      const result = spawnSync('ruby', [script, path, '--spec-only'], { encoding: 'utf8' });
      assert.notEqual(result.status, 0); assert.equal(readFileSync(path, 'utf8'), original);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
