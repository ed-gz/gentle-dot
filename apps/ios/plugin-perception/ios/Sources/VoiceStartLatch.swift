import Foundation

/// Tracks an in-flight native microphone start across suspension points. A
/// cancellation cannot be confirmed until the start has observed its epoch
/// fence and finished closing any locally-created capture candidate.
@MainActor
final class VoiceStartLatch {
    private(set) var active = false
    private var waiters: [UUID: CheckedContinuation<Bool, Never>] = [:]

    func begin() { precondition(!active); active = true }
    func end() {
        guard active else { return }
        active = false
        let waiting = waiters.values
        waiters.removeAll()
        for waiter in waiting { waiter.resume(returning: true) }
    }
    func wait(nanoseconds: UInt64 = 8_000_000_000) async -> Bool {
        guard active else { return true }
        return await withCheckedContinuation { continuation in
            let id = UUID(); waiters[id] = continuation
            Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: nanoseconds)
                self?.waiters.removeValue(forKey: id)?.resume(returning: false)
            }
        }
    }
}
