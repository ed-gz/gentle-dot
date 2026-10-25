package dev.gentledot.mobile;

import static org.junit.Assert.*;
import android.view.View;
import android.view.WindowManager;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.Shadows;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk=35, shadows=CompanionChatActivityTest.ShadowBridgeActivity.class)
public class CompanionChatActivityTest {
    // Capacitor's real load initializes Chromium service workers, unavailable in Robolectric.
    // Keep the real Android activity/window/lifecycle, omitting only the JS bridge.
    @org.robolectric.annotation.Implements(com.getcapacitor.BridgeActivity.class)
    public static class ShadowBridgeActivity extends org.robolectric.shadows.ShadowActivity {
        @org.robolectric.annotation.Implementation protected void load() {}
    }
    @Test public void partialChatKeepsCapriButFullAppDoesNot() {
        try (ActivityController<CompanionChatActivity> chat=Robolectric.buildActivity(CompanionChatActivity.class).setup()) {
            assertTrue("Chat still counts as foreground for notification routing",MainActivity.isVisible());
            assertTrue("Partial chat must not suppress Capri",CompanionPolicy.visible(true,true,true,false,MainActivity.isFullAppVisible()));
            assertFalse(CompanionPolicy.visible(true,true,true,true,MainActivity.isFullAppVisible()));
            assertFalse(CompanionPolicy.visible(true,true,false,false,MainActivity.isFullAppVisible()));
        }
        try (ActivityController<MainActivity> app=Robolectric.buildActivity(MainActivity.class).setup()) {
            assertFalse("Full app owns its composer",CompanionPolicy.visible(true,true,true,false,MainActivity.isFullAppVisible()));
        }
        assertFalse("Activity visibility is released on pause",MainActivity.isVisible());
    }

    @Test public void repeatedSpriteTapDoesNotLaunchAnotherChat() throws Exception {
        try (ActivityController<CompanionChatActivity> chat=Robolectric.buildActivity(CompanionChatActivity.class).setup()) {
            CompanionOverlayService service=Robolectric.buildService(CompanionOverlayService.class).get();
            java.lang.reflect.Method open=CompanionOverlayService.class.getDeclaredMethod("openChat");
            open.setAccessible(true);
            open.invoke(service);
            assertNull("An open chat makes tapping Capri a no-op",Shadows.shadowOf(service).getNextStartedActivity());
        }
        CompanionOverlayService service=Robolectric.buildService(CompanionOverlayService.class).get();
        java.lang.reflect.Method open=CompanionOverlayService.class.getDeclaredMethod("openChat");
        open.setAccessible(true);open.invoke(service);
        assertEquals(CompanionChatActivity.class.getName(),Shadows.shadowOf(service).getNextStartedActivity().getComponent().getClassName());
    }

    @Test public void keyboardConfigurationChangesDoNotRecreateTheWebView() throws Exception {
        android.content.Context context=org.robolectric.RuntimeEnvironment.getApplication();
        android.content.pm.ActivityInfo info=context.getPackageManager().getActivityInfo(
            new android.content.ComponentName(context,CompanionChatActivity.class),0);
        int changes=android.content.pm.ActivityInfo.CONFIG_KEYBOARD
            | android.content.pm.ActivityInfo.CONFIG_KEYBOARD_HIDDEN
            | android.content.pm.ActivityInfo.CONFIG_SCREEN_SIZE
            | android.content.pm.ActivityInfo.CONFIG_SMALLEST_SCREEN_SIZE;
        assertEquals("Keyboard/layout changes must retain the WebView and its IME selection",changes,info.configChanges & changes);
    }

    @Test public void windowOwnsImeOnceEvenWithCapacitorDecorHandling() {
        try (ActivityController<CompanionChatActivity> chat=Robolectric.buildActivity(CompanionChatActivity.class).setup()) {
            CompanionChatActivity activity=chat.get();
            View decor=activity.getWindow().getDecorView();
            View content=activity.findViewById(android.R.id.content);
            WindowInsetsCompat keyboard=new WindowInsetsCompat.Builder()
                .setInsets(WindowInsetsCompat.Type.systemBars(),Insets.of(0,24,0,48))
                .setInsets(WindowInsetsCompat.Type.ime(),Insets.of(0,0,0,600))
                .setVisible(WindowInsetsCompat.Type.ime(),true).build();
            // Bridge load is shadowed, so supply Capacitor's real outer-window padding
            // as the initial state. The sheet must replace it, not add a second owner.
            decor.setPadding(0,24,0,600);
            for (int i=0;i<3;i++) ViewCompat.dispatchApplyWindowInsets(decor,keyboard);
            assertEquals("Only content owns the keyboard inset",0,decor.getPaddingBottom());
            assertEquals(600,content.getPaddingBottom());
            assertEquals("Platform resizing must not subtract the IME again",
                WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING,
                activity.getWindow().getAttributes().softInputMode & WindowManager.LayoutParams.SOFT_INPUT_MASK_ADJUST);
            int height=1000;
            decor.measure(View.MeasureSpec.makeMeasureSpec(1000,View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(height,View.MeasureSpec.EXACTLY));
            decor.layout(0,0,1000,height);
            android.view.View child=((android.view.ViewGroup)content).getChildAt(0);
            assertTrue("Keyboard must leave visible chat content",child.getHeight()>0);
            assertTrue("Composer stays above the IME",child.getBottom()<=content.getHeight()-600);
        }
    }

    @Test public void imeInsetsReserveComposerSpaceAndRestoreSheetWhenHidden() {
        try (ActivityController<CompanionChatActivity> chat=Robolectric.buildActivity(CompanionChatActivity.class).setup()) {
            CompanionChatActivity activity=chat.get();
            View content=activity.findViewById(android.R.id.content);
            int baseline=content.getPaddingBottom();
            WindowInsetsCompat keyboard=new WindowInsetsCompat.Builder()
                .setInsets(WindowInsetsCompat.Type.systemBars(),Insets.of(0,24,0,48))
                .setInsets(WindowInsetsCompat.Type.ime(),Insets.of(0,0,0,360)).build();
            ViewCompat.dispatchApplyWindowInsets(activity.getWindow().getDecorView(),keyboard);
            assertEquals("Reserve the IME, not IME plus nav bar",360,content.getPaddingBottom());
            assertTrue(content.getPaddingBottom()>baseline);
            int hostHeight=activity.getResources().getDisplayMetrics().heightPixels;
            content.measure(View.MeasureSpec.makeMeasureSpec(1000,View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(hostHeight,View.MeasureSpec.EXACTLY));
            content.layout(0,0,1000,hostHeight);
            android.view.ViewGroup host=(android.view.ViewGroup)content;
            assertTrue("The WebView container/composer ends above the keyboard",
                host.getChildAt(0).getBottom()<=hostHeight-360);
            assertEquals("Use a full-height host so Android delivers IME insets",WindowManager.LayoutParams.MATCH_PARENT,activity.getWindow().getAttributes().height);
            assertFalse("Floating windows do not reliably receive IME resize/insets",activity.getWindow().isFloating());
            int sheetTop=content.getPaddingTop();
            assertEquals(Math.round(activity.getResources().getDisplayMetrics().heightPixels*.12f),sheetTop);
            ViewCompat.dispatchApplyWindowInsets(activity.getWindow().getDecorView(),new WindowInsetsCompat.Builder()
                .setInsets(WindowInsetsCompat.Type.systemBars(),Insets.of(0,24,0,48)).build());
            assertEquals(48,content.getPaddingBottom());
            assertEquals(sheetTop,content.getPaddingTop());
            ViewCompat.dispatchApplyWindowInsets(activity.getWindow().getDecorView(),keyboard);
            assertEquals("Repeated delivery is not cumulative",360,content.getPaddingBottom());
        }
    }
}
