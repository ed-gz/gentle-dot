import Foundation

/// Only one of scheduler grant, timeout or cancellation may start an inference.
/// Late callbacks from an older request can never consume a newer request.
struct InferenceStartGate {
    private(set) var identifier: String?

    mutating func begin(_ identifier: String) {
        precondition(self.identifier == nil && !identifier.isEmpty)
        self.identifier = identifier
    }

    mutating func consume(_ identifier: String) -> Bool {
        guard self.identifier == identifier else { return false }
        self.identifier = nil
        return true
    }
}

/// Expiration handlers may already be queued after a previous lease ended.
struct InferenceLeaseEpoch {
    private var current: UUID?
    var currentIdentifier: UUID? { current }
    mutating func begin() -> UUID { let id = UUID(); current = id; return id }
    mutating func end() { current = nil }
    func isActive(_ id: UUID) -> Bool { current == id }
    func shouldExpireShort(_ id: UUID, held: Bool) -> Bool { held && isActive(id) }
}

/// One system task per user instruction, even if it contains many model steps.
struct InferenceTurnGate {
    private var last: String?
    mutating func take(_ turnID: String?) -> Bool {
        guard let turnID = turnID, turnID != last else { return false }
        last = turnID
        return true
    }
}
