import Foundation
import FoundationModels

@available(macOS 26.0, *)
@Generable(description: "Resultado de prueba en español")
private struct SyntheticDecision {
    @Guide(description: "Respuesta breve a la persona") var respuesta: String
}

@available(macOS 26.0, *)
private func probe() async throws -> String {
    let model = SystemLanguageModel.default
    switch model.availability {
    case .available: break
    case .unavailable(.deviceNotEligible): return "SKIP: this macOS environment is not eligible for Apple Intelligence; no inference was run."
    case .unavailable(.appleIntelligenceNotEnabled): return "SKIP: Apple Intelligence is disabled; no inference was run."
    case .unavailable(.modelNotReady): return "SKIP: the model is not ready; no inference or download was requested."
    case .unavailable: return "SKIP: the system language model is unavailable; no inference was run."
    @unknown default: return "SKIP: unknown model availability; no inference was run."
    }
    guard model.supportsLocale(Locale(identifier: "es_MX")) else { return "SKIP: Spanish locale is not supported; no inference was run." }
    let session = LanguageModelSession(instructions: "Responde brevemente en español de México y recuerda los datos de esta conversación.")
    let first = try await session.respond(to: "Mi palabra señal es neón. Confirma que la recordaste.", options: GenerationOptions(maximumResponseTokens: 96))
    guard !first.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw ProbeError.empty }
    let second = try await session.respond(to: "¿Cuál es mi palabra señal? Responde sólo esa palabra.", options: GenerationOptions(maximumResponseTokens: 48))
    let recalled = second.content.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: Locale(identifier: "es_MX"))
    guard recalled.contains("neon") else { throw ProbeError.continuity }
    let structured = LanguageModelSession(instructions: "Responde en español de México.")
    let decision = try await structured.respond(to: "Saluda brevemente a la persona.", generating: SyntheticDecision.self, options: GenerationOptions(maximumResponseTokens: 96))
    guard !decision.content.respuesta.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw ProbeError.empty }
    return "PASS: real local Foundation Models Spanish inference, two-turn continuity and structured generation on macOS. This is not an iPhone test."
}
private enum ProbeError: Error { case empty, continuity }
@main struct FoundationModelSpanishProbe {
    static func main() async {
        if #available(macOS 26.0, *) {
            do { print(try await probe()) }
            catch { fputs("FAIL: the local Foundation Models probe did not complete all checks on macOS.\n", stderr); exit(1) }
        } else { print("SKIP: macOS 26 is required; no inference was run.") }
    }
}
