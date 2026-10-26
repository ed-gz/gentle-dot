package dev.gentledot.mobile;

import android.app.Notification;
import android.app.NotificationManager;
import android.content.Context;
import android.service.notification.StatusBarNotification;
import androidx.core.app.NotificationCompat;

/** Presentation only; never changes notification content, routing or channel policy. */
final class NotificationAppearance {
    static int icon(String theme) {
        return "capri".equals(theme) ? R.drawable.ic_notification_capri : R.drawable.ic_notification;
    }
    static int color(String theme) {
        return "capri".equals(theme) ? 0xffbcf86a : Notification.COLOR_DEFAULT;
    }
    private static String theme(Context context) {
        return CompanionOverlayService.prefs(context).getString("theme", "gentle-dot");
    }
    static NotificationCompat.Builder builder(Context context, String channel) {
        String selected = theme(context);
        return new NotificationCompat.Builder(context, channel).setSmallIcon(icon(selected)).setColor(color(selected));
    }
    static void refreshOngoing(Context context) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        String selected = theme(context);
        try {
            for (StatusBarNotification active : manager.getActiveNotifications()) {
                Notification notice = active.getNotification();
                // Do not re-post alerts: that would reset pending permission/notice expiry.
                if ((notice.flags & Notification.FLAG_ONGOING_EVENT) == 0) continue;
                Notification updated = Notification.Builder.recoverBuilder(context, notice)
                    .setSmallIcon(icon(selected)).setColor(color(selected)).setOnlyAlertOnce(true).build();
                manager.notify(active.getTag(), active.getId(), updated);
            }
        } catch (SecurityException ignored) { /* Notification permission may have been revoked. */ }
    }
}
