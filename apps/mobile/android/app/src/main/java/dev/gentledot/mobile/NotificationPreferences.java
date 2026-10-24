package dev.gentledot.mobile;

import java.util.LinkedHashMap;
import java.util.Map;

/** Pure preference migration and event classification, shared by every delivery path. */
final class NotificationPreferences {
    static final String[] KEYS = {
        "dotReplies", "dotErrors", "agentCompleted", "agentAttention", "agentErrors",
        "agentAvailable", "permissions", "inApp", "preview", "sound", "vibration"
    };
    private final Map<String, Boolean> values;

    NotificationPreferences(String legacyMode, Map<String, ?> saved) {
        values = new LinkedHashMap<>();
        boolean dot = !"agents".equals(legacyMode);
        boolean agents = !"dot".equals(legacyMode);
        values.put("dotReplies", dot); values.put("dotErrors", dot);
        values.put("agentCompleted", agents); values.put("agentAttention", agents); values.put("agentErrors", agents);
        values.put("agentAvailable", false); values.put("permissions", true); values.put("inApp", true);
        values.put("preview", false); values.put("sound", false); values.put("vibration", true);
        if (saved != null) for (String key : KEYS) {
            Object value = saved.get(key);
            if (value instanceof Boolean) values.put(key, (Boolean) value);
        }
    }

    boolean get(String key) { return Boolean.TRUE.equals(values.get(key)); }
    Map<String, Boolean> values() { return new LinkedHashMap<>(values); }
    static boolean knownKey(String key) {
        for (String name : KEYS) if (name.equals(key)) return true;
        return false;
    }
    boolean allows(String event) {
        switch (event) {
            case "dotReply": return get("dotReplies");
            case "dotError": return get("dotErrors");
            case "agentCompleted": return get("agentCompleted");
            case "agentAttention": return get("agentAttention");
            case "agentError": return get("agentErrors");
            case "agentAvailable": return get("agentAvailable");
            case "permission": return get("permissions");
            default: return false;
        }
    }
    static boolean hasSessionPermission(String requestId, String legacyApprovalId) {
        return (requestId != null && !requestId.isEmpty()) || (legacyApprovalId != null && !legacyApprovalId.isEmpty());
    }
    static boolean socketQuestion(String method) {
        // Native app approvals have a richer, independently polled broker record.
        return !"app".equals(method);
    }
    static String legacyEvent(String source) {
        if ("permission".equals(source)) return "permission";
        if ("agents".equals(source)) return "agentCompleted";
        return "dot".equals(source) ? "dotReply" : "unknown";
    }
    static String agentEvent(String type, boolean hasReply, boolean permission, Boolean resultChanged) {
        if (permission) return "permission";
        if ("completed".equals(type)) return (resultChanged == null ? hasReply : resultChanged) ? "agentCompleted" : "agentAvailable";
        if ("attention".equals(type)) return "agentAttention";
        if ("disconnected".equals(type)) return "agentError";
        return "unknown";
    }
    String channelSuffix() { return (get("sound") ? "sound" : "quiet") + (get("vibration") ? "-vibrate" : "-still"); }
}
