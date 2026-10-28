import Foundation

/// A native, bounded inference loop over durable checkpoints. The caller owns
/// the iOS execution lease and supplies one model step; this type neither
/// schedules background work nor executes a tool. It stops at every ordinary
/// tool proposal so the foreground review and existing execution journal can
/// make the decision. Not yet registered as an application command.
struct AgentCheckpointRunner {
    typealias Infer = (String) async throws -> CheckpointDecision
    let journal: AgentCheckpointJournal

    func run(id: String, revision: String, infer: @escaping Infer) async throws -> AgentCheckpoint {
        var nextRevision = revision
        while true {
            try Task.checkCancellation()
            let step = try journal.beginStep(id: id, revision: nextRevision)
            guard let stepID = step.stepID else { throw AgentCheckpointError.corrupt }
            do {
                let prompt = try journal.promptForStep(id: id, revision: step.revision, stepID: stepID)
                let decision = try await infer(prompt)
                try Task.checkCancellation()
                let current = try journal.finishStep(id: id, revision: step.revision, stepID: stepID, decision: decision)
                if current.state != "ready" { return current }
                nextRevision = current.revision
            } catch {
                // An explicit cancel or a newer revision always wins. A failed
                // attempt is never silently started again after expiration.
                _ = try? journal.interrupt(id: id, revision: step.revision, stepID: stepID)
                throw error
            }
        }
    }
}
