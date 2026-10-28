import Foundation
import CryptoKit

// Only digest state remains in memory between calls, never file bytes.
final class StreamingHash {
    private struct State {
        var digest = SHA256()
        var bytes = 0
        var expires = Date().addingTimeInterval(120)
    }
    private let lock = NSLock()
    private var states: [String: State] = [:]
    func begin() throws -> String {
        lock.lock(); defer { lock.unlock() }
        states = states.filter { $0.value.expires > Date() }
        guard states.count < 4 else { throw DeviceFailure.unavailable("Hay demasiados archivos verificándose. Intenta de nuevo.") }
        let id = UUID().uuidString.lowercased(); states[id] = State(); return id
    }
    func update(_ id: String, _ encoded: String) throws {
        guard encoded.utf8.count <= 349_528, let data = Data(base64Encoded: encoded),
              !data.isEmpty, data.count <= 256 * 1024 else { throw DeviceFailure.invalid("Bloque de verificación inválido.") }
        lock.lock(); defer { lock.unlock() }
        guard var state = states[id], state.expires > Date() else { states[id] = nil; throw DeviceFailure.invalid("La verificación expiró.") }
        guard state.bytes + data.count <= 50 * 1024 * 1024 else { states[id] = nil; throw DeviceFailure.oversized }
        state.digest.update(data: data); state.bytes += data.count
        state.expires = Date().addingTimeInterval(120); states[id] = state
    }
    func finish(_ id: String) throws -> String {
        lock.lock(); defer { lock.unlock() }
        guard let state = states.removeValue(forKey: id), state.expires > Date() else { throw DeviceFailure.invalid("La verificación expiró.") }
        return state.digest.finalize().map { String(format: "%02x", $0) }.joined()
    }
    func cancel(_ id: String) { lock.lock(); states[id] = nil; lock.unlock() }
}
