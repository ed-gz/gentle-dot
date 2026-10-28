import Foundation
import Tauri
import UIKit
import WebKit
// A build without this SDK must fail instead of shipping a UI-only local engine.
import FoundationModels

private struct PromptArgs: Decodable { let prompt: String }
private struct Availability: Encodable {
    let available: Bool
    let status: String
    let supportsSpanish: Bool
}
private struct Reply: Encodable {
    var ok: Bool
    var text: String? = nil
    var error: String? = nil
    var message: String? = nil
}

@available(iOS 26.0, *)
private final class Conversation {
    let session = LanguageModelSession(instructions: """
        The person's locale is es_MX. Responde en español.
        Eres Capri, una asistente animada con personalidad cyberpunk: cálida, directa y con humor.
        Conversa de forma natural y breve, normalmente en dos a cuatro frases.
        Funcionas localmente en este iPhone. No tienes acceso a internet, a la PC ni a otras apps.
        No afirmes haber enviado mensajes, creado recordatorios o realizado acciones del sistema.
        Si no sabes algo, dilo. No inventes recuerdos ni datos actuales.
        """)
}

final class LocalIntelligencePlugin: Plugin {
    // All mutable state is accessed on the main queue. A cancelled generation
    // remains busy until its Task exits, so a replacement cannot overlap it.
    private var conversation: AnyObject?
    private var task: Task<Void, Never>?
    private var pending: Invoke?
    private var cancellationRequested = false
    private var lifecycleObserver: NSObjectProtocol?

    @objc override func load(webview: WKWebView) {
        lifecycleObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.willResignActiveNotification, object: nil, queue: .main
        ) { [weak self] _ in
            self?.cancelCurrent(message: "Respuesta pausada al salir de Capri. Vuelve a intentarlo al regresar.")
        }
    }

    deinit {
        if let observer = lifecycleObserver { NotificationCenter.default.removeObserver(observer) }
        task?.cancel()
    }

    private func availability() -> Availability {
        if #available(iOS 26.0, *) {
            let model = SystemLanguageModel.default
            switch model.availability {
            case .available:
                let spanish = model.supportsLocale(Locale(identifier: "es_MX"))
                return Availability(available: spanish, status: spanish ? "available" : "unsupported_language",
                                    supportsSpanish: spanish)
            case .unavailable(.deviceNotEligible):
                return Availability(available: false, status: "device_not_eligible", supportsSpanish: false)
            case .unavailable(.appleIntelligenceNotEnabled):
                return Availability(available: false, status: "apple_intelligence_disabled", supportsSpanish: false)
            case .unavailable(.modelNotReady):
                return Availability(available: false, status: "model_not_ready", supportsSpanish: false)
            case .unavailable:
                return Availability(available: false, status: "model_unavailable", supportsSpanish: false)
            @unknown default:
                return Availability(available: false, status: "model_unavailable", supportsSpanish: false)
            }
        }
        return Availability(available: false, status: "os_unsupported", supportsSpanish: false)
    }

    @objc func checkAvailability(_ invoke: Invoke) {
        DispatchQueue.main.async { invoke.resolve(self.availability()) }
    }

    @objc func respond(_ invoke: Invoke) {
        guard let args = try? invoke.parseArgs(PromptArgs.self) else {
            invoke.resolve(Reply(ok: false, error: "invalid_prompt", message: "El mensaje no es válido."))
            return
        }
        DispatchQueue.main.async { self.start(prompt: args.prompt, invoke: invoke) }
    }

    private func start(prompt: String, invoke: Invoke) {
        guard !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              prompt.unicodeScalars.count <= 4_000 else {
            invoke.resolve(Reply(ok: false, error: "invalid_prompt", message: "Escribe entre 1 y 4000 caracteres."))
            return
        }
        guard UIApplication.shared.applicationState == .active else {
            invoke.resolve(Reply(ok: false, error: "not_foreground", message: "Abre Capri para conversar."))
            return
        }
        guard task == nil else {
            invoke.resolve(Reply(ok: false, error: "busy", message: "Espera a que termine la respuesta actual."))
            return
        }
        let state = availability()
        guard state.available else {
            invoke.resolve(Reply(ok: false, error: state.status, message: "La IA local aún no está disponible en este iPhone."))
            return
        }
        if #available(iOS 26.0, *) {
            let local = (conversation as? Conversation) ?? Conversation()
            conversation = local
            pending = invoke
            cancellationRequested = false
            task = Task { @MainActor [weak self] in
                guard let self = self else { return }
                defer { self.task = nil; self.pending = nil; self.cancellationRequested = false }
                do {
                    try Task.checkCancellation()
                    let response = try await local.session.respond(
                        to: prompt, options: GenerationOptions(maximumResponseTokens: 384)
                    )
                    try Task.checkCancellation()
                    if !self.cancellationRequested {
                        self.pending?.resolve(Reply(ok: true, text: response.content))
                    }
                } catch {
                    // An interrupted/failed transcript is never reused.
                    self.conversation = nil
                    if !self.cancellationRequested { self.pending?.resolve(self.failure(error)) }
                }
            }
        }
    }

    private func failure(_ error: Error) -> Reply {
        if error is CancellationError {
            return Reply(ok: false, error: "cancelled", message: "Respuesta cancelada.")
        }
        if #available(iOS 26.0, *), let modelError = error as? LanguageModelSession.GenerationError {
            switch modelError {
            case .exceededContextWindowSize:
                return Reply(ok: false, error: "context_full", message: "La memoria de esta conversación se llenó. Inicié una sesión nueva; vuelve a enviar tu mensaje.")
            case .assetsUnavailable:
                return Reply(ok: false, error: "model_not_ready", message: "El modelo local todavía no está listo. Comprueba Apple Intelligence.")
            case .unsupportedLanguageOrLocale:
                return Reply(ok: false, error: "unsupported_language", message: "El modelo local no admite el idioma de este mensaje.")
            case .guardrailViolation, .refusal:
                return Reply(ok: false, error: "refused", message: "El modelo local no pudo responder a esa solicitud. Prueba con otra formulación.")
            case .rateLimited:
                return Reply(ok: false, error: "temporarily_unavailable", message: "El modelo local necesita una pausa. Intenta de nuevo en un momento.")
            case .concurrentRequests:
                return Reply(ok: false, error: "busy", message: "El modelo local está terminando otra respuesta.")
            default: break
            }
        }
        return Reply(ok: false, error: "generation_failed", message: "No pude completar la respuesta local. Puedes volver a intentarlo.")
    }

    private func cancelCurrent(message: String) {
        guard task != nil else { return }
        conversation = nil
        cancellationRequested = true
        task?.cancel()
        pending?.resolve(Reply(ok: false, error: "cancelled", message: message))
        pending = nil
    }

    @objc func cancel(_ invoke: Invoke) {
        DispatchQueue.main.async {
            self.cancelCurrent(message: "Respuesta cancelada.")
            invoke.resolve(Reply(ok: true))
        }
    }

    @objc func reset(_ invoke: Invoke) {
        DispatchQueue.main.async {
            self.cancelCurrent(message: "Conversación reiniciada.")
            self.conversation = nil
            invoke.resolve(Reply(ok: true))
        }
    }
}

@_cdecl("init_plugin_local_intelligence")
func initLocalIntelligencePlugin() -> Plugin { LocalIntelligencePlugin() }
