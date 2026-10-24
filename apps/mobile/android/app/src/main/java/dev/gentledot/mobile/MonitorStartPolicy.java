package dev.gentledot.mobile;

/** Saved encrypted credentials are the opt-in; presentation preferences are not pairing. */
final class MonitorStartPolicy {
    static boolean shouldStart(boolean saved, boolean allowed, boolean active) {
        return saved && allowed && !active;
    }
    static String status(boolean saved, boolean allowed, boolean active, boolean connected) {
        if (!allowed) return "needs_permission";
        if (!saved) return "not_paired";
        return active && connected ? "on" : "disconnected";
    }
}
