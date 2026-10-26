package dev.gentledot.mobile;

/** Pure routing policy; SYSTEM still requires Android permission and channel checks. */
final class NotificationDelivery {
    enum Route { NONE, FOREGROUND, SYSTEM }

    static String persona(android.content.Context context) {
        return "capri".equals(CompanionOverlayService.prefs(context).getString("theme", "gentle-dot")) ? "Capri" : "Gentle Dot";
    }

    static boolean question(org.json.JSONObject dialog) {
        String kind = dialog.optString("dialogKind");
        if (!kind.isEmpty()) return "question".equals(kind);
        // Older snapshots expose the adapter's original dialog kind.
        return java.util.Arrays.asList("select", "input", "questionnaire", "editor", "custom").contains(dialog.optString("kind", dialog.optString("method")));
    }
    static String dialogEvent(org.json.JSONObject dialog) { return question(dialog) ? "agentAttention" : "permission"; }
    static String dialogTitle(org.json.JSONObject dialog) { return question(dialog) ? "Pregunta" : "Permiso"; }
    static String dialogBody(org.json.JSONObject dialog) {
        String label = dialog.optString("sessionLabel", dialog.optString("sessionId", "La sesión"));
        String summary = dialog.optString("dialogTitle", dialog.optString("title", "Revisa la solicitud en Sesiones."));
        return label + (question(dialog) ? " te pregunta: " : " pide permiso: ") + summary.substring(0, Math.min(summary.length(), 160));
    }

    static Route route(NotificationPreferences preferences, String event, boolean visible, boolean monitorEvent) {
        if (!preferences.allows(event)) return Route.NONE;
        if (!visible) return Route.SYSTEM;
        // Direct UI notifications already have a foreground presentation. Never echo them.
        return monitorEvent && preferences.get("inApp") ? Route.FOREGROUND : Route.NONE;
    }
}
