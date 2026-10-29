import Foundation

/// Fences late start/cancel messages and keeps cancellation pending until the
/// matching scanner has actually dismissed. Only the main queue may call it.
final class PairingCameraGate {
    private var active: String?
    private var retired = Set<String>()
    private var waiters: [() -> Void] = []
    private let limit = 4096

    private func checked(_ value: String) -> String? {
        guard let id = UUID(uuidString: value), id.uuidString.lowercased() == value else { return nil }
        return value
    }
    func begin(_ value: String) -> Bool {
        dispatchPrecondition(condition: .onQueue(.main))
        guard let id = checked(value), active == nil, !retired.contains(id), retired.count < limit else { return false }
        active = id
        return true
    }
    /// A false return means no scanner should be cancelled. The completion is
    /// delayed only for the matching active scanner, including duplicate calls.
    func cancel(_ value: String, completion: @escaping (Bool) -> Void) -> Bool {
        dispatchPrecondition(condition: .onQueue(.main))
        guard let id = checked(value) else { completion(false); return false }
        if active == id {
            waiters.append { completion(true) }
            return waiters.count == 1
        }
        guard retired.contains(id) || retired.count < limit else { completion(false); return false }
        retired.insert(id)
        completion(true)
        return false
    }
    func finish(_ value: String) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard active == value else { return }
        active = nil
        retired.insert(value)
        let callbacks = waiters; waiters.removeAll()
        callbacks.forEach { $0() }
    }
}
