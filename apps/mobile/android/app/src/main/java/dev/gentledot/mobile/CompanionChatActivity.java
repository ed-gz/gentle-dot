package dev.gentledot.mobile;

import android.os.Bundle;
import android.view.Gravity;
import android.view.WindowManager;

/** Same trusted Capacitor chat and secure storage, presented as a collapsible bottom window. */
public final class CompanionChatActivity extends MainActivity {
    // Capacitor resets every BridgeActivity to AppTheme_NoActionBar before inflating its WebView.
    // Preserve this activity's floating window attributes at that same lifecycle point.
    @Override public void setTheme(int resource) { super.setTheme(R.style.AppTheme_CompanionChat); }
    @Override public void onCreate(Bundle state){
        super.onCreate(state);
        if (getBridge() != null) getBridge().getWebView().setBackgroundColor(android.graphics.Color.TRANSPARENT);
        getWindow().setGravity(Gravity.BOTTOM);
        getWindow().setLayout(WindowManager.LayoutParams.MATCH_PARENT,(int)(getResources().getDisplayMetrics().heightPixels*.88f));
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        setFinishOnTouchOutside(false);
    }
}
