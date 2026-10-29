import Foundation

enum DeviceFailure: Error { case invalid(String), oversized, network, cancelled }
final class ReceiptTestProtocol: URLProtocol {
    static let started = DispatchSemaphore(value: 0)
    static let release = DispatchSemaphore(value: 0)
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.started.signal()
        DispatchQueue.global().async {
            Self.release.wait()
            let response = HTTPURLResponse(url: self.request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Length": "2097153"])!
            self.client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            self.client?.urlProtocol(self, didLoad: Data(count: 2 * 1024 * 1024 + 1))
            self.client?.urlProtocolDidFinishLoading(self)
        }
    }
    override func stopLoading() {}
}
@main struct HTTPReceiptTransportTests {
    static func check(_ value: @autoclosure () -> Bool, _ label: String) { if !value() { fatalError(label) } }
    static func main() throws {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("capri-http-transport-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let path = dir.appendingPathComponent("receipt.sqlite").path, id = UUID().uuidString.lowercased(), owner = UUID().uuidString.lowercased()
        let journal = try HTTPReceiptJournal(path: path), reopened = try HTTPReceiptJournal(path: path)
        try journal.begin(id: id, owner: owner)
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [ReceiptTestProtocol.self]
        let completion = DispatchSemaphore(value: 0), terminal = DispatchSemaphore(value: 0), lock = NSLock()
        var stateAtReply: HTTPReceiptJournal.State?, terminalStored = false
        BoundedHTTP.run(HTTPInput(url: "https://fixture.invalid/", method: "POST", headers: [:], body: nil), configuration: config, onTerminal: {
            do { try journal.terminalCallback(id: id, owner: owner); lock.lock(); terminalStored = true; lock.unlock() } catch {}
            terminal.signal()
        }) { _ in
            let state = try? reopened.read(id: id)
            lock.lock(); stateAtReply = state?.state; lock.unlock(); completion.signal()
        }
        check(ReceiptTestProtocol.started.wait(timeout: .now() + 5) == .success, "fixture did not start")
        let during = try reopened.read(id: id); check(during?.state == .active, "in-flight transport must remain active")
        ReceiptTestProtocol.release.signal()
        check(completion.wait(timeout: .now() + 5) == .success, "size failure not delivered")
        check(terminal.wait(timeout: .now() + 5) == .success, "terminal callback not delivered")
        lock.lock(); let observed = stateAtReply, stored = terminalStored; lock.unlock()
        check(observed == .active, "cancel request must not mark terminal")
        check(stored, "terminal callback must be durably stored")
        let after = try reopened.read(id: id); check(after?.state == .terminal, "terminal receipt missing after reopen")
        print("HTTP receipt transport fixtures passed")
    }
}
