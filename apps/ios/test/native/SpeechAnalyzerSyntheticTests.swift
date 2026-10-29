import AVFoundation
import CoreMedia
import Foundation
import Speech

// This is a CI probe, never an iPhone test. It uses only already-installed
// models and a system Spanish voice; it does not request or download assets.
@available(macOS 26.0, *)
private enum LocalModule {
    case speech(SpeechTranscriber, SpeechTranscriber)
    case dictation(DictationTranscriber, DictationTranscriber)
    var modules: [any SpeechModule] {
        switch self { case .speech(let final, let preview): return [final, preview]
        case .dictation(let final, let preview): return [final, preview] }
    }
    var final: any SpeechModule {
        switch self { case .speech(let final, _): return final
        case .dictation(let final, _): return final }
    }
    var name: String { switch self { case .speech: return "SpeechTranscriber"; case .dictation: return "DictationTranscriber" } }
}

@available(macOS 26.0, *)
private func candidate() async -> (Locale, LocalModule)? {
    let locales = [Locale(identifier: "es-MX"), Locale(identifier: "es-ES")]
    var options: [(Locale, LocalModule)] = []
    print("SUPPORT: SpeechTranscriber deviceAvailable=\(SpeechTranscriber.isAvailable)")
    if SpeechTranscriber.isAvailable {
        for requested in locales {
            if let locale = await SpeechTranscriber.supportedLocale(equivalentTo: requested) {
                let final = SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [], attributeOptions: [.audioTimeRange])
                let preview = SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [.volatileResults], attributeOptions: [.audioTimeRange])
                options.append((locale, .speech(final, preview)))
            } else { print("SUPPORT: SpeechTranscriber \(requested.identifier) unsupported") }
        }
    }
    for requested in locales {
        if let locale = await DictationTranscriber.supportedLocale(equivalentTo: requested) {
            let final = DictationTranscriber(locale: locale, contentHints: [], transcriptionOptions: [], reportingOptions: [], attributeOptions: [.audioTimeRange])
            let preview = DictationTranscriber(locale: locale, contentHints: [], transcriptionOptions: [], reportingOptions: [.volatileResults], attributeOptions: [.audioTimeRange])
            options.append((locale, .dictation(final, preview)))
        } else { print("SUPPORT: DictationTranscriber \(requested.identifier) unsupported") }
    }
    var selected: (Locale, LocalModule)?
    for option in options {
        let state = await AssetInventory.status(forModules: option.1.modules)
        let label: String
        switch state {
        case .installed: label = "installed"
        case .supported: label = "supported"
        case .downloading: label = "downloading"
        case .unsupported: label = "unsupported"
        @unknown default: label = "unknown"
        }
        print("SUPPORT: \(option.1.name) locale=\(option.0.identifier) assets=\(label)")
        if state == .installed && selected == nil { selected = option }
    }
    if let selected { return selected }
    return nil
}

@available(macOS 26.0, *)
private func run() async throws -> String {
    guard let voice = AVSpeechSynthesisVoice.speechVoices().first(where: { $0.language.lowercased().hasPrefix("es-") && $0.quality == .default }) else {
        return "SKIP: no available default Spanish synthesis voice; no transcription was run."
    }
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("capri-speech-probe-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let source = root.appendingPathComponent("synthetic.aiff"), converted = root.appendingPathComponent("converted.caf")
    let say = Process(); say.executableURL = URL(fileURLWithPath: "/usr/bin/say")
    say.arguments = ["-v", voice.name, "-o", source.path, "Capri, esta es una prueba local de voz."]
    say.standardOutput = FileHandle.nullDevice; say.standardError = FileHandle.nullDevice
    try say.run(); say.waitUntilExit()
    guard say.terminationReason == .exit, say.terminationStatus == 0 else { throw ProbeError.synthesis }
    let synthetic = try AVAudioFile(forReading: source)
    guard synthetic.length > 0, synthetic.processingFormat.sampleRate > 0 else { throw ProbeError.synthesis }
    // Exercise the actual conversion routine even when SpeechAnalyzer models
    // are absent. Force a different sample rate; preserve duration and samples.
    let sampleRate = synthetic.processingFormat.sampleRate == 16_000 ? 48_000.0 : 16_000.0
    guard let sampleFormat = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 1) else { throw ProbeError.noFormat }
    let formatProbeURL = root.appendingPathComponent("format-probe.caf")
    var usedConverter = false
    let formatProbe = try VoiceAudio.openForAnalysis(source: source, converted: formatProbeURL, format: sampleFormat, maximumSeconds: 90,
        diagnostic: { if $0 == "create-converter" { usedConverter = true } })
    let sourceDuration = Double(synthetic.length) / synthetic.processingFormat.sampleRate
    let outputDuration = Double(formatProbe.length) / formatProbe.processingFormat.sampleRate
    guard usedConverter, formatProbe.processingFormat.isEqual(sampleFormat), sourceDuration.isFinite,
          outputDuration.isFinite, sourceDuration > 0, sourceDuration <= 90,
          abs(sourceDuration - outputDuration) < 0.05 else { throw ProbeError.audio }
    guard let buffer = AVAudioPCMBuffer(pcmFormat: sampleFormat, frameCapacity: 4096) else { throw ProbeError.audio }
    var peak: Float = 0
    while formatProbe.framePosition < formatProbe.length {
        try formatProbe.read(into: buffer)
        guard buffer.frameLength > 0, let channel = buffer.floatChannelData?[0] else { throw ProbeError.audio }
        for index in 0..<Int(buffer.frameLength) { peak = max(peak, abs(channel[index])) }
    }
    guard peak > 0.001 else { throw ProbeError.audio }
    print("PASS: Spanish voice synthesis and VoiceAudio resampling preserve audible samples and duration. No transcription claimed.")
    guard let (_, selected) = await candidate() else { return "SKIP: no compatible module with installed Spanish assets; no transcription was run." }
    guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [selected.final]) else { throw ProbeError.noFormat }
    var convertedInput = false
    let file = try VoiceAudio.openForAnalysis(source: source, converted: converted, format: format, maximumSeconds: 90,
        diagnostic: { if $0 == "create-converter" { convertedInput = true } })
    guard file.length > 0, file.processingFormat.isEqual(format) else { throw ProbeError.audio }
    let duration = Double(file.length) / file.processingFormat.sampleRate
    let analyzer = SpeechAnalyzer(modules: [selected.final])
    let results = Task { () throws -> [(String, Double, Double)] in
        var parts: [(String, Double, Double)] = []
        func append(_ text: AttributedString, _ range: CMTimeRange, _ isFinal: Bool) throws {
            if !isFinal { return }
            let value = String(text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
            if value.isEmpty { return }
            let start = CMTimeGetSeconds(range.start), end = CMTimeGetSeconds(CMTimeRangeGetEnd(range))
            guard start.isFinite, end.isFinite, start >= 0, end >= start, end <= duration + 1 else { throw ProbeError.evidence }
            parts.append((value, start, end))
        }
        switch selected {
        case .speech(let transcriber, _): for try await item in transcriber.results { try append(item.text, item.range, item.isFinal) }
        case .dictation(let transcriber, _): for try await item in transcriber.results { try append(item.text, item.range, item.isFinal) }
        }
        return parts
    }
    defer { results.cancel() }
    guard let lastSample = try await analyzer.analyzeSequence(from: file) else { throw ProbeError.audio }
    try await analyzer.finalizeAndFinish(through: lastSample)
    let parts = try await results.value
    let transcript = parts.map { $0.0 }.joined(separator: " ").lowercased()
    guard transcript.contains("prueba") else { throw ProbeError.transcript }
    return "PASS: real \(selected.name) synthetic Spanish transcription, finalization and timing; VoiceAudio \(convertedInput ? "converted" : "used matching format"). Not an iPhone test."
}

private enum ProbeError: Error { case noFormat, synthesis, audio, evidence, transcript }
@main struct SpeechAnalyzerSyntheticTests {
    static func main() async {
        if #available(macOS 26.0, *) {
            do { print(try await run()) }
            catch { fputs("FAIL: synthetic SpeechAnalyzer probe failed; no successful transcription was established.\n", stderr); exit(1) }
        } else { print("SKIP: macOS 26 is required; no transcription was run.") }
    }
}
