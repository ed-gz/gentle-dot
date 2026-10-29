#if os(iOS)
import ActivityKit
import Foundation
import UIKit

struct LiveActivityItem: Encodable {
    let id: String
    let turnId: String
    let origin: String
    let phase: String
    let sequence: Int
    let observedAt: Double
    let stale: Bool
}
struct LiveActivityReply: Encodable {
    var ok = true
    var error: String? = nil
    var message: String? = nil
    var enabled: Bool? = nil
    var id: String? = nil
    var items: [LiveActivityItem]? = nil
}

/// ActivityKit is only a presentation of events supplied by the app. It never
/// runs a job, accesses a host, requests a push token or approves an operation.
@MainActor
final class LiveActivityController {
    private var busy = Set<String>()
    private var starting = false
    private func unavailable(_ message: String) -> LiveActivityReply {
        LiveActivityReply(ok: false, error: "unavailable", message: message)
    }
    private func invalid(_ message: String) -> LiveActivityReply {
        LiveActivityReply(ok: false, error: "invalid_request", message: message)
    }
    private var bundled: Bool { Bundle.main.object(forInfoDictionaryKey: "NSSupportsLiveActivities") as? Bool == true }
    func availability() -> LiveActivityReply {
        guard #available(iOS 16.2, *), bundled else { return LiveActivityReply(enabled: false) }
        return LiveActivityReply(enabled: ActivityAuthorizationInfo().areActivitiesEnabled)
    }
    @available(iOS 16.2, *)
    private func item(_ activity: Activity<CapriActivityAttributes>) -> LiveActivityItem {
        let content = activity.content.state
        return LiveActivityItem(id: activity.id, turnId: activity.attributes.turnId, origin: activity.attributes.origin,
            phase: content.phase, sequence: content.sequence, observedAt: content.observedAt.timeIntervalSince1970 * 1000,
            stale: activity.activityState == .stale)
    }
    func list() -> LiveActivityReply {
        guard #available(iOS 16.2, *), bundled else { return unavailable("Esta instalación no incluye Actividades en vivo.") }
        let current = Activity<CapriActivityAttributes>.activities.filter { $0.activityState == .active || $0.activityState == .stale }
        return LiveActivityReply(items: current.map(item))
    }
    func start(_ request: LiveActivityRequest) -> LiveActivityReply {
        guard LiveActivityPolicy.valid(request, ending: false, requireActivityID: false) else { return invalid("Estado de actividad inválido.") }
        guard #available(iOS 16.2, *), bundled else { return unavailable("Esta instalación no incluye Actividades en vivo.") }
        guard UIApplication.shared.applicationState == .active else { return unavailable("Abre Capri para iniciar la actividad.") }
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return unavailable("Las Actividades en vivo están desactivadas para Capri en Ajustes del iPhone.") }
        guard !starting else { return unavailable("Capri ya está iniciando una actividad.") }
        starting = true; defer { starting = false }
        let current = Activity<CapriActivityAttributes>.activities.filter { $0.activityState == .active || $0.activityState == .stale }
        if let existing = current.first(where: { $0.attributes.turnId == request.turnId && $0.attributes.origin == request.origin }) {
            return LiveActivityReply(id: existing.id, items: [item(existing)])
        }
        guard current.isEmpty else { return unavailable("Ya hay una actividad de Capri. Termínala antes de iniciar otra.") }
        let now = Date()
        guard let observed = LiveActivityPolicy.observedDate(request, now: now) else { return unavailable("La observación ya no es reciente. Vuelve a consultar la laptop.") }
        let state = CapriActivityAttributes.ContentState(phase: request.phase, sequence: request.sequence, observedAt: observed)
        do {
            let activity = try Activity.request(attributes: CapriActivityAttributes(turnId: request.turnId, origin: request.origin),
                content: ActivityContent(state: state, staleDate: observed.addingTimeInterval(90)), pushType: nil)
            return LiveActivityReply(id: activity.id, items: [item(activity)])
        } catch { return unavailable("iOS no pudo iniciar la actividad. La conversación sigue disponible.") }
    }
    func update(_ request: LiveActivityRequest, ending: Bool) async -> LiveActivityReply {
        guard LiveActivityPolicy.valid(request, ending: ending, requireActivityID: true), let id = request.id else { return invalid("Estado de actividad inválido.") }
        guard #available(iOS 16.2, *), bundled else { return unavailable("Esta instalación no incluye Actividades en vivo.") }
        guard !busy.contains(id) else { return unavailable("Hay una actualización de esta actividad en curso.") }
        guard let activity = Activity<CapriActivityAttributes>.activities.first(where: { $0.id == id }),
              activity.attributes.turnId == request.turnId, activity.attributes.origin == request.origin,
              activity.activityState == .active || activity.activityState == .stale else {
            return unavailable("La actividad ya terminó o no pertenece a este turno.")
        }
        let current = activity.content.state
        guard LiveActivityPolicy.canUpdate(previous: current.sequence, next: request.sequence) else {
            return invalid("La actividad recibió una revisión anterior. Consulta su estado antes de actualizarla.")
        }
        busy.insert(id); defer { busy.remove(id) }
        let now = Date()
        let observed = ending ? now : LiveActivityPolicy.observedDate(request, now: now)
        guard let observed = observed else { return unavailable("La observación ya no es reciente. Vuelve a consultar la laptop.") }
        let content = ActivityContent(state: CapriActivityAttributes.ContentState(phase: request.phase,
            sequence: request.sequence, observedAt: observed), staleDate: ending ? nil : observed.addingTimeInterval(90))
        if ending { await activity.end(content, dismissalPolicy: request.phase == "dismissed" ? .immediate : .after(now.addingTimeInterval(60))) }
        else { await activity.update(content) }
        return LiveActivityReply(id: id)
    }
}
#endif
