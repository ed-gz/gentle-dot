import AVFoundation
import CoreMedia
import Foundation
import Speech

/// Four isolated analyzers on generated Spanish speech. This does not use a
/// microphone or device audio and never emits recognized text or file paths.
@available(macOS 26.0, *)
func runReferenceMatrix(locale: Locale) async {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("capri-speech-matrix-\(UUID().uuidString)", isDirectory: true)
    do {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        guard let voice = AVSpeechSynthesisVoice.speechVoices().first(where: { $0.language.lowercased().hasPrefix("es-") && $0.quality == .default }) else {
            print("MATRIX SKIP: no Spanish synthesis voice."); return
        }
        let source = root.appendingPathComponent("source.aiff"), converted = root.appendingPathComponent("converted.caf")
        let say = Process(); say.executableURL = URL(fileURLWithPath: "/usr/bin/say")
        say.arguments = ["-v", voice.name, "-o", source.path, "Capri, esta es una prueba local de voz."]
        say.standardOutput = FileHandle.nullDevice; say.standardError = FileHandle.nullDevice
        try say.run(); say.waitUntilExit()
        guard say.terminationReason == .exit, say.terminationStatus == 0 else { throw ProbeError.synthesis }
        let formatModule = DictationTranscriber(locale: locale, contentHints: [], transcriptionOptions: [], reportingOptions: [], attributeOptions: [.audioTimeRange])
        guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [formatModule]) else { throw ProbeError.noFormat }
        var cases: [(String, URL, Bool)] = [("original-analyze", source, false), ("original-start", source, true)]
        do {
            let prepared = try VoiceAudio.openForAnalysis(source: source, converted: converted, format: format, maximumSeconds: 90)
            let convertedURL = prepared.url
            print("MATRIX: convertedDistinct=\(convertedURL.standardizedFileURL != source.standardizedFileURL)")
            cases.append(("converted-analyze", convertedURL, false))
            cases.append(("converted-start", convertedURL, true))
        } catch {
            print("MATRIX FAIL: converted-setup \(errorIdentity(error)).")
        }
        for (label, fileURL, autonomous) in cases {
            let module = DictationTranscriber(locale: locale, contentHints: [], transcriptionOptions: [], reportingOptions: [], attributeOptions: [.audioTimeRange])
            let analyzer = SpeechAnalyzer(modules: [module])
            let results = Task { () throws -> Bool in
                var found = false
                for try await result in module.results {
                    if result.isFinal && String(result.text.characters).lowercased().contains("prueba") { found = true }
                }
                return found
            }
            var stage = "open"
            do {
                // Open the original directly; open the converted file in the
                // requested processing representation without conversion.
                let file: AVAudioFile
                if label.hasPrefix("original") { file = try AVAudioFile(forReading: fileURL) }
                else { file = try AVAudioFile(forReading: fileURL, commonFormat: format.commonFormat, interleaved: format.isInterleaved) }
                guard file.length > 0 else { throw ProbeError.audio }
                stage = autonomous ? "start" : "analyze"
                if autonomous { try await analyzer.start(inputAudioFile: file, finishAfterFile: true) }
                else {
                    guard let last = try await analyzer.analyzeSequence(from: file) else { throw ProbeError.audio }
                    stage = "finalize"; try await analyzer.finalizeAndFinish(through: last)
                }
                stage = "results"
                guard try await results.value else { throw ProbeError.transcript }
                print("MATRIX PASS: \(label) produced expected final synthetic speech.")
            } catch {
                print("MATRIX FAIL: \(label) stage=\(stage) \(errorIdentity(error)).")
                results.cancel()
                await analyzer.cancelAndFinishNow()
            }
        }
    } catch {
        print("MATRIX FAIL: setup \(errorIdentity(error)).")
    }
}
