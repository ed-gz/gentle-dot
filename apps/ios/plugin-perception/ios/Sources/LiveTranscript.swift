import Foundation

/// Provisional recognition is presentation-only. A changed hypothesis replaces
/// overlapping provisional text; finalized ranges are never duplicated.
struct LiveTranscript {
    private struct Segment {
        let start: Double
        let end: Double
        let text: String
        let final: Bool
    }
    private var segments: [Segment] = []
    private let maxSegments = 512
    private let maxCharacters = 2_400

    mutating func update(text: String, start: Double, end: Double, final: Bool) -> Bool {
        guard start.isFinite, end.isFinite, start >= 0, end >= start, end <= 91,
              text.unicodeScalars.count <= maxCharacters else { return false }
        let overlaps = { (item: Segment) -> Bool in
            // Speech result ranges may share a boundary without overlapping.
            item.start < end - 0.000_001 && start < item.end - 0.000_001
                || (item.start == start && item.end == end)
        }
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let finalized = segments.filter { $0.final && overlaps($0) }
        if !finalized.isEmpty {
            // A finalized range is evidence, not a mutable hypothesis.
            return final && finalized.count == 1 && finalized[0].start == start
                && finalized[0].end == end && finalized[0].text == clean
        }
        segments.removeAll { !$0.final && overlaps($0) }
        if !clean.isEmpty {
            guard segments.count < maxSegments else { return false }
            segments.append(Segment(start: start, end: end, text: clean, final: final))
        }
        return true
    }

    var text: String {
        let value = segments.sorted { $0.start == $1.start ? $0.end < $1.end : $0.start < $1.start }
            .map(\.text).joined(separator: " ")
        // This is a transient preview, never the final transcript or saved draft.
        if value.unicodeScalars.count <= maxCharacters { return value }
        return String(String.UnicodeScalarView(value.unicodeScalars.suffix(maxCharacters)))
    }
}
