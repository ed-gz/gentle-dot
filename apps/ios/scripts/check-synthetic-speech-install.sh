#!/usr/bin/env bash
# Explicit macOS 26 install probe, only for an ephemeral CI runner. No microphone or IPA.
set -euo pipefail
[[ "$(uname -s)" == Darwin ]] || { printf 'SKIP: macOS is required; no assets requested.\n'; exit 0; }
major=$(sw_vers -productVersion | cut -d. -f1)
[[ "$major" =~ ^[0-9]+$ ]] || { printf 'FAIL: macOS version could not be determined.\n' >&2; exit 1; }
if (( major < 26 )); then printf 'SKIP: macOS 26 is required; no assets requested.\n'; exit 0; fi
cd "$(dirname "$0")/.."
verification=$(mktemp -d "${TMPDIR:-/tmp}/capri-speech-install.XXXXXX")
trap 'rm -rf "$verification"' EXIT
xcrun --sdk macosx swiftc -swift-version 5 -parse-as-library -D CAPRI_ASSET_INSTALL_PROBE \
  -target "$(uname -m)-apple-macosx26.0" -sdk "$(xcrun --sdk macosx --show-sdk-path)" \
  plugin-perception/ios/Sources/VoiceAudio.swift test/native/SpeechAnalyzerSyntheticTests.swift \
  test/native/SpeechAnalyzerInstallProbe.swift -o "$verification/probe"
if [[ "${CAPRI_SPEECH_INSTALL_COMPILE_ONLY:-0}" == 1 ]]; then
  printf 'PASS: installer probe compiled; no assets requested and no transcription run.\n'
  exit 0
fi
if [[ "${CAPRI_EPHEMERAL_SPEECH_INSTALL:-0}" != 1 ]]; then
  printf 'SKIP: explicit ephemeral-runner install opt-in was not set; no assets requested.\n'
  exit 0
fi
python3 - "$verification/probe" <<'PY'
import os, signal, subprocess, sys
try:
    timeout = int(os.environ.get('CAPRI_SPEECH_INSTALL_TIMEOUT_SECONDS', '180'))
except ValueError:
    timeout = 0
if not 1 <= timeout <= 180:
    print('FAIL: probe timeout must be between 1 and 180 seconds; no assets requested.', file=sys.stderr)
    raise SystemExit(2)
process = subprocess.Popen([sys.argv[1]], start_new_session=True)
try:
    result = process.wait(timeout=timeout)
except subprocess.TimeoutExpired:
    os.killpg(process.pid, signal.SIGKILL)
    process.wait()
    print('TIMEOUT: probe terminated; release was not confirmed and Apple may continue the system download until this ephemeral VM ends.', file=sys.stderr)
    raise SystemExit(124)
raise SystemExit(result)
PY
