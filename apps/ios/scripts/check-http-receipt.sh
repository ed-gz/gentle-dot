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
"$verification/http-receipt-journal-tests"
xcrun --sdk iphoneos swiftc -typecheck -swift-version 5 -parse-as-library \
  -target arm64-apple-ios26.0 -sdk "$(xcrun --sdk iphoneos --show-sdk-path)" \
  plugin-device-bridge/ios/Sources/HTTPReceiptJournal.swift
