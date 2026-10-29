import Foundation

/// The Lock Screen receives only a fixed label. Conversation content, service
/// names, file names, arguments, credentials and precise progress stay in Capri.
struct LiveActivityRequest: Decodable {
    let turnId: String
    let origin: String
    let phase: String
    let sequence: Int
    let id: String?
    let observedAt: Double?
    init(turnId: String, origin: String, phase: String, sequence: Int, id: String?, observedAt: Double? = nil) {
        self.turnId = turnId; self.origin = origin; self.phase = phase; self.sequence = sequence; self.id = id; self.observedAt = observedAt
    }
}

enum LiveActivityPolicy {
    static let origins: Set<String> = ["iphone", "laptop"]
    static let activePhases: Set<String> = ["thinking", "working", "attention", "waiting"]
    static let endPhases: Set<String> = ["finished", "interrupted", "dismissed"]
    static func validID(_ value: String) -> Bool { UUID(uuidString: value)?.uuidString.lowercased() == value }
    static func validActivityID(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.count <= 128 && value.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil
    }
    static func valid(_ request: LiveActivityRequest, ending: Bool, requireActivityID: Bool) -> Bool {
        validID(request.turnId) && origins.contains(request.origin)
            && (ending ? endPhases : activePhases).contains(request.phase)
            && request.sequence >= 0 && request.sequence <= 1_000_000_000
            && (request.observedAt == nil || (request.observedAt!.isFinite && request.observedAt! >= 0 && request.observedAt! <= 8_640_000_000_000_000))
            && (ending || request.origin != "laptop" || request.observedAt != nil)
            && (requireActivityID ? request.id.map(validActivityID) == true : request.id == nil)
    }
    static func canUpdate(previous: Int, next: Int) -> Bool { next > previous && next <= 1_000_000_000 }
    static func observedDate(_ request: LiveActivityRequest, now: Date) -> Date? {
        guard request.origin == "laptop" else { return now }
        guard let milliseconds = request.observedAt, milliseconds.isFinite else { return nil }
        let date = Date(timeIntervalSince1970: milliseconds / 1000)
        guard date <= now.addingTimeInterval(2), now.timeIntervalSince(date) <= 90 else { return nil }
        return date
    }
}
