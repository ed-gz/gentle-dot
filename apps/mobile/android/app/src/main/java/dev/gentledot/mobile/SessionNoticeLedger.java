package dev.gentledot.mobile;

import java.util.LinkedHashSet;

/** One bounded deduplication cursor for live socket events and snapshot catch-up. */
final class SessionNoticeLedger {
    private final LinkedHashSet<String> seen = new LinkedHashSet<>();
    private boolean initialized;
    synchronized boolean live(String id) { return remember(id); }
    synchronized boolean snapshot(String id) {
        boolean fresh = remember(id);
        return initialized && fresh;
    }
    synchronized void baselineComplete() { initialized = true; }
    synchronized void resetBaseline() { initialized = false; }
    private boolean remember(String id) {
        if (id == null || id.isEmpty() || !seen.add(id)) return false;
        while (seen.size() > 512) seen.remove(seen.iterator().next());
        return true;
    }
}
