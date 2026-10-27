package dev.gentledot.mobile;

/** Pure gesture and dismiss-affordance state; Android supplies slop and its long-click timeout. */
final class OverlayGestures {
    enum Decision { NONE, TAP, DRAG, LONG_PRESS, DISMISS }
    private final long longPressMs;
    private boolean down, moved, held, dismissVisible;

    OverlayGestures(long longPressMs) { this.longPressMs = longPressMs; }
    void down() { down = true; moved = false; held = false; }
    Decision move(boolean beyondSlop) {
        if (!down) return Decision.NONE;
        moved |= beyondSlop;
        if (!moved) return Decision.NONE;
        dismissVisible = false;
        return Decision.DRAG;
    }
    Decision hold(long elapsedMs) {
        if (!down || moved || held || elapsedMs < longPressMs) return Decision.NONE;
        held = true;
        dismissVisible = !dismissVisible;
        return Decision.LONG_PRESS;
    }
    Decision up(long elapsedMs) {
        if (!down) return Decision.NONE;
        Decision decision;
        if (moved) decision = Decision.DRAG;
        else if (held) decision = Decision.NONE;
        else if (elapsedMs >= longPressMs) decision = hold(elapsedMs);
        else if (dismissVisible) { dismissVisible = false; decision = Decision.DISMISS; }
        else decision = Decision.TAP;
        down = false;
        return decision;
    }
    void cancel() { down = false; }
    void hide() { dismissVisible = false; cancel(); }
    boolean dismissVisible() { return dismissVisible; }
}
