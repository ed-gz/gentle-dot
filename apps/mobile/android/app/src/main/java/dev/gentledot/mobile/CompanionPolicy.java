package dev.gentledot.mobile;

/** Small deterministic policy shared by renderer/service tests. No background polling. */
final class CompanionPolicy {
    static boolean visible(boolean enabled, boolean permission, boolean interactive, boolean locked, boolean appVisible) {
        return enabled && permission && interactive && !locked && !appVisible;
    }
    static boolean offerNotice(boolean notificationsEnabled, boolean normalInterruptionMode) {
        return notificationsEnabled && normalInterruptionMode;
    }
    static boolean animate(boolean visible, boolean powerSave, boolean reducedMotion) {
        return visible && !powerSave && !reducedMotion;
    }
    static int bound(int value, int extent, int size, int inset) {
        return Math.max(inset, Math.min(value, Math.max(inset, extent - size - inset)));
    }
    static String action(String kind) {
        if ("download".equals(kind) || "capture".equals(kind)) return "file-away";
        if ("permission".equals(kind) || "agentAttention".equals(kind)) return "greeting";
        if ("typing".equals(kind) || "working".equals(kind)) return "working";
        return "greeting";
    }
}
