package dev.gentledot.mobile;

import static org.junit.Assert.*;
import java.util.HashMap;
import java.util.Map;
import org.junit.Test;

public class NotificationDeliveryTest {
    private static final String[] EVENTS = {
        "dotReply", "dotError", "agentCompleted", "agentAttention", "agentError", "permission"
    };

    @Test public void everyEnabledMonitorEventHasAForegroundHandoff() {
        NotificationPreferences preferences = new NotificationPreferences("all", null);
        for (String event : EVENTS) {
            assertEquals(event, NotificationDelivery.Route.FOREGROUND,
                NotificationDelivery.route(preferences, event, true, true));
            assertEquals(event, NotificationDelivery.Route.SYSTEM,
                NotificationDelivery.route(preferences, event, false, true));
        }
    }

    @Test public void directUiEventsAreNotEchoedBackToTheirOwnListener() {
        NotificationPreferences preferences = new NotificationPreferences("all", null);
        for (String event : EVENTS) {
            assertEquals(NotificationDelivery.Route.NONE,
                NotificationDelivery.route(preferences, event, true, false));
            assertEquals(NotificationDelivery.Route.SYSTEM,
                NotificationDelivery.route(preferences, event, false, false));
        }
    }

    @Test public void inAppOptOutDoesNotSilenceBackgroundDelivery() {
        Map<String, Boolean> saved = new HashMap<>(); saved.put("inApp", false);
        NotificationPreferences preferences = new NotificationPreferences("all", saved);
        assertEquals(NotificationDelivery.Route.NONE,
            NotificationDelivery.route(preferences, "permission", true, true));
        assertEquals(NotificationDelivery.Route.SYSTEM,
            NotificationDelivery.route(preferences, "permission", false, true));
    }

    @Test public void sourceOptOutAndUnknownEventsNeverReachEitherDestination() {
        Map<String, Boolean> saved = new HashMap<>();
        for (String key : NotificationPreferences.KEYS) saved.put(key, false);
        saved.put("inApp", true);
        NotificationPreferences muted = new NotificationPreferences("all", saved);
        for (String event : EVENTS) for (boolean visible : new boolean[] {true, false}) {
            assertEquals(NotificationDelivery.Route.NONE,
                NotificationDelivery.route(muted, event, visible, true));
        }
        assertEquals(NotificationDelivery.Route.NONE,
            NotificationDelivery.route(new NotificationPreferences("all", null), "unknown", true, true));
    }

    @Test public void availableStaysOptInAndPreviewDoesNotEnableAnyEvent() {
        NotificationPreferences defaults = new NotificationPreferences("all", null);
        assertFalse(defaults.get("preview"));
        assertEquals(NotificationDelivery.Route.NONE,
            NotificationDelivery.route(defaults, "agentAvailable", true, true));
        Map<String, Boolean> saved = new HashMap<>(); saved.put("agentAvailable", true);
        assertEquals(NotificationDelivery.Route.FOREGROUND,
            NotificationDelivery.route(new NotificationPreferences("all", saved), "agentAvailable", true, true));
        assertEquals(NotificationDelivery.Route.NONE,
            NotificationDelivery.route(new NotificationPreferences("agents", null), "dotReply", true, true));
        assertEquals(NotificationDelivery.Route.NONE,
            NotificationDelivery.route(new NotificationPreferences("dot", null), "agentCompleted", false, true));
    }
}
