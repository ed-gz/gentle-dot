import Foundation
import SQLite3

/// Local transport evidence only: never stores endpoints, headers, bodies or results.
/// Terminal means URLSession delivered its terminal callback, not that the server
/// did or did not process the request. Active records survive process death.
final class HTTPReceiptJournal {
    enum State: String { case active, terminal, cancelledBeforeStart }
    struct Entry: Equatable { let id: String; let owner: String; let state: State }
    enum Failure: Error { case invalidIdentifier, storage, alreadyReserved, changed }
    private var db: OpaquePointer?
    private let lock = NSLock()
    private let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

    init(path: String) throws {
        guard sqlite3_open_v2(path, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK else {
            if let db = db { sqlite3_close(db) }; db = nil; throw Failure.storage
        }
        sqlite3_busy_timeout(db, 5000)
        do {
            try exec("PRAGMA journal_mode=DELETE")
            try exec("PRAGMA synchronous=FULL")
            try exec("CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY NOT NULL, owner TEXT NOT NULL, state TEXT NOT NULL)")
        } catch { sqlite3_close(db); db = nil; throw error }
    }
    deinit { if let db = db { sqlite3_close(db) } }
    private func exec(_ sql: String) throws {
        guard sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK else { throw Failure.storage }
    }
    private func checked(_ value: String) throws {
        guard let parsed = UUID(uuidString: value), parsed.uuidString.lowercased() == value else { throw Failure.invalidIdentifier }
    }
    private func statement(_ sql: String, _ values: [String]) throws -> OpaquePointer {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK, let stmt = stmt else { throw Failure.storage }
        for (index, value) in values.enumerated() {
            if sqlite3_bind_text(stmt, Int32(index + 1), value, -1, transient) != SQLITE_OK { sqlite3_finalize(stmt); throw Failure.storage }
        }
        return stmt
    }
    /// Commit this reservation before creating or starting the URLSession task.
    func begin(id: String, owner: String) throws {
        try insert(id: id, owner: owner, state: .active)
    }
    /// A tombstone prevents a delayed bridge command from starting after recovery.
    func cancelBeforeStart(id: String, owner: String) throws {
        try insert(id: id, owner: owner, state: .cancelledBeforeStart)
    }
    private func insert(id: String, owner: String, state: State) throws {
        try checked(id); try checked(owner); lock.lock(); defer { lock.unlock() }
        let stmt = try statement("INSERT OR IGNORE INTO receipts (id, owner, state) VALUES (?, ?, ?)", [id, owner, state.rawValue])
        defer { sqlite3_finalize(stmt) }
        guard sqlite3_step(stmt) == SQLITE_DONE else { throw Failure.storage }
        guard sqlite3_changes(db) == 1 else { throw Failure.alreadyReserved }
    }
    /// Invoke only from URLSession's didCompleteWithError callback, never from
    /// invalidateAndCancel, a timeout, JS cancellation or loss of the WebView.
    func terminalCallback(id: String, owner: String) throws {
        try checked(id); try checked(owner); lock.lock(); defer { lock.unlock() }
        let stmt = try statement("UPDATE receipts SET state = ? WHERE id = ? AND owner = ? AND state = ?", [State.terminal.rawValue, id, owner, State.active.rawValue])
        defer { sqlite3_finalize(stmt) }
        guard sqlite3_step(stmt) == SQLITE_DONE else { throw Failure.storage }
        guard sqlite3_changes(db) == 1 else { throw Failure.changed }
    }
    func read(id: String) throws -> Entry? {
        try checked(id); lock.lock(); defer { lock.unlock() }
        let stmt = try statement("SELECT owner, state FROM receipts WHERE id = ?", [id])
        defer { sqlite3_finalize(stmt) }
        let step = sqlite3_step(stmt)
        if step == SQLITE_DONE { return nil }
        guard step == SQLITE_ROW, let owner = sqlite3_column_text(stmt, 0), let stateValue = sqlite3_column_text(stmt, 1),
              let state = State(rawValue: String(cString: stateValue)) else { throw Failure.storage }
        return Entry(id: id, owner: String(cString: owner), state: state)
    }
}
