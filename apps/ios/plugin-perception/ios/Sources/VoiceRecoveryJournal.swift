import Foundation
import CryptoKit
#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

/// Isolated prototype: callers must close a recording before publishing it and
/// must not acknowledge a transcript until its exact destination saved it.
/// This type is not yet connected to VoiceController or the WebView. Its locks
/// protect cooperating journal users only; atomic rename is not an fsync
/// guarantee. Integration requires acknowledgement of the exact saved draft.
struct VoiceRecoveryRecord: Codable, Equatable, Sendable {
    enum State: String, Codable, Sendable { case capturing, ready }
    enum Kind: String, Codable, Sendable { case speech, dictation }
    let id: String
    let owner: String
    let destination: String
    let locale: String
    let kind: Kind
    let createdAt: Int64
    let state: State
    let byteCount: Int64?
    let sha256: String?
}

enum VoiceRecoveryJournalError: Error {
    case invalid, occupied, changed, missingAudio, invalidAudio, corrupt, busy
}

/// Holds a process-shared read lock until explicitly closed or deinitialized.
/// The URL is for AVAudioFile. Check exact file identity again after analysis
/// and before acknowledging its transcript; it cannot prevent rogue writers.
final class VoiceRecoveryReadLease: @unchecked Sendable {
    let url: URL
    private let record: VoiceRecoveryRecord
    private var lockFD: Int32
    private let guardLock = NSLock()
    private let validate: () throws -> Void
    init(url: URL, record: VoiceRecoveryRecord, lockFD: Int32, validate: @escaping () throws -> Void) {
        self.url = url; self.record = record; self.lockFD = lockFD; self.validate = validate
    }
    func verify() throws {
        guardLock.lock(); defer { guardLock.unlock() }
        guard lockFD >= 0 else { throw VoiceRecoveryJournalError.changed }
        try validate()
    }
    /// Keeps close() from releasing the shared journal lock during a commit.
    func withVerified<T>(record expected: VoiceRecoveryRecord, _ action: () throws -> T) throws -> T {
        guardLock.lock(); defer { guardLock.unlock() }
        guard lockFD >= 0, record == expected else { throw VoiceRecoveryJournalError.changed }
        try validate()
        return try action()
    }
    func close() {
        guardLock.lock(); defer { guardLock.unlock() }
        guard lockFD >= 0 else { return }
        _ = flock(lockFD, LOCK_UN); _ = closeVoiceDescriptor(lockFD); lockFD = -1
    }
    deinit { close() }
}

private func closeVoiceDescriptor(_ descriptor: Int32) -> Int32 {
    #if canImport(Darwin)
    return Darwin.close(descriptor)
    #else
    return Glibc.close(descriptor)
    #endif
}

/// One bounded capture per private directory. Metadata is committed before a
/// caller may create audio, so an interrupted capture never lacks its owner or
/// destination. Only a fully closed file can transition to `ready`. A failed
/// read or delete leaves existing evidence in place for review.
final class VoiceRecoveryJournal {
    private static let lock = NSLock()
    private let root: URL
    private let manager: FileManager
    private let syncDirectory: (URL) throws -> Void
    private let maxAudioBytes: Int64 = 128 * 1024 * 1024
    private var manifest: URL { root.appendingPathComponent("current.json") }
    private var discardMarker: URL { root.appendingPathComponent(".discard.json") }
    private var lockFile: URL { root.appendingPathComponent(".journal.lock") }

    init(root: URL, manager: FileManager = .default, syncDirectory: @escaping (URL) throws -> Void = VoiceRecoveryJournal.syncDirectory) {
        self.root = root; self.manager = manager; self.syncDirectory = syncDirectory
    }

    private static func syncDirectory(_ url: URL) throws {
        let fd = url.path.withCString { open($0, O_RDONLY | O_NOFOLLOW | O_CLOEXEC) }
        guard fd >= 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
        defer { _ = closeVoiceDescriptor(fd) }
        guard fsync(fd) == 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
    }

    private func syncFile(_ url: URL) throws {
        let fd = url.path.withCString { open($0, O_RDONLY | O_NOFOLLOW | O_CLOEXEC) }
        guard fd >= 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
        defer { _ = closeVoiceDescriptor(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG), info.st_nlink == 1 else {
            throw VoiceRecoveryJournalError.corrupt
        }
        #if canImport(Darwin)
        guard fcntl(fd, F_FULLFSYNC) == 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
        #else
        guard fsync(fd) == 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
        #endif
    }

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
        let binding = record.state == .capturing
            ? record.byteCount == nil && record.sha256 == nil
            : record.byteCount.map { $0 > 0 && $0 <= maxAudioBytes } == true
                && record.sha256.map { $0.count == 64 && $0.allSatisfy { ("0"..."9").contains($0) || ("a"..."f").contains($0) } } == true
        return binding && uuid(record.id) && uuid(record.owner) && record.id.lowercased() != record.owner.lowercased()
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
    private func acquireFileLock(shared: Bool) throws -> Int32 {
        let descriptor = lockFile.path.withCString { open($0, O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK, mode_t(0o600)) }
        guard descriptor >= 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
        var info = stat()
        guard fstat(descriptor, &info) == 0, (info.st_mode & mode_t(S_IFMT)) == mode_t(S_IFREG), info.st_nlink == 1 else {
            _ = closeVoiceDescriptor(descriptor); throw VoiceRecoveryJournalError.invalid
        }
        let operation = (shared ? LOCK_SH : LOCK_EX) | LOCK_NB
        guard flock(descriptor, operation) == 0 else {
            let code = errno; _ = closeVoiceDescriptor(descriptor)
            if code == EWOULDBLOCK || code == EAGAIN { throw VoiceRecoveryJournalError.busy }
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(code))
        }
        return descriptor
    }
    private func withFileLock<T>(shared: Bool, _ operation: () throws -> T) throws -> T {
        try ensureRoot()
        let fd = try acquireFileLock(shared: shared)
        defer { _ = flock(fd, LOCK_UN); _ = closeVoiceDescriptor(fd) }
        return try operation()
    }
    private func readRecord(_ url: URL) throws -> VoiceRecoveryRecord? {
        guard try exists(url) else { return nil }
        let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
        guard values.isRegularFile == true, values.isSymbolicLink != true,
              let size = values.fileSize, size > 0, size <= 8192 else { throw VoiceRecoveryJournalError.corrupt }
        let data = try Data(contentsOf: url)
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let state = object["state"] as? String,
              Set(object.keys) == Set(["id", "owner", "destination", "locale", "kind", "createdAt", "state"] + (state == "ready" ? ["byteCount", "sha256"] : [])),
              let record = try? JSONDecoder().decode(VoiceRecoveryRecord.self, from: data), valid(record) else { throw VoiceRecoveryJournalError.corrupt }
        return record
    }
    private func read() throws -> VoiceRecoveryRecord? { try readRecord(manifest) }
    private func write(_ record: VoiceRecoveryRecord) throws {
        let data = try JSONEncoder().encode(record)
        try data.write(to: manifest, options: .atomic)
        #if os(iOS)
        try manager.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: manifest.path)
        #endif
    }
    private struct AudioIdentity: Equatable {
        let byteCount: Int64
        let sha256: String
        let device: UInt64
        let inode: UInt64
        let modifiedSeconds: Int64
        let modifiedNanoseconds: Int64
    }
    private func modifiedTime(_ value: stat) -> (Int64, Int64) {
        #if canImport(Darwin)
        return (Int64(value.st_mtimespec.tv_sec), Int64(value.st_mtimespec.tv_nsec))
        #else
        return (Int64(value.st_mtim.tv_sec), Int64(value.st_mtim.tv_nsec))
        #endif
    }
    private func audioIdentity(_ record: VoiceRecoveryRecord) throws -> (URL, AudioIdentity) {
        let file = audio(record)
        guard try exists(file) else { throw VoiceRecoveryJournalError.missingAudio }
        // Reject FIFOs/devices after fstat without blocking forever on open.
        let fd = file.path.withCString { open($0, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK) }
        guard fd >= 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        defer { try? handle.close() }
        var before = stat()
        guard fstat(fd, &before) == 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
        guard (before.st_mode & mode_t(S_IFMT)) == mode_t(S_IFREG), before.st_nlink == 1, before.st_size > 0,
              before.st_size <= maxAudioBytes else { throw VoiceRecoveryJournalError.invalidAudio }
        var hasher = SHA256()
        var bytes: Int64 = 0
        while let chunk = try handle.read(upToCount: 65_536), !chunk.isEmpty {
            bytes += Int64(chunk.count)
            guard bytes <= maxAudioBytes else { throw VoiceRecoveryJournalError.invalidAudio }
            hasher.update(data: chunk)
        }
        var after = stat(), named = stat()
        guard fstat(fd, &after) == 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
        let namedResult = file.path.withCString { lstat($0, &named) }
        guard namedResult == 0 else { throw VoiceRecoveryJournalError.changed }
        let beforeTime = modifiedTime(before), afterTime = modifiedTime(after), namedTime = modifiedTime(named)
        guard bytes == before.st_size, after.st_size == before.st_size, named.st_size == before.st_size,
              after.st_nlink == 1, named.st_nlink == 1,
              before.st_ino == after.st_ino, before.st_ino == named.st_ino,
              before.st_dev == after.st_dev, before.st_dev == named.st_dev,
              beforeTime.0 == afterTime.0, beforeTime.1 == afterTime.1,
              beforeTime.0 == namedTime.0, beforeTime.1 == namedTime.1 else { throw VoiceRecoveryJournalError.changed }
        return (file, AudioIdentity(byteCount: bytes, sha256: hasher.finalize().map { String(format: "%02x", $0) }.joined(),
            device: UInt64(truncatingIfNeeded: before.st_dev), inode: UInt64(truncatingIfNeeded: before.st_ino),
            modifiedSeconds: beforeTime.0, modifiedNanoseconds: beforeTime.1))
    }
    func current() throws -> VoiceRecoveryRecord? { try locked { try withFileLock(shared: true) {
        guard try readRecord(discardMarker) == nil else { throw VoiceRecoveryJournalError.busy }
        return try read()
    } } }

    /// Opt-in recovery boundary. Until the caller surfaces this state, the
    /// existing remove operation remains unchanged.
    func pendingDiscard() throws -> VoiceRecoveryRecord? {
        try locked { try withFileLock(shared: true) { try readRecord(discardMarker) } }
    }

    func inspectWithDiscard() throws -> (record: VoiceRecoveryRecord?, discardPending: VoiceRecoveryRecord?) {
        try locked { try withFileLock(shared: true) {
            let pending = try readRecord(discardMarker), record = try read()
            if let pending {
                guard record == nil || record == pending else { throw VoiceRecoveryJournalError.corrupt }
                return (nil, pending)
            }
            return (record, nil)
        } }
    }

    /// Copy a stopped, incomplete capture to a caller-owned protected export
    /// file. This proves only that the bytes stayed unchanged during copying;
    /// it does not claim that the interrupted CAF is complete or playable.
    /// The caller must first drain the native recorder and own the destination.
    func copyIncomplete(_ expected: VoiceRecoveryRecord, to destination: URL, afterChunk: () throws -> Void = {}) throws {
        try locked {
          try withFileLock(shared: false) {
            guard valid(expected), expected.state == .capturing,
                  try readRecord(discardMarker) == nil, try read() == expected else { throw VoiceRecoveryJournalError.changed }
            let (source, before) = try audioIdentity(expected)
            let sourceFD = source.path.withCString { open($0, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK) }
            guard sourceFD >= 0 else { throw VoiceRecoveryJournalError.invalidAudio }
            let input = FileHandle(fileDescriptor: sourceFD, closeOnDealloc: true)
            defer { try? input.close() }
            var sourceStat = stat()
            guard fstat(sourceFD, &sourceStat) == 0, sourceStat.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG), sourceStat.st_nlink == 1,
                  UInt64(truncatingIfNeeded: sourceStat.st_dev) == before.device,
                  UInt64(truncatingIfNeeded: sourceStat.st_ino) == before.inode else { throw VoiceRecoveryJournalError.changed }
            let targetFD = destination.path.withCString { open($0, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, mode_t(0o600)) }
            guard targetFD >= 0 else { throw VoiceRecoveryJournalError.invalid }
            let output = FileHandle(fileDescriptor: targetFD, closeOnDealloc: true)
            var keep = false
            defer { try? output.close(); if !keep { try? manager.removeItem(at: destination) } }
            #if os(iOS)
            try manager.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: destination.path)
            #endif
            var bytes: Int64 = 0, hash = SHA256()
            while let chunk = try input.read(upToCount: 65_536), !chunk.isEmpty {
                bytes += Int64(chunk.count)
                guard bytes <= maxAudioBytes else { throw VoiceRecoveryJournalError.invalidAudio }
                hash.update(data: chunk); try output.write(contentsOf: chunk); try afterChunk()
            }
            guard bytes == before.byteCount, hash.finalize().map({ String(format: "%02x", $0) }).joined() == before.sha256 else { throw VoiceRecoveryJournalError.changed }
            let (_, after) = try audioIdentity(expected)
            guard after == before, try readRecord(discardMarker) == nil, try read() == expected else { throw VoiceRecoveryJournalError.changed }
            try output.synchronize()
            #if canImport(Darwin)
            guard fcntl(targetFD, F_FULLFSYNC) == 0 else { throw VoiceRecoveryJournalError.invalid }
            #endif
            keep = true
          }
        }
    }

    /// Exact user-authorized discard with a durable intent. A caller must
    /// surface `pendingDiscard()` before enabling this operation in the app.
    func discardDurably(_ expected: VoiceRecoveryRecord) throws {
        try locked {
          try withFileLock(shared: false) {
            guard valid(expected) else { throw VoiceRecoveryJournalError.invalid }
            let marker = try readRecord(discardMarker)
            let current = try read()
            if let marker {
                guard marker == expected, current == nil || current == expected else { throw VoiceRecoveryJournalError.changed }
                // An earlier callback may have failed after the marker rename.
                try syncFile(discardMarker); try syncDirectory(root)
            } else {
                if current == nil {
                    // A callback or final directory sync may have failed after
                    // the marker was unlinked. Confirm only the present empty
                    // state; never remove unexpectedly reappearing audio.
                    guard !(try exists(audio(expected))) else { throw VoiceRecoveryJournalError.changed }
                    try syncDirectory(root)
                    return
                }
                guard current == expected else { throw VoiceRecoveryJournalError.changed }
                try JSONEncoder().encode(expected).write(to: discardMarker, options: .atomic)
                #if os(iOS)
                try manager.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: discardMarker.path)
                #endif
                try syncFile(discardMarker); try syncDirectory(root)
            }
            let file = audio(expected)
            if try exists(file) {
                if expected.state == .ready {
                    let (_, identity) = try audioIdentity(expected)
                    guard identity.byteCount == expected.byteCount, identity.sha256 == expected.sha256 else { throw VoiceRecoveryJournalError.changed }
                } else {
                    var info = stat()
                    guard file.path.withCString({ lstat($0, &info) }) == 0,
                          info.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG), info.st_nlink == 1 else {
                        throw VoiceRecoveryJournalError.invalidAudio
                    }
                }
                try manager.removeItem(at: file)
            }
            try syncDirectory(root)
            if current != nil { try manager.removeItem(at: manifest) }
            try syncDirectory(root)
            try manager.removeItem(at: discardMarker)
            try syncDirectory(root)
          }
        }
    }
    func acquire(_ expected: VoiceRecoveryRecord) throws -> VoiceRecoveryReadLease {
        try locked {
            try ensureRoot()
            let fd = try acquireFileLock(shared: true)
            do {
                guard try readRecord(discardMarker) == nil else { throw VoiceRecoveryJournalError.busy }
                guard valid(expected), expected.state == .ready, try read() == expected else { throw VoiceRecoveryJournalError.changed }
                let (file, identity) = try audioIdentity(expected)
                guard expected.byteCount == identity.byteCount, expected.sha256 == identity.sha256 else { throw VoiceRecoveryJournalError.changed }
                return VoiceRecoveryReadLease(url: file, record: expected, lockFD: fd) { [self] in
                    try locked {
                        guard try read() == expected else { throw VoiceRecoveryJournalError.changed }
                        let (_, current) = try audioIdentity(expected)
                        guard current == identity else { throw VoiceRecoveryJournalError.changed }
                    }
                }
            } catch {
                _ = flock(fd, LOCK_UN); _ = closeVoiceDescriptor(fd); throw error
            }
        }
    }

    /// Bind the destination durably before exposing the only allowed file path.
    func reserve(id: String, owner: String, destination: String, locale: String,
                 kind: VoiceRecoveryRecord.Kind) throws -> (VoiceRecoveryRecord, URL) {
        try locked {
          try withFileLock(shared: false) {
            guard try read() == nil else { throw VoiceRecoveryJournalError.occupied }
            // An unbound orphan may be the only surviving copy after disk
            // corruption. Refuse a new reservation and never remove it.
            guard try manager.contentsOfDirectory(atPath: root.path).filter({ $0 != ".journal.lock" }).isEmpty else { throw VoiceRecoveryJournalError.occupied }
            let record = VoiceRecoveryRecord(id: id, owner: owner, destination: destination, locale: locale,
                kind: kind, createdAt: Int64(Date().timeIntervalSince1970), state: .capturing, byteCount: nil, sha256: nil)
            guard valid(record) else { throw VoiceRecoveryJournalError.invalid }
            let file = audio(record)
            // Never replace an orphaned file, even when metadata was damaged or lost.
            guard !(try exists(file)) else { throw VoiceRecoveryJournalError.occupied }
            try write(record)
            return (record, file)
          }
        }
    }

    /// The caller is responsible for closing and draining its audio writer.
    func publish(_ expected: VoiceRecoveryRecord) throws -> VoiceRecoveryRecord {
        try locked {
          try withFileLock(shared: false) {
            guard try readRecord(discardMarker) == nil else { throw VoiceRecoveryJournalError.busy }
            guard valid(expected), expected.state == .capturing else { throw VoiceRecoveryJournalError.invalid }
            guard try read() == expected else { throw VoiceRecoveryJournalError.changed }
            let (file, identity) = try audioIdentity(expected)
            #if os(iOS)
            try manager.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: file.path)
            #endif
            // A ready recording is read-only until its explicit removal.
            try manager.setAttributes([.posixPermissions: 0o400], ofItemAtPath: file.path)
            let ready = VoiceRecoveryRecord(id: expected.id, owner: expected.owner, destination: expected.destination,
                locale: expected.locale, kind: expected.kind, createdAt: expected.createdAt, state: .ready,
                byteCount: identity.byteCount, sha256: identity.sha256)
            try write(ready)
            return ready
          }
        }
    }

    /// Explicit cancellation or future verified draft acknowledgement only.
    /// Deleting bytes first avoids a surviving audio file without its binding.
    func remove(_ expected: VoiceRecoveryRecord) throws {
        try locked {
          try withFileLock(shared: false) {
            guard try readRecord(discardMarker) == nil else { throw VoiceRecoveryJournalError.busy }
            guard valid(expected), try read() == expected else { throw VoiceRecoveryJournalError.changed }
            let file = audio(expected)
            if try exists(file) { try manager.removeItem(at: file) }
            try manager.removeItem(at: manifest)
          }
        }
    }

    /// Idempotent removal only for a fully identified ready capture. A
    /// missing manifest is acceptable only if its audio is also absent.
    func releaseExact(_ expected: VoiceRecoveryRecord) throws {
        try locked {
          try withFileLock(shared: false) {
            guard try readRecord(discardMarker) == nil else { throw VoiceRecoveryJournalError.busy }
            guard valid(expected), expected.state == .ready else { throw VoiceRecoveryJournalError.invalid }
            let existing = try read()
            if existing == nil {
                guard !(try exists(audio(expected))) else { throw VoiceRecoveryJournalError.changed }
                // A previous unlink may have succeeded before its callback or
                // directory synchronization failed. Confirm it on retry.
                try syncDirectory(root)
                return
            }
            if existing != expected {
                // A newer capture can occupy the journal after the old audio
                // was released. Never touch it when retrying the old receipt.
                guard !(try exists(audio(expected))) else { throw VoiceRecoveryJournalError.changed }
                try syncDirectory(root)
                return
            }
            let file = audio(expected)
            if try exists(file) {
                let (_, identity) = try audioIdentity(expected)
                guard identity.byteCount == expected.byteCount, identity.sha256 == expected.sha256 else { throw VoiceRecoveryJournalError.changed }
                try manager.removeItem(at: file)
            }
            // Do not remove the binding until the audio unlink is durable.
            // Retry even if a previous attempt already removed the file.
            try syncDirectory(root)
            try manager.removeItem(at: manifest)
            try syncDirectory(root)
          }
        }
    }

    /// Confirm the exact audio is absent while excluding any live journal
    /// reader or writer. The action must not attempt to lock this journal.
    func withReleased<T>(_ expected: VoiceRecoveryRecord, _ action: () throws -> T) throws -> T {
        try locked {
          try withFileLock(shared: false) {
            guard valid(expected), expected.state == .ready else { throw VoiceRecoveryJournalError.invalid }
            guard try readRecord(discardMarker) == nil else { throw VoiceRecoveryJournalError.busy }
            let current = try read()
            guard current?.id.lowercased() != expected.id.lowercased(), !(try exists(audio(expected))) else { throw VoiceRecoveryJournalError.changed }
            try syncDirectory(root)
            return try action()
          }
        }
    }
}
