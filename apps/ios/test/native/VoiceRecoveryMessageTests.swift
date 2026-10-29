import Foundation

@main
struct VoiceRecoveryMessageTests {
    static func main() {
        let silence = VoiceRecoveryMessage.forReason("no_speech")
        precondition(silence.contains("No detecté palabras") && silence.contains("descartarlo"))
        precondition(VoiceRecoveryMessage.forReason("empty_audio").contains("No se capturó audio"))
        precondition(VoiceRecoveryMessage.forReason("audio_format_unavailable").contains("formato"))
        precondition(VoiceRecoveryMessage.forReason("invalid_evidence").contains("no pude verificar"))
        precondition(VoiceRecoveryMessage.forReason("transcription_timeout").contains("tardó demasiado"))
        precondition(VoiceRecoveryMessage.forReason("cleanup_failed").contains("No pude limpiar"))
        precondition(VoiceRecoveryMessage.forReason("background").contains("al salir"))
        let unknown = "untrusted /private/audio-and-speech"
        precondition(!VoiceRecoveryMessage.forReason(unknown).contains(unknown))
        let privatePath = "/private/voice.caf"
        let native = NSError(domain: "SFSpeechErrorDomain", code: 10,
                             userInfo: [NSLocalizedDescriptionKey: privatePath])
        let diagnostic = VoiceFailureDiagnostic(phase: .analysis, error: native)
        let message = VoiceRecoveryMessage.forReason("transcription_failed", diagnostic: diagnostic)
        precondition(message.contains("análisis") && message.contains("Speech 10"))
        precondition(!message.contains(privatePath))
        let foreign = VoiceFailureDiagnostic(phase: .results, error: NSError(domain: privatePath, code: 42))
        let foreignMessage = VoiceRecoveryMessage.forReason("transcription_failed", diagnostic: foreign)
        precondition(foreignMessage.contains("resultados") && foreignMessage.contains("Otro"))
        precondition(!foreignMessage.contains(privatePath) && !foreignMessage.contains("42"))
        precondition(!VoiceRecoveryMessage.forReason("background", diagnostic: diagnostic).contains("Speech 10"))
        for reason in ["no_speech", "empty_audio", "audio_format_unavailable", "invalid_evidence", "transcription_timeout", "preview_pending", "background", "closing", "cleanup_failed", unknown] {
            precondition(!VoiceRecoveryMessage.forReason(reason).isEmpty && VoiceRecoveryMessage.forReason(reason).count <= 500)
            precondition(VoiceRecoveryMessage.forReason(reason).contains("puede perderse si iOS cierra Capri"))
        }
        print("VoiceRecoveryMessage: actionable fixed diagnostics without private error data.")
    }
}
