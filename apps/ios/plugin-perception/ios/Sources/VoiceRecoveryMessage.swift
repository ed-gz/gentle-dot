import Foundation

/// Fixed, non-sensitive messages. Never surface an underlying NSError, audio,
/// transcript, file path, or device identifier through this diagnostic.
enum VoiceRecoveryMessage {
    static func forReason(_ reason: String) -> String {
        let message: String
        switch reason {
        case "no_speech":
            message = "No detecté palabras en este audio. Puedes descartarlo y volver a dictar más cerca del micrófono."
        case "empty_audio":
            message = "No se capturó audio. Descarta esta grabación y comprueba el micrófono antes de dictar de nuevo."
        case "audio_format_unavailable":
            message = "No pude preparar el formato de audio para Apple. Toca el micrófono para reintentar."
        case "invalid_evidence":
            message = "Apple devolvió texto o tiempos que no pude verificar. Toca el micrófono para reintentar."
        case "transcription_timeout":
            message = "Apple tardó demasiado en transcribir. Toca el micrófono para reintentar."
        case "preview_pending":
            message = "Apple todavía está cerrando la vista previa. Toca el micrófono para reintentar."
        case "background":
            message = "La transcripción se interrumpió al salir. Vuelve y toca el micrófono para reintentar."
        case "closing":
            message = "Apple todavía está cerrando la transcripción anterior. Reintenta en un momento."
        default:
            message = "Apple no pudo completar la transcripción. Toca el micrófono para reintentar."
        }
        return "\(message) El audio puede perderse si iOS cierra Capri."
    }
}
