import Foundation
import CryptoKit

private struct Failure: Error { let message: String }
private var checks = 0
private func expect(_ value: Bool, _ message: String) throws {
    checks += 1; if !value { throw Failure(message: message) }
}
private func rejects(_ message: String, _ body: () throws -> Void) throws {
    checks += 1
    do { try body() } catch { return }
    throw Failure(message: "Accepted invalid operation: " + message)
}
private func hash(_ bytes: Data) -> String { SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined() }

@main private struct SessionUploadTests {
    static func main() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("capri-upload-test-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let bytes = Data([0, 255, 17, 128, 42])
        func input(_ payload: Data? = nil, url: String = "https://host.example/upload", name: String = "Evidencia ñ.bin", sha256: String? = nil, uploadId: String? = nil, size: Int? = nil) -> SessionUploadInput {
            let content = payload ?? bytes
            return SessionUploadInput(url: url, token: "fixture-only", paneId: "pane-A", sessionId: "session-A", uploadId: uploadId, name: name, size: size ?? content.count, sha256: sha256 ?? hash(content))
        }
        var instant = Date(timeIntervalSince1970: 1000), sent = 0, cancelled = 0, completed = 0, endedWithCancellation = false
        var request: URLRequest?, uploaded = Data(), file: URL?, pending: ((Result<HTTPOutput, Error>) -> Void)?
        let store = SessionUploadStore(root: root, now: { instant }, sender: { target, source, completion in
            sent += 1; request = target; file = source; uploaded = (try? Data(contentsOf: source)) ?? Data(); pending = completion
            // Simulate a response racing cancellation; it must not become success.
            return { cancelled += 1; completion(.success(HTTPOutput(status: 200, body: "late receipt", headers: [:]))) }
        })
        for url in ["http://host.example/upload", "https://user@host.example/upload", "https://host.example/other", "https://host.example/upload?x=y", "https://host.example/upload#fragment"] {
            try rejects("upload URL") { _ = try store.begin(input(url: url)) }
        }
        try rejects("header newline") { _ = try store.begin(input(name: "bad\r\nheader")) }
        try rejects("batch traversal") { _ = try store.begin(input(uploadId: "../private")) }
        try rejects("bad digest") { _ = try store.begin(input(sha256: "fake")) }
        try rejects("negative size") { _ = try store.begin(input(size: -1)) }
        try rejects("over size limit") { _ = try store.begin(input(size: SessionUploadStore.maximum + 1)) }
        try expect(sent == 0, "invalid inputs made no network request")
        let id = try store.begin(input(uploadId: "u_abcdefghijklmnopqrstuv"))
        try rejects("concurrent upload") { _ = try store.begin(input()) }
        try expect(try store.write(SessionUploadChunk(id: id, offset: 0, data: bytes.prefix(2).base64EncodedString())) == 2, "first chunk")
        try expect(try store.write(SessionUploadChunk(id: id, offset: 2, data: bytes.suffix(3).base64EncodedString())) == 5, "second chunk")
        try expect(sent == 0, "staging is not sending")
        try store.send(id) { result in if case .success = result { completed += 1 } }
        try expect(sent == 1 && uploaded == bytes, "exact binary file sent once")
        try expect(request?.url?.absoluteString == "https://host.example/upload" && request?.httpMethod == "POST", "captured endpoint")
        try expect(request?.value(forHTTPHeaderField: "X-Agent-Pane") == "pane-A" && request?.value(forHTTPHeaderField: "X-Agent-Session") == "session-A", "captured session")
        try expect(request?.value(forHTTPHeaderField: "X-File-Name") == "Evidencia%20%C3%B1.bin" && request?.value(forHTTPHeaderField: "X-Upload-Id") == "u_abcdefghijklmnopqrstuv", "encoded name and batch")
        try expect(FileManager.default.fileExists(atPath: file!.path), "file lives through transport")
        try rejects("second send") { try store.send(id) { _ in } }
        let answer = HTTPOutput(status: 200, body: "fixture receipt", headers: [:])
        pending?(.success(answer)); pending?(.success(answer))
        try expect(completed == 1 && !FileManager.default.fileExists(atPath: file!.path), "one completion and cleanup")

        let corrupt = try store.begin(input(sha256: String(repeating: "0", count: 64)))
        _ = try store.write(SessionUploadChunk(id: corrupt, offset: 0, data: bytes.base64EncodedString()))
        try rejects("hash mismatch") { try store.send(corrupt) { _ in } }
        try expect(sent == 1 && (try FileManager.default.contentsOfDirectory(atPath: root.path)).isEmpty, "corruption never crosses network")
        let partial = try store.begin(input())
        try rejects("truncated source") { try store.send(partial) { _ in } }
        let outOfOrder = try store.begin(input())
        try rejects("out-of-order block") { _ = try store.write(SessionUploadChunk(id: outOfOrder, offset: 1, data: bytes.base64EncodedString())) }
        let expired = try store.begin(input()); instant = instant.addingTimeInterval(121)
        try rejects("expired staging") { _ = try store.write(SessionUploadChunk(id: expired, offset: 0, data: bytes.base64EncodedString())) }
        let empty = try store.begin(input(Data()))
        try store.send(empty) { result in completed += 1; if case .failure(DeviceFailure.cancelled) = result { endedWithCancellation = true } }
        try expect(uploaded.isEmpty, "zero-byte file is valid")
        store.setSuspended(true)
        try expect(cancelled == 1 && completed == 2 && endedWithCancellation && !FileManager.default.fileExists(atPath: file!.path), "background cancels transport and cleans file")
        try rejects("background preparation") { _ = try store.begin(input()) }
        store.setSuspended(false)
        let resumed = try store.begin(input()); store.cancel("unrelated-id")
        try expect(try store.write(SessionUploadChunk(id: resumed, offset: 0, data: bytes.base64EncodedString())) == bytes.count, "stale cancellation cannot affect another transfer")
        store.cancel(resumed)
        try expect((try FileManager.default.contentsOfDirectory(atPath: root.path)).isEmpty, "cancelled staging removed")
        print("SessionUpload: \(checks) native fixture checks passed")
    }
}
