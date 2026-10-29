import Foundation

@main
struct VoiceOwnersTests {
    @MainActor static func main() async {
        var owners = VoiceOwners()
        // Old cancellation arrives before old start, then a new operation starts.
        precondition(!owners.cancel("old"))
        precondition(owners.claim("new"))
        precondition(!owners.claim("old"))
        precondition(!owners.cancel("old"))
        precondition(owners.active == "new")
        precondition(owners.cancel("new"))
        owners.clear()
        precondition(!owners.claim("new"))
        // An unsuccessful preparation releases only its own claim, allowing retry.
        precondition(owners.claim("failed"))
        // A preparation that returns unavailable is a failed attempt, even if
        // its bridge reply itself was valid. A successful prepare keeps owner.
        owners.finishAttempt("failed", succeeded: true)
        precondition(!owners.claim("other"))
        owners.finishAttempt("other", succeeded: false)
        precondition(owners.active == "failed")
        owners.finishAttempt("failed", succeeded: false)
        precondition(owners.claim("retry"))
        owners.clear()
        // Capturing A is cancelled after publishing its audio. B claims a new
        // operational identity without reviving A; a late stop from A is fenced.
        var recovery = VoiceOwners()
        precondition(recovery.claim("capture-a")); precondition(recovery.cancel("capture-a")); recovery.clear()
        precondition(!recovery.claim("capture-a")); precondition(recovery.claim("attempt-b"))
        precondition(!recovery.cancel("capture-a")); precondition(recovery.active == "attempt-b")
        precondition(!VoiceRecoveryAttempt.mayFinish(caller: "capture-a", bound: "attempt-b", active: recovery.active))
        precondition(!VoiceRecoveryAttempt.mayFinish(caller: nil, bound: "attempt-b", active: recovery.active))
        precondition(VoiceRecoveryAttempt.mayFinish(caller: "ATTEMPT-B", bound: "attempt-b", active: recovery.active))
        precondition(VoiceRecoveryAttempt.mayFinish(caller: nil, bound: nil, active: "capture"))
        // A suspension may happen while audio identity is verified off actor.
        // The current generation must be read *after* verification completes.
        var allowed = true
        var verificationStarted = false
        var resumeVerification: CheckedContinuation<Bool, Never>?
        let check = Task { @MainActor in
            verificationStarted = true
            let verified = await withCheckedContinuation { resumeVerification = $0 }
            return VoiceRecoveryAttempt.mayPrepare(verified: verified, epoch: 0, currentEpoch: allowed ? 0 : 1,
                                                   foreground: allowed, cancelled: false)
        }
        while !verificationStarted { await Task.yield() }
        allowed = false
        resumeVerification?.resume(returning: true)
        let suspended = await check.value
        precondition(!suspended, "suspension during verification cannot authorize preparation")
        allowed = true
        let permitted = VoiceRecoveryAttempt.mayPrepare(verified: true, epoch: 0, currentEpoch: 0, foreground: true, cancelled: false)
        let missing = VoiceRecoveryAttempt.mayPrepare(verified: false, epoch: 0, currentEpoch: 0, foreground: true, cancelled: false)
        precondition(permitted && !missing)
        // A flood of abandoned cancellations remains bounded and fails closed.
        var bounded = VoiceOwners()
        for number in 0...4096 { _ = bounded.cancel("cancelled-\(number)") }
        precondition(!bounded.claim("late"))
        print("VoiceOwners: reordered cancellation, retries, and bound passed.")
    }
}
