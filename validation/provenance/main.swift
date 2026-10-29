import Foundation

func require(_ condition: @autoclosure () -> Bool, _ message: String) {
    guard condition() else { fputs("FAIL: \(message)\n", stderr); exit(1) }
}
func uniqueRoot() -> URL { URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("capri-gate-\(UUID().uuidString)", isDirectory: true) }
func id() -> String { UUID().uuidString.lowercased() }
func expectsError(_ message: String, _ body: () throws -> Void) {
    do { try body(); require(false, message) } catch { }
}

do {
    let root = uniqueRoot(); defer { try? FileManager.default.removeItem(at: root) }
    var clock = 10.0, schedules = 0
    var reentryRejected = false
    let firstBoot = id(), secondBoot = id()
    var gate: ProvenanceLeaseGate? = try ProvenanceLeaseGate(root: root, bootId: firstBoot, now: { clock })
    do { _ = try ProvenanceLeaseGate(root: root, bootId: secondBoot); require(false, "second owner must not enter") }
    catch ProvenanceLeaseError.busy { }
    catch { require(false, "second owner must fail specifically with busy") }
    let a = id(), first = try gate!.prepare(id: a, revision: 3, model: "apple-local", input: "hello")
    require(first.inputSHA256 == "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824", "hash of exact input")
    expectsError("identity binding", { _ = try gate!.start(id: a, leaseId: first.leaseId, revision: 3, model: "apple-local", input: "different", schedule: { schedules += 1 }) })
    expectsError("oversized start input rejected", { _ = try gate!.start(id: a, leaseId: first.leaseId, revision: 3, model: "apple-local", input: String(repeating: "x", count: 8_001), schedule: { schedules += 1 }) })
    if case .acceptedNew = try gate!.start(id: a, leaseId: first.leaseId, revision: 3, model: "apple-local", input: "hello", schedule: { do { _ = try gate!.status(id: a) } catch ProvenanceLeaseError.busy { reentryRejected = true } catch { require(false, "unexpected reentry error") }; schedules += 1 }) {} else { require(false, "new acceptance") }
    if case .acceptedEarlier = try gate!.start(id: a, leaseId: first.leaseId, revision: 3, model: "apple-local", input: "hello", schedule: { schedules += 1 }) {} else { require(false, "duplicate cannot start again") }
    require(schedules == 1, "duplicate schedule")
    require(reentryRejected, "reentrant status is rejected")
    let b = id(), second = try gate!.prepare(id: b, revision: 4, model: "apple-local", input: "segundo")
    _ = try gate!.cancelPrepared(id: b, leaseId: second.leaseId)
    if case .rejected = try gate!.start(id: b, leaseId: second.leaseId, revision: 4, model: "apple-local", input: "segundo", schedule: { schedules += 1 }) {} else { require(false, "cancel rejects late start") }
    let c = id(), third = try gate!.prepare(id: c, revision: 5, model: "apple-local", input: "tercero")
    clock = 16
    if case .expired = try gate!.start(id: c, leaseId: third.leaseId, revision: 5, model: "apple-local", input: "tercero", schedule: { schedules += 1 }) {} else { require(false, "expiry") }
    let orphanId = id(), orphan = try gate!.prepare(id: orphanId, revision: 6, model: "apple-local", input: "sin respuesta")
    clock = 22
    let afterOrphanId = id(), afterOrphan = try gate!.prepare(id: afterOrphanId, revision: 6, model: "apple-local", input: "continuar")
    if case .expired = try gate!.start(id: orphanId, leaseId: orphan.leaseId, revision: 6, model: "apple-local", input: "sin respuesta", schedule: { schedules += 1 }) {} else { require(false, "orphaned prepared lease expires") }
    _ = try gate!.cancelPrepared(id: afterOrphanId, leaseId: afterOrphan.leaseId)
    let d = id(), fourth = try gate!.prepare(id: d, revision: 6, model: "apple-local", input: "cuarto")
    gate = nil
    let restarted = try ProvenanceLeaseGate(root: root, bootId: secondBoot, now: { 1 })
    let expiredStatus = try restarted.status(id: d)
    require(expiredStatus.state == "expired", "restart expires prepared lease")
    if case .expired = try restarted.start(id: d, leaseId: fourth.leaseId, revision: 6, model: "apple-local", input: "cuarto", schedule: { schedules += 1 }) {} else { require(false, "old lease cannot restart") }
    let acceptedStatus = try restarted.status(id: a)
    require(acceptedStatus.state == "accepted", "restart preserves acceptance as uncertain outcome")
    expectsError("used identity cannot be prepared again", { _ = try restarted.prepare(id: a, revision: 3, model: "apple-local", input: "hello") })
    let uncertainRoot = uniqueRoot(); defer { try? FileManager.default.removeItem(at: uncertainRoot) }
    var uncertain: ProvenanceLeaseGate? = try ProvenanceLeaseGate(root: uncertainRoot, bootId: firstBoot, now: { 2 })
    let e = id(), fifth = try uncertain!.prepare(id: e, revision: 7, model: "apple-local", input: "incierto")
    expectsError("schedule failure stays uncertain", { _ = try uncertain!.start(id: e, leaseId: fifth.leaseId, revision: 7, model: "apple-local", input: "incierto", schedule: { throw NSError(domain:"fixture",code:1) }) })
    let dispatchStatus = try uncertain!.status(id: e); require(dispatchStatus.state == "dispatching", "dispatch uncertainty persisted")
    expectsError("uncertain request cannot repeat", { _ = try uncertain!.start(id: e, leaseId: fifth.leaseId, revision: 7, model: "apple-local", input: "incierto", schedule: { schedules += 1 }) })
    uncertain = nil
    let recovered = try ProvenanceLeaseGate(root: uncertainRoot, bootId: secondBoot, now: { 1 }), closedStatus = try recovered.status(id: e)
    require(closedStatus.state == "closed_uncertain", "restart closes future dispatch without claiming outcome")
    let sentinelRoot = uniqueRoot(); defer { try? FileManager.default.removeItem(at: sentinelRoot) }
    let sentinelGate = try ProvenanceLeaseGate(root: sentinelRoot, bootId: id(), now: { 1 })
    let sentinelId = id(), sentinelRecord = try sentinelGate.prepare(id: sentinelId, revision: 0, model: "apple-local", input: "dato")
    let ledgerURL = sentinelRoot.appendingPathComponent("leases.json"), sentinelURL = sentinelRoot.appendingPathComponent("ledger-present")
    let ledgerBefore = try Data(contentsOf: ledgerURL)
    try FileManager.default.removeItem(at: sentinelURL)
    expectsError("missing sentinel blocks reading existing ledger", { _ = try sentinelGate.status(id: sentinelRecord.id) })
    let ledgerAfterMissing = try Data(contentsOf: ledgerURL); require(ledgerAfterMissing == ledgerBefore, "missing sentinel preserves ledger")
    try Data("alterado".utf8).write(to: sentinelURL)
    expectsError("corrupt sentinel blocks reading existing ledger", { _ = try sentinelGate.status(id: sentinelRecord.id) })
    let ledgerAfterCorrupt = try Data(contentsOf: ledgerURL); require(ledgerAfterCorrupt == ledgerBefore, "corrupt sentinel preserves ledger")
    let corruptRoot = uniqueRoot(); defer { try? FileManager.default.removeItem(at: corruptRoot) }
    try FileManager.default.createDirectory(at: corruptRoot, withIntermediateDirectories: true)
    let corruptFile = corruptRoot.appendingPathComponent("leases.json"), damaged = Data("{broken".utf8); try damaged.write(to: corruptFile)
    try Data("capri-provenance-ledger/v1".utf8).write(to: corruptRoot.appendingPathComponent("ledger-present"))
    let corrupt = try ProvenanceLeaseGate(root: corruptRoot, bootId: id())
    expectsError("corrupt state must fail closed", { _ = try corrupt.prepare(id: id(), revision: 0, model: "apple-local", input: "dato") })
    let preserved = try Data(contentsOf: corruptFile)
    require(preserved == damaged, "corrupt original retained")
    let unicodeRoot = uniqueRoot(); defer { try? FileManager.default.removeItem(at: unicodeRoot) }
    let unicodeGate = try ProvenanceLeaseGate(root: unicodeRoot, bootId: id(), now: { 1 })
    let composed = try unicodeGate.prepare(id: id(), revision: 0, model: "apple-local", input: "á")
    require(composed.inputSHA256 == "fb9778719d93551b1c88df5f1ab229f83ea30af112fc51017c9f0a383dcf6cb3", "composed unicode hash")
    _ = try unicodeGate.cancelPrepared(id: composed.id, leaseId: composed.leaseId)
    let decomposed = try unicodeGate.prepare(id: id(), revision: 0, model: "apple-local", input: "a\u{0301}")
    require(decomposed.inputSHA256 == "837f6fc956d17cf2ad108f1c00103a77fea972df3c1ef73820cbca063ce624b3", "decomposed unicode hash")
    _ = try unicodeGate.cancelPrepared(id: decomposed.id, leaseId: decomposed.leaseId)
    let emoji = try unicodeGate.prepare(id: id(), revision: 0, model: "apple-local", input: "🤖")
    require(emoji.inputSHA256 == "b0d125182029e6c500cbcc81011341df77de8fe24d9e80190c32be390c916ec2", "emoji unicode hash")
    let missingParent = uniqueRoot().appendingPathComponent("absent").appendingPathComponent("gate")
    expectsError("missing parent fails closed", { _ = try ProvenanceLeaseGate(root: missingParent, bootId: id()) })
    print("PASS: native lease gate model scenarios")
} catch { fputs("FAIL: unexpected native gate error: \(error)\n", stderr); exit(1) }
