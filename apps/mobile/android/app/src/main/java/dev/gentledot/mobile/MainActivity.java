package dev.gentledot.mobile;
import android.os.Bundle;
import android.content.Intent;
import com.getcapacitor.BridgeActivity;
public class MainActivity extends BridgeActivity {
    private static int visibleActivities, fullAppActivities;
    private boolean resumed;
    static boolean isVisible() { return visibleActivities > 0; }
    static boolean isFullAppVisible() { return fullAppActivities > 0; }
    static boolean isCompanionChatVisible() { return visibleActivities > fullAppActivities; }
    @Override public void onResume() {
        super.onResume();
        if (!resumed) {
            resumed = true;
            visibleActivities++;
            if (!(this instanceof CompanionChatActivity)) fullAppActivities++;
        }
        AgentMonitorService.resumeSaved(this); CompanionOverlayService.resumeSaved(this); CompanionOverlayService.refresh();
    }
    @Override public void onPause() {
        if (resumed) {
            resumed = false;
            visibleActivities = Math.max(0, visibleActivities - 1);
            if (!(this instanceof CompanionChatActivity)) fullAppActivities = Math.max(0, fullAppActivities - 1);
        }
        CompanionOverlayService.refresh(); super.onPause();
    }
    @Override public void onNewIntent(Intent intent) { super.onNewIntent(intent); setIntent(intent); }
    @Override public void onCreate(Bundle state) {
        registerPlugin(GentleMobilePlugin.class);
        super.onCreate(state);
    }
}
