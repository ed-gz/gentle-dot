import Foundation

/// An interrupted discard is not a recording available for transcription.
/// Read both states under one journal lock; verify any ready recording before
/// returning it to the caller.
struct VoiceRetainedInspection: Encodable {
    let retainedAudio: VoiceRecoveryRecord?
    let discardPending: VoiceRecoveryRecord?

    static func inspect(_ journal: VoiceRecoveryJournal) throws -> VoiceRetainedInspection {
        let snapshot = try journal.inspectWithDiscard()
        if let record = snapshot.record, record.state == .ready {
            let lease = try journal.acquire(record)
            defer { lease.close() }
            try lease.verify()
        }
        return VoiceRetainedInspection(retainedAudio: snapshot.record, discardPending: snapshot.discardPending)
    }
}
