import Foundation

/// Owns the photo QR reader until Vision actually ends. IDs also fence a
/// cancellation that reaches native before its corresponding start.
final class PairingScanBarrier {
    private var owners = DocumentOwnership()
    private var active: String?
    private struct Waiter {
        let owner: String
        let completion: (Bool) -> Void
    }
    private var waiters: [UUID: Waiter] = [:]

    func begin(_ request: String) -> Bool {
        dispatchPrecondition(condition: .onQueue(.main))
        guard let id = UUID(uuidString: request)?.uuidString, active == nil, owners.begin(id) else { return false }
        active = id
        return true
    }

    /// Returns whether the matching live operation must be cancelled. A false
    /// timeout never clears its owner or claims Vision has stopped.
    func cancel(_ request: String, timeout: TimeInterval = 8, completion: @escaping (Bool) -> Void) -> Bool {
        dispatchPrecondition(condition: .onQueue(.main))
        guard let id = UUID(uuidString: request)?.uuidString else { completion(false); return false }
        guard owners.cancel(id), active == id else { completion(true); return false }
        let token = UUID()
        waiters[token] = Waiter(owner: id, completion: completion)
        DispatchQueue.main.asyncAfter(deadline: .now() + max(0, timeout)) { [weak self] in
            guard let self, let waiter = self.waiters.removeValue(forKey: token) else { return }
            waiter.completion(false)
        }
        return true
    }

    func finish(_ request: String) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard let id = UUID(uuidString: request)?.uuidString, active == id else { return }
        active = nil
        owners.finish(id)
        let completed = waiters.filter { $0.value.owner == id }
        for (token, waiter) in completed {
            waiters.removeValue(forKey: token)
            waiter.completion(true)
        }
    }
}
