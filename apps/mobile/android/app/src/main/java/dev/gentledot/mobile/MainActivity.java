package dev.gentledot.mobile;
import android.os.Bundle;
import android.content.Intent;
import com.getcapacitor.BridgeActivity;
public class MainActivity extends BridgeActivity {
    private static int visibleActivities;
    static boolean isVisible() { return visibleActivities > 0; }
    @Override public void onResume() { super.onResume(); visibleActivities++; AgentMonitorService.resumeSaved(this); CompanionOverlayService.resumeSaved(this); CompanionOverlayService.refresh(); }
    @Override public void onPause() { visibleActivities = Math.max(0, visibleActivities - 1); CompanionOverlayService.refresh(); super.onPause(); }
    @Override public void onNewIntent(Intent intent) { super.onNewIntent(intent); setIntent(intent); }
    @Override public void onCreate(Bundle state) {
        registerPlugin(GentleMobilePlugin.class);
        super.onCreate(state);
    }
}
