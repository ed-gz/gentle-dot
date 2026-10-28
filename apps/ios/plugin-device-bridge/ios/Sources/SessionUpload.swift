import Foundation
import CryptoKit

struct SessionUploadInput: Decodable {
    let url: String
    let token: String
    let paneId: String
    let sessionId: String
    let uploadId: String?
    let name: String
    let size: Int
    let sha256: String
}
struct SessionUploadChunk: Decodable { let id: String; let offset: Int; let data: String }

/// One immutable file and destination per transfer. A completed upload is only
/// a staged attachment on the host: a separate reviewed prompt consumes its ref.
final class SessionUploadStore {
    static let maximum = 25 * 1024 * 1024
    typealias Sender = (URLRequest, URL, @escaping (Result<HTTPOutput, Error>) -> Void) -> () -> Void
    private final class Transfer {
        let id = UUID().uuidString.lowercased()
        let file: URL
        let input: SessionUploadInput
        let request: URLRequest
        var handle: FileHandle?
        var hash = SHA256()
        var written = 0
        var expires: Date
        var sending = false
        var cancelled = false
        var cancel: (() -> Void)?
        init(_ file: URL, _ input: SessionUploadInput, _ request: URLRequest, _ handle: FileHandle, _ now: Date) {
            self.file = file; self.input = input; self.request = request; self.handle = handle
            expires = now.addingTimeInterval(120)
        }
    }
    private let lock = NSRecursiveLock()
    private let root: URL
    private let now: () -> Date
    private let sender: Sender
    private var initialized = false
    private var suspended = false
    private var transfer: Transfer?
    private var timer: DispatchSourceTimer?

    init(root: URL = FileManager.default.temporaryDirectory.appendingPathComponent("capri-session-uploads", isDirectory: true),
         now: @escaping () -> Date = Date.init,
         sender: @escaping Sender = { request, file, completion in
             let transport = BoundedHTTP.upload(request, file: file, completion: completion)
             return { transport.cancel() }
         }) {
        self.root = root; self.now = now; self.sender = sender
        let timer = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
        timer.schedule(deadline: .now() + 30, repeating: 30)
        timer.setEventHandler { [weak self] in self?.expire() }
        self.timer = timer; timer.resume()
    }
    deinit { timer?.cancel(); transfer?.cancel?(); removeLocked() }

    static func request(_ input: SessionUploadInput) throws -> URLRequest {
        guard let target = URLComponents(string: input.url), target.percentEncodedPath == "/upload", target.query == nil,
              !input.token.isEmpty, input.token.utf8.count <= 4096,
              !input.token.unicodeScalars.contains(where: { CharacterSet.whitespacesAndNewlines.contains($0) }),
              !input.paneId.isEmpty, input.paneId.utf8.count <= 256,
              !input.sessionId.isEmpty, input.sessionId.utf8.count <= 256,
              !input.name.isEmpty, input.name.utf8.count <= 1024,
              !input.name.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
              input.size >= 0, input.size <= maximum,
              input.sha256.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              input.uploadId == nil || input.uploadId!.range(of: "^[A-Za-z0-9_-]{8,64}$", options: .regularExpression) != nil else {
            throw DeviceFailure.invalid("El archivo o el destino de sesión no son válidos.")
        }
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")
        guard let name = input.name.addingPercentEncoding(withAllowedCharacters: allowed) else { throw DeviceFailure.invalid("Nombre de archivo inválido.") }
        var headers = ["Authorization": "Bearer " + input.token, "X-Agent-Pane": input.paneId,
                       "X-Agent-Session": input.sessionId, "X-File-Name": name, "Content-Type": "application/octet-stream"]
        if let uploadId = input.uploadId { headers["X-Upload-Id"] = uploadId }
        return try BoundedHTTP.validated(HTTPInput(url: input.url, method: "POST", headers: headers, body: nil))
    }
    private func removeLocked() {
        guard let current = transfer else { return }
        current.cancel = nil
        try? current.handle?.close(); current.handle = nil
        try? FileManager.default.removeItem(at: current.file)
        transfer = nil
    }
    func begin(_ input: SessionUploadInput) throws -> String {
        let request = try Self.request(input)
        lock.lock(); defer { lock.unlock() }
        guard !suspended else { throw DeviceFailure.unavailable("Vuelve a Capri para adjuntar el archivo.") }
        if let current = transfer, !current.sending, current.expires <= now() { removeLocked() }
        guard transfer == nil else { throw DeviceFailure.unavailable("Ya hay un archivo transfiriéndose.") }
        let manager = FileManager.default
        var directoryAttributes: [FileAttributeKey: Any] = [.posixPermissions: 0o700]
        var fileAttributes: [FileAttributeKey: Any] = [.posixPermissions: 0o600]
        #if os(iOS)
        directoryAttributes[.protectionKey] = FileProtectionType.complete
        fileAttributes[.protectionKey] = FileProtectionType.complete
        #endif
        if !initialized {
            // Purge only this non-authoritative staging namespace after a crash.
            if manager.fileExists(atPath: root.path) { try manager.removeItem(at: root) }
            try manager.createDirectory(at: root, withIntermediateDirectories: true, attributes: directoryAttributes)
            var location = root, values = URLResourceValues(); values.isExcludedFromBackup = true
            try location.setResourceValues(values); initialized = true
        }
        let file = root.appendingPathComponent(UUID().uuidString + ".upload")
        guard manager.createFile(atPath: file.path, contents: nil, attributes: fileAttributes) else { throw DeviceFailure.unavailable("No se pudo preparar el adjunto.") }
        do {
            let current = Transfer(file, input, request, try FileHandle(forWritingTo: file), now())
            transfer = current; return current.id
        } catch { try? manager.removeItem(at: file); throw error }
    }
    func write(_ input: SessionUploadChunk) throws -> Int {
        guard input.data.utf8.count <= 349_528, let bytes = Data(base64Encoded: input.data),
              !bytes.isEmpty, bytes.count <= 256 * 1024 else { throw DeviceFailure.invalid("Bloque de adjunto inválido.") }
        lock.lock(); defer { lock.unlock() }
        guard let current = transfer, current.id == input.id, !current.sending, current.expires > now(),
              let handle = current.handle else { throw DeviceFailure.invalid("La transferencia ya no está activa.") }
        do {
            guard input.offset == current.written, bytes.count <= current.input.size - current.written else { throw DeviceFailure.invalid("El adjunto llegó fuera de orden o excede su tamaño.") }
            try handle.write(contentsOf: bytes); current.hash.update(data: bytes); current.written += bytes.count
            current.expires = now().addingTimeInterval(120); return current.written
        } catch { removeLocked(); throw error }
    }
    func send(_ id: String, completion: @escaping (Result<HTTPOutput, Error>) -> Void) throws {
        lock.lock(); defer { lock.unlock() }
        guard !suspended, let current = transfer, current.id == id, !current.sending,
              current.expires > now(), let handle = current.handle else { throw DeviceFailure.invalid("La transferencia ya no está activa.") }
        do {
            let hash = current.hash.finalize().map { String(format: "%02x", $0) }.joined()
            guard current.written == current.input.size, hash == current.input.sha256 else { throw DeviceFailure.invalid("El adjunto no coincide con los bytes revisados.") }
            try handle.synchronize(); try handle.close(); current.handle = nil
            let attributes = try FileManager.default.attributesOfItem(atPath: current.file.path)
            guard (attributes[.size] as? NSNumber)?.intValue == current.input.size else { throw DeviceFailure.invalid("El archivo temporal está incompleto.") }
            current.sending = true; current.expires = now().addingTimeInterval(125)
            current.cancel = sender(current.request, current.file) { [weak self] result in
                guard let self = self else { completion(.failure(DeviceFailure.cancelled)); return }
                self.lock.lock()
                guard self.transfer?.id == id else { self.lock.unlock(); return }
                let cancelled = current.cancelled
                self.removeLocked(); self.lock.unlock()
                completion(cancelled ? .failure(DeviceFailure.cancelled) : result)
            }
        } catch { removeLocked(); throw error }
    }
    func cancel(_ id: String) {
        lock.lock(); defer { lock.unlock() }
        guard let current = transfer, current.id == id else { return }
        if current.sending { current.cancelled = true; current.cancel?() }
        else { removeLocked() }
    }
    func setSuspended(_ value: Bool) {
        lock.lock(); defer { lock.unlock() }; suspended = value
        if value, let current = transfer { cancel(current.id) }
    }
    private func expire() {
        lock.lock(); defer { lock.unlock() }
        if let current = transfer, current.expires <= now() { cancel(current.id) }
    }
}
