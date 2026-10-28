import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, copyFileSync, chmodSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadPackagedArtwork } from '../src/packaged-art.ts';
import { validatePersonalPNG, stagePersonalArtwork, verifyPersonalArtwork, downloadPrivateArtwork } from '../scripts/personal-art.mjs';

function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; }
function chunk(type, bytes) { const result = Buffer.alloc(12 + bytes.length); result.writeUInt32BE(bytes.length); result.write(type, 4); bytes.copy(result, 8); result.writeUInt32BE(crc32(result.subarray(4, -4)), result.length - 4); return result; }
function png(width = 240) { const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(420, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.alloc(420 * (width * 4 + 1)))), chunk('IEND', Buffer.alloc(0))]); }
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const original = png(); const fingerprint = hash(original);
const metadata = validatePersonalPNG(original, fingerprint);
function responses(manifest = metadata, bytes = original) {
  const calls = [];
  const fetch = async (url, options) => { calls.push({ url, options }); return url.endsWith('manifest.json') ? new Response(JSON.stringify(manifest)) : new Response(bytes); };
  return { fetch, calls };
}

test('first-run bundled PNG loads offline without IndexedDB and preserves exact bytes', async () => {
  assert.equal(globalThis.indexedDB, undefined);
  const { fetch, calls } = responses();
  const blob = await loadPackagedArtwork({ fetch });
  assert.equal(blob.type, 'image/png'); assert.equal(blob.size, original.length);
  assert.deepEqual(Buffer.from(await blob.arrayBuffer()), original);
  assert.deepEqual(calls.map(call => call.url), ['./personal-art/manifest.json', './personal-art/capri-full.png']);
  for (const { options } of calls) { assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error'); }
});

test('generic builds return absence only for missing manifest; declared missing art is an error', async () => {
  assert.equal(await loadPackagedArtwork({ fetch: async () => new Response('', { status: 404 }) }), undefined);
  await assert.rejects(loadPackagedArtwork({ fetch: async url => url.endsWith('manifest.json') ? new Response(JSON.stringify(metadata)) : new Response('', { status: 404 }) }), /no contiene/);
  await assert.rejects(loadPackagedArtwork({ fetch: async () => new Response('<html>SPA fallback</html>') }));
});

test('packaged loader rejects wrong hash, bounds, dimensions and external manifest paths', async () => {
  for (const invalid of [{ ...metadata, sha256: '0'.repeat(64) }, { ...metadata, size: 6 * 1024 * 1024 }, { ...metadata, file: 'https://remote.example/capri.png' }, { ...metadata, width: 241 }, null]) {
    const { fetch } = responses(invalid); await assert.rejects(loadPackagedArtwork({ fetch }));
  }
  const { fetch } = responses(metadata, png(241)); await assert.rejects(loadPackagedArtwork({ fetch }));
  const truncated = responses(metadata, original.subarray(0, -1)); await assert.rejects(loadPackagedArtwork(truncated));
});

test('packaged hash supports secure native fallback and a cancelled load never installs', async () => {
  let received; const fixture = responses();
  const blob = await loadPackagedArtwork({ ...fixture, hash: async bytes => { received = bytes; return fingerprint; } });
  assert.equal(blob.size, original.length); assert.deepEqual(Buffer.from(received), original);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(loadPackagedArtwork({ ...responses(), signal: controller.signal }), /interrumpió/);
});

test('personal build staging validates CRC, inflate, exact digest and writes deterministic manifest', () => {
  const directory = mkdtempSync(join(tmpdir(), 'capri-art-'));
  try {
    assert.deepEqual(stagePersonalArtwork(original, fingerprint, directory), metadata);
    assert.deepEqual(verifyPersonalArtwork(directory, fingerprint), metadata);
    assert.deepEqual(readFileSync(join(directory, 'capri-full.png')), original);
    const corrupt = Buffer.from(original); corrupt[40] ^= 1;
    assert.throws(() => validatePersonalPNG(corrupt, hash(corrupt)), /CRC/);
    assert.throws(() => validatePersonalPNG(original, '0'.repeat(64)), /SHA-256/);
    assert.throws(() => validatePersonalPNG(png(241), hash(png(241))), /240/);
    writeFileSync(join(directory, 'manifest.json'), JSON.stringify({ ...metadata, sha256: '0'.repeat(64) }));
    assert.throws(() => verifyPersonalArtwork(directory, fingerprint), /manifest/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('personal workflow runs only privately, pins public source SHA and downloads with repository token', () => {
  const path = new URL('../../../.github/workflows/ios-personal.yml', import.meta.url).pathname;
  const parsed = spawnSync('ruby', ['-rpsych', '-rjson', '-e', 'puts JSON.generate(Psych.safe_load(File.read(ARGV[0]), permitted_classes: [], aliases: false))', path], { encoding: 'utf8' });
  assert.equal(parsed.status, 0, parsed.stderr); const workflow = JSON.parse(parsed.stdout);
  assert.equal(workflow.jobs.ipa.if, 'github.event.repository.private == true');
  assert.deepEqual(Object.keys(workflow.on ?? workflow.true), ['workflow_dispatch']);
  const checkout = workflow.jobs.ipa.steps.find(step => step.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout.with.repository, 'ed-gz/gentle-dot'); assert.equal(checkout.with.ref, '${{ inputs.source_sha }}');
  const provision = workflow.jobs.ipa.steps.find(step => step.run?.includes('personal-art.mjs download'));
  assert.equal(provision.env.GH_TOKEN, '${{ github.token }}');
  assert.equal(workflow.jobs.ipa.env.CAPRI_PERSONAL_ART_SHA256, '${{ inputs.artwork_sha256 }}');
  const csp = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url))).app.security.csp;
  assert.match(csp, /connect-src 'self'/);
});

test('private downloader refuses public repositories and mismatched release digests before binary download', () => {
  const directory = mkdtempSync(join(tmpdir(), 'capri-art-private-'));
  const previousPath = process.env.PATH;
  try {
    writeFileSync(join(directory, 'png'), original);
    const program = `#!${process.execPath}\nimport{readFileSync,writeFileSync}from'node:fs';const root=${JSON.stringify(directory)};const args=process.argv.slice(2);if(args.includes('Accept: application/octet-stream')){writeFileSync(root+'/downloaded','yes');process.stdout.write(readFileSync(root+'/png'));}else if(args[1].endsWith('/assets/123'))process.stdout.write(readFileSync(root+'/asset.json'));else process.stdout.write(readFileSync(root+'/repo.json'));`;
    writeFileSync(join(directory, 'gh'), program); chmodSync(join(directory, 'gh'), 0o755);
    process.env.PATH = `${directory}:${previousPath}`;
    writeFileSync(join(directory, 'repo.json'), JSON.stringify({ private: false, full_name: 'owner/art' }));
    assert.throws(() => downloadPrivateArtwork('owner/art', '123', fingerprint, join(directory, 'out')), /PRIVATE/);
    assert.equal(existsSync(join(directory, 'downloaded')), false);
    writeFileSync(join(directory, 'repo.json'), JSON.stringify({ private: true, full_name: 'owner/art' }));
    writeFileSync(join(directory, 'asset.json'), JSON.stringify({ name: 'capri-full.png', state: 'uploaded', size: original.length, digest: `sha256:${'0'.repeat(64)}` }));
    assert.throws(() => downloadPrivateArtwork('owner/art', '123', fingerprint, join(directory, 'out')), /digest mismatch/);
    assert.equal(existsSync(join(directory, 'downloaded')), false);
    writeFileSync(join(directory, 'asset.json'), JSON.stringify({ name: 'capri-full.png', state: 'uploaded', size: original.length, digest: `sha256:${fingerprint}` }));
    assert.deepEqual(downloadPrivateArtwork('owner/art', '123', fingerprint, join(directory, 'out')), metadata);
    assert.deepEqual(readFileSync(join(directory, 'out/capri-full.png')), original);
  } finally { process.env.PATH = previousPath; rmSync(directory, { recursive: true, force: true }); }
});

test('Xcode personal resource configuration resolves symlink aliases, is idempotent, and only extends the app target', () => {
  const directory = mkdtempSync(join(tmpdir(), 'capri-art-xcode-'));
  try {
    mkdirSync(join(directory, 'scripts')); mkdirSync(join(directory, 'gen'));
    copyFileSync(new URL('../scripts/configure-personal-art.rb', import.meta.url), join(directory, 'scripts/configure-personal-art.rb'));
    stagePersonalArtwork(original, fingerprint, join(directory, 'public/personal-art'));
    const spec = join(directory, 'gen/project.yml');
    writeFileSync(spec, 'targets:\n  Capri:\n    type: application\n    platform: iOS\n    sources:\n      - path: Existing.swift\n  CapriShare:\n    type: app-extension\n    platform: iOS\n    sources: []\n');
    // Reproduce /var versus /private/var on every platform. The first invocation
    // resolves the script physically but receives an aliased project path.
    const alias = join(directory, 'alias'); symlinkSync(directory, alias, 'dir');
    for (const path of [join(alias, 'gen/project.yml'), spec, join(alias, 'gen/project.yml')]) {
      const result = spawnSync('ruby', [join(alias, 'scripts/configure-personal-art.rb'), path, '--spec-only'], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    }
    const result = spawnSync('ruby', ['-ryaml', '-rjson', '-e', 'puts JSON.generate(YAML.safe_load(File.read(ARGV[0]), aliases: true))', spec], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const targets = JSON.parse(result.stdout).targets;
    assert.deepEqual(targets.Capri.sources, [{ path: 'Existing.swift' }, { path: '../public/personal-art', type: 'folder', buildPhase: 'resources' }]);
    assert.deepEqual(targets.CapriShare.sources, []);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('generic IPA build refuses staged personal bytes before invoking the frontend builder', () => {
  const directory = mkdtempSync(join(tmpdir(), 'capri-generic-private-art-'));
  try {
    for (const path of ['scripts', 'public/personal-art', 'bin']) mkdirSync(join(directory, path), { recursive: true });
    copyFileSync(new URL('../scripts/build-unsigned.sh', import.meta.url), join(directory, 'scripts/build-unsigned.sh'));
    writeFileSync(join(directory, 'public/personal-art/capri-full.png'), original);
    writeFileSync(join(directory, 'bin/uname'), '#!/usr/bin/env bash\nprintf Darwin'); chmodSync(join(directory, 'bin/uname'), 0o755);
    writeFileSync(join(directory, 'bin/pnpm'), '#!/usr/bin/env bash\ntouch builder-invoked'); chmodSync(join(directory, 'bin/pnpm'), 0o755);
    const result = spawnSync('bash', [join(directory, 'scripts/build-unsigned.sh')], { encoding: 'utf8', env: { ...process.env, PATH: `${join(directory, 'bin')}:${process.env.PATH}`, CAPRI_PERSONAL_ART_SHA256: '' } });
    assert.equal(result.status, 1); assert.match(result.stderr, /Refusing a generic IPA/);
    assert.equal(existsSync(join(directory, 'builder-invoked')), false);
    assert.deepEqual(readFileSync(join(directory, 'public/personal-art/capri-full.png')), original);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('IPA personal gate verifies actual resource bytes and rejects absent or changed packaged art', () => {
  const directory = mkdtempSync(join(tmpdir(), 'capri-ipa-art-'));
  try {
    stagePersonalArtwork(original, fingerprint, directory);
    const verifier = new URL('../scripts/verify-ipa.py', import.meta.url).pathname;
    const driver = String.raw`
import importlib.util, json, pathlib, plistlib, struct, sys, zipfile
spec=importlib.util.spec_from_file_location('verify',sys.argv[1]); module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
root=pathlib.Path(sys.argv[2]); digest=sys.argv[3]; group='group.dev.gentledot.capri'
base={'DTPlatformName':'iphoneos','CapriAppGroup':group,'CFBundleExecutable':'Capri'}
for mode in ('good','missing','tampered','manifest'):
 p=root/(mode+'.ipa')
 with zipfile.ZipFile(p,'w') as z:
  z.writestr('Payload/Capri.app/Info.plist',plistlib.dumps({**base,'CFBundleIdentifier':'dev.gentledot.capri','NSMicrophoneUsageDescription':'dictation'}))
  z.writestr('Payload/Capri.app/Capri',struct.pack('<8I',0xFEEDFACF,0x0100000C,0,0,0,0,0,0))
  z.writestr('Payload/Capri.app/PlugIns/CapriShare.appex/Info.plist',plistlib.dumps({**base,'CFBundleIdentifier':'dev.gentledot.capri.share','NSExtension':{'NSExtensionPointIdentifier':'com.apple.share-services'}}))
  z.writestr('Payload/Capri.app/PlugIns/CapriShare.appex/Capri',struct.pack('<8I',0xFEEDFACF,0x0100000C,0,0,0,0,0,0))
  if mode!='missing':
   art=(root/'capri-full.png').read_bytes(); meta=(root/'manifest.json').read_bytes()
   z.writestr('Payload/Capri.app/personal-art/capri-full.png',art if mode!='tampered' else art[:-1]+bytes([art[-1]^1]))
   z.writestr('Payload/Capri.app/personal-art/manifest.json',meta if mode!='manifest' else meta.replace(b'240',b'241'))
 if mode=='good': assert module.inspect(p,group,personal_art_sha256=digest)['personalArtworkSHA256']==digest
 else:
  try: module.inspect(p,group,personal_art_sha256=digest)
  except (ValueError,KeyError): pass
  else: raise Exception('Accepted invalid '+mode)
 # Generic public source builds remain compatible.
 module.inspect(p,group)
`;
    const result = spawnSync('python3', ['-B', '-c', driver, verifier, directory, fingerprint], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
