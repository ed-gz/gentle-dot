import Foundation
import UserNotifications

@MainActor
final class FakeCompletionClient: CompletionNotificationClient {
    var permission = "not_determined"
    var requestResult = false
    var requests = 0
    var added: [String] = []
    var removed: [String] = []
    var holdAuthorization = false
    var authorizationContinuation: CheckedContinuation<String, Never>?
    func authorization() async -> String {
        if holdAuthorization { return await withCheckedContinuation { authorizationContinuation = $0 } }
        return permission
    }
    func requestAuthorization() async throws -> Bool { requests += 1; return requestResult }
    func add(identifier: String) async throws { added.append(identifier) }
    func remove(identifier: String) { removed.append(identifier) }
}

@main
enum CompletionNotificationsTests {
    @MainActor static func main() async throws {
        let suite = "capri.notification.tests." + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let client = FakeCompletionClient(); var background = true
        let service = CompletionNotifications(client: client, defaults: defaults, inBackground: { background })
        let id = "d3dba896-4b5c-4c1c-98c9-4e60238fe6b9"
        var checks = 0
        func check(_ condition: Bool, _ message: String) { precondition(condition, message); checks += 1 }
        let initial = await service.status()
        check(initial.preferred && !initial.enabled && client.requests == 0, "default preference is on without requesting permission")
        client.permission = "authorized"
        check((await service.status()).enabled, "existing system permission enables the default")
        client.permission = "not_determined"
        await service.notifyCompleted(id: id)
        check(client.added.isEmpty && client.requests == 0, "no notification or permission request without consent")
        let denied = try await service.configure(enabled: true)
        check(!denied.enabled && client.requests == 1, "explicit consent denial does not enable alerts")
        client.permission = "authorized"; client.requestResult = true
        let enabled = try await service.configure(enabled: true)
        check(enabled.enabled && enabled.authorization == "authorized", "explicit consent enables alerts")
        background = false; await service.notifyCompleted(id: id)
        check(client.added.isEmpty, "foreground completion does not notify")
        background = true; await service.notifyCompleted(id: id)
        check(client.added == ["capri.inference." + id], "background completion gets an identity-bound alert")
        let content = SystemCompletionNotificationClient.content()
        check(content.title == "Capri terminó" && content.body == "Tu respuesta está lista en Capri.", "notification carries only generic text")
        service.cancel(id: id); await service.notifyCompleted(id: id)
        check(client.added.count == 1 && client.removed.last == "capri.inference." + id, "stop removes and fences the alert")
        let delayed = "a3dba896-4b5c-4c1c-98c9-4e60238fe6b9"
        client.holdAuthorization = true
        let pending = Task { await service.notifyCompleted(id: delayed) }
        while client.authorizationContinuation == nil { await Task.yield() }
        service.cancel(id: delayed)
        client.authorizationContinuation?.resume(returning: "authorized"); client.authorizationContinuation = nil
        await pending.value; client.holdAuthorization = false
        check(!client.added.contains("capri.inference." + delayed), "late authorization cannot undo Stop")
        let disabled = try await service.configure(enabled: false)
        check(!disabled.enabled, "explicit opt-out disables future notifications")
        await service.notifyCompleted(id: "b3dba896-4b5c-4c1c-98c9-4e60238fe6b9")
        check(client.added.count == 1, "opt-out survives later completions")
        print("CompletionNotifications: \(checks) native fixture checks passed")
    }
}
