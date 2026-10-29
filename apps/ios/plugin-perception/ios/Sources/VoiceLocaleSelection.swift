/// Prefer an installed supported locale, preserving module and language order.
/// If no model is installed, the first supported candidate can be downloaded.
enum VoiceLocaleSelection {
    static func preferred<T>(_ candidates: [(value: T, installed: Bool)]) -> T? {
        candidates.first(where: { $0.installed })?.value ?? candidates.first?.value
    }
}
