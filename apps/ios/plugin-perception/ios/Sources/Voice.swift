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
    var maxDurationSeconds: Int? = nil
    var partial: String? = nil
    var previewIssue: String? = nil
    var text: String? = nil
    var segments: [VoiceSegment]? = nil
    var durationSeconds: Double? = nil
    var source: String? = nil

    static func failure(_ error: String, _ message: String) -> VoiceReply {
        VoiceReply(message: message, error: error)
    }
}

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
        var speech: Locale?
        if SpeechTranscriber.isAvailable {
            for preferred in preferences {
                if let locale = await SpeechTranscriber.supportedLocale(equivalentTo: preferred) { speech = locale; break }
            }
        }
        // DictationTranscriber is also on-device and covers additional locales
        // and devices when the newer SpeechTranscriber is unavailable.
        var dictation: Locale?
        for preferred in preferences {
            if let locale = await DictationTranscriber.supportedLocale(equivalentTo: preferred) { dictation = locale; break }
        }
        // An installed local option is useful offline; do not demand a new
        // download simply because the preferred module also has a locale.
        if let locale = speech, await installed(locale, kind: .speech) { return (locale, .speech) }
        if let locale = dictation, await installed(locale, kind: .dictation) { return (locale, .dictation) }
        if let locale = speech { return (locale, .speech) }
        if let locale = dictation { return (locale, .dictation) }
        return nil
    }

    private func installed(_ locale: Locale, kind: VoiceTranscriberKind) async -> Bool {
        let locales: [Locale]
        switch kind {
        case .speech: locales = await SpeechTranscriber.installedLocales
        case .dictation: locales = await DictationTranscriber.installedLocales
        }
        return locales.contains { $0.identifier(.bcp47) == locale.identifier(.bcp47) }
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
            previewResultsTask?.cancel()
            if let analyzer = previewAnalyzer { Task { await analyzer.cancelAndFinishNow() } }
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
                }
            }
        }
        previewAnalysisTask = Task { @MainActor [weak self] in
            do {
                if let end = try await analyzer.analyzeSequence(capture.inputs) {
                    try await analyzer.finalizeAndFinish(through: end)
                } else { await analyzer.cancelAndFinishNow() }
            } catch {
                await analyzer.cancelAndFinishNow()
                if !Task.isCancelled, self?.sessionID == session {
                    self?.previewIssue = "La vista previa se interrumpió. El audio completo se transcribirá al terminar."
                }
            }
        }
    }

    private func endPreview() async -> Bool {
        previewAnalysisTask?.cancel(); previewAnalysisTask = nil
        previewResultsTask?.cancel(); previewResultsTask = nil
        let analyzer = previewAnalyzer; previewAnalyzer = nil
        guard let analyzer else { return true }
        // Never begin the final analyzer while an old one may still be active.
        // If Apple doesn't finish cancellation, fail visibly instead of hanging
        // indefinitely or pretending that a concurrent retry is safe.
        return await withCheckedContinuation { continuation in
            var settled = false
            let finish: (Bool) -> Void = { result in
                guard !settled else { return }
                settled = true; continuation.resume(returning: result)
            }
            Task { @MainActor in await analyzer.cancelAndFinishNow(); finish(true) }
            DispatchQueue.main.asyncAfter(deadline: .now() + 8) { finish(false) }
        }
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
            return VoiceReply(ok: true, available: true, status: "available", locale: locale.identifier(.bcp47),
                assetsInstalled: true, microphonePermission: permission, recording: recording,
                readyToTranscribe: !recording, busy: busy, sessionId: id, maxDurationSeconds: Int(maximumDuration),
                partial: liveTranscript.text, previewIssue: previewIssue)
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
        guard !busy, sessionID == nil else { return .failure("busy", "Termina o cancela el comando de voz actual.") }
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
            if let request = try await AssetInventory.assetInstallationRequest(supporting: [module.module]) {
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

    func start(ownerID: String? = nil) async -> VoiceReply {
        guard !busy, sessionID == nil else { return .failure("busy", "Ya hay un comando de voz en curso.") }
        guard UIApplication.shared.applicationState == .active else { return .failure("not_foreground", "Abre Capri para dictar.") }
        if let ownerID, !owners.claim(ownerID) { return .failure("cancelled", "Ese dictado fue cancelado o sustituido.") }
        busy = true
        generation += 1
        let epoch = generation
        var started = false
        defer { busy = false; if let ownerID { owners.finishAttempt(ownerID, succeeded: started) } }
        guard let selected = await preferredTranscriber() else {
            return .failure("unsupported_language", "SpeechAnalyzer no está disponible en español en este iPhone.")
        }
        guard await installed(selected.locale, kind: selected.kind) else { return .failure("assets_required", "Prepara los modelos de voz antes de dictar sin conexión.") }
        let module = makeTranscriber(for: selected.locale, kind: selected.kind)
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
        guard UIApplication.shared.applicationState != .background else { return .failure("not_foreground", "Vuelve a Capri para dictar.") }
        let id = UUID().uuidString
        let url = Self.temporaryDirectory.appendingPathComponent(id).appendingPathExtension("caf")
        do {
            let audio = AVAudioSession.sharedInstance()
            try audio.setCategory(.record, mode: .measurement)
            try audio.setActive(true)
            liveTranscript = LiveTranscript(); previewIssue = nil
            let preview = makeTranscriber(for: selected.locale, kind: selected.kind, incremental: true)
            let previewFormat = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [preview.module])
            guard epoch == generation, !Task.isCancelled else {
                deactivateAudio()
                return .failure("cancelled", "Dictado cancelado.")
            }
            var live: LiveVoiceCapture?
            if let previewFormat {
                do {
                    let candidate = try LiveVoiceCapture(url: url, analyzerFormat: previewFormat) { [weak self] message in
                        guard self?.generation == epoch else { return }
                        self?.previewIssue = message
                    }
                    do { try await candidate.start(); live = candidate }
                    catch { await candidate.cancel() }
                } catch { /* Existing recorder remains the fallback before capture starts. */ }
            }
            guard epoch == generation, !Task.isCancelled else {
                if let live { await live.cancel() }
                deactivateAudio()
                return .failure("cancelled", "Dictado cancelado.")
            }
            if let live {
                liveCapture = live
            } else {
                try? FileManager.default.removeItem(at: url)
                previewIssue = "La vista previa no está disponible. El audio se transcribirá al terminar."
                let capture = try AVAudioRecorder(url: url, settings: [
                    AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: format.sampleRate,
                    AVNumberOfChannelsKey: format.channelCount, AVLinearPCMBitDepthKey: 16,
                    AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false,
                ])
                capture.delegate = self
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
            return VoiceReply(ok: true, sessionId: id, maxDurationSeconds: Int(maximumDuration))
        } catch {
            if let live = liveCapture { liveCapture = nil; await live.cancel() }
            recorder?.stop(); recorder = nil
            try? FileManager.default.removeItem(at: url)
            deactivateAudio()
            return .failure("capture_failed", "No pude iniciar el micrófono. Intenta de nuevo.")
        }
    }

    func stop(id: String) async -> VoiceReply {
        guard !busy, id == sessionID, let url = recordingURL, let locale = recordedLocale, let kind = recordedKind,
              let format = recordedFormat else { return .failure("invalid_voice_session", "Ese comando de voz ya terminó o fue cancelado.") }
        busy = true
        let epoch = generation
        recorder?.stop()
        recorder = nil
        defer {
            busy = false
            analyzer = nil
            if sessionID == id { clearCapture() }
        }
        if let live = liveCapture {
            do { try await live.stop() }
            catch {
                liveCapture = nil
                _ = await endPreview(); deactivateAudio()
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
            return .failure("transcription_timeout", "No pude terminar la vista previa. Intenta dictar de nuevo.")
        }
        guard epoch == generation, !Task.isCancelled else {
            deactivateAudio()
            return .failure("cancelled", "Dictado cancelado.")
        }
        deactivateAudio()
        let module = makeTranscriber(for: locale, kind: kind)
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
                guard !text.isEmpty, start.isFinite, end.isFinite, start >= 0, end >= start,
                      end <= self.maximumDuration + 1 else { return }
                characterCount += text.count + (segments.isEmpty ? 0 : 1)
                guard segments.count < 2_000, characterCount <= 32_000 else {
                    throw NSError(domain: "CapriVoiceLimit", code: 1)
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
        var timedOut = false
        let timeout = Task { @MainActor in
            do { try await Task.sleep(nanoseconds: 60_000_000_000) } catch { return }
            timedOut = true
            results.cancel()
            await analysis.cancelAndFinishNow()
        }
        defer { timeout.cancel(); results.cancel() }
        let convertedURL = url.deletingPathExtension().appendingPathExtension("analysis.caf")
        defer { try? FileManager.default.removeItem(at: convertedURL) }
        do {
            let audioFile = try VoiceAudio.openForAnalysis(source: url, converted: convertedURL,
                format: format, maximumSeconds: maximumDuration)
            let duration = Double(audioFile.length) / audioFile.processingFormat.sampleRate
            guard duration.isFinite, duration > 0, duration <= maximumDuration + 1 else {
                await analysis.cancelAndFinishNow()
                return .failure("empty_audio", "No se capturó una instrucción. Toca el micrófono, habla y vuelve a tocarlo para transcribir.")
            }
            if let lastSample = try await analysis.analyzeSequence(from: audioFile) {
                try await analysis.finalizeAndFinish(through: lastSample)
            } else {
                await analysis.cancelAndFinishNow()
            }
            let segments = try await results.value
            guard epoch == generation, !Task.isCancelled else { return .failure("cancelled", "Dictado cancelado.") }
            guard !timedOut else { return .failure("transcription_timeout", "La transcripción tardó demasiado. Prueba una instrucción más corta.") }
            let text = segments.map(\.text).joined(separator: " ")
            guard !text.isEmpty else { return .failure("no_speech", "No detecté palabras. Puedes intentar de nuevo.") }
            return VoiceReply(ok: true, locale: locale.identifier(.bcp47), sessionId: id, text: text,
                segments: segments, durationSeconds: duration, source: "apple-speech-analyzer")
        } catch {
            await analysis.cancelAndFinishNow()
            if epoch != generation || Task.isCancelled { return .failure("cancelled", "Dictado cancelado.") }
            if error is VoiceAudioError {
                return .failure("audio_format_unavailable", "No pude preparar el audio para el reconocimiento local. Intenta dictar de nuevo.")
            }
            return .failure(timedOut ? "transcription_timeout" : "transcription_failed",
                "No pude completar la transcripción local. El audio temporal se eliminó.")
        }
    }

    /// A permission prompt resigns active too; don't cancel a pending first-use prompt.
    func resignActive() {
        if sessionID != nil || analyzer != nil { cancel() }
    }

    nonisolated func audioRecorderDidFinishRecording(_ recorder: AVAudioRecorder, successfully flag: Bool) {
        Task { @MainActor in
            guard self.recorder === recorder else { return }
            self.deactivateAudio()
            if !flag { self.cancel() }
        }
    }

    func cancel() {
        generation += 1
        recorder?.stop()
        recorder = nil
        if let analysis = analyzer { Task { await analysis.cancelAndFinishNow() } }
        let live = liveCapture; liveCapture = nil
        // The live capture owns its file until its asynchronous writer drains.
        // Do not unlink or replace it while a queued write is still running.
        if live != nil { recordingURL = nil }
        previewAnalysisTask?.cancel(); previewAnalysisTask = nil
        previewResultsTask?.cancel(); previewResultsTask = nil
        if let preview = previewAnalyzer { previewAnalyzer = nil; Task { await preview.cancelAndFinishNow() } }
        clearCapture()
        deactivateAudio()
        if let live { Task { await live.cancel() } }
    }

    func cancel(ownerID: String) {
        // Record even before start/prepare arrive; only the matching owner can
        // stop the current native operation.
        if owners.cancel(ownerID) { cancel() }
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
        owners.clear()
    }

    private func deactivateAudio() {
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}
