import Foundation

/// Resolves once, independently of whether an underlying Apple operation
/// responds to cancellation. A late result cannot replace a timeout.
@MainActor
final class VoiceDeadline<Value> {
    private var continuation: CheckedContinuation<Value?, Never>?
    private var resolved = false
    private var value: Value?
    private var timer: Task<Void, Never>?

    init(operation: Task<Value, Never>, nanoseconds: UInt64) {
        Task { @MainActor [weak self] in
            let result = await operation.value
            self?.finish(result)
        }
        timer = Task { @MainActor [weak self] in
            do { try await Task.sleep(nanoseconds: nanoseconds) } catch { return }
            self?.finish(nil)
        }
    }

    func wait() async -> Value? {
        if resolved { return value }
        return await withCheckedContinuation { continuation = $0 }
    }

    func interrupt() { finish(nil) }

    private func finish(_ result: Value?) {
        guard !resolved else { return }
        resolved = true
        value = result
        timer?.cancel()
        timer = nil
        continuation?.resume(returning: result)
        continuation = nil
    }
}
