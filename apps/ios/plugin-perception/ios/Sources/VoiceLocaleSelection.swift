/// Apple distinguishes downloaded, downloadable, downloading and unsupported
/// module configurations. Keep unknown future states unknown.
enum VoiceAssetState: Equatable {
    case installed, supported, downloading, unsupported, unknown

    var status: String {
        switch self {
        case .installed: return "available"
        case .supported: return "assets_required"
        case .downloading: return "assets_downloading"
        case .unsupported: return "unsupported_configuration"
        case .unknown: return "asset_status_unknown"
        }
    }

    var message: String {
        switch self {
        case .installed: return "La voz está lista."
        case .supported: return "Prepara los modelos de voz antes de dictar sin conexión."
        case .downloading: return "Apple está preparando la voz o esperando condiciones para descargarla. Inténtalo de nuevo en un momento."
        case .unsupported: return "La configuración de voz en español no está disponible en este iPhone."
        case .unknown: return "No pude comprobar el estado de la voz de Apple. Inténtalo de nuevo."
        }
    }
}

/// Prefer an installed candidate, then one Apple can prepare. Do not choose an
/// unsupported configuration over an available alternative.
enum VoiceLocaleSelection {
    static func preferred<T>(_ candidates: [(value: T, state: VoiceAssetState)]) -> T? {
        candidates.first(where: { $0.state == .installed })?.value
            ?? candidates.first(where: { $0.state == .supported || $0.state == .downloading })?.value
            ?? candidates.first(where: { $0.state == .unknown })?.value
            ?? candidates.first?.value
    }
}
