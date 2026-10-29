import Foundation

@main
struct VoiceRecorderCompletionTests {
    @MainActor
    static func main() async {
        let success = VoiceRecorderCompletion()
        let successWait = Task { await success.wait() }
        await Task.yield()
        success.finished(successfully: true)
        let outcome1 = await successWait.value
        precondition(outcome1 == .completed)
        let outcome2 = await success.wait()
        precondition(outcome2 == .completed)

        let failure = VoiceRecorderCompletion()
        failure.finished(successfully: false)
        let outcome3 = await failure.wait()
        precondition(outcome3 == .failed)

        let encoding = VoiceRecorderCompletion()
        let encodingWait = Task { await encoding.wait() }
        await Task.yield()
        encoding.encodingFailed()
        encoding.finished(successfully: true)
        let outcome4 = await encodingWait.value
        precondition(outcome4 == .failed)
        let outcome5 = await encoding.wait()
        precondition(outcome5 == .failed)

        let cancelled = VoiceRecorderCompletion()
        let cancelWait = Task { await cancelled.wait() }
        await Task.yield()
        cancelled.cancel()
        cancelled.finished(successfully: true)
        let outcome6 = await cancelWait.value
        precondition(outcome6 == .cancelled)
        let outcome7 = await cancelled.wait()
        precondition(outcome7 == .cancelled)

        let timeout = VoiceRecorderCompletion()
        let outcome8 = await timeout.wait(nanoseconds: 1_000_000)
        precondition(outcome8 == .timedOut)
        timeout.finished(successfully: true)
        let outcome9 = await timeout.wait()
        precondition(outcome9 == .timedOut)

        // A late callback for a cancelled old recorder must not affect the
        // independent completion object used by the next recording.
        let next = VoiceRecorderCompletion()
        cancelled.encodingFailed()
        next.finished(successfully: true)
        let outcome10 = await next.wait()
        precondition(outcome10 == .completed)
        let outcome11 = await cancelled.wait()
        precondition(outcome11 == .cancelled)
        print("VoiceRecorderCompletion: success, failure, encoding, cancellation and late callbacks passed.")
    }
}
