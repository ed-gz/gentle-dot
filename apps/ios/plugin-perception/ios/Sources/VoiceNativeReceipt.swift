import Foundation
import CryptoKit
#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

struct VoiceSegment: Codable, Equatable, Sendable {
    let text: String
    let startSeconds: Double
    let endSeconds: Double
}

struct VoiceNativeTranscript: Codable, Equatable, Sendable {
    let sessionId: String
    let text: String
    let segments: [VoiceSegment]
    let durationSeconds: Double
    let locale: String
    let source: String
}

struct VoiceNativeReceipt: Codable, Equatable, Sendable {
    let schema: String
    let audio: VoiceRecoveryRecord
    let transcript: VoiceNativeTranscript
}

struct VoiceNativeReceiptEnvelope: Codable, Equatable, Sendable {
    let receipt: VoiceNativeReceipt
    let releaseState: String
}

private struct VoiceNativeReceiptFile: Codable {
    let schema: String
    let state: String
    let digest: String
    let receipt: VoiceNativeReceipt?
}

enum VoiceNativeReceiptError: Error { case invalid, changed, busy, full, corrupt }

/// Separate from the single audio journal. All mutations serialize across
/// processes; a receipt is immutable and never implies that a chat saved it.
final class VoiceNativeReceiptStore {
    private static let mutex = NSLock()
    private let root: URL
    private let fm = FileManager.default
    private let maxRecords: Int
    private let maxFileBytes = 1_500_000
    init(root: URL, maxRecords: Int = 100) { self.root = root; self.maxRecords = max(1, min(maxRecords, 100)) }

    static func defaultRoot() -> URL? {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appendingPathComponent("CapriVoiceReceipts", isDirectory: true)
    }
    private func uuid(_ value: String) -> Bool { UUID(uuidString: value)?.uuidString.lowercased() == value.lowercased() }
    private func validate(_ receipt: VoiceNativeReceipt) throws {
        let audio = receipt.audio, transcript = receipt.transcript
        guard receipt.schema == "capri-native-voice-receipt/v1", audio.state == .ready,
              uuid(audio.id), uuid(audio.owner), audio.id.lowercased() != audio.owner.lowercased(),
              VoiceRetentionBinding.validDestination(audio.destination), audio.createdAt > 0,
              audio.locale.count <= 40, audio.locale.split(separator: "-", omittingEmptySubsequences: false).first?.lowercased() == "es",
              audio.locale.split(separator: "-", omittingEmptySubsequences: false).allSatisfy({ !$0.isEmpty && $0.count <= 8 && $0.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber) } }),
              let bytes = audio.byteCount, bytes > 0, bytes <= 128 * 1024 * 1024,
              let sha = audio.sha256, sha.count == 64, sha.allSatisfy({ ("0"..."9").contains($0) || ("a"..."f").contains($0) }),
              transcript.sessionId == audio.id, transcript.locale.lowercased() == audio.locale.lowercased(),
              transcript.source == "apple-speech-analyzer", transcript.text == transcript.segments.map(\.text).joined(separator: " "),
              VoiceTranscriptBounds.valid(transcript.segments.map { (text: $0.text, start: $0.startSeconds, end: $0.endSeconds) }, duration: transcript.durationSeconds) else {
            throw VoiceNativeReceiptError.invalid
        }
    }
    private func encoder() -> JSONEncoder { let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]; return encoder }
    private func digest(_ receipt: VoiceNativeReceipt) throws -> String {
        try validate(receipt)
        return SHA256.hash(data: try encoder().encode(receipt)).map { String(format: "%02x", $0) }.joined()
    }
    private func path(_ id: String) -> URL { root.appendingPathComponent("\(id.lowercased()).json") }
    private func locked<T>(_ action: () throws -> T) throws -> T {
        Self.mutex.lock(); defer { Self.mutex.unlock() }
        if !fm.fileExists(atPath: root.path) { try fm.createDirectory(at: root, withIntermediateDirectories: true) }
        let values = try root.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        guard values.isDirectory == true, values.isSymbolicLink != true else { throw VoiceNativeReceiptError.invalid }
        #if os(iOS)
        try fm.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: root.path)
        var directory = root, resource = URLResourceValues(); resource.isExcludedFromBackup = true; try directory.setResourceValues(resource)
        #endif
        let fd = root.appendingPathComponent(".receipts.lock").path.withCString { open($0, O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK, mode_t(0o600)) }
        guard fd >= 0 else { throw VoiceNativeReceiptError.invalid }
        defer { _ = close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG), info.st_nlink == 1 else { throw VoiceNativeReceiptError.invalid }
        guard flock(fd, LOCK_EX | LOCK_NB) == 0 else { throw VoiceNativeReceiptError.busy }
        defer { _ = flock(fd, LOCK_UN) }
        return try action()
    }
    private func sync(_ url: URL, directory: Bool = false) throws {
        let fd = url.path.withCString { open($0, O_RDONLY | O_NOFOLLOW | O_CLOEXEC) }
        guard fd >= 0 else { throw VoiceNativeReceiptError.invalid }
        defer { _ = close(fd) }
        #if canImport(Darwin)
        if !directory {
            guard fcntl(fd, F_FULLFSYNC) == 0 else { throw VoiceNativeReceiptError.invalid }
            return
        }
        #endif
        guard fsync(fd) == 0 else { throw VoiceNativeReceiptError.invalid }
    }
    private func write(_ file: VoiceNativeReceiptFile, id: String) throws {
        let data = try encoder().encode(file)
        guard data.count <= maxFileBytes else { throw VoiceNativeReceiptError.invalid }
        let destination = path(id)
        try data.write(to: destination, options: .atomic)
        #if os(iOS)
        try fm.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: destination.path)
        #endif
        try sync(destination); try sync(root, directory: true)
    }
    private func read(_ id: String) throws -> VoiceNativeReceiptFile? {
        guard uuid(id) else { throw VoiceNativeReceiptError.invalid }
        let url = path(id)
        var info = stat()
        let status = url.path.withCString { lstat($0, &info) }
        if status != 0 { if errno == ENOENT { return nil }; throw VoiceNativeReceiptError.corrupt }
        guard info.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG), info.st_nlink == 1,
              info.st_size > 0, info.st_size <= maxFileBytes else { throw VoiceNativeReceiptError.corrupt }
        let fd = url.path.withCString { open($0, O_RDONLY | O_NOFOLLOW | O_CLOEXEC) }
        guard fd >= 0 else { throw VoiceNativeReceiptError.corrupt }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        defer { try? handle.close() }
        var opened = stat()
        guard fstat(fd, &opened) == 0, opened.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG), opened.st_nlink == 1,
              opened.st_dev == info.st_dev, opened.st_ino == info.st_ino, opened.st_size == info.st_size else { throw VoiceNativeReceiptError.corrupt }
        let data = try handle.readToEnd() ?? Data()
        guard data.count > 0, data.count <= maxFileBytes,
              let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let decoded = try? JSONDecoder().decode(VoiceNativeReceiptFile.self, from: data),
              decoded.schema == "capri-native-voice-file/v1", decoded.digest.count == 64,
              decoded.digest.allSatisfy({ ("0"..."9").contains($0) || ("a"..."f").contains($0) }),
              Set(raw.keys) == Set(["schema", "state", "digest"] + (decoded.receipt == nil ? [] : ["receipt"])) else { throw VoiceNativeReceiptError.corrupt }
        if decoded.state == "discarded" {
            guard decoded.receipt == nil else { throw VoiceNativeReceiptError.corrupt }
        } else {
            guard let receiptRaw = raw["receipt"] as? [String: Any], Set(receiptRaw.keys) == Set(["schema", "audio", "transcript"]),
                  let audio = receiptRaw["audio"] as? [String: Any], Set(audio.keys) == Set(["id", "owner", "destination", "locale", "kind", "createdAt", "state", "byteCount", "sha256"]),
                  let transcript = receiptRaw["transcript"] as? [String: Any], Set(transcript.keys) == Set(["sessionId", "text", "segments", "durationSeconds", "locale", "source"]),
                  let segments = transcript["segments"] as? [[String: Any]], segments.allSatisfy({ Set($0.keys) == Set(["text", "startSeconds", "endSeconds"]) }),
                  ["retained", "releasing", "released"].contains(decoded.state), let receipt = decoded.receipt,
                  receipt.audio.id.lowercased() == id.lowercased(), try digest(receipt) == decoded.digest else { throw VoiceNativeReceiptError.corrupt }
        }
        return decoded
    }
    func put(_ receipt: VoiceNativeReceipt) throws {
        let fingerprint = try digest(receipt)
        try locked {
            if let old = try read(receipt.audio.id) {
                guard old.state != "discarded", old.digest == fingerprint, old.receipt == receipt else { throw VoiceNativeReceiptError.changed }
                // Re-sync on a lost callback, including an earlier fsync error.
                try sync(path(receipt.audio.id)); try sync(root, directory: true); return
            }
            let names = try fm.contentsOfDirectory(atPath: root.path).filter { $0 != ".receipts.lock" }
            guard names.count < maxRecords else { throw VoiceNativeReceiptError.full }
            try write(VoiceNativeReceiptFile(schema: "capri-native-voice-file/v1", state: "retained", digest: fingerprint, receipt: receipt), id: receipt.audio.id)
        }
    }
    func get(_ id: String) throws -> VoiceNativeReceiptEnvelope? {
        try locked {
            guard let file = try read(id), let receipt = file.receipt else { return nil }
            return VoiceNativeReceiptEnvelope(receipt: receipt, releaseState: file.state)
        }
    }
    func list() throws -> [VoiceNativeReceiptEnvelope] {
        try locked {
            let names = try fm.contentsOfDirectory(atPath: root.path).filter { $0 != ".receipts.lock" }
            guard names.count <= maxRecords else { throw VoiceNativeReceiptError.corrupt }
            var results: [VoiceNativeReceiptEnvelope] = []
            for name in names {
                guard name.hasSuffix(".json") else { throw VoiceNativeReceiptError.corrupt }
                let id = String(name.dropLast(5))
                guard uuid(id), name == "\(id.lowercased()).json", let file = try read(id) else { throw VoiceNativeReceiptError.corrupt }
                if let receipt = file.receipt { results.append(VoiceNativeReceiptEnvelope(receipt: receipt, releaseState: file.state)) }
            }
            return results.sorted { $0.receipt.audio.createdAt < $1.receipt.audio.createdAt }
        }
    }
    func discard(_ receipt: VoiceNativeReceipt) throws {
        let fingerprint = try digest(receipt)
        try locked {
            guard let existing = try read(receipt.audio.id), existing.digest == fingerprint else { throw VoiceNativeReceiptError.changed }
            if existing.state == "discarded" { try sync(path(receipt.audio.id)); try sync(root, directory: true); return }
            guard existing.receipt == receipt, existing.state != "releasing" else { throw VoiceNativeReceiptError.changed }
            try write(VoiceNativeReceiptFile(schema: "capri-native-voice-file/v1", state: "discarded", digest: fingerprint, receipt: nil), id: receipt.audio.id)
        }
    }
    /// Hold this store's lock across the audio journal removal so explicit
    /// receipt discard cannot race the release. A full receipt always remains.
    func release(_ receipt: VoiceNativeReceipt, audioJournal: VoiceRecoveryJournal) throws {
        let fingerprint = try digest(receipt)
        try locked {
            guard let old = try read(receipt.audio.id), old.digest == fingerprint, old.receipt == receipt else { throw VoiceNativeReceiptError.changed }
            // A prior callback may have been lost after the rename but before
            // synchronization finished. Reconfirm before any deletion or ACK.
            try sync(path(receipt.audio.id)); try sync(root, directory: true)
            if old.state == "released" { try audioJournal.releaseExact(receipt.audio); return }
            guard old.state == "retained" || old.state == "releasing" else { throw VoiceNativeReceiptError.changed }
            if old.state == "retained" {
                try write(VoiceNativeReceiptFile(schema: "capri-native-voice-file/v1", state: "releasing", digest: fingerprint, receipt: receipt), id: receipt.audio.id)
            }
            try audioJournal.releaseExact(receipt.audio)
            try write(VoiceNativeReceiptFile(schema: "capri-native-voice-file/v1", state: "released", digest: fingerprint, receipt: receipt), id: receipt.audio.id)
        }
    }
}
