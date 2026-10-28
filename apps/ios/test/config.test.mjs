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
  copyFileSync(new URL('../scripts/build-unsigned.sh', import.meta.url), join(dir, 'scripts/build-unsigned.sh'));
  writeFileSync(join(dir, 'out/Capri-unsigned.ipa'), 'previous published result');
  writeFileSync(join(dir, 'src-tauri/target/stale.ipa'), 'old product from a different build');
  const command = (name, body) => {
    const path = join(dir, 'bin', name);
    writeFileSync(path, `#!/usr/bin/env bash\nset -eu\n${body}\n`);
    chmodSync(path, 0o755);
  };
  command('uname', 'printf "Darwin\\n"');
  command('pnpm', 'exit 0');
  // XcodeGen mutation is exercised by device-bridge.test; this fixture isolates packaging.
  command('ruby', '[[ "$*" == scripts/configure-share-extension.rb ]]');
  command('cargo', `
    if [[ "$*" == 'tauri ios init --ci' ]]; then
      mkdir -p src-tauri/gen/apple/Capri.xcodeproj
      printf 'buildSettings = {\\n};\\n' > src-tauri/gen/apple/Capri.xcodeproj/project.pbxproj
    elif [[ "$*" == 'tauri ios build '* ]]; then
      printf '%s\\n' "$*" >> build-calls.txt
      [[ "$CAPRI_BUILD_FIXTURE" != failure ]] || exit 42
      [[ "$CAPRI_BUILD_FIXTURE" != stale ]] || exit 0
      python3 - <<'PY'
import os, pathlib, plistlib, zipfile
path = pathlib.Path('src-tauri/gen/apple/build/arm64/Capri.ipa')
path.parent.mkdir(parents=True, exist_ok=True)
info = {'CFBundleIdentifier': 'wrong.app' if os.environ['CAPRI_BUILD_FIXTURE'] == 'identity' else 'dev.gentledot.capri',
        'DTPlatformName': 'iphoneos', 'CFBundleExecutable': 'Capri', 'NSMicrophoneUsageDescription': 'Dictado local'}
with zipfile.ZipFile(path, 'w') as archive:
    archive.writestr('Payload/Capri.app/Info.plist', plistlib.dumps(info))
    archive.writestr('Payload/Capri.app/Capri', b'fixture native executable')
    if os.environ['CAPRI_BUILD_FIXTURE'] != 'share':
        archive.writestr('Payload/Capri.app/PlugIns/CapriShare.appex/Info.plist', plistlib.dumps({'CFBundleIdentifier': 'dev.gentledot.capri.share', 'NSExtension': {'NSExtensionPointIdentifier': 'com.apple.share-services'}}))
PY
    fi`);
  command('xcrun', `
    if [[ "$1" == lipo ]]; then printf 'arm64\\n';
    elif [[ "$CAPRI_BUILD_FIXTURE" == engine ]]; then printf 'UIKit.framework/UIKit\\n';
    else printf 'FoundationModels.framework/FoundationModels\\nSpeech.framework/Speech\\nVision.framework/Vision\\n'; fi`);
  try {
    const result = spawnSync('bash', [join(dir, 'scripts/build-unsigned.sh')], {
      cwd: dir, encoding: 'utf8',
      env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, CAPRI_BUILD_FIXTURE: mode },
    });
    return { ...result, published: existsSync(join(dir, 'out/Capri-unsigned.ipa')),
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
