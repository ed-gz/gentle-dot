package dev.gentledot.mobile;

/** Pure routing policy; SYSTEM still requires Android permission and channel checks. */
final class NotificationDelivery {
    enum Route { NONE, FOREGROUND, SYSTEM }

    static Route route(NotificationPreferences preferences, String event, boolean visible, boolean monitorEvent) {
        if (!preferences.allows(event)) return Route.NONE;
        if (!visible) return Route.SYSTEM;
        // Direct UI notifications already have a foreground presentation. Never echo them.
        return monitorEvent && preferences.get("inApp") ? Route.FOREGROUND : Route.NONE;
    }
}
