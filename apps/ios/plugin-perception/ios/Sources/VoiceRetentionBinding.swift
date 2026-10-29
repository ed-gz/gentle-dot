import Foundation

/// Opt-in retention binds a closed recording to its original destination. The
/// normal dictation path does not create a journal or use this type.
struct VoiceRetentionBinding: Sendable {
    let id: String
    let owner: String
    let destination: String
    let root: URL

    static func defaultRoot() -> URL? {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appendingPathComponent("CapriVoiceRecovery", isDirectory: true)
    }

    static func validDestination(_ value: String?) -> Bool {
        guard let value else { return false }
        if value == "chat" { return true }
        guard value.hasPrefix("session:") else { return false }
        let hash = value.dropFirst("session:".count)
        return hash.count == 64 && hash.allSatisfy { ("0"..."9").contains($0) || ("a"..."f").contains($0) }
    }

    func matches(_ record: VoiceRecoveryRecord) -> Bool {
        record.id.lowercased() == id.lowercased() && record.owner.lowercased() == owner.lowercased()
            && record.destination == destination
    }
}
