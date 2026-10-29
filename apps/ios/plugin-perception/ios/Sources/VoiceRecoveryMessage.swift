import Foundation

/// Fixed, non-sensitive messages. Never surface an underlying NSError, audio,
/// transcript, file path, or device identifier through this diagnostic.
enum VoiceRecoveryMessage {
    static func forReason(_ reason: String) -> String {
        switch reason {
        case "no_speech":
            return "No detecté palabras en este audio. Puedes descartarlo y volver a dictar más cerca del micrófono."
        case "empty_audio":
            return "No se capturó audio. Descarta esta grabación y comprueba el micrófono antes de dictar de nuevo."
        case "audio_format_unavailable":
            return "No pude preparar el formato de audio para Apple. El audio sigue guardado; toca el micrófono para reintentar."
        case "invalid_evidence":
            return "Apple devolvió texto o tiempos que no pude verificar. El audio sigue guardado; toca el micrófono para reintentar."
        case "transcription_timeout":
            return "Apple tardó demasiado en transcribir. El audio sigue guardado; toca el micrófono para reintentar."
        case "preview_pending":
            return "Apple todavía está cerrando la vista previa. El audio sigue guardado; toca el micrófono para reintentar."
        case "background":
            return "La transcripción se interrumpió al salir. El audio sigue guardado; vuelve y toca el micrófono para reintentar."
        case "closing":
            return "Apple todavía está cerrando la transcripción anterior. El audio sigue guardado; reintenta en un momento."
        default:
            return "Apple no pudo completar la transcripción. El audio sigue guardado; toca el micrófono para reintentar."
        }
    }
}
