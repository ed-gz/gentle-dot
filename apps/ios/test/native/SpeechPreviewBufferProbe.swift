import AVFoundation
import CoreMedia
import Darwin
import Dispatch
import Foundation
import Speech

/// Exercises the same buffer-based analyzer API as live preview with generated
/// speech. It never requests a microphone or prints audio, text or paths.
@available(macOS 26.0, *)
func runPreviewBufferProbe(locale: Locale) async throws {
    guard let voice = AVSpeechSynthesisVoice.speechVoices().first(where: {
        $0.language.lowercased().hasPrefix("es-") && $0.quality == .default
    }) else { throw ProbeError.synthesis }
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("capri-preview-buffers-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let source = root.appendingPathComponent("source.aiff"), converted = root.appendingPathComponent("converted.caf")
    let say = Process()
    say.executableURL = URL(fileURLWithPath: "/usr/bin/say")
    say.arguments = ["-v", voice.name, "-o", source.path, "Capri, esta es una prueba local de voz."]
    say.standardOutput = FileHandle.nullDevice; say.standardError = FileHandle.nullDevice
    try say.run(); say.waitUntilExit()
    guard say.terminationReason == .exit, say.terminationStatus == 0 else { throw ProbeError.synthesis }
    let selector = DictationTranscriber(locale: locale, contentHints: [], transcriptionOptions: [], reportingOptions: [.volatileResults], attributeOptions: [.audioTimeRange])
    guard let target = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [selector]) else { throw ProbeError.noFormat }
    guard target.commonFormat == .pcmFormatInt16, target.isInterleaved, target.sampleRate == 16_000 else {
        print("SKIP: preview Int16/16 kHz comparison is unavailable for this analyzer; not an iPhone test.")
        return
    }
    let prepared = try VoiceAudio.openForAnalysis(source: source, converted: converted, format: target, maximumSeconds: 90)
    guard prepared.url.standardizedFileURL == converted.standardizedFileURL, prepared.length > 0 else { throw ProbeError.audio }
    let before = try Data(contentsOf: converted)
    var failures = 0
    for label in ["int16", "float32"] {
        do {
            // The framework can terminate the process for an unsupported input
            // representation. Run each comparison separately so the parent can
            // report the exact signal and still release its locale reservation.
            let child = Process()
            child.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
            child.arguments = ["--preview-buffer-child", converted.path, locale.identifier, label]
            child.standardError = FileHandle.nullDevice
            let finished = DispatchSemaphore(value: 0)
            child.terminationHandler = { _ in finished.signal() }
            try child.run()
            if finished.wait(timeout: .now() + 25) == .timedOut {
                kill(child.processIdentifier, SIGKILL)
                child.waitUntilExit()
                failures += 1
                print("PREVIEW FAIL: \(label) child timed out; no transcript confirmed.")
                continue
            }
            child.waitUntilExit()
            guard child.terminationReason == .exit, child.terminationStatus == 0 else {
                failures += 1
                let reason = child.terminationReason == .uncaughtSignal ? "signal" : "exit"
                print("PREVIEW FAIL: \(label) child \(reason)=\(child.terminationStatus); no transcript confirmed.")
                continue
            }
        } catch {
            failures += 1
            print("PREVIEW FAIL: \(label) synthetic buffers \(errorIdentity(error)); no transcript confirmed.")
        }
    }
    guard try Data(contentsOf: converted) == before, failures == 0 else { throw ProbeError.audio }
}

/// Called only by the test binary's explicit child mode. Require the known
/// synthetic filename inside the runner's temporary directory.
@available(macOS 26.0, *)
func runPreviewBufferChild(arguments: [String]) async -> Int32 {
    guard arguments.count == 4, arguments[0] == "--preview-buffer-child",
          ["int16", "float32"].contains(arguments[3]),
          arguments[2].lowercased().replacingOccurrences(of: "_", with: "-") == "es-mx" else {
        print("PREVIEW FAIL: invalid synthetic child arguments."); return 2
    }
    let fileURL = URL(fileURLWithPath: arguments[1]).standardizedFileURL.resolvingSymlinksInPath()
    let temp = FileManager.default.temporaryDirectory.standardizedFileURL.resolvingSymlinksInPath()
    guard fileURL.lastPathComponent == "converted.caf",
          fileURL.deletingLastPathComponent().lastPathComponent.hasPrefix("capri-preview-buffers-"),
          fileURL.deletingLastPathComponent().deletingLastPathComponent() == temp else {
        print("PREVIEW FAIL: invalid synthetic child path."); return 2
    }
    do {
        let int16 = arguments[3] == "int16"
        let file = int16 ? try AVAudioFile(forReading: fileURL, commonFormat: .pcmFormatInt16, interleaved: true) : try AVAudioFile(forReading: fileURL)
        guard file.processingFormat.sampleRate == 16_000,
              file.processingFormat.commonFormat == (int16 ? .pcmFormatInt16 : .pcmFormatFloat32) else { throw ProbeError.audio }
        try await transcribePreviewBuffers(file: file, locale: Locale(identifier: arguments[2]))
        print("PREVIEW PASS: \(arguments[3]) synthetic buffers transcribed; not an iPhone test.")
        return 0
    } catch {
        print("PREVIEW FAIL: \(arguments[3]) synthetic buffers \(errorIdentity(error)); no transcript confirmed.")
        return 1
    }
}

@available(macOS 26.0, *)
private func transcribePreviewBuffers(file: AVAudioFile, locale: Locale) async throws {
    let module = DictationTranscriber(locale: locale, contentHints: [], transcriptionOptions: [], reportingOptions: [.volatileResults], attributeOptions: [.audioTimeRange])
    let analyzer = SpeechAnalyzer(modules: [module])
    let duration = Double(file.length) / file.processingFormat.sampleRate
    let result = Task { () throws -> Bool in
        var found = false
        for try await item in module.results {
            guard item.isFinal else { continue }
            let start = CMTimeGetSeconds(item.range.start), end = CMTimeGetSeconds(CMTimeRangeGetEnd(item.range))
            guard start.isFinite, end.isFinite, start >= 0, end >= start, end <= duration + 1 else { throw ProbeError.evidence }
            if String(item.text.characters).lowercased().contains("prueba") { found = true }
        }
        return found
    }
    defer { result.cancel() }
    do {
        let sequence = AsyncStream<AnalyzerInput>.makeStream(bufferingPolicy: .bufferingOldest(64))
        while file.framePosition < file.length {
            guard let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: 4096) else { throw ProbeError.audio }
            try file.read(into: buffer)
            guard buffer.frameLength > 0 else { throw ProbeError.audio }
            guard case .enqueued = sequence.continuation.yield(AnalyzerInput(buffer: buffer)) else { throw ProbeError.audio }
        }
        sequence.continuation.finish()
        guard let last = try await analyzer.analyzeSequence(sequence.stream) else { throw ProbeError.audio }
        try await analyzer.finalizeAndFinish(through: last)
        guard try await result.value else { throw ProbeError.transcript }
    } catch {
        await analyzer.cancelAndFinishNow()
        throw error
    }
}
