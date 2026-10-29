import Foundation

// This test supplies its own private root and never resolves an App Group.
enum AppGroupResolver {
    static func container(configured: String) throws -> URL { throw ShareFailure.unavailable }
}

@main struct SharedInboxLargeTests {
    static func main() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("capri-share-test-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let root = directory.appendingPathComponent("inbox", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let source = directory.appendingPathComponent("recording.m4a")
        guard FileManager.default.createFile(atPath: source.path, contents: nil) else { fatalError("source") }
        let handle = try FileHandle(forWritingTo: source)
        let block = Data(repeating: 73, count: 256 * 1024)
        for _ in 0..<104 { try handle.write(contentsOf: block) }
        try handle.write(contentsOf: Data([1, 2, 3]))
        try handle.close()
        let staging = try SharedInbox.makeStaging(root: root)
        let audio = try SharedInbox.stageFile(source, name: "recording.m4a", mime: "audio/mp4", in: staging)
        guard audio.size == 26 * 1024 * 1024 + 3 else { fatalError("audio size") }
        do { _ = try SharedInbox.stageFile(source, name: "notes.txt", mime: "text/plain", in: staging); fatalError("text over 25 MiB accepted") }
        catch ShareFailure.limit { }
        let manifest = try SharedInbox.publish(staging, title: "Meeting", notes: "", files: [audio], root: root)
        guard try SharedInbox.list(root: root).count == 1,
              try SharedInbox.read(manifest.id, audio.id, 0, 10, root: root) == Data(repeating: 73, count: 10),
              try SharedInbox.read(manifest.id, audio.id, audio.size - 3, 3, root: root) == Data([1, 2, 3]) else { fatalError("published audio") }
        try SharedInbox.acknowledge(manifest.id, root: root)
        guard FileManager.default.fileExists(atPath: source.path) else { fatalError("source deleted") }
        let badNameStaging = try SharedInbox.makeStaging(root: root)
        do { _ = try SharedInbox.stageFile(source, name: String(repeating: "🎵", count: 130) + ".m4a", mime: "audio/mp4", in: badNameStaging); fatalError("unusable name accepted") }
        catch ShareFailure.nameLimit { }
        guard FileManager.default.fileExists(atPath: source.path), try FileManager.default.contentsOfDirectory(atPath: badNameStaging.path).isEmpty else { fatalError("name failure lost source or copied bytes") }
        let oversizedStaging = try SharedInbox.makeStaging(root: root)
        let copied = try SharedInbox.stageFile(source, name: "recording.m4a", mime: "audio/mp4", in: oversizedStaging)
        let longNotes = String(repeating: "a" + String(repeating: "\u{0301}", count: 30), count: 1200)
        guard longNotes.count <= 8000, longNotes.utf8.count > 64 * 1024 else { fatalError("metadata fixture") }
        do { _ = try SharedInbox.publish(oversizedStaging, title: "Meeting", notes: longNotes, files: [copied], root: root); fatalError("oversized manifest published") }
        catch ShareFailure.metadataLimit { }
        guard try SharedInbox.list(root: root).isEmpty, FileManager.default.fileExists(atPath: source.path),
              FileManager.default.fileExists(atPath: oversizedStaging.appendingPathComponent("\(copied.id).blob").path) else { fatalError("unpublished source lost") }
        guard SharedInbox.fileLimit("audio/mp4") == 128 * 1024 * 1024,
              SharedInbox.fileLimit("text/plain") == 25 * 1024 * 1024,
              SharedInbox.maxTotal == 256 * 1024 * 1024 else { fatalError("limits") }
        guard DocumentImportMime.normalize(fileExtension: "m4a", reported: "application/octet-stream", conformsToAudio: false) == "audio/mp4",
              DocumentImportMime.normalize(fileExtension: "M4A", reported: "video/mp4", conformsToAudio: true) == "audio/mp4",
              DocumentImportMime.normalize(fileExtension: "wav", reported: nil, conformsToAudio: true) == "audio/x-unknown",
              DocumentImportMime.normalize(fileExtension: "pdf", reported: "application/pdf", conformsToAudio: false) == "application/pdf" else { fatalError("MIME classification") }
    }
}
