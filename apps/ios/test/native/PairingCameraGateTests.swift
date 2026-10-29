import Foundation

@main
struct PairingCameraGateTests {
    static func main() {
        let gate = PairingCameraGate()
        let a = "d3dba896-4b5c-4c1c-98c9-4e60238fe6b9"
        let b = "d3dba896-4b5c-4c1c-98c9-4e60238fe6ba"
        let c = "d3dba896-4b5c-4c1c-98c9-4e60238fe6bb"
        precondition(gate.begin(a))
        var acks = 0
        precondition(gate.cancel(a) { if $0 { acks += 1 } })
        precondition(!gate.cancel(a) { if $0 { acks += 1 } })
        precondition(acks == 0 && !gate.begin(b)) // UIKit dismissal is still pending.
        gate.finish(a)
        precondition(acks == 2 && gate.begin(b))
        var oldClosed = false
        precondition(!gate.cancel(a) { oldClosed = $0 })
        precondition(oldClosed && !gate.begin(c)) // Late cancellation did not stop b.
        gate.finish(b)
        var cancelledBeforeStart = false
        precondition(!gate.cancel(c) { cancelledBeforeStart = $0 })
        precondition(cancelledBeforeStart && !gate.begin(c))
        print("Pairing camera gate: delayed dismissal, duplicate cancellation and late IPC passed")
    }
}
