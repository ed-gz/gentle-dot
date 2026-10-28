import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const script = new URL('../scripts/configure-live-activity.rb', import.meta.url).pathname;
test('optional XcodeGen target is idempotent and embeds only the WidgetKit extension', () => {
  const root = mkdtempSync(join(tmpdir(), 'capri-live-spec-'));
  try {
    const path = join(root, 'project.yml');
    writeFileSync(path, 'targets:\n  CapriApp:\n    type: application\n    platform: iOS\n    info:\n      properties:\n        CFBundleShortVersionString: "0.1.0"\n    dependencies: []\n  CapriShare:\n    type: app-extension\n    platform: iOS\n');
    for (let run = 0; run < 2; run++) {
      const result = spawnSync('ruby', [script, path, '--spec-only'], { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr);
    }
    const parsed = spawnSync('ruby', ['-rpsych', '-rjson', '-e', 'puts JSON.generate(Psych.safe_load(File.read(ARGV[0]), permitted_classes: [], aliases: true))', path], { encoding: 'utf8' });
    assert.equal(parsed.status, 0, parsed.stderr); const spec = JSON.parse(parsed.stdout);
    assert.equal(spec.targets.CapriApp.info.properties.NSSupportsLiveActivities, true);
    assert.deepEqual(spec.targets.CapriApp.dependencies.filter(entry => entry.target === 'CapriLive'), [{ target: 'CapriLive', embed: true, codeSign: false }]);
    const widget = spec.targets.CapriLive;
    assert.equal(widget.info.properties.NSExtension.NSExtensionPointIdentifier, 'com.apple.widgetkit-extension');
    assert.equal(widget.settings.base.PRODUCT_BUNDLE_IDENTIFIER, 'dev.gentledot.capri.live');
    assert.deepEqual(widget.entitlements.properties, {});
    assert.equal(widget.sources.length, 2);
    assert.match(widget.sources[0].path, /CapriActivityWidget\.swift$/);
    assert.match(widget.sources[1].path, /CapriActivityAttributes\.swift$/);
    assert.ok(readFileSync(path, 'utf8').includes('CapriShare'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('refuses a generated spec without the existing Share Extension', () => {
  const root = mkdtempSync(join(tmpdir(), 'capri-live-spec-invalid-'));
  try {
    const path = join(root, 'project.yml'); writeFileSync(path, 'targets:\n  CapriApp:\n    type: application\n    platform: iOS\n');
    assert.notEqual(spawnSync('ruby', [script, path, '--spec-only']).status, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
