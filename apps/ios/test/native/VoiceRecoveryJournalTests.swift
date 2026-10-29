import Foundation
#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

@main
struct VoiceRecoveryJournalTests {
    static func main() throws {
        if CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "try-remove" {
            let journal = VoiceRecoveryJournal(root: URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true))
            do {
                guard let record = try journal.current() else { exit(24) }
                try journal.remove(record)
                exit(0)
            } catch VoiceRecoveryJournalError.busy { exit(23) }
            catch { exit(24) }
        }
        let fm = FileManager.default
        let root = fm.temporaryDirectory.appendingPathComponent("capri-voice-journal-\(UUID().uuidString)")
        defer { try? fm.removeItem(at: root) }
        let journal = VoiceRecoveryJournal(root: root)
        let second = VoiceRecoveryJournal(root: root)
        let id = "12345678-1234-4234-8234-123456789012", owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        func reject(_ action: () throws -> Void) -> Bool { do { try action(); return false } catch { return true } }
        func check(_ value: Bool, _ message: String = "") { precondition(value, message) }
        check(try journal.current() == nil)
        for bad in ["", "../chat", "session:" + String(repeating: "z", count: 64), "session:" + String(repeating: "a", count: 63)] {
            check(reject { _ = try journal.reserve(id: id, owner: owner, destination: bad, locale: "es-MX", kind: .speech) })
            check(try journal.current() == nil)
        }
        check(reject { _ = try journal.reserve(id: "../other", owner: owner, destination: "chat", locale: "es-MX", kind: .speech) })
        let (reserved, file) = try journal.reserve(id: id, owner: owner, destination: "session:" + String(repeating: "a", count: 64), locale: "es-MX", kind: .speech)
        check(reserved.state == .capturing && reserved.owner == owner && reserved.destination.hasPrefix("session:"))
        var rustCapture = try JSONSerialization.jsonObject(with: JSONEncoder().encode(reserved)) as! [String: Any]
        rustCapture["byteCount"] = NSNull(); rustCapture["sha256"] = NSNull()
        check(try JSONDecoder().decode(VoiceRecoveryRecord.self, from: JSONSerialization.data(withJSONObject: rustCapture)) == reserved,
            "Swift accepts Rust's explicit optional null fields on a capturing record")
        check(try second.current() == reserved, "relaunch sees the bound but unconfirmed capture")
        check(reject { _ = try second.acquire(reserved) }, "incomplete audio cannot be opened as ready")
        check(reject { _ = try second.publish(reserved) }, "missing audio cannot be published")
        check(reject { _ = try second.reserve(id: UUID().uuidString, owner: owner, destination: "chat", locale: "es-ES", kind: .dictation) }, "never replace a pending capture")
        try Data().write(to: file)
        check(reject { _ = try second.publish(reserved) }, "empty audio cannot become ready")
        try Data([1, 2, 3]).write(to: file)
        let ready = try journal.publish(reserved)
        let reloadedReady = try second.current()
        check(ready.state == .ready && reloadedReady == ready)
        let readyInspection = try VoiceRetainedInspection.inspect(second)
        let readyJSON = try JSONSerialization.jsonObject(with: JSONEncoder().encode(readyInspection)) as! [String: Any]
        check(readyInspection.retainedAudio == ready && readyInspection.discardPending == nil && readyJSON["discardPending"] == nil && readyJSON["retainedAudio"] != nil,
            "normal ready audio retains the existing encoded contract")
        let binding = VoiceRetentionBinding(id: id, owner: owner, destination: reserved.destination, root: root)
        check(binding.matches(ready) && VoiceRetentionBinding.validDestination("chat"))
        check(!VoiceRetentionBinding.validDestination("session:../bad") && !VoiceRetentionBinding.validDestination(nil))
        check(!VoiceRetentionBinding(id: id, owner: UUID().uuidString, destination: reserved.destination, root: root).matches(ready))
        check(ready.byteCount == 3 && ready.sha256 == "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81")
        let lease = try second.acquire(ready)
        check(lease.url == file)
        try lease.verify()
        check(reject { try journal.remove(ready) }, "cancel cannot delete bytes while the reader holds its lease")
        let child = Process()
        child.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
        child.arguments = ["try-remove", root.path]
        try child.run(); child.waitUntilExit()
        check(child.terminationStatus == 23, "the read lease must block a different process from deleting audio")
        // A writer outside the journal can still replace the private file; the
        // post-analysis verification must detect that before any future ACK.
        try Data([3, 2, 1]).write(to: file, options: .atomic)
        check(reject { _ = try VoiceRetainedInspection.inspect(second) }, "inspection never advertises changed ready bytes")
        check(reject { try lease.verify() }, "a replaced file cannot retain the acquired identity")
        lease.close()
        check(reject { _ = try second.acquire(ready) }, "changed bytes cannot be acquired as the recorded audio")
        try Data([1, 2, 3]).write(to: file, options: .atomic)
        let restoredLease = try second.acquire(ready)
        try restoredLease.verify()
        try Data([1, 2, 3]).write(to: file, options: .atomic)
        check(reject { try restoredLease.verify() }, "replacing a file with equal bytes still changes the acquired identity")
        restoredLease.close()
        check(reject { try second.remove(reserved) }, "stale cancellation must not remove a newer publication")
        check(fm.fileExists(atPath: file.path), "stale cancellation preserves the bytes")
        try second.remove(ready)
        let removed = try journal.current()
        check(!fm.fileExists(atPath: file.path) && removed == nil, "confirmed cancellation removes both bytes and binding")
        let (unfinished, unfinishedFile) = try journal.reserve(id: UUID().uuidString, owner: owner, destination: "chat", locale: "es-ES", kind: .dictation)
        try Data([8, 9]).write(to: unfinishedFile)
        check(try second.current()?.state == .capturing, "unconfirmed recording never becomes ready on restart")
        check(reject { _ = try second.acquire(unfinished) }, "an interrupted writer cannot be reattached as a complete recording")
        check(try Data(contentsOf: unfinishedFile) == Data([8, 9]), "inspection does not discard the incomplete recording")
        try second.remove(unfinished)
        check(!fm.fileExists(atPath: unfinishedFile.path))
        let orphanID = UUID().uuidString.lowercased()
        let orphan = root.appendingPathComponent("\(orphanID).caf")
        try fm.createSymbolicLink(atPath: orphan.path, withDestinationPath: root.appendingPathComponent("missing").path)
        check(reject { _ = try journal.reserve(id: orphanID, owner: owner, destination: "chat", locale: "es-MX", kind: .speech) }, "never overwrite an orphan symlink")
        check(reject { _ = try journal.reserve(id: UUID().uuidString, owner: owner, destination: "chat", locale: "es-MX", kind: .speech) }, "an orphan with another identity blocks reservation")
        try fm.removeItem(at: orphan)
        let discardRoot = root.appendingPathComponent("discard-test")
        let discard = VoiceRecoveryJournal(root: discardRoot)
        let (discardCapture, discardFile) = try discard.reserve(id: UUID().uuidString, owner: owner, destination: "chat", locale: "es-MX", kind: .speech)
        try Data([10, 11]).write(to: discardFile)
        let discardReady = try discard.publish(discardCapture)
        var discardSyncs = 0
        let interruptedDiscard = VoiceRecoveryJournal(root: discardRoot, syncDirectory: { _ in
            discardSyncs += 1
            if discardSyncs == 3 { throw VoiceRecoveryJournalError.invalid }
        })
        check(reject { try interruptedDiscard.discardDurably(discardReady) }, "failure after manifest unlink is never confirmed")
        check(try discard.pendingDiscard() == discardReady, "an exact durable intent remains visible for recovery")
        let pendingView = try discard.inspectWithDiscard()
        check(pendingView.record == nil && pendingView.discardPending == discardReady, "atomic inspection distinguishes pending discard from an empty journal")
        let interruptedView = try VoiceRetainedInspection.inspect(discard)
        let pendingJSON = try JSONSerialization.jsonObject(with: JSONEncoder().encode(interruptedView)) as! [String: Any]
        check(interruptedView.retainedAudio == nil && interruptedView.discardPending == discardReady && pendingJSON["retainedAudio"] == nil && pendingJSON["discardPending"] != nil,
            "the plugin contract exposes pending discard without advertising transcribable audio")
        check(reject { _ = try discard.current() } && !fm.fileExists(atPath: discardFile.path), "inspection must not call an unfinished discard empty")
        check(reject { _ = try discard.acquire(discardReady) } && reject { try discard.releaseExact(discardReady) }, "other journal operations cannot bypass a pending discard")
        check(reject { _ = try discard.reserve(id: UUID().uuidString, owner: owner, destination: "chat", locale: "es-MX", kind: .speech) }, "pending discard blocks a new reservation")
        let wrongDiscard = VoiceRecoveryRecord(id: UUID().uuidString, owner: owner, destination: discardReady.destination,
            locale: discardReady.locale, kind: discardReady.kind, createdAt: discardReady.createdAt,
            state: discardReady.state, byteCount: discardReady.byteCount, sha256: discardReady.sha256)
        check(reject { try discard.discardDurably(wrongDiscard) }, "another identity cannot complete a pending discard")
        let differentCapture = VoiceRecoveryRecord(id: UUID().uuidString, owner: owner, destination: "chat", locale: "es-MX",
            kind: .speech, createdAt: discardReady.createdAt, state: .capturing, byteCount: nil, sha256: nil)
        let differentFile = discardRoot.appendingPathComponent("\(differentCapture.id.lowercased()).caf")
        try JSONEncoder().encode(differentCapture).write(to: discardRoot.appendingPathComponent("current.json"), options: .atomic)
        try Data([99]).write(to: differentFile)
        check(reject { _ = try discard.inspectWithDiscard() } && reject { try discard.discardDurably(discardReady) }, "contradictory current identity fails closed")
        check(fm.fileExists(atPath: differentFile.path), "contradictory capture is never removed")
        try fm.removeItem(at: discardRoot.appendingPathComponent("current.json"))
        try fm.removeItem(at: differentFile)
        // Model the old audio reappearing after an interrupted filesystem sync.
        try Data([10, 11]).write(to: discardFile, options: .atomic)
        try discard.discardDurably(discardReady)
        check(try discard.pendingDiscard() == nil && !fm.fileExists(atPath: discardFile.path), "exact recovery completes the discard")
        let emptyView = try discard.inspectWithDiscard()
        check(emptyView.record == nil && emptyView.discardPending == nil, "completed discard inspects as empty")
        let emptyInspection = try VoiceRetainedInspection.inspect(discard)
        check(emptyInspection.retainedAudio == nil && emptyInspection.discardPending == nil, "empty inspection remains backward compatible")
        let (newCapture, newFile) = try discard.reserve(id: UUID().uuidString, owner: owner, destination: "chat", locale: "es-MX", kind: .speech)
        try Data([12]).write(to: newFile)
        check(reject { try discard.discardDurably(discardReady) }, "a stale retry cannot remove a new capture")
        check(try discard.current() == newCapture && fm.fileExists(atPath: newFile.path), "new capture survives stale discard")
        try discard.remove(newCapture)
        let (unsafeCapture, unsafeFile) = try discard.reserve(id: UUID().uuidString, owner: owner, destination: "chat", locale: "es-MX", kind: .speech)
        try fm.createDirectory(at: unsafeFile, withIntermediateDirectories: false)
        let nested = unsafeFile.appendingPathComponent("keep")
        try Data([42]).write(to: nested)
        check(reject { try discard.discardDurably(unsafeCapture) }, "a substituted directory is not deleted recursively")
        check(try fm.fileExists(atPath: nested.path) && discard.pendingDiscard() == unsafeCapture, "unexpected bytes and discard intent remain for review")
        try fm.removeItem(at: unsafeFile)
        try discard.discardDurably(unsafeCapture)
        let (lastCapture, lastFile) = try discard.reserve(id: UUID().uuidString, owner: owner, destination: "chat", locale: "es-MX", kind: .speech)
        try Data([7, 8]).write(to: lastFile)
        let lastReady = try discard.publish(lastCapture)
        var lastSyncs = 0
        let lastSyncFailure = VoiceRecoveryJournal(root: discardRoot, syncDirectory: { _ in
            lastSyncs += 1
            if lastSyncs == 4 { throw VoiceRecoveryJournalError.invalid }
        })
        check(reject { try lastSyncFailure.discardDurably(lastReady) }, "failure after marker unlink never returns success")
        check(try discard.pendingDiscard() == nil && discard.current() == nil, "last failure may leave no visible marker or manifest")
        try Data([7, 8]).write(to: lastFile, options: .atomic)
        check(reject { try discard.discardDurably(lastReady) } && fm.fileExists(atPath: lastFile.path), "reappearing audio without marker is preserved")
        try fm.removeItem(at: lastFile)
        var retries = 0
        let retryDiscard = VoiceRecoveryJournal(root: discardRoot, syncDirectory: { _ in retries += 1 })
        try retryDiscard.discardDurably(lastReady)
        check(retries == 1, "empty retry synchronizes the directory before confirming the current state")
        let (lastNewCapture, lastNewFile) = try discard.reserve(id: UUID().uuidString, owner: owner, destination: "chat", locale: "es-MX", kind: .speech)
        try Data([13]).write(to: lastNewFile)
        check(reject { try discard.discardDurably(lastReady) }, "a lost callback retry cannot remove a later capture")
        check(try discard.current() == lastNewCapture && fm.fileExists(atPath: lastNewFile.path), "later capture survives final-sync retry")
        try discard.remove(lastNewCapture)
        try fm.removeItem(at: discardRoot)
        let alias = root.deletingLastPathComponent().appendingPathComponent("\(root.lastPathComponent)-alias")
        try fm.createSymbolicLink(at: alias, withDestinationURL: root)
        defer { try? fm.removeItem(at: alias) }
        check(reject { _ = try VoiceRecoveryJournal(root: alias).reserve(id: UUID().uuidString, owner: owner, destination: "chat", locale: "es-MX", kind: .speech) }, "a symbolic-link root is not an isolated journal")
        let guardLock = NSLock()
        var wins: [(VoiceRecoveryRecord, URL)] = []
        DispatchQueue.concurrentPerform(iterations: 8) { _ in
            if let item = try? VoiceRecoveryJournal(root: root).reserve(id: UUID().uuidString, owner: owner, destination: "chat", locale: "es-MX", kind: .speech) {
                guardLock.lock(); wins.append(item); guardLock.unlock()
            }
        }
        check(wins.count == 1, "concurrent reservations in this process cannot replace each other")
        try journal.remove(wins[0].0)
        if geteuid() != 0 {
            let (unreadable, _) = try journal.reserve(id: UUID().uuidString, owner: owner, destination: "chat", locale: "es-MX", kind: .speech)
            try fm.setAttributes([.posixPermissions: 0], ofItemAtPath: root.path)
            let denied = reject { _ = try second.current() }
            try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: root.path)
            check(denied, "a permission failure must not look like an empty journal")
            check(try journal.current() == unreadable)
            try journal.remove(unreadable)
        }
        // A damaged journal must fail closed; no bytes are silently removed.
        let (damaged, damagedFile) = try journal.reserve(id: UUID().uuidString, owner: owner, destination: "chat", locale: "es-MX", kind: .speech)
        try Data([1]).write(to: damagedFile)
        try Data("{broken".utf8).write(to: root.appendingPathComponent("current.json"), options: .atomic)
        check(reject { _ = try second.current() })
        check(reject { try second.remove(damaged) })
        check(fm.fileExists(atPath: damagedFile.path), "corruption must not discard the recording")
        print("VoiceRecoveryJournal: bound publication, explicit deletion and fail-closed recovery.")
    }
}
