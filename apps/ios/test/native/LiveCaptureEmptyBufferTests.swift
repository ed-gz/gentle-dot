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
        let largeURL = root.appendingPathComponent("large.caf")
        let large = try LiveCaptureState(url: largeURL, source: format, target: format, issue: { _ in })
        large.begin()
        let block = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 8_193)!
        block.frameLength = 8_193
        for index in 0..<8_193 { block.floatChannelData![0][index] = Float(index % 8) / 8 }
        large.receive(block)
        try await large.drain()
        let largeFile = try AVAudioFile(forReading: largeURL)
        precondition(largeFile.length == 8_193, "Every sample in a large block must be preserved.")
        let largeRead = AVAudioPCMBuffer(pcmFormat: largeFile.processingFormat, frameCapacity: 8_193)!
        try largeFile.read(into: largeRead)
        for index in 0..<8_193 { precondition(abs(largeRead.floatChannelData![0][index] - Float(index % 8) / 8) < 0.0001) }
        let stereoFormat = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 2)!
        let stereoURL = root.appendingPathComponent("stereo.caf")
        let stereo = try LiveCaptureState(url: stereoURL, source: stereoFormat, target: stereoFormat, issue: { _ in })
        stereo.begin()
        let stereoBlock = AVAudioPCMBuffer(pcmFormat: stereoFormat, frameCapacity: 8_193)!
        stereoBlock.frameLength = 8_193
        for channel in 0..<2 { for index in 0..<8_193 { stereoBlock.floatChannelData![channel][index] = Float((index + channel) % 8) / 8 } }
        stereo.receive(stereoBlock)
        try await stereo.drain()
        let stereoFile = try AVAudioFile(forReading: stereoURL)
        precondition(stereoFile.length == 8_193)
        let stereoRead = AVAudioPCMBuffer(pcmFormat: stereoFile.processingFormat, frameCapacity: 8_193)!
        try stereoFile.read(into: stereoRead)
        for channel in 0..<2 { for index in 0..<8_193 { precondition(abs(stereoRead.floatChannelData![channel][index] - Float((index + channel) % 8) / 8) < 0.0001) } }
        let bounded = try LiveCaptureState(url: root.appendingPathComponent("oversize.caf"), source: format, target: format, issue: { _ in })
        bounded.begin()
        let oversized = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 65_537)!
        oversized.frameLength = 65_537
        bounded.receive(oversized)
        do { try await bounded.drain(); fatalError("An oversized buffer must not become a verified recording.") }
        catch LiveVoiceCaptureError.captureOverflow { /* Expected fail-closed behavior. */ }
        // A missing preview format must not sacrifice the original recording.
        // Closing input represents stop/cancel: later engine callbacks are not
        // accepted, and the queued original bytes drain before the file closes.
        let noPreviewURL = root.appendingPathComponent("without-preview.caf")
        var previewIssues: [String] = []
        let noPreview = try LiveCaptureState(url: noPreviewURL, source: format, target: format, previewEnabled: false, issue: { previewIssues.append($0) })
        noPreview.begin()
        noPreview.receive(audio)
        noPreview.closeInput()
        noPreview.receive(block)
        try await noPreview.drain()
        precondition(previewIssues.count == 1)
        var input = noPreview.inputs.makeAsyncIterator()
        if case .some = await input.next() { fatalError("No preview inputs should be emitted.") }
        let noPreviewFile = try AVAudioFile(forReading: noPreviewURL)
        precondition(noPreviewFile.length == 4, "Closing capture must preserve accepted audio and reject later callbacks.")
        let noPreviewRead = AVAudioPCMBuffer(pcmFormat: noPreviewFile.processingFormat, frameCapacity: 4)!
        try noPreviewFile.read(into: noPreviewRead)
        for index in 0..<4 { precondition(abs(noPreviewRead.floatChannelData![0][index] - Float(index + 1) / 8) < 0.0001) }
        print("PASS: empty input and large blocks preserved synthetic samples; excessive blocks rejected. Not a microphone or iPhone test.")
    }
}
