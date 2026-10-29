@main
struct VoiceLocaleSelectionTests {
    static func main() {
        let choices = [(value: "speech-es-MX", installed: false),
                       (value: "speech-es-ES", installed: true),
                       (value: "dictation-es-MX", installed: true)]
        precondition(VoiceLocaleSelection.preferred(choices) == "speech-es-ES")
        precondition(VoiceLocaleSelection.preferred([(value: "speech-es-MX", installed: false),
            (value: "dictation-es-MX", installed: true)]) == "dictation-es-MX")
        precondition(VoiceLocaleSelection.preferred([(value: "speech-es-MX", installed: false),
            (value: "speech-es-ES", installed: false)]) == "speech-es-MX")
        precondition(VoiceLocaleSelection.preferred([(value: String, installed: Bool)]()) == nil)
        print("VoiceLocaleSelection: installed Spanish alternatives work offline.")
    }
}
