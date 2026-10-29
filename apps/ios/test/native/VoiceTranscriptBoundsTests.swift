import Foundation

@main
struct VoiceTranscriptBoundsTests {
    static func main() {
        func check(_ parts: [(text: String, start: Double, end: Double)], _ duration: Double = 2) -> Bool {
            VoiceTranscriptBounds.valid(parts, duration: duration)
        }
        precondition(check([("Hola", 0, 1), ("Capri", 1, 2)]))
        precondition(check([(String(repeating: "😀", count: 16_000), 0, 2)]))
        precondition(!check([(String(repeating: "😀", count: 16_001), 0, 2)]), "count UTF-16 units as the web bridge does")
        precondition(!check([(String(repeating: "a", count: 32_000), 0, 1), ("b", 1, 2)]), "spaces also count")
        precondition(check([("A", 0, 2.05)]), "bounded floating-point tolerance")
        precondition(!check([("A", 0, 2.11)]), "never silently clamp beyond recorded audio")
        precondition(!check([("A", 1, 1.5), ("B", 0.5, 1)]), "chronological evidence")
        precondition(!check([("A", .nan, 1)]) && !check([("A", 0, .infinity)]))
        precondition(!check([]) && !check([("", 0, 1)]) && !check([("A", 0, 1)], .infinity))
        let boundary = Array(repeating: (text: "A", start: 0.0, end: 0.0), count: 2_000)
        precondition(check(boundary) && !check(boundary + [(text: "A", start: 0.0, end: 0.0)]))
        print("VoiceTranscriptBounds: match WebView Unicode, time, ordering and segment limits without truncation.")
    }
}
