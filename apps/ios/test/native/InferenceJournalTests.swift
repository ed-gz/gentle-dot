import Foundation

@main
enum InferenceJournalTests {
    static func main() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let id = UUID().uuidString.lowercased(), second = UUID().uuidString.lowercased()
        let third = UUID().uuidString.lowercased()
        var checks = 0
        func check(_ condition: Bool, _ message: String) { precondition(condition, message); checks += 1 }
        func rejects(_ action: () throws -> Void) -> Bool { do { try action(); return false } catch { return true } }
        let store = InferenceJournal(root: root, limit: 2)
        check(try store.list(activeID: nil).isEmpty, "fresh journal")
        let pending = try store.begin(id, now: 1234)
        check(try store.list(activeID: id).first?.status == "pending", "live inference is not interrupted")
        check(try InferenceJournal(root: root, limit: 2).list(activeID: nil).first?.status == "interrupted", "restart never replays a pending step")
        let later = try store.begin(id, now: 5678)
        check(later.startedAt == 1234 && later.revision != pending.revision, "next tool step retains turn identity")
        check(rejects { try store.acknowledge(id, revision: pending.revision, activeID: nil) }, "stale ACK cannot delete newer step")
        let answer = try store.finish(id, status: "answer", text: "Respuesta conservada 🦖")
        check(try InferenceJournal(root: root, limit: 2).list(activeID: nil) == [answer], "answer survives independent store recreation")
        check(rejects { try store.begin(id) }, "completed turn cannot start again")
        check(rejects { try store.acknowledge(id, revision: answer.revision, activeID: id) }, "active task cannot lose its record")
        let cancelled = try store.finish(id, status: "cancelled", text: "Respuesta cancelada.")
        check(rejects { try store.acknowledge(id, revision: answer.revision, activeID: nil) }, "answer ACK cannot erase newer human cancellation")
        check(rejects { try store.finish(id, status: "answer", text: "Resultado tardío") }, "late answer cannot overwrite cancellation")
        try store.begin(second)
        let before = try Data(contentsOf: root.appendingPathComponent("inferences.json"))
        check(rejects { try store.begin(third) }, "bounded journal fails without evicting another result")
        check(try Data(contentsOf: root.appendingPathComponent("inferences.json")) == before, "quota failure is atomic")
        check(rejects { try store.finish(second, status: "answer", text: String(repeating: "🦖", count: 2401)) }, "Unicode response limit")
        try store.acknowledge(id, revision: cancelled.revision, activeID: nil)
        try store.acknowledge(id, revision: cancelled.revision, activeID: nil)
        check(try store.list(activeID: nil).map(\.id) == [second], "ACK is idempotent and only removes its own result")
        check(rejects { try store.begin("../../outside") }, "no path identities")
        let bad = Data("{broken".utf8)
        try bad.write(to: root.appendingPathComponent("inferences.json"))
        check(rejects { try store.begin(third) }, "corrupt data is not silently overwritten")
        check(try Data(contentsOf: root.appendingPathComponent("inferences.json")) == bad, "corrupt original retained")
        print("InferenceJournal: \(checks) native fixture checks passed")
    }
}
