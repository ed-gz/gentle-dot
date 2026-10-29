import Foundation
#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

/// Confirm explicit cancellation only when the captured bytes are absent.
/// A permission error is never mistaken for a missing file.
enum VoiceFileCleanup {
    static func removeFinalFiles(_ original: URL, using remove: (URL) throws -> Void = { try FileManager.default.removeItem(at: $0) }) -> Bool {
        let converted = original.deletingPathExtension().appendingPathExtension("analysis.caf")
        // Keep the original if the converted copy cannot be removed.
        guard Self.remove(converted, using: remove) else { return false }
        return Self.remove(original, using: remove)
    }
    static func remove(_ url: URL?, using remove: (URL) throws -> Void = { try FileManager.default.removeItem(at: $0) }) -> Bool {
        guard let url else { return true }
        do { try remove(url) } catch { /* Verify absence independently below. */ }
        var info = stat()
        let (result, code) = url.path.withCString { path -> (Int32, Int32) in
            let result = lstat(path, &info)
            return (result, errno)
        }
        return result != 0 && code == ENOENT
    }
}
