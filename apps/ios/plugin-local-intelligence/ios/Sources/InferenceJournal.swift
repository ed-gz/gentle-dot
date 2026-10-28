import Foundation

struct InferenceRecord: Codable, Equatable {
    let id: String
    let revision: String
    let startedAt: Double
    var status: String
    let text: String
}

enum InferenceJournalError: Error, LocalizedError {
    case invalid, full, terminal, stale, corrupt
    var errorDescription: String? {
        switch self {
        case .invalid: return "La identidad o respuesta local no es válida."
        case .full: return "Recupera las respuestas guardadas antes de iniciar otra."
        case .terminal: return "Esta solicitud ya terminó. No se volvió a ejecutar."
        case .stale: return "La respuesta cambió; vuelve a recuperar su versión actual."
        case .corrupt: return "No pude verificar las respuestas nativas guardadas. Se conservaron sin sobrescribir."
        }
    }
}

/// One owner on the plugin's main queue. No prompts, tool arguments, credentials
/// or approvals are stored. A pending record is never permission to replay work.
final class InferenceJournal {
    private struct Envelope: Codable { let version: Int; let records: [InferenceRecord] }
    private let root: URL
    private let limit: Int
    private let maxBytes = 2 * 1024 * 1024
    private var file: URL { root.appendingPathComponent("inferences.json") }

    init(root: URL? = nil, limit: Int = 100) {
        self.root = root ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("CapriInferenceJournal", isDirectory: true)
        self.limit = limit
    }
    static func validID(_ id: String) -> Bool {
        UUID(uuidString: id)?.uuidString.lowercased() == id
    }
    private func valid(_ record: InferenceRecord) -> Bool {
        Self.validID(record.id) && Self.validID(record.revision)
            && record.startedAt.isFinite && record.startedAt >= 0 && record.startedAt <= 8_640_000_000_000_000
            && ["pending", "answer", "interrupted", "cancelled"].contains(record.status)
            && record.text.unicodeScalars.count <= 2_400
            && (record.status != "answer" || !record.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }
    private func read() throws -> [InferenceRecord] {
        guard FileManager.default.fileExists(atPath: file.path) else { return [] }
        let attributes = try FileManager.default.attributesOfItem(atPath: file.path)
        guard attributes[.type] as? FileAttributeType == .typeRegular,
              let size = attributes[.size] as? NSNumber, size.intValue <= maxBytes else { throw InferenceJournalError.corrupt }
        let data = try Data(contentsOf: file)
        guard data.count <= maxBytes, let envelope = try? JSONDecoder().decode(Envelope.self, from: data),
              envelope.version == 1, envelope.records.count <= limit,
              envelope.records.allSatisfy(valid), Set(envelope.records.map(\.id)).count == envelope.records.count else {
            throw InferenceJournalError.corrupt
        }
        return envelope.records
    }
    private func write(_ records: [InferenceRecord]) throws {
        let data = try JSONEncoder().encode(Envelope(version: 1, records: records))
        guard data.count <= maxBytes, records.count <= limit else { throw InferenceJournalError.full }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true,
                                               attributes: [.posixPermissions: 0o700])
        var directory = root
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        try directory.setResourceValues(values)
        #if os(iOS)
        // Finish the foreground-requested inference after locking. The file is
        // inaccessible before first unlock after a restart; not an App Group.
        try data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        #else
        try data.write(to: file, options: .atomic)
        #endif
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    }
    @discardableResult
    func begin(_ id: String, now: Double = Date().timeIntervalSince1970 * 1000) throws -> InferenceRecord {
        guard Self.validID(id), now.isFinite, now >= 0, now <= 8_640_000_000_000_000 else { throw InferenceJournalError.invalid }
        var records = try read()
        let index = records.firstIndex { $0.id == id }
        if let index = index, records[index].status != "pending" { throw InferenceJournalError.terminal }
        if index == nil && records.count >= limit { throw InferenceJournalError.full }
        let record = InferenceRecord(id: id, revision: UUID().uuidString.lowercased(),
            startedAt: index.map { records[$0].startedAt } ?? now, status: "pending", text: "")
        if let index = index { records[index] = record } else { records.append(record) }
        try write(records); return record
    }
    @discardableResult
    func finish(_ id: String, status: String, text: String) throws -> InferenceRecord {
        guard ["answer", "interrupted", "cancelled"].contains(status) else { throw InferenceJournalError.invalid }
        var records = try read()
        guard let index = records.firstIndex(where: { $0.id == id }) else { throw InferenceJournalError.stale }
        let prior = records[index]
        // Stop may win after inference finishes but before the WebView commits it.
        guard prior.status == "pending" || (status == "cancelled" && prior.status != "cancelled") else { throw InferenceJournalError.terminal }
        let record = InferenceRecord(id: id, revision: UUID().uuidString.lowercased(), startedAt: prior.startedAt,
                                     status: status, text: text)
        guard valid(record) else { throw InferenceJournalError.invalid }
        records[index] = record; try write(records); return record
    }
    func list(activeID: String?) throws -> [InferenceRecord] {
        try read().map { saved in
            var record = saved
            if record.status == "pending" && record.id != activeID {
                record.status = "interrupted"
            }
            return record
        }
    }
    func acknowledge(_ id: String, revision: String, activeID: String?) throws {
        guard Self.validID(id), Self.validID(revision), id != activeID else { throw InferenceJournalError.stale }
        var records = try read()
        guard let index = records.firstIndex(where: { $0.id == id }) else { return }
        guard records[index].revision == revision else { throw InferenceJournalError.stale }
        records.remove(at: index); try write(records)
    }
}
