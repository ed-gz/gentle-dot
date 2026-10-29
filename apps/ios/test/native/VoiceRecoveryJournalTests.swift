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
