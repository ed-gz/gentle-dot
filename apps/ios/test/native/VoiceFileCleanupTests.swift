import Foundation

@main
struct VoiceFileCleanupTests {
    static func main() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("capri-voice-cleanup-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let file = root.appendingPathComponent("voice.caf")
        try Data([1, 2, 3]).write(to: file)
        struct Failed: Error {}
        precondition(!VoiceFileCleanup.remove(file, using: { _ in throw Failed() }), "failed deletion cannot be acknowledged")
        precondition(FileManager.default.fileExists(atPath: file.path), "failed deletion must preserve the file for retry")
        precondition(VoiceFileCleanup.remove(file), "a later successful deletion is confirmed")
        precondition(VoiceFileCleanup.remove(file), "already-missing data is idempotent")
        precondition(VoiceFileCleanup.remove(nil))
        let converted = file.deletingPathExtension().appendingPathExtension("analysis.caf")
        try Data([1, 2, 3]).write(to: file)
        try Data([3, 2, 1]).write(to: converted)
        let failedFinal = VoiceFileCleanup.removeFinalFiles(file, using: { url in
            if url == converted { throw Failed() }
            try FileManager.default.removeItem(at: url)
        })
        precondition(!failedFinal && FileManager.default.fileExists(atPath: file.path) && FileManager.default.fileExists(atPath: converted.path), "failed conversion cleanup keeps the original for recovery")
        precondition(VoiceFileCleanup.removeFinalFiles(file), "retry removes both files")
        precondition(!FileManager.default.fileExists(atPath: file.path) && !FileManager.default.fileExists(atPath: converted.path))
        print("VoiceFileCleanup: failed unlink preserves bytes until a confirmed retry.")
    }
}
