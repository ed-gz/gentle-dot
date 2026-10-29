#!/usr/bin/env bash
# CI-only compile check. Tauri supplies the options server for its Xcode Rust
# phase; archive-only returns before producing an IPA. Nothing is signed or uploaded.
set -euo pipefail
[[ "$(uname -s)" == Darwin ]] || { printf 'Xcode/macOS required\n' >&2; exit 1; }
[[ "${CI:-}" == true ]] || { printf 'This archive check requires a clean CI runner.\n' >&2; exit 1; }
cd "$(dirname "$0")/.."
[[ "$(cargo tauri --version)" == 'tauri-cli 2.12.1' ]] || { printf 'Expected tauri-cli 2.12.1.\n' >&2; exit 1; }
[[ ! -e public/personal-art ]] || { printf 'Archive preflight requires a checkout without personal artwork.\n' >&2; exit 1; }
export CARGO_BUILD_JOBS=4
pnpm build
cargo tauri ios init --ci
cargo tauri icon src-tauri/icons/app.svg --output src-tauri/icons
ruby scripts/configure-share-extension.rb --spec-only
ruby scripts/configure-live-activity.rb
project_count=$(find src-tauri/gen/apple -maxdepth 1 -name '*.xcodeproj' -type d | wc -l | tr -d ' ')
[[ "$project_count" == 1 ]] || { printf 'Expected one generated Xcode project.\n' >&2; exit 1; }
project=$(find src-tauri/gen/apple -maxdepth 1 -name '*.xcodeproj' -type d)
node -e '
const fs = require("fs");
const path = process.argv[1];
let contents = fs.readFileSync(path, "utf8");
contents = contents.replace(/buildSettings = \{([\s\S]*?)\n\s*\};/g, (block) => {
  const body = block.replace(/CODE_SIGNING_(?:ALLOWED|REQUIRED) = [^;]+;/g, "");
  return body.replace("buildSettings = {", "buildSettings = {\n\t\t\t\tCODE_SIGNING_ALLOWED = NO;\n\t\t\t\tCODE_SIGNING_REQUIRED = NO;");
});
fs.writeFileSync(path, contents);
' "$project/project.pbxproj"
# A fresh runner must not contain prior archives or IPAs that could mask failure.
python3 - <<'PY'
from pathlib import Path
for root in (Path('src-tauri/gen/apple'), Path('src-tauri/target')):
    if root.exists() and any(p.suffix in ('.xcarchive', '.ipa') for p in root.rglob('*')):
        raise SystemExit('Archive preflight requires a clean runner without previous iOS products.')
PY
cargo tauri ios build --target aarch64 --no-sign --archive-only --ci -- --locked
archive=$(python3 - <<'PY'
from pathlib import Path
root = Path('src-tauri/gen/apple')
archives = [p for p in root.rglob('*.xcarchive') if p.is_dir()]
ipas = [p for base in (root, Path('src-tauri/target')) if base.exists() for p in base.rglob('*.ipa')]
if len(archives) != 1 or ipas:
    raise SystemExit('Expected one archive and no IPA from the archive-only build.')
print(archives[0])
PY
)
python3 scripts/verify-device-archive.py "$archive" --group "${CAPRI_APP_GROUP:-group.dev.gentledot.capri}"
printf 'Archive compile check complete. No IPA was generated or published.\n'
