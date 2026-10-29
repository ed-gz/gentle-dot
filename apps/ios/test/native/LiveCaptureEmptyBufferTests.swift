import AVFoundation
import Foundation

/// Synthetic buffers only. Does not open a microphone or install speech assets.
@main struct LiveCaptureEmptyBufferTests {
    static func main() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("capri-empty-buffer-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let url = root.appendingPathComponent("synthetic.caf")
        let format = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1)!
        let state = try LiveCaptureState(url: url, source: format, target: format, issue: { _ in })
        state.begin()
        let empty = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 8)!
        precondition(empty.frameLength == 0)
        state.receive(empty)
        let audio = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 4)!
        audio.frameLength = 4
        for index in 0..<4 { audio.floatChannelData![0][index] = Float(index + 1) / 8 }
        state.receive(audio)
        try await state.drain()
        let file = try AVAudioFile(forReading: url)
        precondition(file.length == 4, "An empty buffer must not prevent later audio from being saved.")
        let read = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: 4)!
        try file.read(into: read)
        precondition(read.frameLength == 4)
        for index in 0..<4 { precondition(abs(read.floatChannelData![0][index] - Float(index + 1) / 8) < 0.0001) }
        print("PASS: empty input preserved subsequent synthetic samples. Not a microphone or iPhone test.")
    }
}
