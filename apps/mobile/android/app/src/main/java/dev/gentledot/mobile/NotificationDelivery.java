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

    static java.util.List<String> batchLines(org.json.JSONObject batch, NotificationPreferences preferences) {
        java.util.List<String> lines = new java.util.ArrayList<>();
        org.json.JSONArray summaries = batch.optJSONArray("summaries"), events = batch.optJSONArray("events");
        if (summaries == null || events == null) return lines;
        for (int i = 0; i < Math.min(8, summaries.length()); i++) {
            String line = summaries.optString(i, "");
            if (preferences.allows(events.optString(i)) && !line.isEmpty()) lines.add(line.substring(0, Math.min(240, line.length())));
        }
        int dropped = Math.max(0, batch.optInt("dropped"));
        if (!lines.isEmpty() && dropped > 0) lines.add("+" + dropped + " más");
        return lines;
    }

    static String batchEvent(org.json.JSONObject batch, NotificationPreferences preferences) {
        org.json.JSONArray events = batch.optJSONArray("events");
        if (events != null) for (int i = 0; i < Math.min(8, events.length()); i++)
            if (preferences.allows(events.optString(i))) return events.optString(i);
        return "unknown";
    }

    static Route route(NotificationPreferences preferences, String event, boolean visible, boolean monitorEvent) {
        if (!preferences.allows(event)) return Route.NONE;
        if (!visible) return Route.SYSTEM;
        // Direct UI notifications already have a foreground presentation. Never echo them.
        return monitorEvent && preferences.get("inApp") ? Route.FOREGROUND : Route.NONE;
    }
}
