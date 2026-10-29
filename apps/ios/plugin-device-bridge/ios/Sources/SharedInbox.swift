import Foundation
import CryptoKit
import Darwin

enum ShareFailure: Error, LocalizedError {
    case unavailable, invalid, limit, integrity, metadataLimit, nameLimit
    var errorDescription: String? {
        switch self {
        case .unavailable: return "El grupo compartido no está disponible con esta firma. Puedes importar desde Archivos en Capri."
        case .invalid: return "El material compartido no es válido o ya no está disponible."
        case .limit: return "Límite: 10 archivos, audio hasta 128 MiB, otros archivos hasta 25 MiB, 256 MiB por trabajo y 100 importaciones pendientes."
        case .integrity: return "No se pudo verificar el archivo. El original compartido se conserva."
        case .metadataLimit: return "El título y las notas ocupan demasiado espacio. Acórtalos y vuelve a intentarlo; el archivo original se conserva."
        case .nameLimit: return "El nombre del archivo es demasiado largo para Capri. Renómbralo y vuelve a intentarlo; el original se conserva."
        }
    }
}
struct SharedFile: Codable {
    let id: String
    let name: String
    let mime: String
    let size: Int
    let sha256: String
}
struct SharedManifest: Codable {
    let schemaVersion: Int
    let id: String
    let createdAt: Int64
    let title: String
    let notes: String
    let files: [SharedFile]
}
struct SharedListing {
    let items: [SharedManifest]
    let invalidIDs: [String]
    let pendingCopies: [SharedPendingCopy]
    let omittedPending: Int
}
struct SharedPendingCopy: Encodable {
    let id: String
    let bytes: Int64?
    let files: [SharedPendingFile]
}
struct SharedPendingFile: Encodable { let id: String; let bytes: Int }

// Compiled into both app and extension. Only an atomically published directory is visible
// to the app. The acknowledgement removes it after the app's IndexedDB commit.
enum SharedInbox {
    static let maxFile = 25 * 1024 * 1024
    static let maxAudio = 128 * 1024 * 1024
    static let maxTotal = 256 * 1024 * 1024
    static func fileLimit(_ mime: String) -> Int { mime.hasPrefix("audio/") ? maxAudio : maxFile }
    static func validID(_ value: String) -> Bool {
        UUID(uuidString: value)?.uuidString.lowercased() == value
    }
    static func root() throws -> URL {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "CapriAppGroup") as? String else { throw ShareFailure.unavailable }
        let container: URL
        do { container = try AppGroupResolver.container(configured: group) }
        catch { throw ShareFailure.unavailable }
        let root = container.appendingPathComponent("CapriSharedInbox", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.complete])
        return root
    }
    private static func locked<T>(_ root: URL, _ action: () throws -> T) throws -> T {
        let fd = open(root.appendingPathComponent(".lock").path, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
        guard fd >= 0 else { throw ShareFailure.unavailable }
        defer { close(fd) }
        guard flock(fd, LOCK_EX) == 0 else { throw ShareFailure.unavailable }
        defer { flock(fd, LOCK_UN) }
        return try action()
    }
    static func readManifest(_ directory: URL) throws -> SharedManifest {
        let url = directory.appendingPathComponent("manifest.json")
        let values = try url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey, .isSymbolicLinkKey])
        guard values.isRegularFile == true, values.isSymbolicLink != true, (values.fileSize ?? 0) <= 64 * 1024 else { throw ShareFailure.invalid }
        let value = try JSONDecoder().decode(SharedManifest.self, from: Data(contentsOf: url))
        guard value.schemaVersion == 1, validID(value.id), directory.lastPathComponent == value.id,
              value.createdAt > 0, !value.title.isEmpty, value.title.count <= 120, value.notes.count <= 8000,
              value.files.count <= 10, !value.files.isEmpty,
              Set(value.files.map { $0.id }).count == value.files.count else { throw ShareFailure.invalid }
        for file in value.files {
            guard validID(file.id), !file.name.isEmpty, file.name.count <= 255, file.mime.count <= 128,
                  file.size > 0, file.size <= fileLimit(file.mime),
                  file.sha256.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { throw ShareFailure.invalid }
        }
        guard value.files.reduce(0, { $0 + $1.size }) <= maxTotal else { throw ShareFailure.invalid }
        return value
    }
    static func listReport(root suppliedRoot: URL? = nil) throws -> SharedListing {
        let root = try suppliedRoot ?? root()
        return try locked(root) {
            let directories = try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: [.isDirectoryKey])
            var items: [SharedManifest] = []
            var invalidIDs: [String] = []
            for directory in directories where validID(directory.lastPathComponent) {
                do { items.append(try readManifest(directory)) }
                catch { invalidIDs.append(directory.lastPathComponent) }
            }
            // Staging may still be in progress, or may be the only remaining
            // copy after a provider or extension was interrupted. Never infer
            // that it is disposable, and never expose paths or file names.
            let pending = directories.filter { entry in
                let name = entry.lastPathComponent
                return name.hasPrefix(".pending-") && validID(String(name.dropFirst(".pending-".count)))
            }.sorted { $0.lastPathComponent < $1.lastPathComponent }
            let copies = pending.prefix(100).map { entry -> SharedPendingCopy in
                let id = String(entry.lastPathComponent.dropFirst(".pending-".count))
                do {
                    var total: Int64 = 0
                    var files: [SharedPendingFile] = []
                    for file in try FileManager.default.contentsOfDirectory(at: entry, includingPropertiesForKeys: [.fileSizeKey, .isRegularFileKey, .isSymbolicLinkKey]) {
                        let values = try file.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey, .isSymbolicLinkKey])
                        guard values.isRegularFile == true, values.isSymbolicLink != true, let size = values.fileSize, size >= 0 else { return SharedPendingCopy(id: id, bytes: nil, files: []) }
                        let (next, overflow) = total.addingReportingOverflow(Int64(size))
                        guard !overflow else { return SharedPendingCopy(id: id, bytes: nil, files: []) }
                        total = next
                        let name = file.lastPathComponent
                        if name.hasSuffix(".blob"), validID(String(name.dropLast(5))), size > 0, size <= maxAudio {
                            files.append(SharedPendingFile(id: String(name.dropLast(5)), bytes: size))
                        }
                    }
                    return SharedPendingCopy(id: id, bytes: total, files: Array(files.sorted { $0.id < $1.id }.prefix(10)))
                } catch { return SharedPendingCopy(id: id, bytes: nil, files: []) }
            }
            return SharedListing(items: items.sorted { $0.createdAt < $1.createdAt }, invalidIDs: invalidIDs.sorted(), pendingCopies: copies, omittedPending: max(0, pending.count - copies.count))
        }
    }
    // Strict API retained for callers that cannot surface partial failures.
    static func list(root suppliedRoot: URL? = nil) throws -> [SharedManifest] {
        let result = try listReport(root: suppliedRoot)
        guard result.invalidIDs.isEmpty else { throw ShareFailure.invalid }
        return result.items
    }
    static func read(_ id: String, _ fileID: String, _ offset: Int, _ length: Int, root suppliedRoot: URL? = nil) throws -> Data {
        guard validID(id), validID(fileID), offset >= 0, length > 0, length <= 256 * 1024 else { throw ShareFailure.invalid }
        let root = try suppliedRoot ?? root()
        return try locked(root) {
            let directory = root.appendingPathComponent(id, isDirectory: true)
            let manifest = try readManifest(directory)
            guard let file = manifest.files.first(where: { $0.id == fileID }), offset < file.size else { throw ShareFailure.invalid }
            let url = directory.appendingPathComponent("\(fileID).blob")
            let values = try url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey, .isSymbolicLinkKey])
            guard values.fileSize == file.size, values.isRegularFile == true, values.isSymbolicLink != true else { throw ShareFailure.integrity }
            let handle = try FileHandle(forReadingFrom: url)
            defer { try? handle.close() }
            if offset == 0 {
                var digest = SHA256()
                while let data = try handle.read(upToCount: 256 * 1024), !data.isEmpty { digest.update(data: data) }
                let hex = digest.finalize().map { String(format: "%02x", $0) }.joined()
                guard hex == file.sha256 else { throw ShareFailure.integrity }
            }
            try handle.seek(toOffset: UInt64(offset))
            let expected = min(length, file.size - offset)
            guard let data = try handle.read(upToCount: expected), data.count == expected else { throw ShareFailure.integrity }
            return data
        }
    }
    /// Read a bounded snapshot of an unconfirmed partial copy, never treating it
    /// as a complete import. A changing file must be selected and reviewed again.
    static func readPending(_ id: String, _ fileID: String, _ expectedSize: Int, _ offset: Int, _ length: Int, root suppliedRoot: URL? = nil) throws -> Data {
        guard validID(id), validID(fileID), expectedSize > 0, expectedSize <= maxAudio,
              offset >= 0, length > 0, length <= 256 * 1024, offset <= expectedSize, length <= expectedSize - offset else { throw ShareFailure.invalid }
        let root = try suppliedRoot ?? root()
        return try locked(root) {
            let directory = root.appendingPathComponent(".pending-\(id)", isDirectory: true)
            let values = try directory.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
            guard values.isDirectory == true, values.isSymbolicLink != true else { throw ShareFailure.invalid }
            let fd = open(directory.appendingPathComponent("\(fileID).blob").path, O_RDONLY | O_NOFOLLOW)
            guard fd >= 0 else { throw ShareFailure.invalid }
            let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
            defer { try? handle.close() }
            var info = stat()
            guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG, info.st_size == Int64(expectedSize) else { throw ShareFailure.integrity }
            try handle.seek(toOffset: UInt64(offset))
            guard let bytes = try handle.read(upToCount: length), bytes.count == length else { throw ShareFailure.integrity }
            return bytes
        }
    }
    static func acknowledge(_ id: String, root suppliedRoot: URL? = nil) throws {
        guard validID(id) else { throw ShareFailure.invalid }
        let root = try suppliedRoot ?? root()
        try locked(root) {
            let directory = root.appendingPathComponent(id, isDirectory: true)
            if FileManager.default.fileExists(atPath: directory.path) { try FileManager.default.removeItem(at: directory) }
        }
    }
    static func makeStaging(root suppliedRoot: URL? = nil) throws -> URL {
        let root = try suppliedRoot ?? root()
        return try locked(root) {
            let url = root.appendingPathComponent(".pending-\(UUID().uuidString.lowercased())", isDirectory: true)
            try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false,
                attributes: [.protectionKey: FileProtectionType.complete])
            return url
        }
    }
    static func stageFile(_ source: URL, name: String, mime: String, in staging: URL) throws -> SharedFile {
        let scoped = source.startAccessingSecurityScopedResource()
        defer { if scoped { source.stopAccessingSecurityScopedResource() } }
        let values = try source.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
        let limit = fileLimit(mime)
        guard values.isRegularFile == true, let count = values.fileSize, count > 0, count <= limit else { throw ShareFailure.limit }
        let safeName = name.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) && $0 != "/" && $0 != "\\" }.map(String.init).joined()
        guard safeName.utf16.count <= 255 else { throw ShareFailure.nameLimit }
        let id = UUID().uuidString.lowercased()
        let destination = staging.appendingPathComponent("\(id).blob")
        let input = try FileHandle(forReadingFrom: source)
        defer { try? input.close() }
        guard FileManager.default.createFile(atPath: destination.path, contents: nil,
            attributes: [.protectionKey: FileProtectionType.complete]) else { throw ShareFailure.unavailable }
        let output = try FileHandle(forWritingTo: destination)
        defer { try? output.close() }
        var digest = SHA256(); var bytes = 0
        while let data = try input.read(upToCount: 256 * 1024), !data.isEmpty {
            bytes += data.count
            guard bytes <= limit else { throw ShareFailure.limit }
            digest.update(data: data)
            try output.write(contentsOf: data)
        }
        guard bytes == count else { throw ShareFailure.integrity }
        try output.synchronize()
        return SharedFile(id: id, name: safeName.isEmpty ? "adjunto" : safeName, mime: String(mime.prefix(128)), size: bytes,
            sha256: digest.finalize().map { String(format: "%02x", $0) }.joined())
    }
    static func publish(_ staging: URL, title: String, notes: String, files: [SharedFile], root suppliedRoot: URL? = nil) throws -> SharedManifest {
        guard !files.isEmpty, files.count <= 10, files.reduce(0, { $0 + $1.size }) <= maxTotal,
              !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, title.count <= 120, notes.count <= 8000 else { throw ShareFailure.limit }
        let root = try suppliedRoot ?? root()
        guard staging.deletingLastPathComponent().standardizedFileURL == root.standardizedFileURL,
              staging.lastPathComponent.hasPrefix(".pending-") else { throw ShareFailure.invalid }
        let manifest = SharedManifest(schemaVersion: 1, id: UUID().uuidString.lowercased(),
            createdAt: Int64(Date().timeIntervalSince1970 * 1000), title: title, notes: notes, files: files)
        let data = try JSONEncoder().encode(manifest)
        guard data.count <= 64 * 1024 else { throw ShareFailure.metadataLimit }
        try data.write(to: staging.appendingPathComponent("manifest.json"), options: [.atomic, .completeFileProtection])
        return try locked(root) {
            let count = try FileManager.default.contentsOfDirectory(atPath: root.path).filter(validID).count
            guard count < 100 else { throw ShareFailure.limit }
            try FileManager.default.moveItem(at: staging, to: root.appendingPathComponent(manifest.id, isDirectory: true))
            return manifest
        }
    }
}
