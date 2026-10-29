import Foundation
import CryptoKit

private struct ReceiptFixtureFile: Codable {
    let schema: String
    let state: String
    let digest: String
    let receipt: VoiceNativeReceipt
}

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
        check(reject { try store.discard(receipt, audioJournal: audio) }, "an absent receipt cannot be confirmed discarded while its audio is still live")
        try store.put(receipt, lease: lease); try store.put(receipt, lease: lease)
        check(reject { try store.discard(receipt, audioJournal: audio) }, "retained receipt cannot be discarded before its audio is released")
        let fresh = VoiceNativeReceiptStore(root: receiptRoot)
        check(try fresh.get(id)?.receipt == receipt, "restart sees the complete exact transcript")
        check(try fresh.list().count == 1, "idempotent write does not duplicate")
        check(reject { try store.release(receipt, audioJournal: audio) }, "a live reader blocks release")
        check(try fresh.get(id)?.releaseState == "releasing", "interrupted release preserves complete receipt")
        check(reject { try fresh.discard(receipt, audioJournal: audio) }, "receipt is pinned while release is unresolved")
        check(fm.fileExists(atPath: path.path), "failed release preserves source")
        lease.close()
        try Data([3, 2, 1]).write(to: path, options: .atomic)
        check(reject { try fresh.release(receipt, audioJournal: audio) }, "changed bytes cannot be released using the original identity")
        let preserved = try fresh.get(id)
        check(fm.fileExists(atPath: path.path) && preserved?.receipt == receipt, "a changed file and the receipt are preserved")
        try Data([1, 2, 3]).write(to: path, options: .atomic)
        let syncFailure = VoiceRecoveryJournal(root: audioRoot, syncDirectory: { _ in throw VoiceRecoveryJournalError.invalid })
        check(reject { try fresh.release(receipt, audioJournal: syncFailure) }, "a failed audio-directory sync cannot confirm release")
        check(try fresh.get(id)?.releaseState == "releasing", "failed sync leaves the full receipt in recovery")
        check(try audio.current() == ready, "the exact binding remains until the audio unlink is synchronized")
        // Simulate audio reappearing after a crash before the unsynced unlink.
        try Data([1, 2, 3]).write(to: path, options: .atomic)
        var syncCalls = 0
        let manifestSyncFailure = VoiceRecoveryJournal(root: audioRoot, syncDirectory: { _ in
            syncCalls += 1
            if syncCalls == 2 { throw VoiceRecoveryJournalError.invalid }
        })
        check(reject { try fresh.release(receipt, audioJournal: manifestSyncFailure) }, "a failed manifest-directory sync cannot confirm release")
        check(try fresh.get(id)?.releaseState == "releasing", "failed final sync keeps the transcript recoverable")
        check(try audio.current() == nil && !fm.fileExists(atPath: path.path), "lost callback can leave both unlinks applied")
        try fresh.release(receipt, audioJournal: audio)
        try fresh.release(receipt, audioJournal: audio)
        check(try fresh.get(id)?.releaseState == "released", "lost callback retries same release")
        check(!fm.fileExists(atPath: path.path), "only matching audio removed")
        check(try fresh.get(id)?.receipt.transcript.text == "Hola Capri", "release keeps all words")
        let absentRoot = root.appendingPathComponent("initially-absent")
        try VoiceRecoveryJournal(root: absentRoot).releaseExact(ready)
        check(fm.fileExists(atPath: absentRoot.path), "retry on an absent root establishes and syncs the empty journal")
        let (other, otherPath) = try audio.reserve(id: UUID().uuidString, owner: UUID().uuidString, destination: "chat", locale: "es-MX", kind: .speech)
        try Data([4, 5]).write(to: otherPath)
        try fresh.release(receipt, audioJournal: audio)
        check(try audio.current() == other && fm.fileExists(atPath: otherPath.path), "old release cannot remove new capture")
        // If old bytes reappear alongside a new capture, do not guess which
        // operation owns them or touch either capture on a release retry.
        try Data([1, 2, 3]).write(to: path, options: .atomic)
        check(reject { try fresh.release(receipt, audioJournal: audio) }, "reappearing old audio requires review")
        check(reject { try fresh.discard(receipt, audioJournal: audio) }, "reappearing audio prevents receipt deletion")
        check(try audio.current() == other && fm.fileExists(atPath: otherPath.path) && fm.fileExists(atPath: path.path), "retry preserves both old bytes and the newer capture")
        try fm.removeItem(at: path)
        var changed = transcript
        changed = VoiceNativeTranscript(sessionId: id, text: "distinto", segments: [VoiceSegment(text: "distinto", startSeconds: 0, endSeconds: 1)], durationSeconds: 1, locale: "es-MX", source: transcript.source)
        let mismatch = VoiceNativeReceipt(schema: receipt.schema, audio: ready, transcript: changed)
        check(reject { try store.put(mismatch, lease: lease) }, "closed lease cannot replace transcript")
        check(reject { try store.discard(mismatch, audioJournal: audio) }, "changed transcript cannot discard")
        try fresh.discard(receipt, audioJournal: audio); try fresh.discard(receipt, audioJournal: audio)
        check(try fresh.get(id) == nil && fresh.list().isEmpty, "explicit discard removes words and leaves a tombstone")
        check(reject { try store.put(receipt, lease: lease) }, "late callback cannot resurrect a discarded transcript")
        check(reject { try store.release(receipt, audioJournal: audio) }, "discarded receipt cannot authorize audio release")
        try audio.remove(other)
        let limited = VoiceNativeReceiptStore(root: root.appendingPathComponent("limited"), maxRecords: 1)
        let limitedAudio = VoiceRecoveryJournal(root: root.appendingPathComponent("limited-audio"))
        let limitedRoot = root.appendingPathComponent("limited")
        try fm.createDirectory(at: limitedRoot, withIntermediateDirectories: true)
        for _ in 0..<100 {
            let oldID = UUID().uuidString.lowercased()
            let tombstone: [String: String] = ["schema": "capri-native-voice-file/v1", "state": "discarded", "digest": String(repeating: "a", count: 64)]
            try JSONSerialization.data(withJSONObject: tombstone).write(to: limitedRoot.appendingPathComponent("\(oldID).json"))
        }
        check(try limited.list().isEmpty, "legacy tombstones do not consume active receipt capacity")
        var firstReceipt: VoiceNativeReceipt?
        var firstLease: VoiceRecoveryReadLease?
        for index in 0..<105 {
            let nextID = UUID().uuidString
            let (capture, nextFile) = try limitedAudio.reserve(id: nextID, owner: owner, destination: "chat", locale: "es-MX", kind: .speech)
            try Data([UInt8(index)]).write(to: nextFile)
            let nextAudio = try limitedAudio.publish(capture)
            let nextTranscript = VoiceNativeTranscript(sessionId: nextID, text: transcript.text, segments: transcript.segments,
                durationSeconds: transcript.durationSeconds, locale: transcript.locale, source: transcript.source)
            let nextReceipt = VoiceNativeReceipt(schema: receipt.schema, audio: nextAudio, transcript: nextTranscript)
            let nextLease = try limitedAudio.acquire(nextAudio)
            try limited.put(nextReceipt, lease: nextLease)
            check(reject { try limited.discard(nextReceipt, audioJournal: limitedAudio) }, "a retained receipt is never discarded")
            if let firstReceipt, let firstLease {
                check(reject { try limited.put(firstReceipt, lease: firstLease) }, "stale callbacks cannot restore a deleted receipt")
                check(try limited.get(nextID)?.receipt == nextReceipt, "stale callback preserves the current receipt")
            } else { firstReceipt = nextReceipt; firstLease = nextLease }
            nextLease.close()
            try limited.release(nextReceipt, audioJournal: limitedAudio)
            try limited.discard(nextReceipt, audioJournal: limitedAudio); try limited.discard(nextReceipt, audioJournal: limitedAudio)
            check(try limited.list().isEmpty, "released receipt can be removed without a permanent quota tombstone")
        }
        let (heldCapture, heldFile) = try limitedAudio.reserve(id: UUID().uuidString, owner: owner, destination: "chat", locale: "es-MX", kind: .speech)
        try Data([1]).write(to: heldFile)
        let heldAudio = try limitedAudio.publish(heldCapture)
        let heldText = VoiceNativeTranscript(sessionId: heldAudio.id, text: transcript.text, segments: transcript.segments,
            durationSeconds: transcript.durationSeconds, locale: transcript.locale, source: transcript.source)
        let heldReceipt = VoiceNativeReceipt(schema: receipt.schema, audio: heldAudio, transcript: heldText)
        let heldLease = try limitedAudio.acquire(heldAudio)
        try limited.put(heldReceipt, lease: heldLease)
        let separateAudio = VoiceRecoveryJournal(root: root.appendingPathComponent("separate-audio"))
        let (newCapture, newFile) = try separateAudio.reserve(id: UUID().uuidString, owner: owner, destination: "chat", locale: "es-MX", kind: .speech)
        try Data([2]).write(to: newFile)
        let newAudio = try separateAudio.publish(newCapture)
        let newText = VoiceNativeTranscript(sessionId: newAudio.id, text: transcript.text, segments: transcript.segments,
            durationSeconds: transcript.durationSeconds, locale: transcript.locale, source: transcript.source)
        let newReceipt = VoiceNativeReceipt(schema: receipt.schema, audio: newAudio, transcript: newText)
        let newLease = try separateAudio.acquire(newAudio)
        check(reject { try limited.put(newReceipt, lease: heldLease) }, "a lease cannot authorize another capture")
        check(reject { try limited.put(newReceipt, lease: newLease) }, "quota never evicts another retained transcript")
        check(try limited.get(heldAudio.id)?.receipt == heldReceipt, "quota failure preserves retained receipt")
        let inside = DispatchSemaphore(value: 0), unblock = DispatchSemaphore(value: 0)
        let closeStarted = DispatchSemaphore(value: 0), closed = DispatchSemaphore(value: 0), verified = DispatchSemaphore(value: 0)
        DispatchQueue.global().async {
            do {
                try newLease.withVerified(record: newAudio) { inside.signal(); unblock.wait() }
                verified.signal()
            } catch { preconditionFailure("live lease should remain valid during its critical section") }
        }
        check(inside.wait(timeout: .now() + 2) == .success, "verification entered its critical section")
        DispatchQueue.global().async { closeStarted.signal(); newLease.close(); closed.signal() }
        check(closeStarted.wait(timeout: .now() + 2) == .success, "concurrent close started")
        check(closed.wait(timeout: .now() + .milliseconds(50)) == .timedOut, "close cannot release the source during a verified commit")
        unblock.signal()
        check(verified.wait(timeout: .now() + 2) == .success && closed.wait(timeout: .now() + 2) == .success, "verification and close both finish")
        heldLease.close()
        try limited.release(heldReceipt, audioJournal: limitedAudio)
        try limited.discard(heldReceipt, audioJournal: limitedAudio)
        try separateAudio.remove(newAudio)
        let fullRoot = root.appendingPathComponent("full-store")
        try fm.createDirectory(at: fullRoot, withIntermediateDirectories: true)
        let fullStore = VoiceNativeReceiptStore(root: fullRoot)
        let fixtureEncoder = JSONEncoder(); fixtureEncoder.outputFormatting = [.sortedKeys]
        var firstLegacyFile: URL?
        for index in 0..<100 {
            let oldID = UUID().uuidString.lowercased()
            let tombstone: [String: String] = ["schema": "capri-native-voice-file/v1", "state": "discarded", "digest": String(repeating: "a", count: 64)]
            let legacyFile = fullRoot.appendingPathComponent("\(oldID).json")
            if index == 0 { firstLegacyFile = legacyFile }
            try JSONSerialization.data(withJSONObject: tombstone).write(to: legacyFile)
            let activeID = UUID().uuidString
            let activeAudio = VoiceRecoveryRecord(id: activeID, owner: owner, destination: "chat", locale: ready.locale,
                kind: ready.kind, createdAt: ready.createdAt + Int64(index), state: .ready, byteCount: ready.byteCount, sha256: ready.sha256)
            let activeText = VoiceNativeTranscript(sessionId: activeID, text: transcript.text, segments: transcript.segments,
                durationSeconds: transcript.durationSeconds, locale: transcript.locale, source: transcript.source)
            let activeReceipt = VoiceNativeReceipt(schema: receipt.schema, audio: activeAudio, transcript: activeText)
            let digest = SHA256.hash(data: try fixtureEncoder.encode(activeReceipt)).map { String(format: "%02x", $0) }.joined()
            let file = ReceiptFixtureFile(schema: "capri-native-voice-file/v1", state: "released", digest: digest, receipt: activeReceipt)
            try fixtureEncoder.encode(file).write(to: fullRoot.appendingPathComponent("\(activeID.lowercased()).json"))
        }
        let scanStart = Date()
        check(try fullStore.list().count == 100, "all 100 active receipts remain visible alongside 100 legacy tombstones")
        print("Voice receipt scan of 200 bounded files: \(Int(Date().timeIntervalSince(scanStart) * 1000)) ms")
        try fm.removeItem(at: firstLegacyFile!)
        let stray = fullRoot.appendingPathComponent("unexpected")
        try Data([0]).write(to: stray)
        check(reject { _ = try fullStore.list() }, "unexpected files fail closed even at the physical limit")
        try fm.removeItem(at: stray)
        let tombstone = receiptRoot.appendingPathComponent("\(id.lowercased()).json")
        try Data("broken".utf8).write(to: tombstone, options: .atomic)
        check(reject { _ = try fresh.list() } && reject { try fresh.put(receipt, lease: lease) }, "corrupt storage fails closed")
        print("VoiceNativeReceipt: durable binding, exact release, retry and explicit discard.")
    }
}
