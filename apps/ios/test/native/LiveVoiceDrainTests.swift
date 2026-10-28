import Foundation

private final class WriteState {
    private let lock = NSLock()
    private var completed = false
    func mark() { lock.lock(); completed = true; lock.unlock() }
    func isComplete() -> Bool { lock.lock(); defer { lock.unlock() }; return completed }
}

@main
struct LiveVoiceDrainTests {
    static func main() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("capri-live-drain-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("audio.caf")
        try Data().write(to: file)
        let queue = DispatchQueue(label: "capri.test.writer")
        let allowWrite = DispatchSemaphore(value: 0)
        let state = WriteState()
        queue.async {
            allowWrite.wait()
            try! Data([1, 2, 3, 4]).write(to: file)
            state.mark()
        }
        // Simulate Stop and Cancel racing while a prior write is still pending.
        let stop = Task {
            await LiveVoiceDrain.barrier(on: queue) {
                precondition(state.isComplete())
            }
        }
        let cancel = Task {
            await LiveVoiceDrain.barrier(on: queue) {
                precondition(state.isComplete())
            }
            try? FileManager.default.removeItem(at: file)
        }
        try await Task.sleep(nanoseconds: 50_000_000)
        precondition(FileManager.default.fileExists(atPath: file.path), "cancel cannot remove a file still being written")
        allowWrite.signal()
        await stop.value; await cancel.value
        precondition(!FileManager.default.fileExists(atPath: file.path))
        print("LiveVoiceDrain: concurrent stop/cancel wait for pending writes.")
    }
}
