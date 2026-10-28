import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('shell bundles local frontend without desktop privileges', () => {
  const config = JSON.parse(read('../src-tauri/tauri.conf.json'));
  assert.equal(config.build.frontendDist, '../dist');
  assert.equal(config.identifier, 'dev.gentledot.capri');
  assert.equal(config.app.windows[0].title, 'Capri');
  assert.equal(config.app.security.csp.includes("default-src 'self'"), true);
  assert.equal(config.app.security.csp.includes('wss:'), true);
  assert.equal(config.app.security.csp.includes('unsafe-eval'), false);
  const cargo = read('../src-tauri/Cargo.toml');
  assert.match(cargo, /"staticlib"/);
  assert.doesNotMatch(cargo, /tray-icon|global-shortcut|autostart/);
});

test('frontend reuses only the current workspace rig and renders untrusted cards as text', () => {
  const pkg = JSON.parse(read('../package.json'));
  assert.equal(pkg.dependencies['@gentle-dot/ui'], 'workspace:*');
  const main = read('../src/main.ts');
  assert.match(main, /@gentle-dot\/ui\/src\/capri2d\/engine.ts/);
  assert.match(main, /@gentle-dot\/ui\/src\/capri2d\/director.ts/);
  assert.match(main, /textContent/);
  assert.doesNotMatch(main, /innerHTML|capri3d|SpriteView|sprite-sheet/i);
});

test('workflow parses as YAML, is manual, unsigned, bounded, and secret-free', () => {
  const path = new URL('../../../.github/workflows/ios-sideload.yml', import.meta.url).pathname;
  const parsed = spawnSync('ruby', ['-rpsych', '-rjson', '-e',
    'puts JSON.generate(Psych.safe_load(File.read(ARGV[0]), permitted_classes: [], aliases: false))', path], { encoding: 'utf8' });
  assert.equal(parsed.status, 0, parsed.stderr);
  const workflow = JSON.parse(parsed.stdout);
  // Psych YAML 1.1 treats the GitHub Actions key "on" as boolean true.
  assert.deepEqual(Object.keys(workflow.on ?? workflow.true), ['workflow_dispatch']);
  assert.equal(workflow.permissions.contents, 'read');
  const job = workflow.jobs.ipa;
  assert.match(job['runs-on'], /^macos-/);
  assert.ok(job['timeout-minutes'] <= 60);
  assert.ok(job.steps.some(step => step.uses?.startsWith('actions/upload-artifact@')));
  assert.doesNotMatch(read('../../../.github/workflows/ios-sideload.yml'), /secrets\./);
  const script = read('../scripts/build-unsigned.sh');
  assert.match(script, /tauri ios build --target aarch64 /);
  assert.match(script, /CODE_SIGNING_ALLOWED = NO/);
  assert.match(script, /project\.pbxproj/);
  assert.doesNotMatch(script, /xcodebuild -project/);
  assert.match(script, /Payload/);
  assert.doesNotMatch(script, /-allowProvisioningUpdates|-exportArchive/);
});

test('build script is valid shell', () => {
  const result = spawnSync('bash', ['-n', new URL('../scripts/build-unsigned.sh', import.meta.url).pathname]);
  assert.equal(result.status, 0);
});

test('non-macOS host fails early, before builds or dependency changes', { skip: process.platform === 'darwin' }, () => {
  const result = spawnSync('bash', [new URL('../scripts/build-unsigned.sh', import.meta.url).pathname], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Xcode\/macOS required/);
  assert.equal(result.stdout, '');
});

// Exercise packaging/failure propagation with fixture command binaries. This
// proves the script's artifact contract, not Swift compilation or inference.
function unsignedBuildFixture(mode) {
  const dir = mkdtempSync(join(tmpdir(), 'capri-unsigned-'));
  for (const path of ['scripts', 'bin', 'out', 'src-tauri/target']) mkdirSync(join(dir, path), { recursive: true });
  for (const file of ['build-unsigned.sh', 'verify-ipa.py']) copyFileSync(new URL(`../scripts/${file}`, import.meta.url), join(dir, 'scripts', file));
  writeFileSync(join(dir, 'out/Capri-unsigned.ipa'), 'previous published result');
  writeFileSync(join(dir, 'src-tauri/target/stale.ipa'), 'old product from a different build');
  const command = (name, body) => {
    const path = join(dir, 'bin', name);
    writeFileSync(path, `#!/usr/bin/env bash\nset -eu\n${body}\n`);
    chmodSync(path, 0o755);
  };
  command('uname', 'printf "Darwin\\n"');
  command('pnpm', 'exit 0');
  // The real Ruby parser still resolves generated source paths. Only XcodeGen
  // setup is stubbed here; its behavior has separate device-bridge fixtures.
  command('ruby', 'if [[ "$*" == scripts/configure-share-extension.rb ]]; then exit 0; else exec /usr/bin/ruby "$@"; fi');
  command('cargo', String.raw`
    if [[ "$*" == 'tauri ios init --ci' ]]; then
      mkdir -p src-tauri/gen/apple/Capri.xcodeproj
      printf 'buildSettings = {\n};\n' > src-tauri/gen/apple/Capri.xcodeproj/project.pbxproj
      python3 - <<'PY'
import os, pathlib, plistlib
root = pathlib.Path('src-tauri/gen/apple')
(root/'project.yml').write_text('targets:\n  AppProduct:\n    type: application\n    platform: iOS\n    entitlements:\n      path: AppProduct/AppProduct.entitlements\n  CapriShare:\n    type: app-extension\n    platform: iOS\n    entitlements:\n      path: CapriShare/CapriShare.entitlements\n')
for product in ('AppProduct', 'CapriShare'):
    directory = root/product
    directory.mkdir()
    group = 'group.wrong.fixture' if os.environ['CAPRI_BUILD_FIXTURE'] == 'source_group' and product == 'CapriShare' else 'group.dev.gentledot.capri'
    (directory/(product+'.entitlements')).write_bytes(plistlib.dumps({'com.apple.security.application-groups': [group]}))
PY
    elif [[ "$*" == 'tauri ios build '* ]]; then
      printf '%s\n' "$*" >> build-calls.txt
      [[ "$CAPRI_BUILD_FIXTURE" != failure ]] || exit 42
      [[ "$CAPRI_BUILD_FIXTURE" != stale ]] || exit 0
      python3 - <<'PY'
import os, pathlib, plistlib, struct, zipfile
mode = os.environ['CAPRI_BUILD_FIXTURE']
path = pathlib.Path('src-tauri/gen/apple/build/arm64/Capri.ipa')
path.parent.mkdir(parents=True, exist_ok=True)
info = {'CFBundleIdentifier': 'wrong.app' if mode == 'identity' else 'dev.gentledot.capri',
        'DTPlatformName': 'iphoneos', 'CFBundleExecutable': 'Capri', 'NSMicrophoneUsageDescription': 'Dictado local', 'CapriAppGroup': 'group.dev.gentledot.capri'}
with zipfile.ZipFile(path, 'w') as archive:
    archive.writestr('Payload/Capri.app/Info.plist', plistlib.dumps(info))
    archive.writestr('Payload/Capri.app/Capri', struct.pack('<8I', 0xfeedfacf, 0x100000c, 0, 2, 0, 0, 0, 0))
    if mode != 'share':
        archive.writestr('Payload/Capri.app/PlugIns/CapriShare.appex/Info.plist', plistlib.dumps({'CFBundleIdentifier': 'dev.gentledot.capri.share', 'CFBundleExecutable': 'CapriShare', 'DTPlatformName': 'iphoneos', 'CapriAppGroup': 'group.dev.gentledot.capri', 'NSExtension': {'NSExtensionPointIdentifier': 'com.apple.share-services'}}))
        archive.writestr('Payload/Capri.app/PlugIns/CapriShare.appex/CapriShare', struct.pack('<8I', 0xfeedfacf, 0x1000007 if mode == 'share_arch' else 0x100000c, 0, 2, 0, 0, 0, 0))
    if mode == 'zip_path': archive.writestr('../outside', b'unsafe')
PY
    fi`);
  command('xcrun', String.raw`
    if [[ "$1" == lipo ]]; then printf 'arm64\n';
    elif [[ "$CAPRI_BUILD_FIXTURE" == engine ]]; then printf 'UIKit.framework/UIKit\n';
    else printf 'FoundationModels.framework/FoundationModels\nSpeech.framework/Speech\nVision.framework/Vision\n'; fi`);
  // Deliberately simulated signatures: these contain a real-shaped Mach-O
  // entitlement blob so the independent parser sees actual executable bytes.
  // They do not claim to test Apple's cryptographic signing implementation.
  const signer = join(dir, 'bin/codesign');
  writeFileSync(signer, String.raw`#!/usr/bin/env python3
import json, os, pathlib, plistlib, struct, sys
args = sys.argv[1:]
with open('sign-calls.jsonl', 'a') as log: log.write(json.dumps(args)+'\n')
bundle = pathlib.Path(args[-1])
info = plistlib.loads((bundle/'Info.plist').read_bytes())
executable = bundle/info['CFBundleExecutable']
mode = os.environ['CAPRI_BUILD_FIXTURE']
if '--sign' in args:
    if mode == 'sign_failure': raise SystemExit(73)
    assert args[args.index('--sign')+1] == '-'
    assert '--timestamp=none' in args and '--generate-entitlement-der' in args
    source = pathlib.Path(args[args.index('--entitlements')+1]).read_bytes()
    (bundle/'.fixture-source.plist').write_bytes(source)
    if mode == 'unsigned_extension' and bundle.suffix == '.appex': raise SystemExit(0)
    if mode == 'sealed_group' and bundle.suffix == '.appex': source = plistlib.dumps({'com.apple.security.application-groups':['group.wrong.fixture']})
    blob = struct.pack('>II', 0xfade7171, len(source)+8)+source
    signature = struct.pack('>IIIII', 0xfade0cc0, len(blob)+20, 1, 5, 20)+blob
    executable.write_bytes(struct.pack('<8I', 0xfeedfacf, 0x100000c, 0, 2, 1, 16, 0, 0)+struct.pack('<IIII', 0x1d, 16, 48, len(signature))+signature)
elif '--verify' in args:
    if mode == 'verify_failure': raise SystemExit(74)
elif '--display' in args:
    # Simulate a lying display command for these modes: final ZIP verification
    # still has to reject the missing/wrong actual embedded entitlement blob.
    if mode in ('unsigned_extension','sealed_group'): sys.stdout.buffer.write((bundle/'.fixture-source.plist').read_bytes())
    else:
        binary = executable.read_bytes()
        offset, size = struct.unpack_from('<II', binary, 40)
        start = struct.unpack_from('>I', binary, offset+16)[0]
        length = struct.unpack_from('>I', binary, offset+start+4)[0]
        sys.stdout.buffer.write(binary[offset+start+8:offset+start+length])
else: raise SystemExit('Unexpected codesign command')
`);
  chmodSync(signer, 0o755);
  command('ditto', String.raw`
    [[ "$CAPRI_BUILD_FIXTURE" != zip_failure ]] || exit 75
    python3 - "$@" <<'PY'
import pathlib, sys, zipfile
source, output = pathlib.Path(sys.argv[-2]), pathlib.Path(sys.argv[-1])
with zipfile.ZipFile(output,'w') as archive:
    for path in source.rglob('*'):
        if path.is_file(): archive.write(path, path.relative_to(source.parent))
PY`);
  try {
    const result = spawnSync('bash', [join(dir, 'scripts/build-unsigned.sh')], {
      cwd: dir, encoding: 'utf8',
      // These are generic packaging fixtures; a private CI job's artwork
      // requirement is exercised separately with its own PNG/resource fixtures.
      env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, CAPRI_BUILD_FIXTURE: mode, CAPRI_APP_GROUP: 'group.dev.gentledot.capri', CAPRI_PERSONAL_ART_SHA256: '' },
    });
    const published = existsSync(join(dir, 'out/Capri-unsigned.ipa'));
    const verified = published ? spawnSync('python3', [join(dir, 'scripts/verify-ipa.py'), join(dir, 'out/Capri-unsigned.ipa'), '--sealed'], { encoding: 'utf8' }) : undefined;
    return { ...result, published, verified,
      signing: existsSync(join(dir, 'sign-calls.jsonl')) ? readFileSync(join(dir, 'sign-calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [],
      calls: readFileSync(join(dir, 'build-calls.txt'), 'utf8').trim().split('\n') };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('unsigned packaging propagates a native build failure without publishing a residual IPA', () => {
  const result = unsignedBuildFixture('failure');
  assert.equal(result.status, 42, result.stderr);
  assert.equal(result.published, false);
  assert.equal(result.calls.length, 1);
});

test('unsigned packaging rejects stale artifacts even when the build returns success', () => {
  const result = unsignedBuildFixture('stale');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Expected one new unsigned IPA/);
  assert.equal(result.published, false);
});

test('unsigned packaging publishes a newly built device IPA after inspecting it', () => {
  const result = unsignedBuildFixture('success');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.published, true);
  assert.equal(result.calls.length, 1);
  assert.equal(result.verified.status, 0, result.verified.stderr);
  const seals = result.signing.filter(args => args.includes('--sign'));
  assert.equal(seals.length, 2);
  assert.match(seals[0].at(-1), /CapriShare\.appex$/);
  assert.match(seals[1].at(-1), /Capri\.app$/);
  assert.equal(result.signing.filter(args => args.includes('--verify')).length, 2);
});

test('unsigned packaging rejects a different application', () => {
  const result = unsignedBuildFixture('identity');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not the Capri device app/);
  assert.equal(result.published, false);
});

test('unsigned packaging rejects an executable missing Foundation Models linkage', () => {
  const result = unsignedBuildFixture('engine');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not link the FoundationModels engine/);
  assert.equal(result.published, false);
});

test('unsigned packaging refuses an app missing its native Share Extension', () => {
  const result = unsignedBuildFixture('share');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must embed one Share Extension/);
  assert.equal(result.published, false);
});


test('packaging verifies the Share Extension architecture independently', () => {
  const result = unsignedBuildFixture('share_arch');
  assert.notEqual(result.status, 0); assert.equal(result.published, false);
  assert.match(result.stderr, /arm64 iPhone extension/);
});

test('packaging refuses unsafe ZIP extraction paths before signing', () => {
  const result = unsignedBuildFixture('zip_path');
  assert.notEqual(result.status, 0); assert.equal(result.published, false);
  assert.match(result.stderr, /unsafe extraction path/); assert.equal(result.signing.length, 0);
});

test('generated entitlement sources must match both the app and extension group', () => {
  const result = unsignedBuildFixture('source_group');
  assert.notEqual(result.status, 0); assert.equal(result.published, false);
  assert.match(result.stderr, /generated App Group entitlements/); assert.equal(result.signing.length, 0);
});

test('ad-hoc signing or cryptographic verification failures never publish the previous IPA', () => {
  for (const [mode, code] of [['sign_failure',73],['verify_failure',74]]) {
    const result = unsignedBuildFixture(mode);
    assert.equal(result.status, code, result.stderr); assert.equal(result.published, false);
  }
});

test('final Mach-O inspection rejects an extension without entitlements even if codesign reports success', () => {
  const result = unsignedBuildFixture('unsigned_extension');
  assert.notEqual(result.status, 0); assert.equal(result.published, false);
  assert.match(result.stderr, /embedded LC_CODE_SIGNATURE/);
});

test('final Mach-O inspection rejects a different embedded App Group', () => {
  const result = unsignedBuildFixture('sealed_group');
  assert.notEqual(result.status, 0); assert.equal(result.published, false);
  assert.match(result.stderr, /extension embedded App Group entitlements/);
});

test('a final ZIP failure cannot publish the unsealed source archive', () => {
  const result = unsignedBuildFixture('zip_failure');
  assert.equal(result.status, 75, result.stderr); assert.equal(result.published, false);
});

test('portable verifier rejects malformed signature tables and DER-only entitlements', () => {
  const result = spawnSync('python3', ['-B', '-c', String.raw`
import plistlib, runpy, struct, sys
parse = runpy.run_path(sys.argv[1])['embedded_entitlements']
xml = plistlib.dumps({'com.apple.security.application-groups': ['group.dev.gentledot.capri']})
blob = struct.pack('>II', 0xfade7171, len(xml)+8)+xml
def signature(entries):
    start = 12+len(entries)*8
    indexes, payload = b'', b''
    for kind, value in entries:
        indexes += struct.pack('>II', kind, start+len(payload))
        payload += value
    return struct.pack('>III', 0xfade0cc0, start+len(payload), len(entries))+indexes+payload
def macho(value):
    return struct.pack('<8I', 0xfeedfacf, 0x100000c, 0, 2, 1, 16, 0, 0)+struct.pack('<IIII', 0x1d, 16, 48, len(value))+value
valid = macho(signature([(5,blob)]))
assert parse(valid)['com.apple.security.application-groups'] == ['group.dev.gentledot.capri']
cases = [valid[:20], macho(signature([(7,blob)])), macho(signature([(5,blob),(5,blob)]))]
for offset, value in [(20,0xffffffff), (36,0), (40,0xffffffff), (44,0xffffffff)]:
    malformed = bytearray(valid); struct.pack_into('<I',malformed,offset,value); cases.append(malformed)
overlap = bytearray(signature([(0,blob),(5,blob)]))
struct.pack_into('>I',overlap,24,28); cases.append(macho(overlap))
for malformed in cases:
    try: parse(malformed)
    except ValueError: pass
    else: raise AssertionError('Malformed executable accepted')
`, new URL('../scripts/verify-ipa.py', import.meta.url).pathname], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
