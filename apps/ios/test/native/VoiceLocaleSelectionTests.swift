@main
struct VoiceLocaleSelectionTests {
    static func main() {
        let choices: [(value: String, state: VoiceAssetState)] = [
            ("speech-es-MX", .supported), ("speech-es-ES", .installed), ("dictation-es-MX", .installed)]
        precondition(VoiceLocaleSelection.preferred(choices) == "speech-es-ES")
        precondition(VoiceLocaleSelection.preferred([(value: "speech", state: .unsupported),
            (value: "dictation", state: .supported)]) == "dictation")
        precondition(VoiceLocaleSelection.preferred([(value: "speech", state: .unsupported),
            (value: "dictation", state: .downloading)]) == "dictation")
        precondition(VoiceLocaleSelection.preferred([(value: "speech", state: .unsupported),
            (value: "dictation", state: .unknown)]) == "dictation")
        precondition(VoiceLocaleSelection.preferred([(value: "speech", state: .supported),
            (value: "dictation", state: .downloading)]) == "speech")
        precondition(VoiceLocaleSelection.preferred([(value: String, state: VoiceAssetState)]()) == nil)
        precondition(VoiceAssetState.installed.status == "available")
        precondition(VoiceAssetState.supported.status == "assets_required")
        precondition(VoiceAssetState.downloading.status == "assets_downloading")
        precondition(VoiceAssetState.unsupported.status == "unsupported_configuration")
        precondition(VoiceAssetState.unknown.status == "asset_status_unknown")
        precondition(VoiceAssetState.downloading.message.contains("esperando"))
        precondition(VoiceAssetState.unsupported.message.contains("no está disponible"))
        print("VoiceLocaleSelection: installed and supported candidates take priority; asset states remain distinct.")
    }
}
