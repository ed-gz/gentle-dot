import Foundation

/// Only fixed stage names, known system domains and bounded numeric codes
/// leave the native bridge. Never include NSError descriptions or userInfo.
struct VoiceFailureDiagnostic: Encodable {
    enum Phase: String, Encodable { case analysis, finalization, results }
    let phase: Phase
    let category: String
    let code: Int?

    init(phase: Phase, error: Error) {
        let native = error as NSError
        self.phase = phase
        switch native.domain {
        case "SFSpeechErrorDomain": category = "Speech"
        case NSOSStatusErrorDomain: category = "Audio"
        case NSCocoaErrorDomain: category = "Sistema"
        default: category = "Otro"
        }
        // Unrecognized domains and arbitrary error payloads are not safe to expose.
        code = category != "Otro" && (-999_999...999_999).contains(native.code) ? native.code : nil
    }

    var description: String {
        let label: String
        switch phase {
        case .analysis: label = "análisis"
        case .finalization: label = "finalización"
        case .results: label = "resultados"
        }
        return "Etapa: \(label) · \(category)\(code.map { " \($0)" } ?? "")."
    }
}

/// Fixed, non-sensitive messages. Never surface an underlying NSError, audio,
/// transcript, file path, or device identifier through this diagnostic.
enum VoiceRecoveryMessage {
    static func forReason(_ reason: String, diagnostic: VoiceFailureDiagnostic? = nil) -> String {
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
        case "cleanup_failed":
            message = "No pude limpiar el audio temporal. Toca el micrófono para reintentar o descarta el audio."
        case "retention_failed":
            message = "No pude confirmar el audio guardado. Se conserva para revisión; no lo descarté."
        case "capture_incomplete":
            message = "El audio quedó incompleto. Se conserva para revisión y no se presentará como una grabación terminada."
        default:
            message = "Apple no pudo completar la transcripción. Toca el micrófono para reintentar."
        }
        let detail = reason == "transcription_failed" ? diagnostic.map { " \($0.description)" } ?? "" : ""
        return "\(message)\(detail) El audio puede perderse si iOS cierra Capri."
    }
}
