import Foundation

/// Classification is metadata only; downstream decoders still validate the actual bytes.
enum DocumentImportMime {
    static func normalize(fileExtension suffix: String, reported: String?, conformsToAudio: Bool) -> String {
        let mime = reported?.lowercased() ?? "application/octet-stream"
        if conformsToAudio || suffix.lowercased() == "m4a" {
            if mime.hasPrefix("audio/") { return mime }
            return suffix.lowercased() == "m4a" ? "audio/mp4" : "audio/x-unknown"
        }
        return mime
    }
}
