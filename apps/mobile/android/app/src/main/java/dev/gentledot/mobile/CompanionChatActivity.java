package dev.gentledot.mobile;

import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;

/** Same trusted Capacitor chat and secure storage, presented as a collapsible bottom sheet. */
public final class CompanionChatActivity extends MainActivity {
    // Capacitor resets every BridgeActivity to AppTheme_NoActionBar before inflating its WebView.
    @Override public void setTheme(int resource) { super.setTheme(R.style.AppTheme_CompanionChat); }
    @Override public void onCreate(Bundle state){
        super.onCreate(state);
        if (getBridge() != null) getBridge().getWebView().setBackgroundColor(android.graphics.Color.TRANSPARENT);
        // A full-size transparent host receives IME insets on Android 15/16, unlike a
        // floating 88%-height window. Only the content is inset to retain the sheet look.
        WindowCompat.setDecorFitsSystemWindows(getWindow(),false);
        getWindow().setGravity(Gravity.BOTTOM);
        getWindow().setLayout(WindowManager.LayoutParams.MATCH_PARENT,WindowManager.LayoutParams.MATCH_PARENT);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        View content=findViewById(android.R.id.content);
        ViewCompat.setOnApplyWindowInsetsListener(content,(view,insets)->{
            Insets bars=insets.getInsets(WindowInsetsCompat.Type.systemBars());
            int ime=insets.getInsets(WindowInsetsCompat.Type.ime()).bottom;
            view.setPadding(bars.left,Math.max(Math.round(getResources().getDisplayMetrics().heightPixels*.12f),bars.top),
                bars.right,Math.max(bars.bottom,ime));
            // Native layout owns these insets; do not let the WebView apply them twice.
            return WindowInsetsCompat.CONSUMED;
        });
        content.setPadding(0,Math.round(getResources().getDisplayMetrics().heightPixels*.12f),0,0);
        ViewCompat.requestApplyInsets(content);
        setFinishOnTouchOutside(false);
    }
}
