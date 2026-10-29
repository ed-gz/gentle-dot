import Foundation

/// A recorder file is not complete until its own delegate confirms success.
/// Cancellation or timeout closes this attempt permanently; late callbacks
/// cannot turn it into a successful recording.
@MainActor
final class VoiceRecorderCompletion {
    enum Outcome: Equatable { case completed, failed, cancelled, timedOut }
    private var outcome: Outcome?
    private var waiters: [UUID: CheckedContinuation<Outcome, Never>] = [:]

    func finished(successfully: Bool) { resolve(successfully ? .completed : .failed) }
    func encodingFailed() { resolve(.failed) }
    func cancel() { resolve(.cancelled) }

    private func resolve(_ result: Outcome) {
        guard outcome == nil else { return }
        outcome = result
        let pending = waiters.values
        waiters.removeAll()
        for waiter in pending { waiter.resume(returning: result) }
    }

    func wait(nanoseconds: UInt64 = 8_000_000_000) async -> Outcome {
        if let outcome { return outcome }
        return await withCheckedContinuation { continuation in
            let id = UUID()
            waiters[id] = continuation
            Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: nanoseconds)
                guard let self, self.waiters[id] != nil else { return }
                self.resolve(.timedOut)
            }
        }
    }
}
