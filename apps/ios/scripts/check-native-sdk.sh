#!/usr/bin/env bash
# Catch framework and guided-generation API errors before compiling Rust dependencies.
set -euo pipefail
[[ "$(uname -s)" == Darwin ]] || { printf 'Xcode/macOS required\n' >&2; exit 1; }
cd "$(dirname "$0")/.."
verification=$(mktemp -d "${TMPDIR:-/tmp}/capri-sdk.XXXXXX")
trap 'rm -rf "$verification"' EXIT
python3 - "$verification/AgentTypes.swift" <<'PY'
from pathlib import Path
import sys
source = Path('plugin-local-intelligence/ios/Sources/LocalIntelligencePlugin.swift').read_text()
source = source.split('final class LocalIntelligencePlugin: Plugin {', 1)[0].replace('import Tauri\n', '')
Path(sys.argv[1]).write_text(source)
PY
xcrun --sdk iphoneos swiftc -typecheck -swift-version 5 -parse-as-library \
  -target arm64-apple-ios26.0 -sdk "$(xcrun --sdk iphoneos --show-sdk-path)" \
  "$verification/AgentTypes.swift" \
  plugin-perception/ios/Sources/Voice.swift \
  plugin-perception/ios/Sources/Documents.swift \
  plugin-device-bridge/ios/Sources/BoundedHTTP.swift \
  plugin-device-bridge/ios/Sources/KeychainStore.swift \
  plugin-device-bridge/ios/Sources/SharedInbox.swift \
  plugin-device-bridge/ios/Sources/StreamingHash.swift \
  plugin-device-bridge/ios/Sources/DocumentExport.swift
