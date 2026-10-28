import Foundation

@main
struct LiveTranscriptTests {
    static func main() {
        var preview = LiveTranscript()
        precondition(preview.update(text: "hola", start: 0, end: 1, final: false))
        precondition(preview.update(text: "hola Capri", start: 0, end: 1.2, final: false))
        precondition(preview.text == "hola Capri")
        precondition(preview.update(text: "hola Capri", start: 0, end: 1.2, final: true))
        precondition(preview.update(text: "hola Capri", start: 0, end: 1.2, final: true))
        precondition(preview.update(text: "cómo", start: 1.2, end: 2, final: false))
        precondition(preview.update(text: "cómo estás", start: 1.2, end: 2.5, final: false))
        precondition(preview.text == "hola Capri cómo estás")
        precondition(preview.update(text: "", start: 1.2, end: 2.5, final: false))
        precondition(preview.text == "hola Capri")
        precondition(!preview.update(text: "reemplazo", start: 0, end: 1, final: false))
        precondition(preview.text == "hola Capri")
        precondition(!preview.update(text: "inválido", start: .nan, end: 1, final: false))
        precondition(!preview.update(text: "inválido", start: 1, end: 92, final: true))
        print("LiveTranscript: provisional replacement, final deduplication and bounds passed.")
    }
}
