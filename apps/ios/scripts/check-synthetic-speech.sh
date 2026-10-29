#!/usr/bin/env bash
# Optional macOS 26 probe. Does not install models, touch a microphone, or build an IPA.
set -euo pipefail
[[ "$(uname -s)" == Darwin ]] || { printf 'SKIP: macOS is required; no transcription was run.\n'; exit 0; }
major=$(sw_vers -productVersion | cut -d. -f1)
[[ "$major" =~ ^[0-9]+$ ]] || { printf 'FAIL: macOS version could not be determined.\n' >&2; exit 1; }
if (( major < 26 )); then printf 'SKIP: macOS 26 is required; no transcription was run.\n'; exit 0; fi
cd "$(dirname "$0")/.."
verification=$(mktemp -d "${TMPDIR:-/tmp}/capri-synthetic-speech.XXXXXX")
trap 'rm -rf "$verification"' EXIT
xcrun --sdk macosx swiftc -swift-version 5 -parse-as-library \
  -target "$(uname -m)-apple-macosx26.0" -sdk "$(xcrun --sdk macosx --show-sdk-path)" \
  plugin-perception/ios/Sources/VoiceAudio.swift test/native/SpeechAnalyzerSyntheticTests.swift \
  -o "$verification/probe"
python3 - "$verification/probe" <<'PY'
import os, signal, subprocess, sys
process = subprocess.Popen([sys.argv[1]], start_new_session=True)
try:
    status = process.wait(timeout=120)
except subprocess.TimeoutExpired:
    os.killpg(process.pid, signal.SIGKILL)
    process.wait()
    print('FAIL: synthetic SpeechAnalyzer probe timed out; no transcription was confirmed.', file=sys.stderr)
    raise SystemExit(1)
raise SystemExit(status)
PY
