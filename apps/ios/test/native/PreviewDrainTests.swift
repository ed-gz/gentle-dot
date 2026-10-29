import Foundation

@main
struct PreviewDrainTests {
    @MainActor static func main() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("capri-preview-\(UUID())")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let file = folder.appendingPathComponent("recording.caf")
        let original = Data([0, 13, 255, 71, 82])
        try original.write(to: file)
        let drain = PreviewDrain()
        var finishes = 0
        drain.begin { try? await Task.sleep(nanoseconds: 150_000_000); finishes += 1 }
        drain.begin { finishes += 100 } // Duplicate shutdown is never started.
        var cleanupRan = false
        drain.after { cleanupRan = true }
        let first = await drain.wait(nanoseconds: 10_000_000)
        precondition(!first && drain.active && !cleanupRan)
        let afterTimeout = try Data(contentsOf: file)
        precondition(afterTimeout == original, "timeout must preserve original bytes")
        let second = await drain.wait(nanoseconds: 1_000_000_000)
        precondition(second && finishes == 1 && cleanupRan)
        let afterRetry = try Data(contentsOf: file)
        precondition(afterRetry == original, "retry must not delete or duplicate original bytes")
        print("PreviewDrain: timeout preserves audio and retry awaits the original shutdown.")
    }
}
