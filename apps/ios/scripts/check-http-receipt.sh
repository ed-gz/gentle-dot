#!/usr/bin/env bash
set -euo pipefail
[[ "$(uname -s)" == Darwin ]] || { printf 'Xcode/macOS required\n' >&2; exit 1; }
cd "$(dirname "$0")/.."
verification=$(mktemp -d "${TMPDIR:-/tmp}/capri-http-receipt.XXXXXX")
trap 'rm -rf "$verification"' EXIT
xcrun --sdk macosx swiftc -swift-version 5 -parse-as-library \
  -sdk "$(xcrun --sdk macosx --show-sdk-path)" \
  plugin-device-bridge/ios/Sources/HTTPReceiptJournal.swift \
  test/native/HTTPReceiptJournalTests.swift -lsqlite3 -o "$verification/http-receipt-journal-tests"
xcrun --sdk macosx swiftc -swift-version 5 -parse-as-library \
  -sdk "$(xcrun --sdk macosx --show-sdk-path)" \
  plugin-device-bridge/ios/Sources/HTTPReceiptJournal.swift \
  plugin-device-bridge/ios/Sources/BoundedHTTP.swift \
  test/native/HTTPReceiptTransportTests.swift -lsqlite3 -o "$verification/http-receipt-transport-tests"
"$verification/http-receipt-transport-tests"
"$verification/http-receipt-journal-tests"
xcrun --sdk iphoneos swiftc -typecheck -swift-version 5 -parse-as-library \
  -target arm64-apple-ios26.0 -sdk "$(xcrun --sdk iphoneos --show-sdk-path)" \
  plugin-device-bridge/ios/Sources/HTTPReceiptJournal.swift
python3 - "$verification/DeviceBridgePlugin.swift" <<'PY'
from pathlib import Path
import sys
source = Path('plugin-device-bridge/ios/Sources/DeviceBridgePlugin.swift').read_text()
stub = '''import Foundation
import WebKit
@objc class Invoke: NSObject {
    func parseArgs<T: Decodable>(_ type: T.Type) throws -> T { fatalError() }
    func resolve<T: Encodable>(_ data: T) {}
}
class Plugin: NSObject { @objc func load(webview: WKWebView) {} }
'''
Path(sys.argv[1]).write_text(source.replace('import Tauri\n', stub))
PY
sources=()
for source in plugin-device-bridge/ios/Sources/*.swift; do
  [[ "$source" == */DeviceBridgePlugin.swift ]] || sources+=("$source")
done
printf 'Device bridge uses Tauri typecheck stubs; a full Tauri build is still required.\n'
xcrun --sdk iphoneos swiftc -typecheck -swift-version 5 -parse-as-library \
  -target arm64-apple-ios26.0 -sdk "$(xcrun --sdk iphoneos --show-sdk-path)" \
  "${sources[@]}" "$verification/DeviceBridgePlugin.swift"
