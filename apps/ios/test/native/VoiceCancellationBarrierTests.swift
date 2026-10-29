import Foundation

@main
struct VoiceCancellationBarrierTests {
    @MainActor
    static func main() async {
        let barrier = VoiceCancellationBarrier()
        var finish: CheckedContinuation<Void, Never>?
        barrier.begin(owner: "owner-A") { await withCheckedContinuation { finish = $0 }; return true }
        for _ in 0..<100 { if finish != nil { break }; await Task.yield() }
        precondition(finish != nil)
        precondition(barrier.active)
        let unrelated = await barrier.wait(owner: "owner-B", nanoseconds: 1_000_000)
        precondition(unrelated && barrier.active, "a stale owner cannot close another capture")
        let timedOut = await barrier.wait(owner: "owner-A", nanoseconds: 1_000_000)
        precondition(!timedOut && barrier.active, "timeout must not pretend the audio writer closed")
        finish?.resume()
        let completed = await barrier.wait(owner: "owner-A", nanoseconds: 1_000_000_000)
        precondition(completed && !barrier.active, "retry observes the same completed shutdown")
        let alreadyClosed = await barrier.wait(owner: "owner-A", nanoseconds: 1_000_000)
        precondition(alreadyClosed)
        let start = VoiceStartLatch()
        start.begin()
        barrier.begin(owner: "owner-C") {
            while !(await start.wait(nanoseconds: 1_000_000)) { }
            return true
        }
        let starting = await barrier.wait(owner: "owner-C", nanoseconds: 1_000_000)
        precondition(!starting && barrier.active, "a cancelled start cannot be confirmed while its microphone candidate is still open")
        start.end()
        let startClosed = await barrier.wait(owner: "owner-C", nanoseconds: 1_000_000_000)
        precondition(startClosed && !barrier.active)
        // The start can also finish before the shutdown task first runs.
        start.begin()
        barrier.begin(owner: "owner-D") { while !(await start.wait(nanoseconds: 1_000_000)) { }; return true }
        start.end()
        let fastStart = await barrier.wait(owner: "owner-D", nanoseconds: 1_000_000_000)
        precondition(fastStart && !barrier.active, "finishing before wait must not strand the latch")
        var finishAnonymous: CheckedContinuation<Void, Never>?
        barrier.begin(owner: nil) { await withCheckedContinuation { finishAnonymous = $0 }; return false }
        for _ in 0..<100 { if finishAnonymous != nil { break }; await Task.yield() }
        precondition(finishAnonymous != nil)
        let anonymousPending = await barrier.wait(owner: "owner-E", nanoseconds: 1_000_000)
        precondition(!anonymousPending && barrier.active, "an anonymous writer must fence every caller until it closes")
        finishAnonymous?.resume()
        let anonymousFailure = await barrier.wait(owner: "owner-E", nanoseconds: 1_000_000_000)
        precondition(!anonymousFailure, "an anonymous failed cleanup cannot be reported as stopped to another owner")
        barrier.begin(owner: "owner-E") { true }
        let retry = await barrier.wait(owner: "owner-E", nanoseconds: 1_000_000_000)
        precondition(retry, "an explicit retry can confirm the preserved cleanup")
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("capri-cancel-barrier-\(UUID().uuidString)")
        try! FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let audio = root.appendingPathComponent("audio.caf")
        let converted = root.appendingPathComponent("audio.analysis.caf")
        try! Data([1, 2, 3]).write(to: audio)
        try! Data([3, 2, 1]).write(to: converted)
        struct UnlinkFailed: Error {}
        barrier.begin(owner: "owner-F") {
            let primary = VoiceFileCleanup.remove(audio)
            let conversion = VoiceFileCleanup.remove(converted, using: { _ in throw UnlinkFailed() })
            return primary && conversion
        }
        let unlinkFailed = await barrier.wait(owner: "owner-F", nanoseconds: 1_000_000_000)
        precondition(!unlinkFailed && FileManager.default.fileExists(atPath: converted.path), "a failed converted-audio unlink preserves its owner and bytes for retry")
        barrier.begin(owner: "owner-F") {
            let primary = VoiceFileCleanup.remove(audio), conversion = VoiceFileCleanup.remove(converted)
            return primary && conversion
        }
        let unlinked = await barrier.wait(owner: "owner-F", nanoseconds: 1_000_000_000)
        precondition(unlinked && !FileManager.default.fileExists(atPath: audio.path) && !FileManager.default.fileExists(atPath: converted.path), "retry confirms only after both files are absent")
        print("VoiceCancellationBarrier: owner-specific retries wait for actual writer and analyzer shutdown.")
    }
}
