import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Fixture commands exercise the CI contract, not Xcode, signing or iPhone.
function fixture(mode) {
  const root = mkdtempSync(join(tmpdir(), 'capri-archive-check-'));
  for (const path of ['bin', 'scripts', 'out', 'src-tauri/target']) mkdirSync(join(root, path), { recursive: true });
  for (const name of ['check-device-archive.sh', 'verify-device-archive.py']) copyFileSync(new URL(`../scripts/${name}`, import.meta.url), join(root, 'scripts', name));
  writeFileSync(join(root, 'out/Capri-unsigned.ipa'), 'existing IPA must remain untouched');
  const command = (name, body) => { const path = join(root, 'bin', name); writeFileSync(path, `#!/usr/bin/env bash\nset -eu\n${body}\n`); chmodSync(path, 0o755); };
  command('uname', 'printf "Darwin\\n"');
  command('pnpm', 'exit 0');
  command('ruby', 'exit 0');
  command('xcrun', String.raw`
    if [[ "$1" == lipo ]]; then
      if [[ "$CAPRI_ARCHIVE_TEST" == bad_arch && "$3" == *CapriShare* ]]; then printf 'x86_64\n'; else printf 'arm64\n'; fi
    else
      if [[ "$CAPRI_ARCHIVE_TEST" == missing_framework ]]; then printf 'Speech.framework/Speech\nVision.framework/Vision\n';
      else printf 'FoundationModels.framework/FoundationModels\nSpeech.framework/Speech\nVision.framework/Vision\nActivityKit.framework/ActivityKit\nWidgetKit.framework/WidgetKit\n'; fi
    fi`);
  command('cargo', String.raw`
    if [[ "$*" == 'tauri --version' ]]; then printf 'tauri-cli 2.12.1\n';
    elif [[ "$*" == 'tauri ios init --ci' ]]; then
      mkdir -p src-tauri/gen/apple/Capri.xcodeproj
      printf 'buildSettings = {\n};\n' > src-tauri/gen/apple/Capri.xcodeproj/project.pbxproj
    elif [[ "$*" == 'tauri icon '* ]]; then :
    elif [[ "$*" == 'tauri ios build '* ]]; then
      printf '%s\n' "$*" > build-call.txt
      [[ "$*" == 'tauri ios build --target aarch64 --no-sign --archive-only --ci -- --locked' ]] || exit 88
      [[ "$CAPRI_ARCHIVE_TEST" != build_failure ]] || exit 42
      python3 - <<'PY'
from pathlib import Path
import os, plistlib
base=Path('src-tauri/gen/apple/build/Capri.xcarchive/Products/Applications/Capri.app')
mode=os.environ['CAPRI_ARCHIVE_TEST']
items=[(base,'dev.gentledot.capri','Capri',None),(base/'PlugIns/CapriShare.appex','dev.gentledot.capri.share','CapriShare','com.apple.share-services'),(base/'PlugIns/CapriLive.appex','dev.gentledot.capri.live','CapriLive','com.apple.widgetkit-extension')]
for folder,bundle,exe,point in items:
    if mode=='missing_widget' and exe=='CapriLive': continue
    folder.mkdir(parents=True,exist_ok=True)
    info={'CFBundleIdentifier':bundle,'CFBundleExecutable':exe,'DTPlatformName':'iphoneos'}
    if exe in ('Capri','CapriShare'): info['CapriAppGroup']='group.dev.gentledot.capri' if mode!='wrong_group' else 'group.wrong.fixture'
    if point: info['NSExtension']={'NSExtensionPointIdentifier':point}
    if exe=='Capri': info.update({'NSMicrophoneUsageDescription':'mic','NSCameraUsageDescription':'camera','NSSupportsLiveActivities':True})
    (folder/'Info.plist').write_bytes(plistlib.dumps(info)); (folder/exe).write_bytes(b'fixture executable')
if mode=='unexpected_ipa': Path('src-tauri/gen/apple/build/incorrect.ipa').write_bytes(b'not allowed')
PY
    else exit 89; fi`);
  try {
    const result = spawnSync('bash', [join(root, 'scripts/check-device-archive.sh')], { cwd: root, encoding: 'utf8', env: { ...process.env, CI: 'true', PATH: `${join(root, 'bin')}:${process.env.PATH}`, CAPRI_ARCHIVE_TEST: mode, CAPRI_PERSONAL_ART_SHA256: '' } });
    return { ...result, oldIPA: readFileSync(join(root, 'out/Capri-unsigned.ipa'), 'utf8'), call: (() => { try { return readFileSync(join(root, 'build-call.txt'), 'utf8').trim(); } catch { return ''; } })() };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('archive-only CI checks all targets without changing or producing an IPA', () => {
  const result = fixture('success'); assert.equal(result.status, 0, result.stderr);
  assert.equal(result.call, 'tauri ios build --target aarch64 --no-sign --archive-only --ci -- --locked');
  assert.equal(result.oldIPA, 'existing IPA must remain untouched');
  assert.match(result.stdout, /No IPA was generated or published/);
});

test('archive-only CI fails closed on build error, missing target, wrong group, architecture or framework and unexpected IPA', () => {
  for (const mode of ['build_failure', 'missing_widget', 'wrong_group', 'bad_arch', 'missing_framework', 'unexpected_ipa']) {
    const result = fixture(mode); assert.notEqual(result.status, 0, mode); assert.equal(result.oldIPA, 'existing IPA must remain untouched', mode);
    if (mode === 'build_failure') assert.equal(result.status, 42);
  }
});

test('archive-only script is valid shell and refuses non-macOS', { skip: process.platform === 'darwin' }, () => {
  const file = new URL('../scripts/check-device-archive.sh', import.meta.url).pathname;
  assert.equal(spawnSync('bash', ['-n', file]).status, 0);
  const result = spawnSync('bash', [file], { encoding: 'utf8' }); assert.notEqual(result.status, 0); assert.match(result.stderr, /Xcode\/macOS required/);
});
