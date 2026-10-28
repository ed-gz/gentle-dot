#!/usr/bin/env bash
# Run on a macOS runner with Xcode 26+, cargo-tauri 2.12.1 and the iOS target.
# The Xcode "Build Rust Code" phase runs `tauri ios xcode-script`, which connects
# to an options server that only `tauri ios build` starts; raw xcodebuild always
# panics on the missing -server-addr file (tauri-apps/tauri#13547). Build through
# the CLI and disable signing in the generated project (SideStore signs on device).
set -euo pipefail
[[ "$(uname -s)" == Darwin ]] || { printf 'Xcode/macOS required\n' >&2; exit 1; }
cd "$(dirname "$0")/.."
export CARGO_BUILD_JOBS=4
mkdir -p out
# A failed attempt must not leave a previous IPA looking like the new result.
rm -f out/Capri-unsigned.ipa
pnpm build
cargo tauri icon src-tauri/icons/app.svg --output src-tauri/icons
cargo tauri ios init --ci
ruby scripts/configure-share-extension.rb
project_count=$(find src-tauri/gen/apple -maxdepth 1 -name '*.xcodeproj' -type d | wc -l | tr -d ' ')
[[ "$project_count" == 1 ]] || { printf 'Expected one generated Xcode project\n' >&2; exit 1; }
project=$(find src-tauri/gen/apple -maxdepth 1 -name '*.xcodeproj' -type d)
node -e '
const fs = require("fs");
const p = process.argv[1];
let c = fs.readFileSync(p, "utf8");
c = c.replace(/buildSettings = \{([\s\S]*?)\n\s*\};/g, (block) => {
  const body = block.replace(/CODE_SIGNING_(?:ALLOWED|REQUIRED) = [^;]+;/g, "");
  return body.replace("buildSettings = {", "buildSettings = {\n\t\t\t\tCODE_SIGNING_ALLOWED = NO;\n\t\t\t\tCODE_SIGNING_REQUIRED = NO;");
});
fs.writeFileSync(p, c);
console.log("Signing disabled in", p);
' "$project/project.pbxproj"
rm -rf src-tauri/gen/apple/build
verification=$(mktemp -d "$PWD/out/.ipa-verification.XXXXXX")
trap 'rm -rf "$verification"' EXIT
touch "$verification/started"
# The pinned CLI packages --no-sign itself. Never swallow a Swift/archive error
# or search global Xcode Archives for a product left by another build.
cargo tauri ios build --target aarch64 --no-sign --ci -- --locked
ipa=$(python3 - "$verification/started" <<'PY'
from pathlib import Path
import sys

started = Path(sys.argv[1]).stat().st_mtime_ns
candidates = [p for root in (Path('src-tauri/gen/apple'), Path('src-tauri/target'))
              for p in root.rglob('*.ipa') if p.stat().st_mtime_ns > started]
if len(candidates) != 1:
    raise SystemExit(f'Expected one new unsigned IPA; found {len(candidates)}')
print(candidates[0])
PY
)
python3 - "$ipa" "$verification/executable" <<'PY'
from pathlib import Path
import plistlib
import sys
import zipfile

with zipfile.ZipFile(sys.argv[1]) as archive:
    if archive.testzip() is not None:
        raise SystemExit('Unsigned IPA has a corrupt entry')
    plists = [name for name in archive.namelist()
              if name.startswith('Payload/') and name.count('/') == 2
              and name.endswith('.app/Info.plist')]
    if len(plists) != 1:
        raise SystemExit('Unsigned IPA must contain one application')
    info = plistlib.loads(archive.read(plists[0]))
    if info.get('CFBundleIdentifier') != 'dev.gentledot.capri' or info.get('DTPlatformName') != 'iphoneos':
        raise SystemExit('Unsigned IPA is not the Capri device app')
    if not info.get('NSMicrophoneUsageDescription'):
        raise SystemExit('Unsigned IPA is missing its microphone purpose')
    extensions = [name for name in archive.namelist() if name.endswith('.appex/Info.plist')]
    if len(extensions) != 1:
        raise SystemExit('Unsigned IPA must embed one Share Extension')
    extension = plistlib.loads(archive.read(extensions[0]))
    if extension.get('CFBundleIdentifier') != 'dev.gentledot.capri.share' or extension.get('NSExtension', {}).get('NSExtensionPointIdentifier') != 'com.apple.share-services':
        raise SystemExit('Unsigned IPA has an invalid Share Extension')
    executable = info.get('CFBundleExecutable', '')
    if not executable or '/' in executable or executable in ('.', '..'):
        raise SystemExit('Unsigned IPA has an invalid executable name')
    app = plists[0].rsplit('/', 1)[0]
    Path(sys.argv[2]).write_bytes(archive.read(f'{app}/{executable}'))
PY
archs=$(xcrun lipo -archs "$verification/executable")
[[ " $archs " == *' arm64 '* ]] || { printf 'Expected an arm64 iPhone executable\n' >&2; exit 1; }
xcrun otool -L "$verification/executable" > "$verification/frameworks.txt"
for framework in FoundationModels Speech Vision; do
  grep -q "$framework.framework/" "$verification/frameworks.txt" || {
    printf 'IPA does not link the %s engine\n' "$framework" >&2; exit 1;
  }
done
cp "$ipa" out/Capri-unsigned.ipa
shasum -a 256 out/Capri-unsigned.ipa
printf 'Unsigned IPA: apps/ios/out/Capri-unsigned.ipa\n'
