import AVFoundation
import CoreMedia
import Foundation
import Speech
import UIKit

struct VoiceSegment: Encodable {
    let text: String
    let startSeconds: Double
    let endSeconds: Double
}

struct VoiceReply: Encodable {
    var ok = false
    var available: Bool? = nil
    var status: String? = nil
    var message: String? = nil
    var error: String? = nil
    var locale: String? = nil
    var assetsInstalled: Bool? = nil
    var microphonePermission: String? = nil
    var recording: Bool? = nil
    var readyToTranscribe: Bool? = nil
    var busy: Bool? = nil
    var sessionId: String? = nil
    var ownerId: String? = nil
    var recoveryPending: Bool? = nil
    var recoveryIssue: String? = nil
    var maxDurationSeconds: Int? = nil
    var partial: String? = nil
    var previewIssue: String? = nil
    var microphoneLevel: Double? = nil
    var text: String? = nil
    var segments: [VoiceSegment]? = nil
    var durationSeconds: Double? = nil
    var source: String? = nil
    /// Present only for an explicitly requested, verified journal copy. The
    /// copy is not an acknowledgement that the draft was saved.
    var retainedAudio: VoiceRecoveryRecord? = nil
    var failureDiagnostic: VoiceFailureDiagnostic? = nil

    static func failure(_ error: String, _ message: String) -> VoiceReply {
        VoiceReply(message: message, error: error)
    }
}

enum VoiceCancellationResult { case confirmed, closing, cleanupFailed }

@available(iOS 26.0, *)
private enum VoiceTranscriberKind { case speech, dictation }

@available(iOS 26.0, *)
private enum VoiceTranscriber {
    case speech(SpeechTranscriber)
    case dictation(DictationTranscriber)

    var module: any SpeechModule {
        switch self {
        case .speech(let value): return value
        case .dictation(let value): return value
        }
    }
}

@available(iOS 26.0, *)
@MainActor
final class VoiceController: NSObject, AVAudioRecorderDelegate {
    private var recorder: AVAudioRecorder?
    private var recordingURL: URL?
    private var sessionID: String?
    private var analyzer: SpeechAnalyzer?
    private var generation = 0
    private var busy = false
    private var recordedLocale: Locale?
    private var recordedKind: VoiceTranscriberKind?
    private var recordedFormat: AVAudioFormat?
    private var owners = VoiceOwners()
    private var liveCapture: LiveVoiceCapture?
    private var previewAnalyzer: SpeechAnalyzer?
    private var previewAnalysisTask: Task<Void, Never>?
    private var previewResultsTask: Task<Void, Never>?
    private let previewDrain = PreviewDrain()
    private let finalDrain = PreviewDrain()
    private let cancellationBarrier = VoiceCancellationBarrier()
    private let startLatch = VoiceStartLatch()
    private let retentionLatch = VoiceStartLatch()
    private var retentionBinding: VoiceRetentionBinding?
    private var retainedRecord: VoiceRecoveryRecord?
    private var retainedLease: VoiceRecoveryReadLease?
    private var retentionCaptureIncomplete = false
    private var pendingStartURL: URL?
    private var startupAudioActive = false
    private struct PendingCancellation {
        let id: UUID
        let owner: String?
        let url: URL?
        let live: LiveVoiceCapture?
        let retention: VoiceRetentionBinding?
        let lease: VoiceRecoveryReadLease?
    }
    private var pendingCancellation: PendingCancellation?
    private var finalOperation: Task<VoiceReply, Never>?
    private var finalResults: Task<[VoiceSegment], Error>?
    private var finalDeadline: VoiceDeadline<VoiceReply>?
    private var finalInterrupted = false
    private var recoveryPending = false
    private var recoveryIssue: String?
    private var stoppingCapture = false
    private var liveTranscript = LiveTranscript()
    private var previewIssue: String?
    private let maximumDuration: TimeInterval = 90

    private static var temporaryDirectory: URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("capri-voice-commands", isDirectory: true)
    }

    override init() {
        super.init()
        // Only our own previous short voice-command captures are removed.
        try? FileManager.default.removeItem(at: Self.temporaryDirectory)
        try? FileManager.default.createDirectory(at: Self.temporaryDirectory, withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.complete])
    }

    private func preferredTranscriber() async -> (locale: Locale, kind: VoiceTranscriberKind)? {
        let preferences = [Locale(identifier: "es-MX"), Locale(identifier: "es-ES")]
        var candidates: [(locale: Locale, kind: VoiceTranscriberKind)] = []
        if SpeechTranscriber.isAvailable {
            for preferred in preferences {
                if let locale = await SpeechTranscriber.supportedLocale(equivalentTo: preferred) {
                    candidates.append((locale, .speech))
                }
            }
        }
        // DictationTranscriber is also on-device and covers additional locales
        // and devices when the newer SpeechTranscriber is unavailable.
        for preferred in preferences {
            if let locale = await DictationTranscriber.supportedLocale(equivalentTo: preferred) {
                candidates.append((locale, .dictation))
            }
        }
        // Check every supported Spanish candidate before asking for a download.
        // es-MX may be supported but not installed while es-ES is already on
        // the device. Stopping at the first supported locale broke offline use.
        var choices: [(value: (locale: Locale, kind: VoiceTranscriberKind), installed: Bool)] = []
        for candidate in candidates {
            choices.append((candidate, await installed(candidate.locale, kind: candidate.kind)))
        }
        return VoiceLocaleSelection.preferred(choices)
    }

    private func installed(_ locale: Locale, kind: VoiceTranscriberKind) async -> Bool {
        let final = makeTranscriber(for: locale, kind: kind)
        let preview = makeTranscriber(for: locale, kind: kind, incremental: true)
        return await AssetInventory.status(forModules: [final.module, preview.module]) == .installed
    }

    // Use the shipping initializer, with the same configuration for asset
    // preparation, capture-format selection and final local transcription.
    // SpeechTranscriber runs on device; there is no offlineTranscription preset
    // in the released SDK. Both final and provisional results retain timing attributes.
    private func makeTranscriber(for locale: Locale, kind: VoiceTranscriberKind, incremental: Bool = false) -> VoiceTranscriber {
        switch kind {
        case .speech:
            let reporting: Set<SpeechTranscriber.ReportingOption> = incremental ? [.volatileResults] : []
            return .speech(SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: reporting, attributeOptions: [.audioTimeRange]))
        case .dictation:
            let reporting: Set<DictationTranscriber.ReportingOption> = incremental ? [.volatileResults] : []
            return .dictation(DictationTranscriber(locale: locale, contentHints: [], transcriptionOptions: [], reportingOptions: reporting, attributeOptions: [.audioTimeRange]))
        }
    }

    private func showPreview(_ text: AttributedString, range: CMTimeRange, final: Bool, session: String) {
        guard sessionID == session, previewIssue == nil else { return }
        let start = CMTimeGetSeconds(range.start), end = CMTimeGetSeconds(CMTimeRangeGetEnd(range))
        if !liveTranscript.update(text: String(text.characters), start: start, end: end, final: final) {
            previewIssue = "La vista previa se interrumpió. El audio completo se transcribirá al terminar."
            requestPreviewShutdown()
        }
    }

    private func beginPreview(_ module: VoiceTranscriber, capture: LiveVoiceCapture, session: String) {
        let analyzer = SpeechAnalyzer(modules: [module.module])
        previewAnalyzer = analyzer
        previewResultsTask = Task { @MainActor [weak self] in
            do {
                switch module {
                case .speech(let transcriber):
                    for try await result in transcriber.results {
                        guard !Task.isCancelled else { break }
                        self?.showPreview(result.text, range: result.range, final: result.isFinal, session: session)
                    }
                case .dictation(let transcriber):
                    for try await result in transcriber.results {
                        guard !Task.isCancelled else { break }
                        self?.showPreview(result.text, range: result.range, final: result.isFinal, session: session)
                    }
                }
            } catch {
                if !Task.isCancelled, self?.sessionID == session {
                    self?.previewIssue = "La vista previa se interrumpió. El audio completo se transcribirá al terminar."
                    self?.requestPreviewShutdown()
                }
            }
        }
        previewAnalysisTask = Task { @MainActor [weak self] in
            do {
                if let end = try await analyzer.analyzeSequence(capture.inputs) {
                    try await analyzer.finalizeAndFinish(through: end)
                } else { await analyzer.cancelAndFinishNow() }
            } catch {
                if !Task.isCancelled, self?.sessionID == session {
                    self?.previewIssue = "La vista previa se interrumpió. El audio completo se transcribirá al terminar."
                    self?.requestPreviewShutdown()
                }
            }
        }
    }

    private func requestPreviewShutdown() {
        previewAnalysisTask?.cancel(); previewAnalysisTask = nil
        previewResultsTask?.cancel(); previewResultsTask = nil
        let analyzer = previewAnalyzer; previewAnalyzer = nil
        if let analyzer { previewDrain.begin { await analyzer.cancelAndFinishNow() } }
    }

    private func endPreview() async -> Bool {
        requestPreviewShutdown()
        return await previewDrain.wait()
    }

    private func requestFinalShutdown() {
        let current = analyzer
        analyzer = nil
        let operation = finalOperation
        finalOperation = nil
        finalResults?.cancel()
        finalResults = nil
        operation?.cancel()
        if let current {
            // Both the analyzer shutdown and the task consuming its results
            // must end before starting another analyzer on the retained audio.
            finalDrain.begin {
                async let closed: Void = current.cancelAndFinishNow()
                if let operation { _ = await operation.value }
                await closed
            }
        }
    }

    private func pending(_ id: String, reason: String, diagnostic: VoiceFailureDiagnostic? = nil) -> VoiceReply {
        let message = VoiceRecoveryMessage.forReason(reason, diagnostic: diagnostic)
        recoveryIssue = message
        var reply = VoiceReply.failure("preview_pending", message)
        reply.sessionId = id
        return reply
    }

    func check() async -> VoiceReply {
        let permission: String
        switch AVAudioSession.sharedInstance().recordPermission {
        case .granted: permission = "granted"
        case .denied: permission = "denied"
        default: permission = "undetermined"
        }
        if let id = sessionID, let locale = recordedLocale {
            let recording = (recorder?.isRecording ?? false) || (liveCapture?.recording ?? false)
            var level: Double?
            if recording {
                if let capture = liveCapture { level = capture.microphoneLevel }
                else if let capture = recorder { capture.updateMeters(); level = VoiceLevel.fromDecibels(capture.averagePower(forChannel: 0)) }
            }
            return VoiceReply(ok: true, available: true, status: "available", locale: locale.identifier(.bcp47),
                assetsInstalled: true, microphonePermission: permission, recording: recording,
                readyToTranscribe: !recording, busy: busy, sessionId: id,
                ownerId: owners.active, recoveryPending: recoveryPending, recoveryIssue: recoveryIssue, maxDurationSeconds: Int(maximumDuration),
                partial: liveTranscript.text, previewIssue: previewIssue, microphoneLevel: level)
        }
        guard let selected = await preferredTranscriber() else {
            return VoiceReply(available: false, status: "unsupported_language", microphonePermission: permission)
        }
        let assets = await installed(selected.locale, kind: selected.kind)
        return VoiceReply(ok: true, available: assets, status: assets ? "available" : "assets_required",
            locale: selected.locale.identifier(.bcp47), assetsInstalled: assets, microphonePermission: permission,
            recording: recorder?.isRecording ?? false, readyToTranscribe: sessionID != nil && !(recorder?.isRecording ?? false),
            busy: busy, sessionId: sessionID, maxDurationSeconds: Int(maximumDuration))
    }

    func prepare(ownerID: String? = nil) async -> VoiceReply {
        guard !busy, sessionID == nil, !cancellationBarrier.active, pendingCancellation == nil else { return .failure("busy", "Termina o cancela el comando de voz actual.") }
        guard UIApplication.shared.applicationState == .active else { return .failure("not_foreground", "Abre Capri para preparar la voz.") }
        if let ownerID, !owners.claim(ownerID) { return .failure("cancelled", "Ese dictado fue cancelado o sustituido.") }
        busy = true
        let epoch = generation
        var prepared = false
        defer { busy = false; if let ownerID { owners.finishAttempt(ownerID, succeeded: prepared) } }
        guard let selected = await preferredTranscriber() else {
            return .failure("unsupported_language", "Este iPhone no ofrece SpeechAnalyzer en español.")
        }
        guard epoch == generation else { return .failure("cancelled", "Preparación cancelada.") }
        do {
            let module = makeTranscriber(for: selected.locale, kind: selected.kind)
            let preview = makeTranscriber(for: selected.locale, kind: selected.kind, incremental: true)
            if let request = try await AssetInventory.assetInstallationRequest(supporting: [module.module, preview.module]) {
                try await request.downloadAndInstall()
            }
            guard epoch == generation, !Task.isCancelled else { return .failure("cancelled", "Preparación cancelada.") }
            let state = await check()
            prepared = state.available == true
            return state
        } catch {
            return .failure(epoch == generation ? "asset_download_failed" : "cancelled",
                "No se completó la preparación de voz. Comprueba la conexión y el espacio disponible.")
        }
    }

    func start(ownerID: String? = nil, retainDestination: String? = nil) async -> VoiceReply {
        guard !busy, sessionID == nil else { return .failure("busy", "Ya hay un comando de voz en curso.") }
        guard !previewDrain.active, !finalDrain.active, !cancellationBarrier.active, pendingCancellation == nil else { return .failure("busy", "Apple todavía está cerrando el dictado anterior. Intenta de nuevo en un momento.") }
        guard UIApplication.shared.applicationState == .active else { return .failure("not_foreground", "Abre Capri para dictar.") }
        if retainDestination != nil {
            guard let ownerID, UUID(uuidString: ownerID) != nil, VoiceRetentionBinding.validDestination(retainDestination) else {
                return .failure("invalid_voice_retention", "No se pudo vincular el audio con su destino original.")
            }
        }
        if let ownerID, !owners.claim(ownerID) { return .failure("cancelled", "Ese dictado fue cancelado o sustituido.") }
        busy = true
        startLatch.begin()
        generation += 1
        let epoch = generation
        var started = false
        defer { startupAudioActive = false; pendingStartURL = nil; startLatch.end(); busy = false; if let ownerID { owners.finishAttempt(ownerID, succeeded: started) } }
        guard let selected = await preferredTranscriber() else {
            return .failure("unsupported_language", "SpeechAnalyzer no está disponible en español en este iPhone.")
        }
        guard await installed(selected.locale, kind: selected.kind) else { return .failure("assets_required", "Prepara los modelos de voz antes de dictar sin conexión.") }
        guard epoch == generation, !Task.isCancelled else { return .failure("cancelled", "Dictado cancelado.") }
        let module = makeTranscriber(for: selected.locale, kind: selected.kind)
        let preview = makeTranscriber(for: selected.locale, kind: selected.kind, incremental: true)
        do {
            // installedLocales is device-wide; a downloaded model can belong
            // to another app. Reserve this app's locale even on the fast path
            // which skips prepare(), and verify both module configurations.
            try await AssetInventory.reserve(locale: selected.locale)
            guard try await AssetInventory.assetInstallationRequest(supporting: [module.module, preview.module]) == nil else {
                return .failure("assets_required", "Prepara los modelos de voz antes de dictar sin conexión.")
            }
        } catch {
            return .failure("asset_reservation_failed", "Apple no pudo reservar la voz en español para Capri. Revisa el espacio disponible e inténtalo de nuevo.")
        }
        guard epoch == generation, !Task.isCancelled else { return .failure("cancelled", "Dictado cancelado.") }
        guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [module.module]) else {
            return .failure("audio_format_unavailable", "No hay un formato de audio compatible con el transcriptor.")
        }
        guard epoch == generation, !Task.isCancelled else { return .failure("cancelled", "Dictado cancelado.") }
        // Permission is requested by the user's start action, never by check().
        let granted = await withCheckedContinuation { continuation in
            AVAudioApplication.requestRecordPermission { allowed in continuation.resume(returning: allowed) }
        }
        guard epoch == generation, !Task.isCancelled else { return .failure("cancelled", "Dictado cancelado.") }
        guard granted else { return .failure("microphone_denied", "Activa el micrófono para Capri en Ajustes del iPhone.") }
        // The permission callback can precede didBecomeActive. Wait briefly
        // for the sheet to disappear, without starting a microphone while the
        // app is inactive or allowing an old start through a cancel fence.
        guard await waitForForeground(epoch: epoch) else {
            return .failure(epoch == generation ? "not_foreground" : "cancelled", "Vuelve a Capri para dictar.")
        }
        let id = UUID().uuidString
        var url = Self.temporaryDirectory.appendingPathComponent(id).appendingPathExtension("caf")
        if let ownerID, let retainDestination {
            guard let root = VoiceRetentionBinding.defaultRoot() else {
                return .failure("retention_unavailable", "No pude preparar el audio guardado.")
            }
            let binding = VoiceRetentionBinding(id: id, owner: ownerID, destination: retainDestination, root: root)
            let journalKind: VoiceRecoveryRecord.Kind
            switch selected.kind { case .speech: journalKind = .speech; case .dictation: journalKind = .dictation }
            do {
                let (record, path) = try VoiceRecoveryJournal(root: root).reserve(id: id, owner: ownerID,
                    destination: retainDestination, locale: selected.locale.identifier(.bcp47), kind: journalKind)
                retentionBinding = binding; retainedRecord = record; retentionCaptureIncomplete = false; url = path
            } catch {
                return .failure("retention_unavailable", "No pude reservar el audio. Revisa si hay un dictado guardado.")
            }
        }
        pendingStartURL = url
        do {
            let audio = AVAudioSession.sharedInstance()
            try audio.setCategory(.record, mode: .measurement)
            try audio.setActive(true)
            startupAudioActive = true
            liveTranscript = LiveTranscript(); previewIssue = nil
            let previewFormat = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [preview.module])
            guard epoch == generation, !Task.isCancelled, UIApplication.shared.applicationState == .active else {
                let cancelled = epoch != generation || Task.isCancelled
                cancel()
                return .failure(cancelled ? "cancelled" : "not_foreground", cancelled ? "Dictado cancelado." : "Vuelve a Capri para dictar.")
            }
            var live: LiveVoiceCapture?
            if let previewFormat {
                do {
                    let candidate = try LiveVoiceCapture(url: url, analyzerFormat: previewFormat, preserveOnStartFailure: retainDestination != nil) { [weak self] message in
                        guard self?.generation == epoch else { return }
                        self?.previewIssue = message
                    }
                    do { try await candidate.start(); live = candidate }
                    catch { if retainDestination != nil { throw error }; await candidate.cancel() }
                } catch { if retainDestination != nil { throw error } /* Existing recorder remains the fallback before capture starts. */ }
            }
            guard epoch == generation, !Task.isCancelled, UIApplication.shared.applicationState == .active else {
                let cancelled = epoch != generation || Task.isCancelled
                let keepCaptured = retainDestination != nil
                cancel()
                if let live { if keepCaptured { try? await live.stop() } else { await live.cancel() } }
                return .failure(cancelled ? "cancelled" : "not_foreground", cancelled ? "Dictado cancelado." : "Vuelve a Capri para dictar.")
            }
            if let live {
                liveCapture = live
            } else {
                // AVAudioRecorder's asynchronous completion callback can arrive
                // after stop(). Until that completion is fenced, it cannot
                // publish an opt-in recording as verified and complete.
                guard retainDestination == nil else { throw NSError(domain: "CapriVoice", code: 3) }
                guard VoiceFileCleanup.remove(url) else { throw NSError(domain: "CapriVoice", code: 2) }
                previewIssue = "La vista previa no está disponible. El audio se transcribirá al terminar."
                let capture = try AVAudioRecorder(url: url, settings: [
                    AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: format.sampleRate,
                    AVNumberOfChannelsKey: format.channelCount, AVLinearPCMBitDepthKey: 16,
                    AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false,
                ])
                capture.delegate = self
                capture.isMeteringEnabled = true
                guard capture.prepareToRecord(), capture.record(forDuration: maximumDuration) else {
                    throw NSError(domain: "CapriVoice", code: 1)
                }
                recorder = capture
            }
            try FileManager.default.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: url.path)
            recordingURL = url
            sessionID = id
            recordedLocale = selected.locale
            recordedKind = selected.kind
            recordedFormat = format
            if let live { beginPreview(preview, capture: live, session: id) }
            started = true
            return VoiceReply(ok: true, sessionId: id, maxDurationSeconds: Int(maximumDuration), retainedAudio: retainedRecord)
        } catch {
            // The normal cancellation fence owns the URL until all startup
            // candidates and writers have stopped and deletion is confirmed.
            cancel()
            return .failure("capture_failed", "No pude iniciar el micrófono. Intenta de nuevo.")
        }
    }

    private func waitForForeground(epoch: Int) async -> Bool {
        for _ in 0..<100 {
            guard epoch == generation, !Task.isCancelled else { return false }
            if UIApplication.shared.applicationState == .active { return true }
            if UIApplication.shared.applicationState == .background { return false }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        return false
    }

    func stop(id: String, retainOwner: String? = nil, retainDestination: String? = nil) async -> VoiceReply {
        guard !busy, id == sessionID, let url = recordingURL, let locale = recordedLocale, let kind = recordedKind,
              let format = recordedFormat else { return .failure("invalid_voice_session", "Ese comando de voz ya terminó o fue cancelado.") }
        let retainRequested = retainOwner != nil || retainDestination != nil
        if retainRequested {
            guard let retainOwner, UUID(uuidString: retainOwner) != nil,
                  let active = owners.active, active.lowercased() == retainOwner.lowercased(),
                  let binding = retentionBinding, binding.id.lowercased() == id.lowercased(),
                  binding.owner.lowercased() == retainOwner.lowercased(), binding.destination == retainDestination,
                  VoiceRetentionBinding.validDestination(retainDestination) else {
                return .failure("invalid_voice_retention", "No se pudo vincular el audio con su destino original.")
            }
        }
        if let binding = retentionBinding {
            guard let retainOwner, let retainDestination, binding.id.lowercased() == id.lowercased(),
                  binding.owner.lowercased() == retainOwner.lowercased(), binding.destination == retainDestination else {
                return .failure("invalid_voice_retention", "El audio reservado pertenece a otro dictado.")
            }
        }
        if finalDrain.active {
            return pending(id, reason: "closing")
        }
        busy = true
        let epoch = generation
        // Opt-in bytes are never removed just because this async task was
        // cancelled or a callback was lost. Only exact explicit discard may
        // remove their journal record.
        var preserve = retentionBinding != nil
        stoppingCapture = true
        recoveryPending = true
        recorder?.stop()
        recorder = nil
        defer {
            busy = false
            stoppingCapture = false
            analyzer = nil
            if sessionID == id && !preserve { clearCapture() }
        }
        if let live = liveCapture {
            do { try await live.stop() }
            catch {
                liveCapture = nil
                _ = await endPreview(); deactivateAudio()
                if retentionBinding != nil {
                    retentionCaptureIncomplete = true; preserve = true
                    return pending(id, reason: "capture_incomplete")
                }
                return .failure("capture_incomplete", "No pude conservar todo el audio. Vuelve a dictarlo.")
            }
            guard epoch == generation, !Task.isCancelled else {
                _ = await endPreview(); deactivateAudio()
                return .failure("cancelled", "Dictado cancelado.")
            }
            liveCapture = nil
        }
        // Free the provisional analyzer before starting the independently
        // verified final transcription from the complete recording.
        guard await endPreview() else {
            deactivateAudio()
            guard epoch == generation, sessionID == id, !Task.isCancelled else {
                return .failure("cancelled", "Dictado cancelado.")
            }
            recoveryPending = true
            preserve = true
            return pending(id, reason: "preview_pending")
        }
        guard epoch == generation, !Task.isCancelled else {
            deactivateAudio()
            return .failure("cancelled", "Dictado cancelado.")
        }
        // If iOS suspended the app during the drain, keep the complete
        // recording and retry in the foreground rather than producing a result
        // for a web view that may no longer exist.
        guard UIApplication.shared.applicationState == .active else {
            deactivateAudio()
            recoveryPending = true
            preserve = true
            return pending(id, reason: "background")
        }
        deactivateAudio()
        if let retainOwner, let retainDestination {
            guard let binding = retentionBinding, let record = retainedRecord,
                  binding.owner.lowercased() == retainOwner.lowercased(), binding.destination == retainDestination else {
                preserve = true; return pending(id, reason: "retention_failed")
            }
            if retentionCaptureIncomplete { preserve = true; return pending(id, reason: "capture_incomplete") }
            // The writer has drained. Only now may the bound recording be
            // published as ready; validation and hashing stay off main.
            let existingLease = retainedLease
            retentionLatch.begin()
            let work = Task.detached(priority: .userInitiated) {
                let journal = VoiceRecoveryJournal(root: binding.root)
                let ready: VoiceRecoveryRecord
                if record.state == .ready { ready = record } else { ready = try journal.publish(record) }
                let lease: VoiceRecoveryReadLease
                if let existingLease { lease = existingLease } else { lease = try journal.acquire(ready) }
                do { try lease.verify(); return (ready, lease) } catch { lease.close(); throw error }
            }
            let copy = await work.result
            retentionLatch.end()
            guard epoch == generation, sessionID == id, !Task.isCancelled else {
                    if case .success((let ready, let lease)) = copy {
                        lease.close()
                        if epoch == generation, sessionID == id { retainedRecord = ready; retainedLease = nil }
                    }
                return .failure("cancelled", "Dictado cancelado.")
            }
            switch copy {
            case .success((let ready, let lease)): retainedRecord = ready; retainedLease = lease
            case .failure:
                retainedLease = nil
                // Publication can succeed even if the following lease failed.
                // Adopt only its exact identity; a later retry will verify it.
                if let current = try? VoiceRecoveryJournal(root: binding.root).current(),
                   binding.matches(current), current.state == .ready { retainedRecord = current }
                preserve = true; return pending(id, reason: "retention_failed")
            }
            guard UIApplication.shared.applicationState == .active else {
                preserve = true; return pending(id, reason: "background")
            }
        }
        let module = makeTranscriber(for: locale, kind: kind)
        // Analyze the verified journal copy when retention was requested. The
        // original can never be substituted for the identity in the receipt.
        let analysisSource = retainedLease?.url ?? url
        let analysis = SpeechAnalyzer(modules: [module.module])
        analyzer = analysis
        let results = Task { @MainActor () throws -> [VoiceSegment] in
            var segments: [VoiceSegment] = []
            var characterCount = 0
            func append(_ resultText: AttributedString, _ range: CMTimeRange, _ isFinal: Bool) throws {
                try Task.checkCancellation()
                guard isFinal else { return }
                let text = String(resultText.characters).trimmingCharacters(in: .whitespacesAndNewlines)
                let start = CMTimeGetSeconds(range.start)
                let end = CMTimeGetSeconds(CMTimeRangeGetEnd(range))
                guard !text.isEmpty else { return }
                guard start.isFinite, end.isFinite, start >= 0, end >= start,
                      end <= self.maximumDuration + 1 else { throw VoiceEvidenceError.invalid }
                characterCount += text.utf16.count + (segments.isEmpty ? 0 : 1)
                guard segments.count < 2_000, characterCount <= 32_000 else {
                    throw VoiceEvidenceError.invalid
                }
                segments.append(VoiceSegment(text: text, startSeconds: start, endSeconds: end))
            }
            switch module {
            case .speech(let transcriber):
                for try await result in transcriber.results { try append(result.text, result.range, result.isFinal) }
            case .dictation(let transcriber):
                for try await result in transcriber.results { try append(result.text, result.range, result.isFinal) }
            }
            return segments.sorted { $0.startSeconds < $1.startSeconds }
        }
        finalResults = results
        let work = Task { @MainActor () -> VoiceReply in
            defer { results.cancel() }
            // Retained audio lives in Application Support. Conversion must use
            // the temporary directory, never create an orphan inside its journal.
            let convertedURL = Self.temporaryDirectory.appendingPathComponent("\(id).analysis.caf")
            defer { try? FileManager.default.removeItem(at: convertedURL) }
            var preparingAudio = true
            var phase = VoiceFailureDiagnostic.Phase.analysis
            do {
                // Conversion is bounded but can be slow. Keep it off the main
                // actor so timeout/background can release the UI promptly.
                let limit = self.maximumDuration
                let preparation = Task.detached(priority: .userInitiated) {
                    try VoiceAudio.openForAnalysis(source: analysisSource, converted: convertedURL,
                        format: format, maximumSeconds: limit)
                }
                let audioFile = try await preparation.value
                try Task.checkCancellation()
                preparingAudio = false
                let duration = Double(audioFile.length) / audioFile.processingFormat.sampleRate
                guard audioFile.length > 0 else {
                    return .failure("empty_audio", "No se capturó una instrucción.")
                }
                guard duration.isFinite, duration >= 0.001, duration <= self.maximumDuration + 1 else {
                    return .failure("invalid_evidence", "No pude verificar la duración del audio.")
                }
                guard let lastSample = try await analysis.analyzeSequence(from: audioFile) else {
                    // Apple documents nil here as an empty input file, not an
                    // indication that speech recognition found no words.
                    return .failure("empty_audio", "No se capturó una instrucción.")
                }
                phase = .finalization
                try await analysis.finalizeAndFinish(through: lastSample)
                phase = .results
                let segments = try await results.value
                guard !Task.isCancelled else { return .failure("cancelled", "Dictado cancelado.") }
                if !segments.isEmpty && !VoiceTranscriptBounds.valid(segments.map { (text: $0.text, start: $0.startSeconds, end: $0.endSeconds) }, duration: duration) {
                    return .failure("invalid_evidence", "No pude verificar los tiempos de la transcripción.")
                }
                let text = segments.map(\.text).joined(separator: " ")
                guard !text.isEmpty else { return .failure("no_speech", "No detecté palabras.") }
                return VoiceReply(ok: true, locale: locale.identifier(.bcp47), sessionId: id, text: text,
                    segments: segments, durationSeconds: duration, source: "apple-speech-analyzer")
            } catch {
                // The phase is enough to guide the user; do not expose error
                // payloads which may contain paths or other private details.
                let reason = error is VoiceEvidenceError ? "invalid_evidence" : preparingAudio ? "audio_format_unavailable" : "transcription_failed"
                var reply = VoiceReply.failure(reason, "No pude completar la transcripción local.")
                if reason == "transcription_failed" { reply.failureDiagnostic = VoiceFailureDiagnostic(phase: phase, error: error) }
                return reply
            }
        }
        finalOperation = work
        finalInterrupted = false
        let deadline = VoiceDeadline(operation: work, nanoseconds: 60_000_000_000)
        finalDeadline = deadline
        let result = await deadline.wait()
        finalDeadline = nil
        guard epoch == generation, sessionID == id, !Task.isCancelled else {
            requestFinalShutdown()
            return .failure("cancelled", "Dictado cancelado.")
        }
        if finalInterrupted || UIApplication.shared.applicationState != .active {
            requestFinalShutdown()
            preserve = true
            return pending(id, reason: "background")
        }
        guard var result, result.ok else {
            requestFinalShutdown()
            preserve = true
            return pending(id, reason: result?.error ?? "transcription_timeout", diagnostic: result?.failureDiagnostic)
        }
        finalOperation = nil
        finalResults = nil
        if let retainedRecord {
            // The caller may later save a durable draft. Returning a reply is
            // not such a receipt: retain the recording until explicit discard
            // or a future exact, verified acknowledgement is implemented.
            guard let lease = retainedLease else { preserve = true; return pending(id, reason: "retention_failed") }
            retentionLatch.begin()
            let verify = Task.detached(priority: .userInitiated) { try lease.verify() }
            let verification = await verify.result
            retentionLatch.end()
            guard epoch == generation, sessionID == id, !Task.isCancelled else { return .failure("cancelled", "Dictado cancelado.") }
            guard !finalInterrupted, UIApplication.shared.applicationState == .active else {
                preserve = true; return pending(id, reason: "background")
            }
            if case .failure = verification { preserve = true; return pending(id, reason: "retention_failed") }
            guard VoiceFileCleanup.remove(Self.temporaryDirectory.appendingPathComponent("\(id).analysis.caf")) else {
                preserve = true; return pending(id, reason: "cleanup_failed")
            }
            preserve = true
            result.retainedAudio = retainedRecord
            return result
        }
        // The converted file must disappear before the original. If cleanup
        // fails, retain the original and owner for an explicit retry/discard;
        // never return success and silently orphan captured audio.
        guard VoiceFileCleanup.removeFinalFiles(url) else {
            preserve = true
            recoveryPending = true
            return pending(id, reason: "cleanup_failed")
        }
        recoveryPending = false
        recoveryIssue = nil
        return result
    }

    /// A permission prompt resigns active too; don't cancel a pending first-use prompt.
    func resignActive() {
        if startLatch.active && startupAudioActive { cancel(); return }
        if analyzer != nil { finalInterrupted = true; finalDeadline?.interrupt(); requestFinalShutdown() }
        else if !recoveryPending && !stoppingCapture && sessionID != nil { cancel() }
    }

    func enterBackground() {
        // Unlike willResignActive (which also occurs for the permission sheet),
        // true background entry must fence a microphone start before sessionID.
        if startLatch.active { cancel() } else { resignActive() }
    }
    func audioInterrupted() {
        if startLatch.active { cancel() } else { resignActive() }
    }

    nonisolated func audioRecorderDidFinishRecording(_ recorder: AVAudioRecorder, successfully flag: Bool) {
        Task { @MainActor in
            guard self.recorder === recorder else { return }
            self.deactivateAudio()
            if !flag { self.cancel() }
        }
    }

    func cancel() {
        guard pendingCancellation == nil, !cancellationBarrier.active else { return }
        let cancelledOwner = owners.active
        let url = recordingURL ?? pendingStartURL
        let retainedBinding = retentionBinding
        let lease = retainedLease
        retainedLease = nil
        generation += 1
        finalDeadline?.interrupt()
        recorder?.stop()
        recorder = nil
        requestFinalShutdown()
        let live = liveCapture; liveCapture = nil
        // The cleanup task owns this path. clearCapture must never unlink it
        // while a startup candidate, writer or analyzer can still read it.
        recordingURL = nil
        requestPreviewShutdown()
        clearCapture()
        deactivateAudio()
        if live != nil || url != nil || retainedBinding != nil || startLatch.active || retentionLatch.active || previewDrain.active || finalDrain.active {
            pendingCancellation = PendingCancellation(id: UUID(), owner: cancelledOwner, url: url, live: live, retention: retainedBinding, lease: lease)
            beginPendingCancellation()
        }
    }

    private func beginPendingCancellation() {
        guard let pending = pendingCancellation, !cancellationBarrier.active else { return }
        cancellationBarrier.begin(owner: pending.owner) { [weak self] in
            guard let self else { return false }
            // A locally-created capture may not yet have reached liveCapture.
            // The start latch closes only after its epoch fence drains it.
            while !(await self.startLatch.wait()) { }
            while !(await self.retentionLatch.wait()) { }
            if let live = pending.live {
                if pending.retention != nil { try? await live.stop() }
                else { await live.cancel() }
            }
            while !(await self.previewDrain.wait()) { }
            while !(await self.finalDrain.wait()) { }
            // A journal source is removed only via the exclusive journal lock,
            // after readers have drained and the lease has been released.
            let journalSource = pending.retention.map { $0.root.appendingPathComponent("\($0.id.lowercased()).caf") }
            let removedAudio = pending.url?.standardizedFileURL == journalSource?.standardizedFileURL
                ? true : VoiceFileCleanup.remove(pending.url)
            let converted = pending.retention.map { Self.temporaryDirectory.appendingPathComponent("\($0.id).analysis.caf") }
                ?? pending.url?.deletingPathExtension().appendingPathExtension("analysis.caf")
            let removedConvertedAudio = VoiceFileCleanup.remove(converted)
            guard removedAudio, removedConvertedAudio else { return false }
            pending.lease?.close()
            // Cancel only stops capture/analysis. A retained journal copy is
            // never treated as disposable merely because a callback or app
            // lifecycle cancelled; it requires explicit discard or a future
            // verified durable acknowledgement.
            if self.pendingCancellation?.id == pending.id { self.pendingCancellation = nil }
            return true
        }
    }

    func cancelAndConfirm(ownerID: String?) async -> VoiceCancellationResult {
        // Record even before start/prepare arrive; only the matching owner can
        // stop the current native operation.
        if let ownerID {
            if owners.cancel(ownerID) { cancel() }
        } else { cancel() }
        // A failed unlink keeps its owner and path for the same owner's retry.
        if let pending = pendingCancellation, !cancellationBarrier.active,
           ownerID == nil || pending.owner == nil || ownerID == pending.owner { beginPendingCancellation() }
        // A timed-out shutdown continues; retrying the same owner waits on the
        // original operation rather than claiming that audio already stopped.
        let confirmed = await cancellationBarrier.wait(owner: ownerID)
        if confirmed { return .confirmed }
        return cancellationBarrier.active ? .closing : .cleanupFailed
    }

    /// Metadata only; a ready record is reported only after verifying its
    /// bytes. A capturing record remains explicitly incomplete after a crash.
    func inspectRetained() async -> VoiceReply {
        guard let root = VoiceRetentionBinding.defaultRoot() else {
            return .failure("retention_unavailable", "No pude abrir el audio guardado.")
        }
        let work = Task.detached(priority: .userInitiated) { () throws -> VoiceRecoveryRecord? in
            let journal = VoiceRecoveryJournal(root: root)
            guard let record = try journal.current() else { return nil }
            if record.state == .ready {
                let lease = try journal.acquire(record); defer { lease.close() }
                try lease.verify()
            }
            return record
        }
        do { return VoiceReply(ok: true, retainedAudio: try await work.value) }
        catch {
            return .failure("retention_unavailable", "No pude verificar el audio guardado. Se conserva para revisión.")
        }
    }

    /// Explicitly reconnect a verified, completed recording to its original
    /// owner and destination. This never begins recording or transcribing.
    func attachRetained(_ expected: VoiceRecoveryRecord) async -> VoiceReply {
        guard expected.state == .ready, !busy, sessionID == nil, !startLatch.active,
              !retentionLatch.active, !cancellationBarrier.active, pendingCancellation == nil,
              !previewDrain.active, !finalDrain.active else {
            return .failure("busy", "Termina el dictado actual antes de recuperar otro.")
        }
        guard UIApplication.shared.applicationState == .active, let root = VoiceRetentionBinding.defaultRoot(),
              owners.claim(expected.owner) else {
            return .failure("retention_unavailable", "Abre Capri para revisar el audio guardado.")
        }
        busy = true; startLatch.begin(); generation += 1
        let epoch = generation
        let binding = VoiceRetentionBinding(id: expected.id, owner: expected.owner,
            destination: expected.destination, root: root)
        retentionBinding = binding
        var attached = false
        defer {
            startLatch.end(); busy = false
            if !attached { owners.clearIfOwned(expected.owner); retentionBinding = nil; retainedRecord = nil }
        }
        let locale = Locale(identifier: expected.locale)
        let kind: VoiceTranscriberKind
        switch expected.kind { case .speech: kind = .speech; case .dictation: kind = .dictation }
        guard await installed(locale, kind: kind) else {
            return .failure("assets_required", "Prepara el idioma del audio para volver a transcribirlo.")
        }
        let module = makeTranscriber(for: locale, kind: kind)
        guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [module.module]) else {
            return .failure("audio_format_unavailable", "No hay un formato compatible para el audio guardado.")
        }
        guard epoch == generation, !Task.isCancelled, UIApplication.shared.applicationState == .active else {
            return .failure("cancelled", "La recuperación fue interrumpida; el audio se conserva.")
        }
        do {
            let work = Task.detached(priority: .userInitiated) {
                let lease = try VoiceRecoveryJournal(root: root).acquire(expected)
                do { try lease.verify(); return lease } catch { lease.close(); throw error }
            }
            let lease = try await work.value
            guard epoch == generation, !Task.isCancelled, UIApplication.shared.applicationState == .active else {
                lease.close(); return .failure("cancelled", "La recuperación fue interrumpida; el audio se conserva.")
            }
            retainedLease = lease; retainedRecord = expected; recordingURL = lease.url
            sessionID = expected.id; recordedLocale = locale; recordedKind = kind; recordedFormat = format
            recoveryPending = true; attached = true
            return VoiceReply(ok: true, sessionId: expected.id, ownerId: expected.owner, retainedAudio: expected)
        } catch {
            return .failure("retention_unavailable", "No pude verificar el audio guardado. Se conserva para revisión.")
        }
    }

    /// This operation is intended only for an explicit user discard. It is
    /// bound to the full record and refuses to race any live reader or capture.
    func discardRetained(_ expected: VoiceRecoveryRecord) -> VoiceReply {
        guard sessionID == nil, !busy, !startLatch.active, !retentionLatch.active,
              !cancellationBarrier.active, pendingCancellation == nil,
              let root = VoiceRetentionBinding.defaultRoot() else {
            return .failure("busy", "Termina el dictado actual antes de descartarlo.")
        }
        do {
            try VoiceRecoveryJournal(root: root).remove(expected)
            return VoiceReply(ok: true)
        } catch {
            return .failure("retention_unconfirmed", "No pude confirmar que se descartó el audio. Se conserva para revisión.")
        }
    }

    private func clearCapture() {
        if let url = recordingURL { try? FileManager.default.removeItem(at: url) }
        recordingURL = nil
        sessionID = nil
        recordedLocale = nil
        recordedKind = nil
        recordedFormat = nil
        liveTranscript = LiveTranscript()
        previewIssue = nil
        recoveryPending = false
        recoveryIssue = nil
        owners.clear()
        retentionBinding = nil
        retainedRecord = nil
        retainedLease?.close(); retainedLease = nil
        retentionCaptureIncomplete = false
    }

    private func deactivateAudio() {
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}
