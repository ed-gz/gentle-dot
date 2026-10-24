package dev.gentledot.mobile;

import static org.junit.Assert.*;
import java.util.HashMap;
import java.util.Map;
import org.junit.Test;

public class NotificationPreferencesTest {
    @Test public void quietDefaultsKeepMeaningfulRepliesAndPermissions() {
        NotificationPreferences preferences = new NotificationPreferences("all", null);
        assertTrue(preferences.allows("dotReply")); assertTrue(preferences.allows("agentCompleted"));
        assertTrue(preferences.allows("permission")); assertTrue(preferences.allows("dotError"));
        assertFalse(preferences.allows("agentAvailable")); assertFalse(preferences.get("sound"));
        assertFalse(preferences.get("preview")); assertTrue(preferences.get("vibration"));
    }
    @Test public void migratesLegacySourceSettingsWithoutUnmutingThem() {
        NotificationPreferences dot = new NotificationPreferences("dot", null);
        assertTrue(dot.allows("dotReply")); assertFalse(dot.allows("agentCompleted")); assertFalse(dot.allows("agentError"));
        NotificationPreferences agents = new NotificationPreferences("agents", null);
        assertFalse(agents.allows("dotReply")); assertFalse(agents.allows("dotError")); assertTrue(agents.allows("agentAttention"));
        assertTrue(dot.allows("permission")); assertTrue(agents.allows("permission"));
    }
    @Test public void everySourceAndPermissionAlertCanBeIndependentlyMuted() {
        Map<String, Object> saved = new HashMap<>();
        saved.put("permissions", false); saved.put("agentAvailable", true); saved.put("dotReplies", false); saved.put("dotErrors", true);
        NotificationPreferences preferences = new NotificationPreferences("all", saved);
        assertFalse(preferences.allows("permission")); assertFalse(preferences.allows("dotReply"));
        assertTrue(preferences.allows("dotError")); assertTrue(preferences.allows("agentAvailable")); assertTrue(preferences.allows("agentCompleted"));
    }
    @Test public void statusChangesAreNotMistakenForNewAnswersAndApprovalHasOneCategory() {
        assertEquals("agentAvailable", NotificationPreferences.agentEvent("completed", false, false, null));
        assertEquals("agentAvailable", NotificationPreferences.agentEvent("completed", true, false, false));
        assertEquals("agentCompleted", NotificationPreferences.agentEvent("completed", false, false, true));
        assertEquals("agentCompleted", NotificationPreferences.agentEvent("completed", true, false, null));
        assertEquals("permission", NotificationPreferences.agentEvent("attention", false, true, null));
        assertEquals("agentAttention", NotificationPreferences.agentEvent("attention", false, false, null));
        assertEquals("agentError", NotificationPreferences.agentEvent("disconnected", false, false, null));
        assertEquals("unknown", NotificationPreferences.agentEvent("policy", false, false, null));
    }
    @Test public void invalidFieldsDoNotBecomeTruthyOrOverrideDefaults() {
        Map<String, Object> saved = new HashMap<>(); saved.put("agentAvailable", "true"); saved.put("sound", 1);
        NotificationPreferences preferences = new NotificationPreferences("all", saved);
        assertFalse(preferences.get("agentAvailable")); assertFalse(preferences.get("sound"));
        assertFalse(preferences.allows("unknown")); assertFalse(NotificationPreferences.knownKey("password"));
    }
    @Test public void currentAndLegacyPermissionEventsAreNotNotifiedAgainAsAgentAttention() {
        assertTrue(NotificationPreferences.hasSessionPermission("question-id", ""));
        assertTrue(NotificationPreferences.hasSessionPermission("", "legacy-question-id"));
        assertTrue(NotificationPreferences.hasSessionPermission("question-id", "legacy-question-id"));
        assertFalse(NotificationPreferences.hasSessionPermission("", ""));
        assertFalse(NotificationPreferences.hasSessionPermission(null, null));
    }
    @Test public void appPermissionsUseOnlyBrokerWhileOrdinaryQuestionsUseSocket() {
        assertFalse(NotificationPreferences.socketQuestion("app"));
        for (String method : new String[] { "confirm", "select", "input", "editor", "pin" }) assertTrue(NotificationPreferences.socketQuestion(method));
    }
    @Test public void channelSettingsAndReturnedValuesCannotMutateStoredPreferences() {
        Map<String, Boolean> saved = new HashMap<>(); saved.put("sound", true); saved.put("vibration", false);
        NotificationPreferences preferences = new NotificationPreferences("all", saved);
        assertEquals("sound-still", preferences.channelSuffix());
        preferences.values().put("sound", false);
        assertEquals("sound-still", preferences.channelSuffix());
        assertEquals("quiet-vibrate", new NotificationPreferences("all", null).channelSuffix());
    }
}
