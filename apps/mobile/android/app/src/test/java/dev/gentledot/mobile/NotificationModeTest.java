package dev.gentledot.mobile;

import static org.junit.Assert.*;
import org.junit.Test;

public class NotificationModeTest {
    @Test public void dotModeMutesAgentEventsButRetainsDotRepliesAndQuestions() {
        assertTrue(NotificationMode.allows("dot", "dot"));
        assertFalse(NotificationMode.allows("dot", "agents"));
    }
    @Test public void agentsModeAndAllModeFilterByExplicitSource() {
        assertTrue(NotificationMode.allows("agents", "agents"));
        assertFalse(NotificationMode.allows("agents", "dot"));
        assertTrue(NotificationMode.allows("all", "agents"));
        assertTrue(NotificationMode.allows("all", "dot"));
    }
    @Test public void concretePermissionsRemainVisibleInEveryNotificationMode() {
        for (String mode : new String[] { "dot", "agents", "all" }) assertTrue(NotificationMode.allows(mode, "permission"));
    }
    @Test public void invalidPreferencesOrSourcesCannotSilentlyEnableAlerts() {
        assertFalse(NotificationMode.valid("none"));
        assertFalse(NotificationMode.valid(null));
        assertFalse(NotificationMode.allows("invalid", "dot"));
        assertFalse(NotificationMode.allows("dot", "unknown"));
    }
}
