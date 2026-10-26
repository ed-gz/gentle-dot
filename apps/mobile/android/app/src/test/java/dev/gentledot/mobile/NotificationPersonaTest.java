package dev.gentledot.mobile;

import static org.junit.Assert.*;
import android.app.Notification;
import android.app.NotificationManager;
import android.content.Context;
import org.robolectric.RuntimeEnvironment;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class NotificationPersonaTest {
    @Test public void systemAndPublicTitlesFollowExistingThemePreference() {
        Context context = RuntimeEnvironment.getApplication();
        for (String theme : new String[] {"capri", "gentle-dot"}) {
            CompanionOverlayService.prefs(context).edit().putString("theme", theme).commit();
            AgentMonitorService.notifyEvent(context, "agentAttention", "persona", "Pregunta", "Review te pregunta: Which branch?", "p", "s", false);
            Notification notice = context.getSystemService(NotificationManager.class).getActiveNotifications()[0].getNotification();
            String title = "capri".equals(theme) ? "Capri" : "Gentle Dot";
            assertEquals(title, notice.extras.getString(Notification.EXTRA_TITLE));
            assertEquals(title, notice.publicVersion.extras.getString(Notification.EXTRA_TITLE));
            assertTrue(notice.extras.getString(Notification.EXTRA_TEXT).contains("Which branch?"));
            assertTrue(context.getSystemService(NotificationManager.class).getNotificationChannel(notice.getChannelId()).getName().toString().startsWith(title));
        }
    }

    @Test public void monitorStatusUsesTheSamePersona() throws Exception {
        Context context = RuntimeEnvironment.getApplication();
        AgentMonitorService service = org.robolectric.Robolectric.buildService(AgentMonitorService.class).create().get();
        java.lang.reflect.Method status = AgentMonitorService.class.getDeclaredMethod("status", String.class);
        status.setAccessible(true);
        for (String theme : new String[] {"capri", "gentle-dot"}) {
            CompanionOverlayService.prefs(context).edit().putString("theme", theme).commit();
            Notification notice = (Notification) status.invoke(service, "Alertas conectadas");
            assertEquals("capri".equals(theme) ? "Capri" : "Gentle Dot", notice.extras.getString(Notification.EXTRA_TITLE));
        }
    }

    @Test public void questionsAndLegacyPermissionsHaveDistinctCopy() throws Exception {
        JSONObject question = new JSONObject("{id:'ask',kind:'questionnaire',title:'Which branch?',sessionId:'Review'}");
        assertEquals("agentAttention", NotificationDelivery.dialogEvent(question));
        assertEquals("Pregunta", NotificationDelivery.dialogTitle(question));
        assertEquals("Review te pregunta: Which branch?", NotificationDelivery.dialogBody(question));
        question.remove("kind");
        assertEquals("permission", NotificationDelivery.dialogEvent(question));
        assertEquals("Permiso", NotificationDelivery.dialogTitle(question));
        assertEquals("Review pide permiso: Which branch?", NotificationDelivery.dialogBody(question));
    }
}
