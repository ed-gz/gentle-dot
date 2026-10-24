package dev.gentledot.mobile;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.LinkedHashMap;

/** Bounded in-memory cursor: never notify historical replies on first activation. */
final class ChatCatchup {
    private final LinkedHashMap<String, String> baselines = new LinkedHashMap<>();
    private String conversation = "";
    private boolean catchingUp;
    private boolean liveReply;
    private boolean idle;

    void ready(String id, boolean isIdle) {
        conversation = id;
        catchingUp = baselines.containsKey(id);
        liveReply = false;
        idle = isIdle;
    }

    void state(boolean isIdle) { idle = isIdle; }
    void liveReply() { liveReply = true; }

    boolean history(String id, String latestReply) {
        // A conversation switch is not a reply. New and reopened chats establish a baseline.
        if (!conversation.equals(id)) {
            conversation = id;
            catchingUp = false;
            liveReply = false;
        }
        // A stored assistant turn can still grow while tools are running.
        if (!idle) {
            if (!baselines.containsKey(id)) {
                baselines.put(id, digest(latestReply));
                trim();
            }
            return false;
        }
        String fingerprint = digest(latestReply);
        String previous = baselines.put(id, fingerprint);
        boolean notify = catchingUp && previous != null && !previous.equals(fingerprint)
            && !latestReply.isEmpty() && !liveReply;
        catchingUp = false;
        liveReply = false;
        trim();
        return notify;
    }

    private void trim() {
        while (baselines.size() > 8) baselines.remove(baselines.keySet().iterator().next());
    }

    private static String digest(String input) {
        try {
            byte[] bytes = MessageDigest.getInstance("SHA-256").digest(input.getBytes(StandardCharsets.UTF_8));
            StringBuilder value = new StringBuilder();
            for (byte b : bytes) value.append(String.format("%02x", b));
            return value.toString();
        } catch (java.security.NoSuchAlgorithmException error) {
            throw new IllegalStateException(error);
        }
    }
}
