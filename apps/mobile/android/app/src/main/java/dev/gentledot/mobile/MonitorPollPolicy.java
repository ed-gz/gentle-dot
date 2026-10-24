package dev.gentledot.mobile;

/** Delivery filters can eliminate HTTP work without changing the user's saved settings. */
final class MonitorPollPolicy {
    static boolean needsSessions(NotificationPreferences preferences) {
        return preferences.get("permissions") || preferences.get("agentCompleted")
            || preferences.get("agentAttention") || preferences.get("agentErrors") || preferences.get("agentAvailable");
    }
    static boolean needsDotApprovals(NotificationPreferences preferences, boolean hostReached) {
        return hostReached && preferences.get("permissions");
    }
}
