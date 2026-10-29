import AVFoundation
import CoreVideo
import Foundation

enum AppGroupResolver {
    static func container(configured: String) throws -> URL { throw ShareFailure.unavailable }
}

@main struct SharedMediaInspectionTests {
    static func videoOnly(_ url: URL) async throws {
        let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: 64,
            AVVideoHeightKey: 64,
        ])
        let adapter = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32ARGB,
            kCVPixelBufferWidthKey as String: 64,
            kCVPixelBufferHeightKey as String: 64,
        ])
        guard writer.canAdd(input) else { fatalError("video writer input") }
        writer.add(input)
        guard writer.startWriting() else { fatalError("video writer start") }
        writer.startSession(atSourceTime: .zero)
        var pixel: CVPixelBuffer?
        guard CVPixelBufferCreate(kCFAllocatorDefault, 64, 64, kCVPixelFormatType_32ARGB, nil, &pixel) == kCVReturnSuccess,
              let pixel else { fatalError("video pixels") }
        CVPixelBufferLockBaseAddress(pixel, [])
        if let address = CVPixelBufferGetBaseAddress(pixel) { memset(address, 0, CVPixelBufferGetDataSize(pixel)) }
        CVPixelBufferUnlockBaseAddress(pixel, [])
        for _ in 0..<500 where !input.isReadyForMoreMediaData { try await Task.sleep(nanoseconds: 10_000_000) }
        guard input.isReadyForMoreMediaData else { fatalError("video writer timeout") }
        guard adapter.append(pixel, withPresentationTime: .zero) else { fatalError("video frame") }
        input.markAsFinished()
        await withCheckedContinuation { continuation in writer.finishWriting { continuation.resume() } }
        guard writer.status == .completed else { fatalError("video writer finish") }
    }

    static func main() async throws {
        guard CommandLine.arguments.count == 2 else { fatalError("audio fixture missing") }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("capri-media-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let staging = try SharedInbox.makeStaging(root: root)
        let audioURL = URL(fileURLWithPath: CommandLine.arguments[1])
        let audioBytes = try Data(contentsOf: audioURL)
        let audio = try SharedInbox.stageFile(audioURL, name: "reunion.m4a", mime: "audio/mp4", in: staging)
        try await SharedMediaInspection.requireAudioOnly(file: audio, in: staging)
        guard try Data(contentsOf: staging.appendingPathComponent("\(audio.id).blob")) == audioBytes else { fatalError("audio bytes changed") }

        let videoURL = root.appendingPathComponent("silent.mp4")
        try await videoOnly(videoURL)
        let videoBytes = try Data(contentsOf: videoURL)
        let video = try SharedInbox.stageFile(videoURL, name: "silent.mp4", mime: "audio/mp4", in: staging)
        do { try await SharedMediaInspection.requireAudioOnly(file: video, in: staging); fatalError("video accepted") }
        catch ShareFailure.unsupportedMedia { }
        guard try Data(contentsOf: staging.appendingPathComponent("\(video.id).blob")) == videoBytes,
              try Data(contentsOf: videoURL) == videoBytes else { fatalError("video bytes lost") }

        let invalidURL = root.appendingPathComponent("invalid.m4a")
        let invalidBytes = Data("not an audio container".utf8)
        try invalidBytes.write(to: invalidURL)
        let invalid = try SharedInbox.stageFile(invalidURL, name: "invalid.m4a", mime: "audio/mp4", in: staging)
        do { try await SharedMediaInspection.requireAudioOnly(file: invalid, in: staging); fatalError("invalid audio accepted") }
        catch ShareFailure.unsupportedMedia { }
        guard try Data(contentsOf: staging.appendingPathComponent("\(invalid.id).blob")) == invalidBytes else { fatalError("invalid bytes lost") }
        guard try FileManager.default.contentsOfDirectory(atPath: staging.path).allSatisfy({ !$0.hasPrefix(".inspect-") }) else { fatalError("temporary link not removed") }
        print("PASS: audio accepted; video and invalid media retained and rejected")
    }
}
