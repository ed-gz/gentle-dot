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

    @Test public void imeInsetsReserveComposerSpaceAndRestoreSheetWhenHidden() {
        try (ActivityController<CompanionChatActivity> chat=Robolectric.buildActivity(CompanionChatActivity.class).setup()) {
            CompanionChatActivity activity=chat.get();
            View content=activity.findViewById(android.R.id.content);
            int baseline=content.getPaddingBottom();
            WindowInsetsCompat keyboard=new WindowInsetsCompat.Builder()
                .setInsets(WindowInsetsCompat.Type.systemBars(),Insets.of(0,24,0,48))
                .setInsets(WindowInsetsCompat.Type.ime(),Insets.of(0,0,0,360)).build();
            ViewCompat.dispatchApplyWindowInsets(content,keyboard);
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
            ViewCompat.dispatchApplyWindowInsets(content,new WindowInsetsCompat.Builder()
                .setInsets(WindowInsetsCompat.Type.systemBars(),Insets.of(0,24,0,48)).build());
            assertEquals(48,content.getPaddingBottom());
            assertEquals(sheetTop,content.getPaddingTop());
            ViewCompat.dispatchApplyWindowInsets(content,keyboard);
            assertEquals("Repeated delivery is not cumulative",360,content.getPaddingBottom());
        }
    }
}
