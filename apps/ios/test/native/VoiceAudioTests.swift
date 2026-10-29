import AVFoundation
import Foundation

@main
struct VoiceAudioTests {
    static func note(_ stage: String) {
        FileHandle.standardError.write(Data("VoiceAudio fixture: \(stage)\n".utf8))
    }
    static func main() {
        do { try run() }
        catch {
            let value = error as NSError
            note("failed (\(value.domain), code \(value.code))")
            exit(1)
        }
    }
    static func run() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("capri-voice-format-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let source = root.appendingPathComponent("input.caf")
        let converted = root.appendingPathComponent("converted.caf")
        let sourceFormat = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1)!
        let targetFormat = AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1)!
        note("create-source")
        do {
            let writer = try AVAudioFile(forWriting: source, settings: sourceFormat.settings)
            let input = AVAudioPCMBuffer(pcmFormat: sourceFormat, frameCapacity: 48_000)!
            input.frameLength = input.frameCapacity
            for i in 0..<Int(input.frameLength) {
                input.floatChannelData![0][i] = Float(sin(Double(i) * 2 * .pi * 440 / 48_000) * 0.4)
            }
            note("write-source")
            try writer.write(from: input)
        }
        note("convert-begin")
        let file = try VoiceAudio.openForAnalysis(source: source, converted: converted,
                                                    format: targetFormat, maximumSeconds: 90, diagnostic: note)
        precondition(file.processingFormat.isEqual(targetFormat), "output must match the analyzer format")
        precondition(abs(Double(file.length) / file.processingFormat.sampleRate - 1) < 0.03,
                     "resampling must preserve duration")
        let output = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: 16_000)!
        note("read-converted")
        try file.read(into: output)
        let count = Int(output.frameLength)
        let peak = (0..<count).map { abs(output.floatChannelData![0][$0]) }.max() ?? 0
        precondition(peak > 0.1, "conversion must preserve audible samples")
        note("same-format")
        let unchanged = try VoiceAudio.openForAnalysis(source: source, converted: root.appendingPathComponent("unused.caf"),
                                                         format: sourceFormat, maximumSeconds: 90)
        precondition(unchanged.length == 48_000, "already compatible files must remain intact")
        precondition(!FileManager.default.fileExists(atPath: root.appendingPathComponent("unused.caf").path))
        note("int16-resampling")
        let int16Target = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true)!
        let int16URL = root.appendingPathComponent("int16-resampled.caf")
        let int16Output = try VoiceAudio.openForAnalysis(source: source, converted: int16URL, format: int16Target, maximumSeconds: 90)
        precondition(int16Output.fileFormat.commonFormat == .pcmFormatInt16, "physical converted encoding remains Int16")
        precondition(int16Output.processingFormat.commonFormat == .pcmFormatFloat32 && !int16Output.processingFormat.isInterleaved,
                     "SpeechAnalyzer file input uses standard Float32 processing")
        precondition(int16Output.processingFormat.sampleRate == 16_000 && int16Output.processingFormat.channelCount == 1)
        precondition(abs(Double(int16Output.length) / int16Output.processingFormat.sampleRate - 1) < 0.03)
        let samples = AVAudioPCMBuffer(pcmFormat: int16Output.processingFormat, frameCapacity: 16_000)!
        try int16Output.read(into: samples)
        precondition((0..<Int(samples.frameLength)).contains { abs(samples.floatChannelData![0][$0]) > 0.1 })

        note("already-matching-int16")
        let int16Source = root.appendingPathComponent("already-int16.caf")
        do {
            let writer = try AVAudioFile(forWriting: int16Source, settings: int16Target.settings,
                                         commonFormat: .pcmFormatFloat32, interleaved: false)
            let signal = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: 16_000)!
            signal.frameLength = signal.frameCapacity
            for i in 0..<Int(signal.frameLength) { signal.floatChannelData![0][i] = Float(sin(Double(i) * 2 * .pi * 440 / 16_000) * 0.4) }
            try writer.write(from: signal); writer.close()
        }
        let originalBytes = try Data(contentsOf: int16Source)
        let unused = root.appendingPathComponent("unused-int16.caf")
        let same = try VoiceAudio.openForAnalysis(source: int16Source, converted: unused, format: int16Target, maximumSeconds: 90)
        precondition(same.processingFormat.commonFormat == .pcmFormatFloat32 && !same.processingFormat.isInterleaved)
        precondition(same.processingFormat.sampleRate == 16_000 && same.processingFormat.channelCount == 1 && same.length == 16_000)
        let unchangedBytes = try Data(contentsOf: int16Source)
        precondition(!FileManager.default.fileExists(atPath: unused.path) && unchangedBytes == originalBytes,
                     "matching audio must not be rewritten")

        note("stereo-resampling")
        let stereoSource = root.appendingPathComponent("stereo.caf")
        let stereoInput = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 2)!
        let stereoTarget = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 2, interleaved: true)!
        do {
            let writer = try AVAudioFile(forWriting: stereoSource, settings: stereoInput.settings)
            let signal = AVAudioPCMBuffer(pcmFormat: stereoInput, frameCapacity: 48_000)!
            signal.frameLength = signal.frameCapacity
            for i in 0..<Int(signal.frameLength) {
                signal.floatChannelData![0][i] = Float(sin(Double(i) * 2 * .pi * 440 / 48_000) * 0.4)
                signal.floatChannelData![1][i] = Float(sin(Double(i) * 2 * .pi * 660 / 48_000) * 0.4)
            }
            try writer.write(from: signal); writer.close()
        }
        let stereo = try VoiceAudio.openForAnalysis(source: stereoSource, converted: root.appendingPathComponent("stereo-resampled.caf"), format: stereoTarget, maximumSeconds: 90)
        precondition(stereo.processingFormat.commonFormat == .pcmFormatFloat32 && stereo.processingFormat.channelCount == 2 && stereo.processingFormat.sampleRate == 16_000)
        precondition(abs(Double(stereo.length) / stereo.processingFormat.sampleRate - 1) < 0.03)
        let stereoSamples = AVAudioPCMBuffer(pcmFormat: stereo.processingFormat, frameCapacity: 16_000)!
        try stereo.read(into: stereoSamples)
        for channel in 0..<2 { precondition((0..<Int(stereoSamples.frameLength)).contains { abs(stereoSamples.floatChannelData![channel][$0]) > 0.1 }) }
        do { _ = try VoiceAudio.openForAnalysis(source: source, converted: converted, format: targetFormat, maximumSeconds: 91); preconditionFailure("invalid duration accepted") }
        catch VoiceAudioError.invalidFormat { }
        let longSource = root.appendingPathComponent("long-int16.caf")
        do {
            let writer = try AVAudioFile(forWriting: longSource, settings: int16Target.settings,
                                         commonFormat: .pcmFormatFloat32, interleaved: false)
            let signal = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: 32_000)!
            signal.frameLength = signal.frameCapacity
            try writer.write(from: signal); writer.close()
        }
        let longBytes = try Data(contentsOf: longSource)
        do { _ = try VoiceAudio.openForAnalysis(source: longSource, converted: unused, format: int16Target, maximumSeconds: 0.001); preconditionFailure("oversized matching input accepted") }
        catch VoiceAudioError.excessiveOutput { }
        let longAfter = try Data(contentsOf: longSource)
        precondition(longAfter == longBytes && !FileManager.default.fileExists(atPath: unused.path), "rejected source must remain unchanged")
        print("VoiceAudio: compatible and resampled files passed.")
    }
}
