#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
verification=$(mktemp -d "${TMPDIR:-/tmp}/capri-share-media.XXXXXX")
trap 'rm -rf "$verification"' EXIT
python3 - "$verification/input.wav" <<'PY'
import math, struct, sys, wave
with wave.open(sys.argv[1], 'wb') as output:
    output.setparams((1, 2, 16000, 16000, 'NONE', 'not compressed'))
    output.writeframes(b''.join(struct.pack('<h', int(9000 * math.sin(2 * math.pi * 440 * i / 16000))) for i in range(16000)))
PY
afconvert -f m4af -d aac "$verification/input.wav" "$verification/input.m4a"
xcrun --sdk macosx swiftc -swift-version 5 -parse-as-library \
  -target "$(uname -m)-apple-macosx12.0" -sdk "$(xcrun --sdk macosx --show-sdk-path)" \
  plugin-device-bridge/ios/Sources/SharedInbox.swift \
  share-extension/SharedMediaInspection.swift \
  test/native/SharedMediaInspectionTests.swift -o "$verification/share-media-tests"
"$verification/share-media-tests" "$verification/input.m4a"
