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
        for reason in ["no_speech", "empty_audio", "audio_format_unavailable", "invalid_evidence", "transcription_timeout", "preview_pending", "background", "closing", "cleanup_failed", unknown] {
            precondition(!VoiceRecoveryMessage.forReason(reason).isEmpty && VoiceRecoveryMessage.forReason(reason).count <= 500)
            precondition(VoiceRecoveryMessage.forReason(reason).contains("puede perderse si iOS cierra Capri"))
        }
        print("VoiceRecoveryMessage: actionable fixed diagnostics without private error data.")
    }
}
