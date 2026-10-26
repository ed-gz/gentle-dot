package dev.gentledot.mobile;

import static org.junit.Assert.*;
import android.app.Application;
import android.content.ComponentName;
import android.content.pm.PackageManager;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk=35)
public class NativeIdentityTest {
    @Test public void capriUsesItsOwnSmallIconAndLimeAccent() {
        assertEquals(R.drawable.ic_notification_capri, NotificationAppearance.icon("capri"));
        assertEquals(0xffbcf86a, NotificationAppearance.color("capri"));
    }
    @Test public void everyOtherThemePreservesTheDefaultNotificationAppearance() {
        for (String theme : new String[]{"gentle-dot", "gentle", "dark", "", null}) {
            assertEquals(R.drawable.ic_notification, NotificationAppearance.icon(theme));
            assertEquals(android.app.Notification.COLOR_DEFAULT, NotificationAppearance.color(theme));
        }
    }
    @Test public void launcherPlanEnablesFirstDoesNotKillAndSkipsRepeatedWrites() {
        java.util.Map<String,Integer> states = new java.util.HashMap<>();
        java.util.List<String> writes = new java.util.ArrayList<>();
        LauncherIcon.Components components = new LauncherIcon.Components() {
            public int state(String alias) { return states.getOrDefault(alias, PackageManager.COMPONENT_ENABLED_STATE_DEFAULT); }
            public void set(String alias, int state, int flags) {
                assertEquals(PackageManager.DONT_KILL_APP, flags);
                writes.add(alias + ":" + state);
                states.put(alias, state);
            }
        };
        LauncherIcon.apply("gentle-dot", components);
        assertTrue(writes.isEmpty());
        LauncherIcon.apply("capri", components);
        assertEquals(java.util.Arrays.asList(".CapriLauncher:1", ".DefaultLauncher:2"), writes);
        LauncherIcon.apply("capri", components);
        assertEquals(2, writes.size());
        LauncherIcon.apply("gentle-dot", components);
        assertEquals(".DefaultLauncher:1", writes.get(2));
        assertEquals(".CapriLauncher:2", writes.get(3));
        assertEquals(".DefaultLauncher", LauncherIcon.selectedAlias(null));
    }
    @Test public void notificationBuilderKeepsContentAndChannelAndBrandsPublicVersion() {
        Application context = RuntimeEnvironment.getApplication();
        for (String theme : new String[]{"capri", "gentle-dot"}) {
            CompanionOverlayService.prefs(context).edit().putString("theme", theme).commit();
            android.app.Notification publicVersion = NotificationAppearance.builder(context, "original-channel")
                .setContentTitle("Public title").build();
            android.app.Notification notification = NotificationAppearance.builder(context, "original-channel")
                .setContentTitle("Original title").setContentText("Original body").setPublicVersion(publicVersion).build();
            assertEquals("Original title", notification.extras.getString(android.app.Notification.EXTRA_TITLE));
            assertEquals("Original body", notification.extras.getString(android.app.Notification.EXTRA_TEXT));
            assertEquals("original-channel", notification.getChannelId());
            assertEquals(NotificationAppearance.icon(theme), notification.getSmallIcon().getResId());
            assertEquals(NotificationAppearance.icon(theme), notification.publicVersion.getSmallIcon().getResId());
            assertEquals(NotificationAppearance.color(theme), notification.color);
        }
    }
    @Test public void refreshUpdatesOngoingButDoesNotRepostExpiringAlerts() {
        Application context = RuntimeEnvironment.getApplication();
        android.app.NotificationManager manager = context.getSystemService(android.app.NotificationManager.class);
        manager.createNotificationChannel(new android.app.NotificationChannel("identity-test", "Test", android.app.NotificationManager.IMPORTANCE_LOW));
        CompanionOverlayService.prefs(context).edit().putString("theme", "gentle-dot").commit();
        manager.notify("ongoing", 71, NotificationAppearance.builder(context, "identity-test").setContentTitle("Unchanged")
            .setContentText("Same body").setOngoing(true).build());
        manager.notify("alert", 72, NotificationAppearance.builder(context, "identity-test").setTimeoutAfter(12345).build());
        CompanionOverlayService.prefs(context).edit().putString("theme", "capri").commit();
        NotificationAppearance.refreshOngoing(context);
        for (android.service.notification.StatusBarNotification active : manager.getActiveNotifications()) {
            android.app.Notification notice = active.getNotification();
            if (active.getId() == 71) {
                assertEquals(R.drawable.ic_notification_capri, notice.getSmallIcon().getResId());
                assertEquals(0xffbcf86a, notice.color);
                assertEquals("Unchanged", notice.extras.getString(android.app.Notification.EXTRA_TITLE));
                assertEquals("Same body", notice.extras.getString(android.app.Notification.EXTRA_TEXT));
                assertEquals("identity-test", notice.getChannelId());
            } else if (active.getId() == 72) {
                assertEquals(R.drawable.ic_notification, notice.getSmallIcon().getResId());
                assertEquals(12345, notice.getTimeoutAfter());
            }
        }
        assertEquals(android.app.NotificationManager.IMPORTANCE_LOW, manager.getNotificationChannel("identity-test").getImportance());
    }
    @Test public void launcherSwitchIsReversibleAndRepeatable() {
        Application context = RuntimeEnvironment.getApplication();
        PackageManager manager = context.getPackageManager();
        ComponentName capri = new ComponentName(context.getPackageName(), context.getPackageName()+".CapriLauncher");
        ComponentName gentle = new ComponentName(context.getPackageName(), context.getPackageName()+".DefaultLauncher");
        for (int i=0; i<2; i++) {
            LauncherIcon.apply(context, "capri");
            assertEquals(PackageManager.COMPONENT_ENABLED_STATE_ENABLED, manager.getComponentEnabledSetting(capri));
            assertEquals(PackageManager.COMPONENT_ENABLED_STATE_DISABLED, manager.getComponentEnabledSetting(gentle));
            LauncherIcon.apply(context, "gentle-dot");
            assertEquals(PackageManager.COMPONENT_ENABLED_STATE_ENABLED, manager.getComponentEnabledSetting(gentle));
            assertEquals(PackageManager.COMPONENT_ENABLED_STATE_DISABLED, manager.getComponentEnabledSetting(capri));
        }
    }
}
