package dev.gentledot.mobile;

import static org.junit.Assert.*;
import java.util.HashMap;
import java.util.Map;
import org.junit.Test;

public class MonitorPollPolicyTest {
    private static Map<String, Boolean> quiet() {
        Map<String, Boolean> values = new HashMap<>();
        for (String key : new String[] { "permissions", "agentCompleted", "agentAttention", "agentErrors", "agentAvailable" }) values.put(key, false);
        return values;
    }
    @Test public void dotOnlyDoesNotNeedSessionSnapshotsOrPermissionPolling() {
        NotificationPreferences preferences = new NotificationPreferences("all", quiet());
        assertTrue(preferences.get("dotReplies"));
        assertFalse(MonitorPollPolicy.needsSessions(preferences));
        assertFalse(MonitorPollPolicy.needsDotApprovals(preferences, true));
    }
    @Test public void everyEnabledSessionCategoryRetainsItsRequiredSnapshot() {
        for (String key : new String[] { "permissions", "agentCompleted", "agentAttention", "agentErrors", "agentAvailable" }) {
            Map<String, Boolean> values = quiet(); values.put(key, true);
            assertTrue(key, MonitorPollPolicy.needsSessions(new NotificationPreferences("all", values)));
        }
    }
    @Test public void offlineHostDoesNotPayTheSameTimeoutForThePermissionEndpoint() {
        NotificationPreferences preferences = new NotificationPreferences("all", null);
        assertFalse(MonitorPollPolicy.needsDotApprovals(preferences, false));
        assertTrue(MonitorPollPolicy.needsDotApprovals(preferences, true));
    }
    @Test public void sourceFilteringDoesNotChangePresentationOrSavedPreferences() {
        Map<String, Boolean> values = quiet(); values.put("inApp", false); values.put("sound", true);
        NotificationPreferences preferences = new NotificationPreferences("all", values);
        assertFalse(MonitorPollPolicy.needsSessions(preferences));
        assertTrue(preferences.get("sound")); assertFalse(preferences.get("inApp"));
        assertEquals(values.get("permissions"), preferences.values().get("permissions"));
    }
}
