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
        print("VoiceAudio: compatible and resampled files passed.")
    }
}
