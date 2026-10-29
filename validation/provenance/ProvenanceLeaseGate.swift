import Foundation
import CryptoKit
import Darwin

// Isolated prototype only. It is not registered with the Tauri plugin and has
// not been compiled or run on Apple platforms in this environment.
enum ProvenanceLeaseError: Error { case invalid, full, conflict, corrupt, expired, terminal, busy, uncertain }

struct ProvenanceLeaseRecord: Codable, Equatable {
    let id: String
    let leaseId: String
    let revision: UInt64
    let inputSHA256: String
    let model: String
    let bootId: String
    let deadlineUptime: Double
    var state: String // prepared, dispatching, accepted, rejected, expired or closed_uncertain
}

enum ProvenanceLeaseStart { case acceptedNew, acceptedEarlier, rejected, expired }

/// All calls must occur on one owner queue. A persisted acceptance is only an
/// acceptance of the exact model input, never a tool approval or final answer.
final class ProvenanceLeaseGate {
    private struct Envelope: Codable { let version: Int; let records: [ProvenanceLeaseRecord] }
    private static let processBootId = UUID().uuidString.lowercased()
    private let root: URL
    private let lockDescriptor: Int32
    private let queueLock = NSRecursiveLock()
    private var scheduling = false
    private let bootId: String
    private let now: () -> Double
    private let limit = 10_000
    private let maxBytes = 8 * 1024 * 1024
    private let lifetime: Double = 5
    private var file: URL { root.appendingPathComponent("leases.json") }
    private var sentinel: URL { root.appendingPathComponent("ledger-present") }

    init(root: URL, bootId: String? = nil, now: @escaping () -> Double = { ProcessInfo.processInfo.systemUptime }) throws {
        let parent = root.deletingLastPathComponent()
        let attributes = try FileManager.default.attributesOfItem(atPath: parent.path)
        guard attributes[.type] as? FileAttributeType == .typeDirectory else { throw ProvenanceLeaseError.corrupt }
        do { try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700]) }
        catch let error as NSError {
            guard (error.domain == NSCocoaErrorDomain && error.code == NSFileWriteFileExistsError) || (error.domain == NSPOSIXErrorDomain && error.code == Int(EEXIST)) else { throw error }
        }
        let rootAttributes = try FileManager.default.attributesOfItem(atPath: root.path)
        guard rootAttributes[.type] as? FileAttributeType == .typeDirectory else { throw ProvenanceLeaseError.corrupt }
        try Self.syncDirectory(parent)
        let path = root.appendingPathComponent("leases.lock").path
        let descriptor = path.withCString { Darwin.open($0, O_CREAT | O_RDWR | O_CLOEXEC | O_NOFOLLOW, mode_t(0o600)) }
        guard descriptor >= 0 else { throw ProvenanceLeaseError.uncertain }
        guard Darwin.flock(descriptor, LOCK_EX | LOCK_NB) == 0 else { Darwin.close(descriptor); throw ProvenanceLeaseError.busy }
        self.root = root; self.lockDescriptor = descriptor; self.bootId = bootId ?? Self.processBootId; self.now = now
    }
    deinit { Darwin.flock(lockDescriptor, LOCK_UN); Darwin.close(lockDescriptor) }
    private static func syncDirectory(_ url: URL) throws {
        let descriptor = url.path.withCString { Darwin.open($0, O_RDONLY | O_CLOEXEC) }
        guard descriptor >= 0 else { throw ProvenanceLeaseError.uncertain }
        defer { Darwin.close(descriptor) }
        guard Darwin.fsync(descriptor) == 0 else { throw ProvenanceLeaseError.uncertain }
    }
    private func validateSentinel() throws {
        let expected = Data("capri-provenance-ledger/v1".utf8)
        let attributes = try FileManager.default.attributesOfItem(atPath: sentinel.path)
        guard attributes[.type] as? FileAttributeType == .typeRegular,
              let size = attributes[.size] as? NSNumber, size.intValue == expected.count,
              try Data(contentsOf: sentinel) == expected else { throw ProvenanceLeaseError.corrupt }
    }
    private func confirmSentinel() throws {
        let expected = Data("capri-provenance-ledger/v1".utf8)
        do { try validateSentinel() }
        catch let error as NSError {
            if (error.domain == NSCocoaErrorDomain && [NSFileNoSuchFileError, NSFileReadNoSuchFileError].contains(error.code)) || (error.domain == NSPOSIXErrorDomain && error.code == Int(ENOENT)) {
                #if os(iOS)
                try expected.write(to: sentinel, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
                #else
                try expected.write(to: sentinel, options: .atomic)
                #endif
                try validateSentinel()
            } else { throw error }
        }
        // Retry the flush even for an existing sentinel: a previous creation may
        // have returned an error after the rename but before its sync.
        let descriptor = sentinel.path.withCString { Darwin.open($0, O_RDWR | O_CLOEXEC | O_NOFOLLOW) }
        guard descriptor >= 0 else { throw ProvenanceLeaseError.uncertain }
        defer { Darwin.close(descriptor) }
        guard Darwin.fcntl(descriptor, F_FULLFSYNC) == 0 else { throw ProvenanceLeaseError.uncertain }
        try Self.syncDirectory(root); try Self.syncDirectory(root.deletingLastPathComponent())
    }
    private func isID(_ value: String) -> Bool { UUID(uuidString: value)?.uuidString.lowercased() == value }
    private func isHash(_ value: String) -> Bool { value.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil }
    private func isModel(_ value: String) -> Bool { value.range(of: "^[a-zA-Z0-9._:-]{1,80}$", options: .regularExpression) != nil }
    private func digest(_ input: String) -> String {
        SHA256.hash(data: Data(input.utf8)).map { String(format: "%02x", $0) }.joined()
    }
    private func valid(_ record: ProvenanceLeaseRecord) -> Bool {
        isID(record.id) && isID(record.leaseId) && isID(record.bootId) && isHash(record.inputSHA256) && isModel(record.model)
            && record.revision <= 9_007_199_254_740_991 && record.deadlineUptime.isFinite && record.deadlineUptime >= 0
            && ["prepared", "dispatching", "accepted", "rejected", "expired", "closed_uncertain"].contains(record.state)
    }
    private func read() throws -> [ProvenanceLeaseRecord] {
        let attributes: [FileAttributeKey: Any]
        do { attributes = try FileManager.default.attributesOfItem(atPath: file.path) }
        catch let error as NSError {
            if (error.domain == NSCocoaErrorDomain && [NSFileNoSuchFileError, NSFileReadNoSuchFileError].contains(error.code)) || (error.domain == NSPOSIXErrorDomain && error.code == Int(ENOENT)) {
                do { _ = try FileManager.default.attributesOfItem(atPath: sentinel.path); throw ProvenanceLeaseError.corrupt }
                catch let markerError as NSError {
                    if (markerError.domain == NSCocoaErrorDomain && [NSFileNoSuchFileError, NSFileReadNoSuchFileError].contains(markerError.code)) || (markerError.domain == NSPOSIXErrorDomain && markerError.code == Int(ENOENT)) { return [] }
                    throw markerError
                }
            }
            throw error
        }
        guard attributes[.type] as? FileAttributeType == .typeRegular,
              let size = attributes[.size] as? NSNumber, size.intValue <= maxBytes else { throw ProvenanceLeaseError.corrupt }
        // A ledger without its synced sentinel may be an interrupted first
        // write or damaged state. Preserve it for explicit recovery.
        try validateSentinel()
        let data = try Data(contentsOf: file)
        guard data.count <= maxBytes,
              let rootObject = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(rootObject.keys) == Set(["version", "records"]),
              let raw = rootObject["records"] as? [[String: Any]],
              raw.allSatisfy({ Set($0.keys) == Set(["id", "leaseId", "revision", "inputSHA256", "model", "bootId", "deadlineUptime", "state"]) }),
              let envelope = try? JSONDecoder().decode(Envelope.self, from: data), envelope.version == 1,
              envelope.records.count <= limit, envelope.records.allSatisfy(valid),
              Set(envelope.records.map(\.id)).count == envelope.records.count,
              envelope.records.filter({ $0.state == "prepared" || $0.state == "dispatching" }).count <= 1 else { throw ProvenanceLeaseError.corrupt }
        return envelope.records
    }
    private func write(_ records: [ProvenanceLeaseRecord]) throws {
        guard records.count <= limit, records.allSatisfy(valid) else { throw ProvenanceLeaseError.full }
        let data = try JSONEncoder().encode(Envelope(version: 1, records: records))
        guard data.count <= maxBytes else { throw ProvenanceLeaseError.full }
        var directory = root; var values = URLResourceValues(); values.isExcludedFromBackup = true; try directory.setResourceValues(values)
        #if os(iOS)
        try data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        #else
        try data.write(to: file, options: .atomic)
        #endif
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        let descriptor = file.path.withCString { Darwin.open($0, O_RDWR | O_CLOEXEC | O_NOFOLLOW) }
        guard descriptor >= 0 else { throw ProvenanceLeaseError.uncertain }
        defer { Darwin.close(descriptor) }
        guard Darwin.fcntl(descriptor, F_FULLFSYNC) == 0 else { throw ProvenanceLeaseError.uncertain }
        let directoryDescriptor = root.path.withCString { Darwin.open($0, O_RDONLY | O_CLOEXEC) }
        guard directoryDescriptor >= 0 else { throw ProvenanceLeaseError.uncertain }
        defer { Darwin.close(directoryDescriptor) }
        guard Darwin.fsync(directoryDescriptor) == 0 else { throw ProvenanceLeaseError.uncertain }
        try Self.syncDirectory(root.deletingLastPathComponent())
        try confirmSentinel()
    }
    private func recover(_ records: inout [ProvenanceLeaseRecord]) throws {
        let current = now()
        guard current.isFinite, current >= 0 else { throw ProvenanceLeaseError.invalid }
        var changed = false
        for index in records.indices {
            if records[index].state == "prepared" && (records[index].bootId != bootId || current >= records[index].deadlineUptime) {
                records[index].state = "expired"; changed = true
            } else if records[index].state == "dispatching" && records[index].bootId != bootId {
                records[index].state = "closed_uncertain"; changed = true
            }
        }
        if changed { try write(records) }
    }
    func prepare(id: String, revision: UInt64, model: String, input: String) throws -> ProvenanceLeaseRecord {
        queueLock.lock(); defer { queueLock.unlock() }
        guard !scheduling else { throw ProvenanceLeaseError.busy }
        guard isID(id), isID(bootId), isModel(model), revision <= 9_007_199_254_740_991,
              !input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, input.unicodeScalars.count <= 8_000 else { throw ProvenanceLeaseError.invalid }
        var records = try read(); try recover(&records)
        guard records.count < limit else { throw ProvenanceLeaseError.full }
        guard !records.contains(where: { $0.id == id || $0.state == "prepared" || $0.state == "dispatching" }) else { throw ProvenanceLeaseError.conflict }
        let current = now(); guard current.isFinite, current >= 0, (current + lifetime).isFinite else { throw ProvenanceLeaseError.invalid }
        let record = ProvenanceLeaseRecord(id: id, leaseId: UUID().uuidString.lowercased(), revision: revision, inputSHA256: digest(input), model: model, bootId: bootId, deadlineUptime: current + lifetime, state: "prepared")
        records.append(record); try write(records); return record
    }
    func start(id: String, leaseId: String, revision: UInt64, model: String, input: String, schedule: () throws -> Void) throws -> ProvenanceLeaseStart {
        queueLock.lock(); defer { queueLock.unlock() }
        guard !scheduling else { throw ProvenanceLeaseError.busy }
        guard !input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, input.unicodeScalars.count <= 8_000 else { throw ProvenanceLeaseError.invalid }
        var records = try read(); try recover(&records)
        guard let index = records.firstIndex(where: { $0.id == id }) else { throw ProvenanceLeaseError.invalid }
        let record = records[index]
        guard record.leaseId == leaseId, record.revision == revision, record.model == model, record.inputSHA256 == digest(input) else { throw ProvenanceLeaseError.conflict }
        if record.state == "accepted" { return .acceptedEarlier }
        if record.state == "rejected" { return .rejected }
        if record.state == "expired" { return .expired }
        if record.state == "dispatching" || record.state == "closed_uncertain" { throw ProvenanceLeaseError.uncertain }
        let current = now(); guard current.isFinite, current >= 0 else { throw ProvenanceLeaseError.invalid }
        if record.bootId != bootId || current >= record.deadlineUptime { records[index].state = "expired"; try write(records); return .expired }
        records[index].state = "dispatching"; try write(records)
        // The caller must schedule the actual task synchronously without an
        // await, while this gate holds its process-wide owner lock. If schedule
        // throws after doing work, dispatching remains uncertain and cannot be retried.
        scheduling = true; defer { scheduling = false }
        try schedule()
        records[index].state = "accepted"; try write(records)
        return .acceptedNew
    }
    func status(id: String) throws -> ProvenanceLeaseRecord {
        queueLock.lock(); defer { queueLock.unlock() }
        guard !scheduling else { throw ProvenanceLeaseError.busy }
        var records = try read(); try recover(&records)
        guard let index = records.firstIndex(where: { $0.id == id }) else { throw ProvenanceLeaseError.invalid }
        let current = now(); guard current.isFinite, current >= 0 else { throw ProvenanceLeaseError.invalid }
        if records[index].state == "prepared" && current >= records[index].deadlineUptime { records[index].state = "expired"; try write(records) }
        return records[index]
    }
    func cancelPrepared(id: String, leaseId: String) throws -> ProvenanceLeaseRecord {
        queueLock.lock(); defer { queueLock.unlock() }
        guard !scheduling else { throw ProvenanceLeaseError.busy }
        var records = try read(); try recover(&records)
        guard let index = records.firstIndex(where: { $0.id == id }), records[index].leaseId == leaseId else { throw ProvenanceLeaseError.invalid }
        if records[index].state == "prepared" { records[index].state = "rejected"; try write(records) }
        // An accepted request is not claimed to have stopped by cancelling a lease.
        return records[index]
    }
}
