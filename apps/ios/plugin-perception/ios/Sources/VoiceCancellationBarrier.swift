import Foundation

/// A native cancel is confirmed only after every captured writer and analyzer
/// has actually closed. Timed waits do not abandon the shutdown operation.
@MainActor
final class VoiceCancellationBarrier {
    private let drain = PreviewDrain()
    private var owner: String?
    private var outcome: Bool?
    var active: Bool { drain.active }

    func begin(owner: String?, shutdown: @escaping () async -> Bool) {
        guard !drain.active else { return }
        self.owner = owner; outcome = nil
        drain.begin { [weak self] in
            let success = await shutdown()
            self?.outcome = success
        }
    }

    /// A delayed cancel from another owner cannot interrupt this shutdown.
    func wait(owner expected: String?, nanoseconds: UInt64 = 7_000_000_000) async -> Bool {
        if let expected, let owner, expected != owner { return true }
        if drain.active {
            if !(await drain.wait(nanoseconds: nanoseconds)) { return false }
        }
        return outcome ?? true
    }
}
