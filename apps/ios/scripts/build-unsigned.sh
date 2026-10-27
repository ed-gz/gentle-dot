#!/usr/bin/env bash
# Run from apps/ios on a macOS runner with Xcode, cargo-tauri and the iOS target.
# The Xcode "Build Rust Code" phase runs `tauri ios xcode-script`, which connects
# to an options server that only `tauri ios build` starts; raw xcodebuild always
# panics on the missing -server-addr file (tauri-apps/tauri#13547). Build through
# the CLI and disable signing in the generated project (SideStore signs on device).
set -euo pipefail
[[ "$(uname -s)" == Darwin ]] || { printf 'Xcode/macOS required\n' >&2; exit 1; }
export CARGO_BUILD_JOBS=4
pnpm build
cargo tauri icon src-tauri/icons/app.svg --output src-tauri/icons
cargo tauri ios init --ci
project_count=$(find src-tauri/gen/apple -maxdepth 1 -name '*.xcodeproj' -type d | wc -l | tr -d ' ')
[[ "$project_count" == 1 ]] || { printf 'Expected one generated Xcode project\n' >&2; exit 1; }
project=$(find src-tauri/gen/apple -maxdepth 1 -name '*.xcodeproj' -type d)
node -e '
const fs = require("fs");
const p = process.argv[1];
let c = fs.readFileSync(p, "utf8");
if (!c.includes("CODE_SIGNING_ALLOWED = NO")) {
  c = c.replace(/buildSettings = \{/g, "buildSettings = {\n\t\t\t\tCODE_SIGNING_ALLOWED = NO;\n\t\t\t\tCODE_SIGNING_REQUIRED = NO;");
  fs.writeFileSync(p, c);
  console.log("Signing disabled in", p);
}' "$project/project.pbxproj"
mkdir -p out
rm -rf src-tauri/gen/apple/build out/Payload out/Capri-unsigned.ipa
if cargo tauri ios build --target aarch64-apple-ios --no-sign; then
  # Newer CLIs package the unsigned IPA themselves.
  ipa=$(find src-tauri/gen/apple src-tauri/target -maxdepth 6 -name '*.ipa' -type f 2>/dev/null | head -1 || true)
  if [[ -n "$ipa" ]]; then cp "$ipa" out/Capri-unsigned.ipa; fi
fi
if [[ ! -f out/Capri-unsigned.ipa ]]; then
  # Older CLIs: the archive/product is on disk; package the Payload ourselves.
  cargo tauri ios build --target aarch64-apple-ios --export-method debugging || true
  app=$(find src-tauri/gen/apple src-tauri/target ~/Library/Developer/Xcode/Archives \
    -maxdepth 8 -name '*.app' -type d -path '*iphoneos*' 2>/dev/null | head -1 || true)
  [[ -n "$app" ]] || { printf 'No unsigned device .app produced\n' >&2; exit 1; }
  mkdir -p out/Payload
  cp -R "$app" out/Payload/
  (cd out && /usr/bin/zip -qry Capri-unsigned.ipa Payload)
fi
printf 'Unsigned IPA: apps/ios/out/Capri-unsigned.ipa\n'
