#!/usr/bin/env bash
# Typecheck the real iOS extension; the provider URL is copied in its callback.
set -euo pipefail
[[ "$(uname -s)" == Darwin ]] || { printf 'Xcode/macOS required\n' >&2; exit 1; }
cd "$(dirname "$0")/.."
diagnostics=$(mktemp "${TMPDIR:-/tmp}/capri-share-sendable.XXXXXXXX")
trap 'rm -f "$diagnostics"' EXIT
if ! xcrun --sdk iphoneos swiftc -typecheck -swift-version 5 -strict-concurrency=complete -parse-as-library \
  -target arm64-apple-ios26.0 -sdk "$(xcrun --sdk iphoneos --show-sdk-path)" \
  plugin-device-bridge/ios/Sources/AppGroupResolver.swift \
  plugin-device-bridge/ios/Sources/SharedInbox.swift \
  share-extension/ShareViewController.swift >"$diagnostics" 2>&1; then
  cat "$diagnostics" >&2
  exit 1
fi
cat "$diagnostics"
if grep -E "capture of .*non-Sendable type 'NSItemProvider'" "$diagnostics"; then
  printf 'NSItemProvider was captured by a Sendable callback.\n' >&2
  exit 1
fi
printf 'Share extension typechecked; no NSItemProvider capture warnings.\n'
