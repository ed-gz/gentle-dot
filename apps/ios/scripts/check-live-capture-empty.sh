#!/usr/bin/env bash
# macOS-only synthetic capture-state regression, no microphone or assets.
set -euo pipefail
[[ "$(uname -s)" == Darwin ]] || { printf 'macOS required\n' >&2; exit 1; }
cd "$(dirname "$0")/.."
root=$(mktemp -d "${TMPDIR:-/tmp}/capri-capture-test.XXXXXXXX")
trap 'rm -rf "$root"' EXIT
xcrun --sdk macosx swiftc -target "$(uname -m)-apple-macos26.0" \
  plugin-perception/ios/Sources/LiveAudioBuffer.swift \
  plugin-perception/ios/Sources/LiveCaptureLifecycle.swift \
  plugin-perception/ios/Sources/LiveVoiceDrain.swift \
  plugin-perception/ios/Sources/VoiceLevel.swift \
  plugin-perception/ios/Sources/LiveVoiceCapture.swift \
  test/native/LiveCaptureEmptyBufferTests.swift -o "$root/test"
"$root/test"
