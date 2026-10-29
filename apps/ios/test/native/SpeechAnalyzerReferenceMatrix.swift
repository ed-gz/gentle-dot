import AVFoundation
import CoreMedia
import Foundation
import Speech

private func formatFacts(_ format: AVAudioFormat) -> String {
    let stream = format.streamDescription.pointee
    return "rate=\(Int(format.sampleRate)) channels=\(format.channelCount) common=\(format.commonFormat.rawValue) interleaved=\(format.isInterleaved) id=\(stream.mFormatID) flags=\(stream.mFormatFlags) bits=\(stream.mBitsPerChannel)"
}

private func audible(_ file: AVAudioFile) throws -> Bool {
    guard let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: 4096) else { throw ProbeError.audio }
    while file.framePosition < file.length {
        try file.read(into: buffer)
        guard buffer.frameLength > 0, let channel = buffer.floatChannelData?[0] else { throw ProbeError.audio }
        for index in 0..<Int(buffer.frameLength) where abs(channel[index]) > 0.001 { return true }
    }
    return false
}

private func samePCM(_ first: URL, _ second: URL) throws -> Bool {
    let a = try AVAudioFile(forReading: first), b = try AVAudioFile(forReading: second)
    guard a.length > 0, a.processingFormat.channelCount > 0, a.length == b.length, a.processingFormat.sampleRate == b.processingFormat.sampleRate,
          a.processingFormat.channelCount == b.processingFormat.channelCount,
          let left = AVAudioPCMBuffer(pcmFormat: a.processingFormat, frameCapacity: 4096),
          let right = AVAudioPCMBuffer(pcmFormat: b.processingFormat, frameCapacity: 4096) else { return false }
    while a.framePosition < a.length {
        try a.read(into: left); try b.read(into: right)
        guard left.frameLength > 0, left.frameLength == right.frameLength,
              let l = left.floatChannelData, let r = right.floatChannelData else { return false }
        for channel in 0..<Int(a.processingFormat.channelCount) {
            for index in 0..<Int(left.frameLength) {
                guard l[channel][index].isFinite, r[channel][index].isFinite,
                      abs(l[channel][index] - r[channel][index]) <= 0.000001 else { return false }
            }
        }
    }
    return b.framePosition == b.length
}

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
        print("MATRIX FORMAT: target \(formatFacts(format))")
        let sourceInfo = try AVAudioFile(forReading: source)
        print("MATRIX FORMAT: original file \(formatFacts(sourceInfo.fileFormat)); processing \(formatFacts(sourceInfo.processingFormat)); frames=\(sourceInfo.length) start=\(sourceInfo.framePosition)")
        print("MATRIX: originalAudible=\(try audible(sourceInfo))")
        var cases: [(String, URL, Bool)] = [("original-analyze", source, false), ("original-start", source, true),
                                            ("original-int16-read-analyze", source, false), ("original-int16-read-start", source, true)]
        do {
            // A CAF copy at the source processing rate isolates the container
            // from VoiceAudio's resampling and format changes.
            let cafSource = root.appendingPathComponent("source-copy.caf")
            let input = try AVAudioFile(forReading: source)
            let output = try AVAudioFile(forWriting: cafSource, settings: input.processingFormat.settings)
            guard let buffer = AVAudioPCMBuffer(pcmFormat: input.processingFormat, frameCapacity: 4096) else { throw ProbeError.audio }
            while input.framePosition < input.length {
                try input.read(into: buffer)
                guard buffer.frameLength > 0 else { throw ProbeError.audio }
                try output.write(from: buffer)
            }
            output.close()
            let copied = try AVAudioFile(forReading: cafSource)
            print("MATRIX FORMAT: caf-copy file \(formatFacts(copied.fileFormat)); processing \(formatFacts(copied.processingFormat)); frames=\(copied.length) start=\(copied.framePosition)")
            print("MATRIX: cafCopyAudible=\(try audible(copied))")
            guard try samePCM(source, cafSource) else { throw ProbeError.audio }
            print("MATRIX: cafCopyMatchesSource=true")
            cases.append(("caf-copy-analyze", cafSource, false)); cases.append(("caf-copy-start", cafSource, true))
        } catch { print("MATRIX FAIL: caf-copy-setup \(errorIdentity(error)).") }
        do {
            // Preserve the original rate/samples while writing a 16-bit CAF.
            // This isolates physical encoding from resampling and read format.
            let int16URL = root.appendingPathComponent("source-int16.caf")
            let input = try AVAudioFile(forReading: source)
            guard let physical = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: input.processingFormat.sampleRate,
                                               channels: input.processingFormat.channelCount, interleaved: true),
                  let buffer = AVAudioPCMBuffer(pcmFormat: input.processingFormat, frameCapacity: 4096) else { throw ProbeError.audio }
            let output = try AVAudioFile(forWriting: int16URL, settings: physical.settings,
                                         commonFormat: input.processingFormat.commonFormat, interleaved: input.processingFormat.isInterleaved)
            while input.framePosition < input.length {
                try input.read(into: buffer)
                guard buffer.frameLength > 0 else { throw ProbeError.audio }
                try output.write(from: buffer)
            }
            output.close()
            let int16 = try AVAudioFile(forReading: int16URL)
            print("MATRIX FORMAT: caf-int16 file \(formatFacts(int16.fileFormat)); processing \(formatFacts(int16.processingFormat)); frames=\(int16.length) start=\(int16.framePosition)")
            guard try samePCM(source, int16URL) else { throw ProbeError.audio }
            print("MATRIX: cafInt16MatchesSource=true")
            cases.append(("caf-int16-default-analyze", int16URL, false)); cases.append(("caf-int16-default-start", int16URL, true))
            cases.append(("caf-int16-read-analyze", int16URL, false)); cases.append(("caf-int16-read-start", int16URL, true))
        } catch { print("MATRIX FAIL: caf-int16-setup \(errorIdentity(error)).") }
        do {
            let prepared = try VoiceAudio.openForAnalysis(source: source, converted: converted, format: format, maximumSeconds: 90)
            let convertedURL = prepared.url
            print("MATRIX FORMAT: converted file \(formatFacts(prepared.fileFormat)); processing \(formatFacts(prepared.processingFormat)); frames=\(prepared.length) start=\(prepared.framePosition)")
            let soundCheck = try AVAudioFile(forReading: convertedURL)
            print("MATRIX: convertedAudible=\(try audible(soundCheck))")
            print("MATRIX: convertedDistinct=\(convertedURL.standardizedFileURL != source.standardizedFileURL)")
            cases.append(("converted-analyze", convertedURL, false))
            cases.append(("converted-start", convertedURL, true))
            cases.append(("converted-default-analyze", convertedURL, false))
            cases.append(("converted-default-start", convertedURL, true))
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
                if label.contains("int16-read") { file = try AVAudioFile(forReading: fileURL, commonFormat: .pcmFormatInt16, interleaved: true) }
                else if label.hasPrefix("converted") && !label.contains("default") { file = try AVAudioFile(forReading: fileURL, commonFormat: format.commonFormat, interleaved: format.isInterleaved) }
                else { file = try AVAudioFile(forReading: fileURL) }
                guard file.length > 0 else { throw ProbeError.audio }
                print("MATRIX INPUT: \(label) file \(formatFacts(file.fileFormat)); processing \(formatFacts(file.processingFormat)); frames=\(file.length) start=\(file.framePosition)")
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
