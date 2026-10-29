import Foundation

/// A timed wait never abandons the actual shutdown. Subsequent retries observe
/// the same task, so a second analyzer cannot run before the first has ended.
@MainActor
final class PreviewDrain {
    private var pending: Task<Void, Never>?
    private var generation = 0
    private var waiters: [UUID: CheckedContinuation<Bool, Never>] = [:]
    private var completions: [() -> Void] = []
    var active: Bool { pending != nil }

    func begin(_ shutdown: @escaping () async -> Void) {
        guard pending == nil else { return }
        generation += 1
        let current = generation
        let task = Task { await shutdown() }
        pending = task
        Task { [weak self] in
            await task.value
            guard let self, self.generation == current else { return }
            self.pending = nil
            let waiting = self.waiters.values
            self.waiters.removeAll()
            for waiter in waiting { waiter.resume(returning: true) }
            let completions = self.completions
            self.completions.removeAll()
            for completion in completions { completion() }
        }
    }

    func after(_ completion: @escaping () -> Void) {
        if pending == nil { completion() }
        else { completions.append(completion) }
    }

    func wait(nanoseconds: UInt64 = 8_000_000_000) async -> Bool {
        guard pending != nil else { return true }
        return await withCheckedContinuation { continuation in
            let id = UUID()
            waiters[id] = continuation
            Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: nanoseconds)
                self?.waiters.removeValue(forKey: id)?.resume(returning: false)
            }
        }
    }
}
