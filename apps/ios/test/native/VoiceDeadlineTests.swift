import Foundation

@main
struct VoiceDeadlineTests {
    @MainActor static func main() async {
        let slow = Task { () -> String in
            try? await Task.sleep(nanoseconds: 120_000_000)
            return "late"
        }
        let deadline = VoiceDeadline(operation: slow, nanoseconds: 5_000_000)
        let timedOut = await deadline.wait()
        precondition(timedOut == nil, "timeout must release the caller")
        _ = await slow.value
        let late = await deadline.wait()
        precondition(late == nil, "a late completion must not overwrite timeout")

        let hung = Task { () -> String in
            try? await Task.sleep(nanoseconds: 60_000_000)
            return "ignored"
        }
        let interrupted = VoiceDeadline(operation: hung, nanoseconds: 1_000_000_000)
        interrupted.interrupt()
        let interruptedResult = await interrupted.wait()
        precondition(interruptedResult == nil, "background must release the caller")
        _ = await hung.value
        let lateInterrupted = await interrupted.wait()
        precondition(lateInterrupted == nil, "interruption must reject a late value")

        let fast = Task { "verified" }
        let completed = VoiceDeadline(operation: fast, nanoseconds: 1_000_000_000)
        let completedResult = await completed.wait()
        precondition(completedResult == "verified")
        print("VoiceDeadline: timeout, interruption and late completion are isolated.")
    }
}
