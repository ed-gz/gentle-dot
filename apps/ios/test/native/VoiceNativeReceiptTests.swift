import Foundation

@main
struct VoiceNativeReceiptTests {
    static func main() throws {
        let fm = FileManager.default
        let root = fm.temporaryDirectory.appendingPathComponent("capri-receipt-tests-\(UUID().uuidString)")
        defer { try? fm.removeItem(at: root) }
        let audioRoot = root.appendingPathComponent("audio"), receiptRoot = root.appendingPathComponent("receipts")
        let audio = VoiceRecoveryJournal(root: audioRoot), store = VoiceNativeReceiptStore(root: receiptRoot)
        let id = "ABCDEF01-1234-4123-8123-123456789ABC", owner = "ABCDEF02-1234-4123-8123-123456789ABC"
        func reject(_ block: () throws -> Void) -> Bool { do { try block(); return false } catch { return true } }
        func check(_ condition: Bool, _ message: String) { precondition(condition, message) }
        let (capture, path) = try audio.reserve(id: id, owner: owner, destination: "chat", locale: "es-MX", kind: .speech)
        try Data([1, 2, 3]).write(to: path)
        let ready = try audio.publish(capture)
        let segment = VoiceSegment(text: "Hola Capri", startSeconds: 0, endSeconds: 1)
        let transcript = VoiceNativeTranscript(sessionId: id, text: segment.text, segments: [segment], durationSeconds: 1, locale: "es-MX", source: "apple-speech-analyzer")
        let receipt = VoiceNativeReceipt(schema: "capri-native-voice-receipt/v1", audio: ready, transcript: transcript)
        let lease = try audio.acquire(ready); try lease.verify()
        try store.put(receipt); try store.put(receipt)
        let fresh = VoiceNativeReceiptStore(root: receiptRoot)
        check(try fresh.get(id)?.receipt == receipt, "restart sees the complete exact transcript")
        check(try fresh.list().count == 1, "idempotent write does not duplicate")
        check(reject { try store.release(receipt, audioJournal: audio) }, "a live reader blocks release")
        check(try fresh.get(id)?.releaseState == "releasing", "interrupted release preserves complete receipt")
        check(reject { try fresh.discard(receipt) }, "receipt is pinned while release is unresolved")
        check(fm.fileExists(atPath: path.path), "failed release preserves source")
        lease.close()
        try Data([3, 2, 1]).write(to: path, options: .atomic)
        check(reject { try fresh.release(receipt, audioJournal: audio) }, "changed bytes cannot be released using the original identity")
        check(fm.fileExists(atPath: path.path) && (try fresh.get(id)?.receipt == receipt), "a changed file and the receipt are preserved")
        try Data([1, 2, 3]).write(to: path, options: .atomic)
        try fresh.release(receipt, audioJournal: audio)
        try fresh.release(receipt, audioJournal: audio)
        check(try fresh.get(id)?.releaseState == "released", "lost callback retries same release")
        check(!fm.fileExists(atPath: path.path), "only matching audio removed")
        check(try fresh.get(id)?.receipt.transcript.text == "Hola Capri", "release keeps all words")
        let (other, otherPath) = try audio.reserve(id: UUID().uuidString, owner: UUID().uuidString, destination: "chat", locale: "es-MX", kind: .speech)
        try Data([4, 5]).write(to: otherPath)
        try fresh.release(receipt, audioJournal: audio)
        check(try audio.current() == other && fm.fileExists(atPath: otherPath.path), "old release cannot remove new capture")
        var changed = transcript
        changed = VoiceNativeTranscript(sessionId: id, text: "distinto", segments: [VoiceSegment(text: "distinto", startSeconds: 0, endSeconds: 1)], durationSeconds: 1, locale: "es-MX", source: transcript.source)
        let mismatch = VoiceNativeReceipt(schema: receipt.schema, audio: ready, transcript: changed)
        check(reject { try store.put(mismatch) }, "same ID cannot replace transcript")
        check(reject { try store.discard(mismatch) }, "changed transcript cannot discard")
        try fresh.discard(receipt); try fresh.discard(receipt)
        check(try fresh.get(id) == nil && fresh.list().isEmpty, "explicit discard removes words and leaves a tombstone")
        check(reject { try store.put(receipt) }, "late callback cannot resurrect a discarded transcript")
        check(reject { try store.release(receipt, audioJournal: audio) }, "discarded receipt cannot authorize audio release")
        try audio.remove(other)
        let limited = VoiceNativeReceiptStore(root: root.appendingPathComponent("limited"), maxRecords: 1)
        try limited.put(receipt)
        let otherID = UUID().uuidString
        let otherAudio = VoiceRecoveryRecord(id: otherID, owner: owner, destination: "chat", locale: ready.locale,
            kind: ready.kind, createdAt: ready.createdAt, state: .ready, byteCount: ready.byteCount, sha256: ready.sha256)
        let otherText = VoiceNativeTranscript(sessionId: otherID, text: transcript.text, segments: transcript.segments,
            durationSeconds: transcript.durationSeconds, locale: transcript.locale, source: transcript.source)
        let otherReceipt = VoiceNativeReceipt(schema: receipt.schema, audio: otherAudio, transcript: otherText)
        check(reject { try limited.put(otherReceipt) }, "a full store never evicts another transcript")
        check(try limited.get(id)?.receipt == receipt, "quota failure preserves the original")
        try limited.discard(receipt)
        check(reject { try limited.put(otherReceipt) }, "tombstones count toward quota")
        let tombstone = receiptRoot.appendingPathComponent("\(id.lowercased()).json")
        try Data("broken".utf8).write(to: tombstone, options: .atomic)
        check(reject { _ = try fresh.list() } && reject { try fresh.put(receipt) }, "corrupt storage fails closed")
        print("VoiceNativeReceipt: durable binding, exact release, retry and explicit discard.")
    }
}
