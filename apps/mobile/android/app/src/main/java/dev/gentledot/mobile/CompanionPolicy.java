package dev.gentledot.mobile;

/** Small deterministic policy shared by renderer/service tests. No background polling. */
final class CompanionPolicy {
    // The partial chat is not the full app: keep Capri there, but never cover the full-app composer.
    static boolean visible(boolean enabled, boolean permission, boolean interactive, boolean locked, boolean fullAppVisible) {
        return enabled && permission && interactive && !locked && !fullAppVisible;
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
        String selected = "idle";
        for (String state : states) {
            String kind = normalize(state);
            if (factPriority(kind) > factPriority(selected)) selected = kind;
        }
        return selected;
    }
    static boolean loop(String action, String sustained) { return action.equals(sustained); }
    private static int factPriority(String kind) {
        if ("reading".equals(kind) || "read".equals(kind) || "search".equals(kind)) return 2;
        return priority(action(kind));
    }
    static String normalize(String kind) {
        if (kind == null) return "idle";
        switch (kind) {
            case "blocked": case "needs_you": case "agentAttention": return "permission";
            case "agentCompleted": case "dotReply": case "success": return "done";
            case "agentError": case "dotError": case "failed": return "error";
            default: return kind;
        }
    }
    /** Same fact priorities as theme-capri/behavior.ts; thinking is agent work. */
    static int priority(String animation) {
        switch (animation) {
            case "attentive": return 6;
            case "crying": case "duo-high-five": return 5;
            case "eyes": return 4;
            case "working": case "curious": return 3;
            case "follow-message": return 2;
            default: return 0;
        }
    }
    /** Only animation keys present in validated, packaged motion atlases. */
    static String action(String kind) {
        if (kind == null) return "idle";
        switch (kind) {
            case "download": case "capture": return "file-away";
            case "permission": case "agentAttention": case "blocked": case "needs_you": return "attentive";
            case "typing": return "eyes";
            case "reading": case "read": case "search": return "eyes";
            case "working": case "run": case "edit": case "commands": return "working";
            case "thinking": return "curious";
            case "submitted": return "follow-message";
            case "agentCompleted": case "dotReply": case "done": case "success": case "victory": return "duo-high-five";
            case "agentError": case "dotError": case "error": case "failed": return "crying";
            case "agentAvailable": case "idle": default: return "idle";
        }
    }
}
