package dev.gentledot.mobile;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import androidx.core.content.ContextCompat;
import java.util.function.Consumer;

/** No receiver exists in release. Debug adb preview only accepts known animation keys. */
final class CompanionDebug {
    static final String ACTION="dev.gentledot.mobile.DEBUG_COMPANION";
    static boolean enabled(boolean debugBuild) { return debugBuild; }
    static BroadcastReceiver register(Context context, boolean debugBuild, Consumer<String> preview) {
        if(!enabled(debugBuild))return null;
        BroadcastReceiver receiver=new BroadcastReceiver() {
            @Override public void onReceive(Context ignored, Intent intent) {
                if(!ACTION.equals(intent.getAction()))return;
                String name=intent.getStringExtra("animation");
                if(name==null)return;
                try { CompanionSpriteView.sheetFor(name);preview.accept(name); }
                catch(java.io.IOException invalid) { /* Never accept arbitrary assets/paths. */ }
            }
        };
        ContextCompat.registerReceiver(context,receiver,new IntentFilter(ACTION),ContextCompat.RECEIVER_EXPORTED);
        return receiver;
    }
}
