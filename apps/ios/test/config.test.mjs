import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
  assert.match(script, /tauri ios build --target aarch64-apple-ios/);
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
