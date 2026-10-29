import Foundation
#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

/// Isolated prototype: callers must close a recording before publishing it and
/// must not acknowledge a transcript until its exact destination saved it.
/// This type is not yet connected to VoiceController or the WebView. The lock
/// only covers one process; the returned URL is not a read lease, and byte
/// hashes or fsync guarantees are not provided. Integrating it requires those
/// protections and an acknowledgement of the exact saved destination.
struct VoiceRecoveryRecord: Codable, Equatable {
    enum State: String, Codable { case capturing, ready }
    enum Kind: String, Codable { case speech, dictation }
    let id: String
    let owner: String
    let destination: String
    let locale: String
    let kind: Kind
    let createdAt: Int64
    let state: State
}

enum VoiceRecoveryJournalError: Error {
    case invalid, occupied, changed, missingAudio, invalidAudio, corrupt
}

/// One bounded capture per private directory. Metadata is committed before a
/// caller may create audio, so an interrupted capture never lacks its owner or
/// destination. Only a fully closed file can transition to `ready`. A failed
/// read or delete leaves existing evidence in place for review.
final class VoiceRecoveryJournal {
    private static let lock = NSLock()
    private let root: URL
    private let manager: FileManager
    private let maxAudioBytes: Int64 = 128 * 1024 * 1024
    private var manifest: URL { root.appendingPathComponent("current.json") }

    init(root: URL, manager: FileManager = .default) { self.root = root; self.manager = manager }

    private func locked<T>(_ operation: () throws -> T) rethrows -> T {
        Self.lock.lock(); defer { Self.lock.unlock() }; return try operation()
    }
    private func uuid(_ value: String) -> Bool {
        guard let id = UUID(uuidString: value) else { return false }
        return id.uuidString.lowercased() == value.lowercased()
    }
    private func destination(_ value: String) -> Bool {
        if value == "chat" { return true }
        guard value.hasPrefix("session:") else { return false }
        let hash = value.dropFirst("session:".count)
        return hash.count == 64 && hash.allSatisfy { ("0"..."9").contains($0) || ("a"..."f").contains($0) }
    }
    private func locale(_ value: String) -> Bool {
        guard value.count <= 40, value.lowercased().hasPrefix("es") else { return false }
        let parts = value.split(separator: "-", omittingEmptySubsequences: false)
        return parts.first?.lowercased() == "es" && parts.allSatisfy { !$0.isEmpty && $0.count <= 8 && $0.allSatisfy { $0.isASCII && $0.isLetter || $0.isASCII && $0.isNumber } }
    }
    private func valid(_ record: VoiceRecoveryRecord) -> Bool {
        uuid(record.id) && uuid(record.owner) && record.id.lowercased() != record.owner.lowercased()
            && destination(record.destination) && locale(record.locale) && record.createdAt > 0
    }
    private func ensureRoot() throws {
        if !(try exists(root)) { try manager.createDirectory(at: root, withIntermediateDirectories: true) }
        let attributes = try root.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        guard attributes.isDirectory == true, attributes.isSymbolicLink != true else { throw VoiceRecoveryJournalError.invalid }
        #if os(iOS)
        try manager.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: root.path)
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        var directory = root; try directory.setResourceValues(values)
        #endif
    }
    private func audio(_ record: VoiceRecoveryRecord) -> URL { root.appendingPathComponent("\(record.id.lowercased()).caf") }
    private func exists(_ url: URL) throws -> Bool {
        // fileExists() conflates missing files with permission failures. lstat
        // also notices dangling symlinks without following them.
        var info = stat()
        let (result, code) = url.path.withCString { path -> (Int32, Int32) in
            let result = lstat(path, &info)
            return (result, errno)
        }
        if result == 0 { return true }
        if code == ENOENT { return false }
        throw NSError(domain: NSPOSIXErrorDomain, code: Int(code))
    }
    private func read() throws -> VoiceRecoveryRecord? {
        guard try exists(manifest) else { return nil }
        let values = try manifest.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
        guard values.isRegularFile == true, values.isSymbolicLink != true,
              let size = values.fileSize, size > 0, size <= 8192 else { throw VoiceRecoveryJournalError.corrupt }
        let data = try Data(contentsOf: manifest)
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(object.keys) == Set(["id", "owner", "destination", "locale", "kind", "createdAt", "state"]),
              let record = try? JSONDecoder().decode(VoiceRecoveryRecord.self, from: data), valid(record) else { throw VoiceRecoveryJournalError.corrupt }
        return record
    }
    private func write(_ record: VoiceRecoveryRecord) throws {
        let data = try JSONEncoder().encode(record)
        try data.write(to: manifest, options: .atomic)
        #if os(iOS)
        try manager.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: manifest.path)
        #endif
    }
    private func verifiedAudio(_ record: VoiceRecoveryRecord) throws -> URL {
        let file = audio(record)
        guard try exists(file) else { throw VoiceRecoveryJournalError.missingAudio }
        let values = try file.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
        guard values.isRegularFile == true, values.isSymbolicLink != true,
              let size = values.fileSize, size > 0, Int64(size) <= maxAudioBytes else { throw VoiceRecoveryJournalError.invalidAudio }
        return file
    }
    func current() throws -> VoiceRecoveryRecord? { try locked { try read() } }
    func readyAudio(_ expected: VoiceRecoveryRecord) throws -> URL {
        try locked {
            guard valid(expected), expected.state == .ready, try read() == expected else { throw VoiceRecoveryJournalError.changed }
            return try verifiedAudio(expected)
        }
    }

    /// Bind the destination durably before exposing the only allowed file path.
    func reserve(id: String, owner: String, destination: String, locale: String,
                 kind: VoiceRecoveryRecord.Kind) throws -> (VoiceRecoveryRecord, URL) {
        try locked {
            try ensureRoot()
            guard try read() == nil else { throw VoiceRecoveryJournalError.occupied }
            // An unbound orphan may be the only surviving copy after disk
            // corruption. Refuse a new reservation and never remove it.
            guard try manager.contentsOfDirectory(atPath: root.path).isEmpty else { throw VoiceRecoveryJournalError.occupied }
            let record = VoiceRecoveryRecord(id: id, owner: owner, destination: destination, locale: locale,
                kind: kind, createdAt: Int64(Date().timeIntervalSince1970), state: .capturing)
            guard valid(record) else { throw VoiceRecoveryJournalError.invalid }
            let file = audio(record)
            // Never replace an orphaned file, even when metadata was damaged or lost.
            guard !(try exists(file)) else { throw VoiceRecoveryJournalError.occupied }
            try write(record)
            return (record, file)
        }
    }

    /// The caller is responsible for closing and draining its audio writer.
    func publish(_ expected: VoiceRecoveryRecord) throws -> VoiceRecoveryRecord {
        try locked {
            guard valid(expected), expected.state == .capturing else { throw VoiceRecoveryJournalError.invalid }
            guard try read() == expected else { throw VoiceRecoveryJournalError.changed }
            let file = try verifiedAudio(expected)
            #if os(iOS)
            try manager.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: file.path)
            #endif
            let ready = VoiceRecoveryRecord(id: expected.id, owner: expected.owner, destination: expected.destination,
                locale: expected.locale, kind: expected.kind, createdAt: expected.createdAt, state: .ready)
            try write(ready)
            return ready
        }
    }

    /// Explicit cancellation or future verified draft acknowledgement only.
    /// Deleting bytes first avoids a surviving audio file without its binding.
    func remove(_ expected: VoiceRecoveryRecord) throws {
        try locked {
            guard valid(expected), try read() == expected else { throw VoiceRecoveryJournalError.changed }
            let file = audio(expected)
            if try exists(file) { try manager.removeItem(at: file) }
            try manager.removeItem(at: manifest)
        }
    }
}
