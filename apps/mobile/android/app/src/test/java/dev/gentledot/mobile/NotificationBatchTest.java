package dev.gentledot.mobile;

import static org.junit.Assert.*;
import android.app.Notification;
import android.app.NotificationManager;
import android.content.Context;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Map;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class NotificationBatchTest {
 @Test public void defaultsOnAndRetainsOptOut() {
  assertTrue(new NotificationPreferences("all", null).get("desktopPresence"));
  Map<String, Boolean> saved = new HashMap<>(); saved.put("desktopPresence", false);
  assertFalse(new NotificationPreferences("all", saved).get("desktopPresence"));
 }
 @Test public void groupsSummariesWithOverflowAndRespectsEventPreferences() throws Exception {
  JSONObject batch = new JSONObject("{id:'presence:test',summaries:['Respuesta lista','Dot respondió'],events:['agentCompleted','dotReply'],dropped:3}");
  assertEquals(Arrays.asList("Respuesta lista", "Dot respondió", "+3 más"), NotificationDelivery.batchLines(batch, new NotificationPreferences("all", null)));
  assertEquals(Arrays.asList("Dot respondió", "+3 más"), NotificationDelivery.batchLines(batch, new NotificationPreferences("dot", null)));
 }
 @Test public void suppressesOnlySocketReplyNotificationsNotQuestions() throws Exception {
  Context context = RuntimeEnvironment.getApplication();
  DotMonitorSocket socket = new DotMonitorSocket(context, "https://computer.example.ts.net", "test", () -> true, () -> {}, notice -> {});
  try {
   java.lang.reflect.Method receive = DotMonitorSocket.class.getDeclaredMethod("receive", okhttp3.WebSocket.class, long.class, JSONObject.class);
   receive.setAccessible(true);
   receive.invoke(socket, null, 1L, new JSONObject("{type:'message_done',messageId:'m',text:'Lista',mobileNotificationSuppressed:true}"));
   assertEquals(0, context.getSystemService(NotificationManager.class).getActiveNotifications().length);
   receive.invoke(socket, null, 1L, new JSONObject("{type:'ask',mobileNotificationSuppressed:true,ask:{requestId:'q',method:'select',title:'Which branch?'}}"));
   assertEquals(1, context.getSystemService(NotificationManager.class).getActiveNotifications().length);
  } finally { socket.close(); }
 }
 @Test public void rendersOneGroupedInboxNotificationWithPrivatePublicVersion() throws Exception {
  Context context = RuntimeEnvironment.getApplication();
  AgentMonitorService.notifyBatch(context, new JSONObject("{id:'presence:test',summaries:['Una','Dos'],events:['agentCompleted','dotReply'],dropped:0}"));
  android.service.notification.StatusBarNotification[] active = context.getSystemService(NotificationManager.class).getActiveNotifications();
  assertEquals(1, active.length);
  Notification notice = active[0].getNotification();
  assertEquals("gentledot:presence", notice.getGroup());
  assertTrue((notice.flags & Notification.FLAG_GROUP_SUMMARY) != 0);
  assertArrayEquals(new CharSequence[]{"Una", "Dos"}, notice.extras.getCharSequenceArray(Notification.EXTRA_TEXT_LINES));
  assertEquals("Tienes una nueva alerta.", notice.publicVersion.extras.getString(Notification.EXTRA_TEXT));
 }
}
