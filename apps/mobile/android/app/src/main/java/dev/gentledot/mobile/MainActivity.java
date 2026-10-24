package dev.gentledot.mobile;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
public class MainActivity extends BridgeActivity {
    private static volatile boolean visible;
    static boolean isVisible() { return visible; }
    @Override public void onResume() { super.onResume(); visible = true; AgentMonitorService.resumeSaved(this); }
    @Override public void onPause() { visible = false; super.onPause(); }
    @Override public void onCreate(Bundle state) {
        registerPlugin(GentleMobilePlugin.class);
        super.onCreate(state);
    }
}
