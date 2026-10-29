import Foundation

/// Prevents a delayed cancellation from affecting another dictation. A
/// cancellation may arrive before its corresponding start crosses the bridge.
struct VoiceOwners {
    private(set) var active: String?
    private var cancelled: Set<String> = []
    private let limit = 4096
    private var saturated = false

    mutating func claim(_ id: String) -> Bool {
        guard !saturated, !cancelled.contains(id), active == nil || active == id else { return false }
        active = id
        return true
    }

    mutating func cancel(_ id: String) -> Bool {
        if !cancelled.contains(id) {
            if cancelled.count >= limit { saturated = true }
            else { cancelled.insert(id) }
        }
        return active == id
    }

    mutating func clear() { active = nil }
    mutating func clearIfOwned(_ id: String) { if active == id { active = nil } }
    mutating func finishAttempt(_ id: String, succeeded: Bool) { if !succeeded { clearIfOwned(id) } }
}

/// The caller must name the exact live attempt when resuming a retained file.
/// A callback from an older attempt cannot start analysis for its successor.
enum VoiceRecoveryAttempt {
    /// All state is sampled synchronously after the async verification.
    static func mayPrepare(verified: Bool, epoch: Int, currentEpoch: Int, foreground: Bool, cancelled: Bool) -> Bool {
        verified && epoch == currentEpoch && foreground && !cancelled
    }

    static func mayFinish(caller: String?, bound: String?, active: String?) -> Bool {
        guard let bound else { return caller == nil }
        guard let caller, let active else { return false }
        return caller.lowercased() == bound.lowercased() && active.lowercased() == bound.lowercased()
    }
}
