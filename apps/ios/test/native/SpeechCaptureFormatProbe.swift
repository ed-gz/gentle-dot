import AVFoundation
import CoreMedia
import Foundation
import Speech

/// Real synthetic coverage of capture-like audio formats; no microphone or user audio.
@available(macOS 26.0, *)
func runCaptureFormatProbe(locale: Locale) async throws {
    guard let voice = AVSpeechSynthesisVoice.speechVoices().first(where: {
        $0.language.lowercased().hasPrefix("es-") && $0.quality == .default
    }) else { throw ProbeError.synthesis }
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("capri-capture-format-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let source = root.appendingPathComponent("source.aiff")
    let captured = root.appendingPathComponent("captured.caf")
    let converted = root.appendingPathComponent("converted.caf")
    let unused = root.appendingPathComponent("unused.caf")
    let say = Process()
    say.executableURL = URL(fileURLWithPath: "/usr/bin/say")
    say.arguments = ["-v", voice.name, "-o", source.path, "Capri, esta es una prueba local de voz."]
    say.standardOutput = FileHandle.nullDevice; say.standardError = FileHandle.nullDevice
    try say.run(); say.waitUntilExit()
    guard say.terminationReason == .exit, say.terminationStatus == 0,
          let captureFormat = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1) else { throw ProbeError.synthesis }
    // Model an AVAudioEngine source as Float32 CAF with a higher sample rate.
    let capture = try VoiceAudio.openForAnalysis(source: source, converted: captured, format: captureFormat, maximumSeconds: 90)
    guard capture.url.standardizedFileURL == captured.standardizedFileURL,
          capture.fileFormat.sampleRate == 48_000, capture.fileFormat.channelCount == 1,
          capture.processingFormat.commonFormat == .pcmFormatFloat32, capture.length > 0 else { throw ProbeError.audio }
    let firstModule = DictationTranscriber(locale: locale, contentHints: [], transcriptionOptions: [], reportingOptions: [], attributeOptions: [.audioTimeRange])
    guard let target = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [firstModule]) else { throw ProbeError.noFormat }
    var convertedInput = false
    let first = try VoiceAudio.openForAnalysis(source: captured, converted: converted, format: target, maximumSeconds: 90,
        diagnostic: { if $0 == "create-converter" { convertedInput = true } })
    guard convertedInput, first.url.standardizedFileURL == converted.standardizedFileURL,
          first.processingFormat.commonFormat == .pcmFormatFloat32,
          first.processingFormat.sampleRate == target.sampleRate,
          first.processingFormat.channelCount == target.channelCount else { throw ProbeError.audio }
    try await transcribeCaptureProbe(file: first, module: firstModule)
    print("PASS: synthetic Float32 48 kHz CAF capture converted and transcribed by DictationTranscriber; not an iPhone test.")

    // The target-format path must keep the existing file and all its bytes.
    let before = try Data(contentsOf: converted)
    var unnecessaryConversion = false
    let second = try VoiceAudio.openForAnalysis(source: converted, converted: unused, format: target, maximumSeconds: 90,
        diagnostic: { if $0 == "create-converter" { unnecessaryConversion = true } })
    guard !unnecessaryConversion, !FileManager.default.fileExists(atPath: unused.path),
          second.url.standardizedFileURL == converted.standardizedFileURL,
          second.processingFormat.commonFormat == .pcmFormatFloat32,
          try Data(contentsOf: converted) == before else { throw ProbeError.audio }
    let secondModule = DictationTranscriber(locale: locale, contentHints: [], transcriptionOptions: [], reportingOptions: [], attributeOptions: [.audioTimeRange])
    try await transcribeCaptureProbe(file: second, module: secondModule)
    print("PASS: already-compatible synthetic recording remained unchanged and transcribed; not an iPhone test.")
}

@available(macOS 26.0, *)
private func transcribeCaptureProbe(file: AVAudioFile, module: DictationTranscriber) async throws {
    let duration = Double(file.length) / file.processingFormat.sampleRate
    let analyzer = SpeechAnalyzer(modules: [module])
    let results = Task { () throws -> Bool in
        var found = false
        for try await result in module.results {
            guard result.isFinal else { continue }
            let begin = CMTimeGetSeconds(result.range.start), end = CMTimeGetSeconds(CMTimeRangeGetEnd(result.range))
            guard begin.isFinite, end.isFinite, begin >= 0, end >= begin, end <= duration + 1 else { throw ProbeError.evidence }
            if String(result.text.characters).lowercased().contains("prueba") { found = true }
        }
        return found
    }
    defer { results.cancel() }
    do {
        guard let last = try await analyzer.analyzeSequence(from: file) else { throw ProbeError.audio }
        try await analyzer.finalizeAndFinish(through: last)
        guard try await results.value else { throw ProbeError.transcript }
    } catch {
        await analyzer.cancelAndFinishNow()
        throw error
    }
}
