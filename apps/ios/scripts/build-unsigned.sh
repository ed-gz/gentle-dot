#!/usr/bin/env bash
# Run on a macOS runner with Xcode 26+, cargo-tauri 2.12.1 and the iOS target.
# The Xcode "Build Rust Code" phase runs `tauri ios xcode-script`, which connects
# to an options server that only `tauri ios build` starts; raw xcodebuild always
# panics on the missing -server-addr file (tauri-apps/tauri#13547). Build through
# the CLI and disable Apple signing in Xcode. After building, ad-hoc seals carry
# App Group entitlements for SideStore to discover before personal re-signing.
set -euo pipefail
[[ "$(uname -s)" == Darwin ]] || { printf 'Xcode/macOS required\n' >&2; exit 1; }
cd "$(dirname "$0")/.."
export CARGO_BUILD_JOBS=4
mkdir -p out
# A failed attempt must not leave a previous IPA looking like the new result.
rm -f out/Capri-unsigned.ipa
group=${CAPRI_APP_GROUP:-group.dev.gentledot.capri}
# macOS ships Bash 3.2: expanding an empty array under nounset fails there.
# The verifier always has a group, so this array is never empty in either mode.
verification_args=(--group "$group")
case "${CAPRI_LIVE_ACTIVITY:-0}" in
  0) ;;
  1) verification_args+=(--live-activity) ;;
  *) printf 'CAPRI_LIVE_ACTIVITY must be 0 or 1.\n' >&2; exit 1 ;;
esac
if [[ -n "${CAPRI_PERSONAL_ART_SHA256:-}" ]]; then
  node scripts/personal-art.mjs verify public/personal-art "$CAPRI_PERSONAL_ART_SHA256"
  verification_args+=(--personal-art-sha256 "$CAPRI_PERSONAL_ART_SHA256")
elif [[ -e public/personal-art ]]; then
  printf 'Personal artwork is staged: use the private build with CAPRI_PERSONAL_ART_SHA256. Refusing a generic IPA.\n' >&2
  exit 1
fi
pnpm build
if [[ -n "${CAPRI_PERSONAL_ART_SHA256:-}" ]]; then
  node scripts/personal-art.mjs verify dist/personal-art "$CAPRI_PERSONAL_ART_SHA256"
fi
cargo tauri icon src-tauri/icons/app.svg --output src-tauri/icons
cargo tauri ios init --ci
if [[ "${CAPRI_LIVE_ACTIVITY:-0}" == 1 ]]; then
  ruby scripts/configure-share-extension.rb --spec-only
  ruby scripts/configure-live-activity.rb
else
  ruby scripts/configure-share-extension.rb
fi
if [[ -n "${CAPRI_PERSONAL_ART_SHA256:-}" ]]; then
  ruby scripts/configure-personal-art.rb
fi
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
python3 scripts/verify-ipa.py "$ipa" "${verification_args[@]}" --extract "$verification/payload" --manifest "$verification/manifest.json"
app=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["app"])' "$verification/manifest.json")
extension=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["extension"])' "$verification/manifest.json")
app_executable=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["appExecutable"])' "$verification/manifest.json")
extension_executable=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["extensionExecutable"])' "$verification/manifest.json")
executables=("$app_executable" "$extension_executable")
if [[ "${CAPRI_LIVE_ACTIVITY:-0}" == 1 ]]; then
  widget=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["widget"])' "$verification/manifest.json")
  widget_executable=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["widgetExecutable"])' "$verification/manifest.json")
  executables+=("$widget_executable")
fi
for executable in "${executables[@]}"; do
  archs=$(xcrun lipo -archs "$verification/payload/$executable")
  [[ " $archs " == *' arm64 '* ]] || { printf 'Expected an arm64 iPhone executable\n' >&2; exit 1; }
done
xcrun otool -L "$verification/payload/$app_executable" > "$verification/frameworks.txt"
for framework in FoundationModels Speech Vision; do
  grep -q "$framework.framework/" "$verification/frameworks.txt" || {
    printf 'IPA does not link the %s engine\n' "$framework" >&2; exit 1;
  }
done
if [[ "${CAPRI_LIVE_ACTIVITY:-0}" == 1 ]]; then
  xcrun otool -L "$verification/payload/$widget_executable" > "$verification/widget-frameworks.txt"
  for framework in ActivityKit WidgetKit; do
    grep -q "$framework.framework/" "$verification/widget-frameworks.txt" || {
      printf 'Live Activity does not link %s\n' "$framework" >&2; exit 1;
    }
  done
fi
# Read the generated target paths, not guessed bundle/product names. XcodeGen
# writes these plists even when CODE_SIGNING_ALLOWED is disabled for compilation.
ruby -ryaml -rfileutils - "$verification" <<'RUBY'
spec_path = File.expand_path('src-tauri/gen/apple/project.yml')
spec = YAML.safe_load(File.read(spec_path), permitted_classes: [], permitted_symbols: [], aliases: true)
apps = spec.fetch('targets').select { |_name, target| target['type'] == 'application' && target['platform'] == 'iOS' }
raise 'Expected one generated application entitlement source.' unless apps.length == 1
extension = spec.fetch('targets').fetch('CapriShare')
raise 'Expected the generated iOS Share Extension.' unless extension['type'] == 'app-extension' && extension['platform'] == 'iOS'
{ 'app' => apps.values.first, 'extension' => extension }.each do |label, target|
  path = target.fetch('entitlements').fetch('path')
  raise 'Invalid entitlement source path.' unless path.is_a?(String) && !path.empty?
  source = File.expand_path(path, File.dirname(spec_path))
  raise 'Missing generated entitlement plist.' unless File.file?(source)
  FileUtils.cp(source, File.join(ARGV.fetch(0), "#{label}.entitlements"))
end
if ENV.fetch('CAPRI_LIVE_ACTIVITY', '0') == '1'
  widget = spec.fetch('targets').fetch('CapriLive')
  raise 'Expected the generated iOS Widget Extension.' unless widget['type'] == 'app-extension' && widget['platform'] == 'iOS'
  source = File.expand_path(widget.fetch('entitlements').fetch('path'), File.dirname(spec_path))
  raise 'Missing generated widget entitlement plist.' unless File.file?(source)
  FileUtils.cp(source, File.join(ARGV.fetch(0), 'widget.entitlements'))
end
RUBY
python3 - "$verification" "$group" <<'PY'
from pathlib import Path
import plistlib, sys
for label in ('app', 'extension'):
    source = plistlib.loads((Path(sys.argv[1]) / f'{label}.entitlements').read_bytes())
    if source.get('com.apple.security.application-groups') != [sys.argv[2]]:
        raise SystemExit(f'{label} generated App Group entitlements do not match the configured group')
widget = Path(sys.argv[1]) / 'widget.entitlements'
if widget.exists() and plistlib.loads(widget.read_bytes()) != {}:
    raise SystemExit('Live Activity must not have additional entitlements')
PY
# Seal nested code first, then the containing app. '-' is an ad-hoc identity:
# no certificate, provisioning profile, Apple account, or timestamp service.
if [[ "${CAPRI_LIVE_ACTIVITY:-0}" == 1 ]]; then
  codesign --force --sign - --timestamp=none --generate-entitlement-der --entitlements "$verification/widget.entitlements" "$verification/payload/$widget"
  codesign --verify --strict "$verification/payload/$widget"
fi
codesign --force --sign - --timestamp=none --generate-entitlement-der --entitlements "$verification/extension.entitlements" "$verification/payload/$extension"
codesign --verify --strict "$verification/payload/$extension"
codesign --force --sign - --timestamp=none --generate-entitlement-der --entitlements "$verification/app.entitlements" "$verification/payload/$app"
codesign --verify --strict "$verification/payload/$app"
labels=(app extension)
if [[ "${CAPRI_LIVE_ACTIVITY:-0}" == 1 ]]; then labels+=(widget); fi
for label in "${labels[@]}"; do
  if [[ "$label" == app ]]; then bundle=$app; elif [[ "$label" == extension ]]; then bundle=$extension; else bundle=$widget; fi
  codesign --display --entitlements :- "$verification/payload/$bundle" > "$verification/$label.embedded.plist"
done
python3 - "$verification" <<'PY'
from pathlib import Path
import plistlib, sys
root = Path(sys.argv[1])
labels = ['app', 'extension'] + (['widget'] if (root / 'widget.entitlements').exists() else [])
for label in labels:
    expected = plistlib.loads((root / f'{label}.entitlements').read_bytes())
    embedded = plistlib.loads((root / f'{label}.embedded.plist').read_bytes())
    if embedded != expected:
        raise SystemExit(f'{label} sealed entitlements differ from the generated source')
PY
ditto -c -k --keepParent "$verification/payload/Payload" "$verification/candidate.ipa"
# Inspect the final ZIP and its embedded Mach-O signatures independently. A
# successful signing command alone cannot publish an unsigned/stale executable.
python3 scripts/verify-ipa.py "$verification/candidate.ipa" "${verification_args[@]}" --sealed
mv "$verification/candidate.ipa" out/Capri-unsigned.ipa
shasum -a 256 out/Capri-unsigned.ipa
printf 'IPA with ad-hoc entitlement seals; SideStore personal signing still required: apps/ios/out/Capri-unsigned.ipa\n'
