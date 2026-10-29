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
        let brokenID = UUID().uuidString.lowercased()
        let broken = root.appendingPathComponent(brokenID, isDirectory: true)
        try FileManager.default.createDirectory(at: broken, withIntermediateDirectories: false)
        // A missing/unreadable manifest cannot prevent a separate valid item from being listed.
        let partial = try SharedInbox.listReport(root: root)
        guard partial.items.map({ $0.id }) == [manifest.id], partial.invalidIDs == [brokenID],
              FileManager.default.fileExists(atPath: broken.path) else { fatalError("partial recovery") }
        do { _ = try SharedInbox.list(root: root); fatalError("strict list ignored failure") } catch ShareFailure.invalid { }
        // Once the same native item is repaired it reappears; no failed list deletes it.
        let repaired = SharedManifest(schemaVersion: 1, id: brokenID, createdAt: manifest.createdAt,
                                      title: manifest.title, notes: manifest.notes, files: manifest.files)
        try JSONEncoder().encode(repaired).write(to: broken.appendingPathComponent("manifest.json"))
        try FileManager.default.copyItem(at: root.appendingPathComponent(manifest.id).appendingPathComponent("\(audio.id).blob"), to: broken.appendingPathComponent("\(audio.id).blob"))
        let recovered = try SharedInbox.listReport(root: root)
        guard recovered.items.count == 2, recovered.invalidIDs.isEmpty,
              try SharedInbox.read(brokenID, audio.id, 0, 10, root: root) == Data(repeating: 73, count: 10) else { fatalError("repaired item") }
        try SharedInbox.acknowledge(brokenID, root: root)
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
