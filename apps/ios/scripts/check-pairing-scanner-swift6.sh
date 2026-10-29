#!/usr/bin/env bash
set -euo pipefail
[[ "$(uname -s)" == Darwin ]] || { printf 'Xcode/macOS required\n' >&2; exit 1; }
cd "$(dirname "$0")/.."
verification=$(mktemp -d "${TMPDIR:-/tmp}/capri-pairing-swift6.XXXXXX")
trap 'rm -rf "$verification"' EXIT
cat > "$verification/DeviceFailure.swift" <<'SWIFT'
enum DeviceFailure: Error { case unavailable(String) }
SWIFT
xcrun --sdk iphoneos swiftc -typecheck -swift-version 6 -warnings-as-errors -parse-as-library \
  -target arm64-apple-ios15.0 -sdk "$(xcrun --sdk iphoneos --show-sdk-path)" \
  "$verification/DeviceFailure.swift" \
  plugin-device-bridge/ios/Sources/PairingCameraAvailability.swift \
  plugin-device-bridge/ios/Sources/PairingScanner.swift
