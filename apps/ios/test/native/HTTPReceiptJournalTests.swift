import Foundation

@main struct HTTPReceiptJournalTests {
    static func check(_ value: @autoclosure () -> Bool, _ label: String) {
        if !value() { fatalError(label) }
    }
    static func main() throws {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("capri-http-receipt-\(UUID().uuidString.lowercased())")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let path = dir.appendingPathComponent("journal.sqlite").path
        let first = try HTTPReceiptJournal(path: path), second = try HTTPReceiptJournal(path: path)
        let id = UUID().uuidString.lowercased(), owner = UUID().uuidString.lowercased(), other = UUID().uuidString.lowercased()
        try first.begin(id: id, owner: owner)
        let active = try second.read(id: id)
        check(active?.state == .active, "reservation must survive reopen")
        do { try second.begin(id: id, owner: other); fatalError("duplicate began") } catch HTTPReceiptJournal.Failure.alreadyReserved {}
        do { try second.terminalCallback(id: id, owner: other); fatalError("foreign callback") } catch HTTPReceiptJournal.Failure.changed {}
        let unchanged = try first.read(id: id)
        check(unchanged?.state == .active, "foreign callback must not settle")
        try first.terminalCallback(id: id, owner: owner)
        let terminal = try second.read(id: id)
        check(terminal?.state == .terminal, "terminal callback must persist")
        do { try second.terminalCallback(id: id, owner: owner); fatalError("duplicate callback") } catch HTTPReceiptJournal.Failure.changed {}
        let cancelled = UUID().uuidString.lowercased()
        try first.cancelBeforeStart(id: cancelled, owner: owner)
        do { try second.begin(id: cancelled, owner: owner); fatalError("late command began") } catch HTTPReceiptJournal.Failure.alreadyReserved {}
        do { try second.terminalCallback(id: cancelled, owner: owner); fatalError("cancelled callback settled") } catch HTTPReceiptJournal.Failure.changed {}
        let tombstone = try second.read(id: cancelled)
        check(tombstone?.state == .cancelledBeforeStart, "tombstone must survive")
        let concurrent = UUID().uuidString.lowercased()
        let group = DispatchGroup(), queue = DispatchQueue(label: "capri-http-test", attributes: .concurrent), lock = NSLock()
        var wins = 0
        for journal in [first, second] {
            group.enter(); queue.async {
                defer { group.leave() }
                if (try? journal.begin(id: concurrent, owner: UUID().uuidString.lowercased())) != nil { lock.lock(); wins += 1; lock.unlock() }
            }
        }
        group.wait(); check(wins == 1, "concurrent reservations must have one owner")
        let raw = try Data(contentsOf: URL(fileURLWithPath: path))
        check(raw.range(of: Data("Bearer".utf8)) == nil, "journal must not contain credentials")
        do { try first.begin(id: "not-a-uuid", owner: owner); fatalError("invalid id") } catch HTTPReceiptJournal.Failure.invalidIdentifier {}
        do { try first.begin(id: cancelled.uppercased(), owner: owner); fatalError("noncanonical id") } catch HTTPReceiptJournal.Failure.invalidIdentifier {}
        do { try first.cancelBeforeStart(id: id.uppercased(), owner: owner); fatalError("noncanonical tombstone") } catch HTTPReceiptJournal.Failure.invalidIdentifier {}
        print("HTTP receipt journal fixtures passed")
    }
}
