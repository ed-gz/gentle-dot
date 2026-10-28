import ActivityKit
import SwiftUI
import WidgetKit

@main
struct CapriActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: CapriActivityAttributes.self) { context in
            CapriLockScreen(context: context)
                .activityBackgroundTint(Color(red: 0.08, green: 0.07, blue: 0.12))
                .activitySystemActionForegroundColor(.white)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.center) { Text("CAPRI · \(phaseLabel(context.state.phase))") }
            } compactLeading: { Text("C").foregroundStyle(.pink) }
              compactTrailing: { Image(systemName: "sparkle") }
              minimal: { Text("C").foregroundStyle(.pink) }
        }
    }
}

private func phaseLabel(_ phase: String) -> String {
    switch phase {
    case "thinking": return "Pensando contigo"
    case "working": return "Trabajando"
    case "attention": return "Necesita tu revisión"
    case "waiting": return "Esperando una señal"
    case "finished": return "Respuesta terminada"
    case "interrupted": return "Respuesta interrumpida"
    default: return "Estado sin confirmar"
    }
}

private struct CapriLockScreen: View {
    let context: ActivityViewContext<CapriActivityAttributes>
    var body: some View {
        HStack(alignment: .center, spacing: 14) {
            Text("C//")
                .font(.system(size: 23, weight: .black, design: .monospaced))
                .foregroundStyle(Color(red: 1, green: 0.25, blue: 0.56))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text("CAPRI · \(context.attributes.origin == "iphone" ? "iPhone" : "laptop")")
                    .font(.system(.caption, design: .monospaced, weight: .bold))
                    .foregroundStyle(Color(red: 0.73, green: 0.92, blue: 0.46))
                Text(context.isStale ? "Sin señal reciente · abre Capri" : phaseLabel(context.state.phase))
                    .font(.headline).foregroundStyle(.white)
                Text(context.state.observedAt, style: .relative)
                    .font(.caption).foregroundStyle(.secondary)
                    .accessibilityLabel("Última actualización")
            }
            Spacer(minLength: 0)
        }
        .padding(16)
    }
}
