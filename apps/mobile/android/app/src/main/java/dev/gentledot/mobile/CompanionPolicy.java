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
        return visible && motionPausedReason(powerSave,reducedMotion)==null;
    }
    static String motionPausedReason(boolean powerSave, boolean reducedMotion) {
        return powerSave ? "battery" : reducedMotion ? "system" : null;
    }
    static int bound(int value, int extent, int size, int inset) {
        return Math.max(inset, Math.min(value, Math.max(inset, extent - size - inset)));
    }
    static boolean shouldStart(boolean enabled, boolean permission, boolean running) {
        return retry(enabled, permission) && !running;
    }
    static boolean retry(boolean enabled, boolean permission) { return enabled && permission; }
    /** Attention takes priority; one idle agent must never cancel another working agent. */
    static String aggregate(Iterable<String> states) {
        boolean working = false;
        for (String state : states) {
            if ("blocked".equals(state) || "needs_you".equals(state) || "permission".equals(state) || "agentAttention".equals(state)) return "permission";
            working |= "working".equals(state) || "thinking".equals(state) || "typing".equals(state);
        }
        return working ? "working" : "idle";
    }
    static boolean loop(String action, String sustained) { return action.equals(sustained); }
    /** Only names present in the shipped core/actions atlases. */
    static String action(String kind) {
        if (kind == null) return "idle";
        switch (kind) {
            case "download": case "capture": return "file-away";
            case "permission": case "agentAttention": case "blocked": case "needs_you": return "perch";
            case "typing": case "working": case "thinking": return "working";
            case "agentCompleted": case "dotReply": case "done": case "success": return "greeting";
            case "agentError": case "dotError": case "error": case "failed": return "step-aside";
            case "agentAvailable": case "idle": default: return "idle";
        }
    }
}
