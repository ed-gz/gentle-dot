package dev.gentledot.mobile;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Restores existing opt-ins after boot or update: the encrypted notification monitor and an enabled companion. Never a new pairing. */
public final class MonitorRestoreReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        if (Intent.ACTION_BOOT_COMPLETED.equals(action) || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            AgentMonitorService.resumeSaved(context);
            CompanionOverlayService.resumeSaved(context);
        }
    }
}
