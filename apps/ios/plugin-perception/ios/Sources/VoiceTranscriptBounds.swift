import Foundation

enum VoiceEvidenceError: Error { case invalid }

/// Mirror the WebView transcript boundary before declaring success: rejecting
/// evidence in JavaScript after Swift has deleted its recording loses audio.
/// This never clamps a timestamp, truncates text, or invents missing segments.
enum VoiceTranscriptBounds {
    static func valid(_ parts: [(text: String, start: Double, end: Double)], duration: Double) -> Bool {
        guard duration.isFinite, duration >= 0.001, duration <= 91,
              !parts.isEmpty, parts.count <= 2_000 else { return false }
        var units = 0
        var previousStart = 0.0
        for (index, part) in parts.enumerated() {
            guard !part.text.isEmpty, part.start.isFinite, part.end.isFinite,
                  part.start >= 0, part.end >= part.start,
                  part.end <= duration + 0.1,
                  index == 0 || part.start >= previousStart else { return false }
            units += part.text.utf16.count + (index == 0 ? 0 : 1)
            guard units <= 32_000 else { return false }
            previousStart = part.start
        }
        return true
    }
}
