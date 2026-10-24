package dev.gentledot.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import android.app.Application;
import android.content.Intent;
import org.robolectric.RuntimeEnvironment;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowSettings;

@RunWith(RobolectricTestRunner.class)
@Config(sdk=35)
public class MonitorRestoreReceiverTest {
    private Application context;
    @Before public void setUp() {
        context=RuntimeEnvironment.getApplication();
        ShadowSettings.setCanDrawOverlays(true);
    }
    private Intent started() {
        Intent intent;
        while((intent=Shadows.shadowOf(context).getNextStartedService())!=null)
            if(intent.getComponent()!=null&&CompanionOverlayService.class.getName().equals(intent.getComponent().getClassName()))return intent;
        return null;
    }
    @Test public void packageUpdateAndBootBringBackAnEnabledCompanion() {
        CompanionOverlayService.prefs(context).edit().putBoolean("enabled",true).apply();
        for(String action:new String[]{Intent.ACTION_MY_PACKAGE_REPLACED,Intent.ACTION_BOOT_COMPLETED}) {
            new MonitorRestoreReceiver().onReceive(context,new Intent(action));
            Intent intent=started();
            assertEquals(action,CompanionOverlayService.class.getName(),intent==null?null:intent.getComponent().getClassName());
        }
    }
    @Test public void aDisabledCompanionStaysOff() {
        CompanionOverlayService.prefs(context).edit().putBoolean("enabled",false).apply();
        new MonitorRestoreReceiver().onReceive(context,new Intent(Intent.ACTION_MY_PACKAGE_REPLACED));
        assertNull(started());
    }
}
