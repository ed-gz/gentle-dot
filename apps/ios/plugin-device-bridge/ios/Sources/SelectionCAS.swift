import Foundation

/// Serializes cooperative writers in this process; it is not a cross-process lock.
final class SelectionCAS {
    private let lock = NSLock()
    func compareAndSet(expected: String?, value: String, read: () throws -> String?, write: (String) throws -> Void) rethrows -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard try read() == expected else { return false }
        try write(value)
        return true
    }
}
