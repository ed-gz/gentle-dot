import Foundation
import UserNotifications
#if canImport(UIKit)
import UIKit
#endif

struct CompletionNotificationStatus: Encodable {
    let ok: Bool
    let enabled: Bool
    let preferred: Bool
    let authorization: String
}

@MainActor
protocol CompletionNotificationClient {
    func authorization() async -> String
    func requestAuthorization() async throws -> Bool
    func add(identifier: String) async throws
    func remove(identifier: String)
}

@MainActor
final class SystemCompletionNotificationClient: CompletionNotificationClient {
    private let center = UNUserNotificationCenter.current()
    func authorization() async -> String {
        switch await center.notificationSettings().authorizationStatus {
        case .authorized: return "authorized"
        case .provisional: return "provisional"
        case .ephemeral: return "ephemeral"
        case .denied: return "denied"
        case .notDetermined: return "not_determined"
        @unknown default: return "unavailable"
        }
    }
    func requestAuthorization() async throws -> Bool {
        try await center.requestAuthorization(options: [.alert, .sound])
    }
    static func content() -> UNMutableNotificationContent {
        let content = UNMutableNotificationContent()
        content.title = "Capri terminó"
        content.body = "Tu respuesta está lista en Capri."
        content.sound = .default
        content.threadIdentifier = "capri-respuestas"
        return content
    }
    func add(identifier: String) async throws {
        try await center.add(UNNotificationRequest(identifier: identifier, content: Self.content(), trigger: nil))
    }
    func remove(identifier: String) {
        center.removePendingNotificationRequests(withIdentifiers: [identifier])
        center.removeDeliveredNotifications(withIdentifiers: [identifier])
    }
}

/// Notification content never includes prompts, model text, account names or tools.
/// Completion is reported only after the journal persisted an answer.
@MainActor
final class CompletionNotifications {
    private static let key = "capri.localCompletionNotifications"
    private let client: CompletionNotificationClient
    private let defaults: UserDefaults
    private let inBackground: () -> Bool
    private var revision = 0
    private var cancelled = Set<String>()

    init(client: CompletionNotificationClient? = nil,
         defaults: UserDefaults = .standard, inBackground: @escaping () -> Bool = {
        #if canImport(UIKit)
        return UIApplication.shared.applicationState == .background
        #else
        return false
        #endif
    }) {
        defaults.register(defaults: [Self.key: true])
        self.client = client ?? SystemCompletionNotificationClient(); self.defaults = defaults; self.inBackground = inBackground
    }
    private func allowed(_ status: String) -> Bool { ["authorized", "provisional", "ephemeral"].contains(status) }
    func status() async -> CompletionNotificationStatus {
        let authorization = await client.authorization()
        let preferred = defaults.bool(forKey: Self.key)
        return CompletionNotificationStatus(ok: true, enabled: preferred && allowed(authorization), preferred: preferred, authorization: authorization)
    }
    func configure(enabled: Bool) async throws -> CompletionNotificationStatus {
        revision += 1; let current = revision
        if !enabled {
            defaults.set(false, forKey: Self.key)
            return await status()
        }
        let granted = try await client.requestAuthorization()
        guard revision == current else { return await status() }
        let authorization = await client.authorization()
        guard revision == current else { return await status() }
        defaults.set(granted && allowed(authorization), forKey: Self.key)
        return CompletionNotificationStatus(ok: true, enabled: granted && allowed(authorization), preferred: granted && allowed(authorization), authorization: authorization)
    }
    func notifyCompleted(id: String) async {
        guard defaults.bool(forKey: Self.key), inBackground(), !cancelled.contains(id) else { return }
        let authorization = await client.authorization()
        guard allowed(authorization), defaults.bool(forKey: Self.key), inBackground(), !cancelled.contains(id) else { return }
        let identifier = "capri.inference." + id
        do {
            try await client.add(identifier: identifier)
            if cancelled.contains(id) || !defaults.bool(forKey: Self.key) { client.remove(identifier: identifier) }
        } catch { /* Delivery failure never changes the saved inference outcome. */ }
    }
    func cancel(id: String) {
        cancelled.insert(id)
        client.remove(identifier: "capri.inference." + id)
    }
}
