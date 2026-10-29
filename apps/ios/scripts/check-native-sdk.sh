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
xcrun --sdk macosx swiftc -swift-version 5 -parse-as-library \
  -sdk "$(xcrun --sdk macosx --show-sdk-path)" \
  plugin-local-intelligence/ios/Sources/CompletionNotifications.swift \
  test/native/CompletionNotificationsTests.swift -o "$verification/completion-notification-tests"
"$verification/completion-notification-tests"
xcrun --sdk macosx swiftc -swift-version 5 -parse-as-library \
  -sdk "$(xcrun --sdk macosx --show-sdk-path)" \
  plugin-device-bridge/ios/Sources/LiveActivityPolicy.swift \
  test/native/LiveActivityPolicyTests.swift -o "$verification/live-activity-policy-tests"
"$verification/live-activity-policy-tests"
xcrun --sdk macosx swiftc -swift-version 5 -parse-as-library \
  -sdk "$(xcrun --sdk macosx --show-sdk-path)" \
  plugin-local-intelligence/ios/Sources/InferenceJournal.swift \
  test/native/InferenceJournalTests.swift -o "$verification/inference-journal-tests"
"$verification/inference-journal-tests"
xcrun --sdk macosx swiftc -swift-version 5 -parse-as-library \
  -sdk "$(xcrun --sdk macosx --show-sdk-path)" \
  plugin-local-intelligence/ios/Sources/AgentCheckpointJournal.swift \
  plugin-local-intelligence/ios/Sources/AgentCheckpointRunner.swift \
  test/native/AgentCheckpointJournalTests.swift -o "$verification/agent-checkpoint-tests"
"$verification/agent-checkpoint-tests"
xcrun --sdk macosx swiftc -swift-version 5 -parse-as-library \
  -sdk "$(xcrun --sdk macosx --show-sdk-path)" \
  plugin-local-intelligence/ios/Sources/InferenceStartGate.swift \
  test/native/InferenceStartGateTests.swift -o "$verification/inference-start-gate-tests"
"$verification/inference-start-gate-tests"
xcrun --sdk macosx swiftc -swift-version 5 -parse-as-library \
  -sdk "$(xcrun --sdk macosx --show-sdk-path)" \
  plugin-device-bridge/ios/Sources/AppGroupResolver.swift \
  test/native/AppGroupResolverTests.swift -o "$verification/app-group-tests"
"$verification/app-group-tests"
xcrun --sdk macosx swiftc -swift-version 5 -parse-as-library \
  -target "$(uname -m)-apple-macosx12.0" -sdk "$(xcrun --sdk macosx --show-sdk-path)" \
  plugin-device-bridge/ios/Sources/KeychainStore.swift \
  plugin-device-bridge/ios/Sources/BoundedHTTP.swift \
  plugin-device-bridge/ios/Sources/SessionUpload.swift \
  test/native/SessionUploadTests.swift -o "$verification/session-upload-tests"
"$verification/session-upload-tests"
xcrun --sdk macosx swiftc -swift-version 5 -parse-as-library \
  -target "$(uname -m)-apple-macosx12.0" -sdk "$(xcrun --sdk macosx --show-sdk-path)" \
  plugin-perception/ios/Sources/Documents.swift \
  test/native/PairingCodeVisionTests.swift -o "$verification/pairing-qr-tests"
"$verification/pairing-qr-tests"
xcrun --sdk macosx swiftc -swift-version 5 -parse-as-library \
  -target "$(uname -m)-apple-macosx12.0" -sdk "$(xcrun --sdk macosx --show-sdk-path)" \
  plugin-device-bridge/ios/Sources/PairingCameraAvailability.swift \
  test/native/PairingCameraAvailabilityTests.swift -o "$verification/pairing-camera-availability-tests"
"$verification/pairing-camera-availability-tests"
xcrun --sdk macosx swiftc -swift-version 5 -parse-as-library \
  -target "$(uname -m)-apple-macosx12.0" -sdk "$(xcrun --sdk macosx --show-sdk-path)" \
  plugin-perception/ios/Sources/VoiceAudio.swift \
  test/native/VoiceAudioTests.swift -o "$verification/voice-audio-tests"
"$verification/voice-audio-tests"
xcrun --sdk macosx swiftc -swift-version 5 -parse-as-library \
  -target "$(uname -m)-apple-macosx12.0" -sdk "$(xcrun --sdk macosx --show-sdk-path)" \
  plugin-perception/ios/Sources/VoiceRecorderCompletion.swift \
  test/native/VoiceRecorderCompletionTests.swift -o "$verification/voice-recorder-completion-tests"
"$verification/voice-recorder-completion-tests"
xcrun --sdk macosx swiftc -swift-version 5 -parse-as-library \
  -target "$(uname -m)-apple-macosx12.0" -sdk "$(xcrun --sdk macosx --show-sdk-path)" \
  plugin-perception/ios/Sources/VoiceLevel.swift \
  test/native/VoiceLevelTests.swift -o "$verification/voice-level-tests"
"$verification/voice-level-tests"
xcrun --sdk macosx swiftc -swift-version 5 -parse-as-library \
  -sdk "$(xcrun --sdk macosx --show-sdk-path)" \
  plugin-perception/ios/Sources/VoiceRecoveryMessage.swift \
  test/native/VoiceRecoveryMessageTests.swift -o "$verification/voice-recovery-message-tests"
"$verification/voice-recovery-message-tests"
xcrun --sdk macosx swiftc -swift-version 5 -parse-as-library \
  -sdk "$(xcrun --sdk macosx --show-sdk-path)" \
  plugin-perception/ios/Sources/VoiceRecoveryJournal.swift \
  plugin-perception/ios/Sources/VoiceRetentionBinding.swift \
  plugin-perception/ios/Sources/VoiceRetainedInspection.swift \
  test/native/VoiceRecoveryJournalTests.swift -o "$verification/voice-recovery-journal-tests"
"$verification/voice-recovery-journal-tests"
xcrun --sdk macosx swiftc -swift-version 5 -parse-as-library \
  -sdk "$(xcrun --sdk macosx --show-sdk-path)" \
  plugin-perception/ios/Sources/VoiceRecoveryJournal.swift \
  plugin-perception/ios/Sources/VoiceRetentionBinding.swift \
  plugin-perception/ios/Sources/VoiceTranscriptBounds.swift \
  plugin-perception/ios/Sources/VoiceNativeReceipt.swift \
  test/native/VoiceNativeReceiptTests.swift -o "$verification/voice-native-receipt-tests"
"$verification/voice-native-receipt-tests"
xcrun --sdk macosx swiftc -swift-version 5 -parse-as-library \
  -sdk "$(xcrun --sdk macosx --show-sdk-path)" \
  plugin-perception/ios/Sources/VoiceTranscriptBounds.swift \
  test/native/VoiceTranscriptBoundsTests.swift -o "$verification/voice-transcript-bounds-tests"
"$verification/voice-transcript-bounds-tests"
xcrun --sdk macosx swiftc -swift-version 5 -parse-as-library \
  -sdk "$(xcrun --sdk macosx --show-sdk-path)" \
  plugin-perception/ios/Sources/VoiceOwners.swift \
  test/native/VoiceOwnersTests.swift -o "$verification/voice-owner-tests"
"$verification/voice-owner-tests"
xcrun --sdk macosx swiftc -swift-version 5 -parse-as-library \
  -sdk "$(xcrun --sdk macosx --show-sdk-path)" \
  plugin-perception/ios/Sources/VoiceLocaleSelection.swift \
  test/native/VoiceLocaleSelectionTests.swift -o "$verification/voice-locale-tests"
"$verification/voice-locale-tests"
xcrun --sdk macosx swiftc -swift-version 5 -parse-as-library \
  -target "$(uname -m)-apple-macosx12.0" -sdk "$(xcrun --sdk macosx --show-sdk-path)" \
  plugin-perception/ios/Sources/LiveAudioBuffer.swift \
  test/native/LiveAudioBufferTests.swift -o "$verification/live-audio-buffer-tests"
"$verification/live-audio-buffer-tests"
xcrun --sdk macosx swiftc -swift-version 5 -parse-as-library \
  -sdk "$(xcrun --sdk macosx --show-sdk-path)" \
  plugin-perception/ios/Sources/LiveTranscript.swift \
  test/native/LiveTranscriptTests.swift -o "$verification/live-transcript-tests"
"$verification/live-transcript-tests"
xcrun --sdk macosx swiftc -swift-version 5 -parse-as-library \
  -sdk "$(xcrun --sdk macosx --show-sdk-path)" \
  plugin-perception/ios/Sources/LiveVoiceDrain.swift \
  test/native/LiveVoiceDrainTests.swift -o "$verification/live-voice-drain-tests"
"$verification/live-voice-drain-tests"
xcrun --sdk macosx swiftc -swift-version 5 -parse-as-library \
  -sdk "$(xcrun --sdk macosx --show-sdk-path)" \
  plugin-perception/ios/Sources/PreviewDrain.swift \
  test/native/PreviewDrainTests.swift -o "$verification/preview-drain-tests"
"$verification/preview-drain-tests"
xcrun --sdk macosx swiftc -swift-version 5 -parse-as-library \
  -sdk "$(xcrun --sdk macosx --show-sdk-path)" \
  plugin-perception/ios/Sources/PreviewDrain.swift \
  plugin-perception/ios/Sources/VoiceStartLatch.swift \
  plugin-perception/ios/Sources/VoiceCancellationBarrier.swift \
  plugin-perception/ios/Sources/VoiceFileCleanup.swift \
  test/native/VoiceCancellationBarrierTests.swift -o "$verification/voice-cancellation-barrier-tests"
"$verification/voice-cancellation-barrier-tests"
xcrun --sdk macosx swiftc -swift-version 5 -parse-as-library \
  -sdk "$(xcrun --sdk macosx --show-sdk-path)" \
  plugin-perception/ios/Sources/VoiceFileCleanup.swift \
  test/native/VoiceFileCleanupTests.swift -o "$verification/voice-file-cleanup-tests"
"$verification/voice-file-cleanup-tests"
xcrun --sdk macosx swiftc -swift-version 5 -parse-as-library \
  -sdk "$(xcrun --sdk macosx --show-sdk-path)" \
  plugin-perception/ios/Sources/VoiceDeadline.swift \
  test/native/VoiceDeadlineTests.swift -o "$verification/voice-deadline-tests"
"$verification/voice-deadline-tests"
xcrun --sdk macosx swiftc -swift-version 5 -parse-as-library \
  -sdk "$(xcrun --sdk macosx --show-sdk-path)" \
  plugin-perception/ios/Sources/LiveCaptureLifecycle.swift \
  test/native/LiveCaptureLifecycleTests.swift -o "$verification/live-capture-lifecycle-tests"
"$verification/live-capture-lifecycle-tests"
xcrun --sdk iphoneos swiftc -typecheck -swift-version 5 -parse-as-library \
  -target arm64-apple-ios26.0 -sdk "$(xcrun --sdk iphoneos --show-sdk-path)" \
  "$verification/AgentTypes.swift" \
  plugin-local-intelligence/ios/Sources/AgentCheckpointJournal.swift \
  plugin-local-intelligence/ios/Sources/AgentCheckpointRunner.swift \
  plugin-local-intelligence/ios/Sources/InferenceJournal.swift \
  plugin-local-intelligence/ios/Sources/InferenceStartGate.swift \
  plugin-local-intelligence/ios/Sources/ContinuedInferenceLease.swift \
  plugin-local-intelligence/ios/Sources/CompletionNotifications.swift \
  plugin-perception/ios/Sources/VoiceAudio.swift \
  plugin-perception/ios/Sources/VoiceRecorderCompletion.swift \
  plugin-perception/ios/Sources/VoiceLevel.swift \
  plugin-perception/ios/Sources/VoiceRecoveryMessage.swift \
  plugin-perception/ios/Sources/VoiceRecoveryJournal.swift \
  plugin-perception/ios/Sources/VoiceRetentionBinding.swift \
  plugin-perception/ios/Sources/VoiceRetainedInspection.swift \
  plugin-perception/ios/Sources/VoiceTranscriptBounds.swift \
  plugin-perception/ios/Sources/VoiceNativeReceipt.swift \
  plugin-perception/ios/Sources/VoiceOwners.swift \
  plugin-perception/ios/Sources/VoiceLocaleSelection.swift \
  plugin-perception/ios/Sources/LiveAudioBuffer.swift \
  plugin-perception/ios/Sources/LiveTranscript.swift \
  plugin-perception/ios/Sources/LiveVoiceDrain.swift \
  plugin-perception/ios/Sources/PreviewDrain.swift \
  plugin-perception/ios/Sources/VoiceStartLatch.swift \
  plugin-perception/ios/Sources/VoiceCancellationBarrier.swift \
  plugin-perception/ios/Sources/VoiceFileCleanup.swift \
  plugin-perception/ios/Sources/VoiceDeadline.swift \
  plugin-perception/ios/Sources/LiveCaptureLifecycle.swift \
  plugin-perception/ios/Sources/LiveVoiceCapture.swift \
  plugin-perception/ios/Sources/Voice.swift \
  plugin-perception/ios/Sources/Documents.swift \
  plugin-device-bridge/ios/Sources/BoundedHTTP.swift \
  plugin-device-bridge/ios/Sources/KeychainStore.swift \
  plugin-device-bridge/ios/Sources/AppGroupResolver.swift \
  plugin-device-bridge/ios/Sources/SharedInbox.swift \
  plugin-device-bridge/ios/Sources/StreamingHash.swift \
  plugin-device-bridge/ios/Sources/SessionUpload.swift \
  plugin-device-bridge/ios/Sources/DocumentExport.swift \
  plugin-device-bridge/ios/Sources/DocumentImport.swift \
  plugin-device-bridge/ios/Sources/PairingCameraAvailability.swift \
  plugin-device-bridge/ios/Sources/PairingScanner.swift \
  plugin-device-bridge/ios/Sources/LiveActivityPolicy.swift \
  plugin-device-bridge/ios/Sources/CapriActivityAttributes.swift \
  plugin-device-bridge/ios/Sources/LiveActivityController.swift
xcrun --sdk iphoneos swiftc -typecheck -swift-version 5 -parse-as-library \
  -target arm64-apple-ios26.0 -sdk "$(xcrun --sdk iphoneos --show-sdk-path)" \
  plugin-device-bridge/ios/Sources/CapriActivityAttributes.swift \
  live-activity/CapriActivityWidget.swift
