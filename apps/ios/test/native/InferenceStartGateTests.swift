import Foundation

@main
enum InferenceStartGateTests {
    static func main() {
        var gate = InferenceStartGate()
        // Grant wins; a timeout or duplicate grant cannot start the step twice.
        gate.begin("first")
        precondition(gate.consume("first"))
        precondition(!gate.consume("first"))
        // A late grant from a cancelled request must not consume its successor.
        gate.begin("second")
        precondition(!gate.consume("first"))
        precondition(gate.identifier == "second")
        precondition(gate.consume("second"))
        // Timeout/cancel can release the waiting step exactly once.
        gate.begin("third")
        precondition(gate.consume("third"))
        precondition(!gate.consume("third"))
        precondition(gate.identifier == nil)
        var epochs = InferenceLeaseEpoch()
        let old = epochs.begin()
        precondition(epochs.isActive(old))
        epochs.end()
        let next = epochs.begin()
        precondition(!epochs.isActive(old)) // A queued expiration from the previous step is harmless.
        precondition(epochs.isActive(next))
        precondition(epochs.shouldExpireShort(next, held: true))
        precondition(!epochs.shouldExpireShort(next, held: false)) // A queued UIKit expiration cannot cancel the granted longer lease.
        epochs.end()
        precondition(!epochs.isActive(next))
        var turns = InferenceTurnGate()
        precondition(!turns.take(nil))
        precondition(turns.take("user-turn-1"))
        precondition(!turns.take("user-turn-1"))
        precondition(turns.take("user-turn-2"))
        print("InferenceStartGate: 18 checks passed")
    }
}
