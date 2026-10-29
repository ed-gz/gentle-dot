import Foundation

/// A cancelled request is fenced even if cancellation crosses the bridge first.
/// UUID normalization keeps the same identity across Swift and WebKit.
struct DocumentOwnership {
    private var owners = VoiceOwners()

    mutating func begin(_ request: String) -> Bool {
        guard let id = UUID(uuidString: request)?.uuidString else { return false }
        return owners.claim(id)
    }

    mutating func cancel(_ request: String) -> Bool {
        guard let id = UUID(uuidString: request)?.uuidString else { return false }
        return owners.cancel(id)
    }

    mutating func finish(_ request: String) {
        guard let id = UUID(uuidString: request)?.uuidString else { return }
        owners.clearIfOwned(id)
    }
}
