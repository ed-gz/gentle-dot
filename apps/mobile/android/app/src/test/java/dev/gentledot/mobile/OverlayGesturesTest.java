package dev.gentledot.mobile;

import static org.junit.Assert.*;
import org.junit.Test;

@org.junit.runner.RunWith(org.robolectric.RobolectricTestRunner.class)
@org.robolectric.annotation.Config(sdk=35)
@org.robolectric.annotation.LooperMode(org.robolectric.annotation.LooperMode.Mode.PAUSED)
public class OverlayGesturesTest {
    private void withOverlay(java.util.function.Consumer<CompanionOverlayService> check) {
        android.content.Context context=org.robolectric.RuntimeEnvironment.getApplication();
        org.robolectric.shadows.ShadowSettings.setCanDrawOverlays(true);
        org.robolectric.Shadows.shadowOf(context.getSystemService(android.os.PowerManager.class)).setIsInteractive(true);
        org.robolectric.Shadows.shadowOf(context.getSystemService(android.app.KeyguardManager.class)).setKeyguardLocked(false);
        CompanionOverlayService.prefs(context).edit().clear().putBoolean("enabled",true).putBoolean("pinned",true).putString("theme","capri").commit();
        org.robolectric.android.controller.ServiceController<CompanionOverlayService> controller=
            org.robolectric.Robolectric.buildService(CompanionOverlayService.class).create().startCommand(0,1);
        try { check.accept(controller.get()); } finally { controller.destroy(); }
    }
    private Object field(CompanionOverlayService service,String name) {
        try { java.lang.reflect.Field field=CompanionOverlayService.class.getDeclaredField(name);field.setAccessible(true);return field.get(service); }
        catch(ReflectiveOperationException error) { throw new AssertionError(error); }
    }
    private long downAt;
    private void touch(CompanionOverlayService service,int action,float x) {
        if(action==android.view.MotionEvent.ACTION_DOWN)downAt=android.os.SystemClock.uptimeMillis();
        android.view.MotionEvent event=android.view.MotionEvent.obtain(downAt,android.os.SystemClock.uptimeMillis(),action,x,40,0);
        try { ((android.view.View)field(service,"sprite")).dispatchTouchEvent(event); } finally { event.recycle(); }
    }
    private void advance(long millis) {
        org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idleFor(java.time.Duration.ofMillis(millis));
    }
    @Test public void actualHoldShowsBottomCenterButtonAndXReusesPersistedOffPath() {
        withOverlay(service->{
            touch(service,android.view.MotionEvent.ACTION_DOWN,40);advance(android.view.ViewConfiguration.getLongPressTimeout());
            android.view.View button=(android.view.View)field(service,"dismissButton");assertNotNull(button);
            android.view.WindowManager.LayoutParams layout=(android.view.WindowManager.LayoutParams)button.getLayoutParams();
            assertEquals(android.view.Gravity.BOTTOM|android.view.Gravity.CENTER_HORIZONTAL,layout.gravity);
            assertEquals(Math.round(48*service.getResources().getDisplayMetrics().density),layout.width);
            assertTrue(CompanionOverlayService.prefs(service).getBoolean("pinned",false));
            button.performClick();
            assertFalse(CompanionOverlayService.prefs(service).getBoolean("enabled",true));
            assertNull(field(service,"dismissButton"));assertFalse((Boolean)field(service,"attached"));
        });
    }
    @Test public void actualTapAndTimeoutRemoveOnlyTheXAndHoldReleaseDoesNotOpenChat() {
        withOverlay(service->{
            touch(service,android.view.MotionEvent.ACTION_DOWN,40);advance(android.view.ViewConfiguration.getLongPressTimeout());
            touch(service,android.view.MotionEvent.ACTION_UP,40);
            assertNull(org.robolectric.Shadows.shadowOf(service).getNextStartedActivity());
            touch(service,android.view.MotionEvent.ACTION_DOWN,40);touch(service,android.view.MotionEvent.ACTION_UP,40);
            assertNull(field(service,"dismissButton"));assertTrue(CompanionOverlayService.prefs(service).getBoolean("enabled",false));
            assertNull(org.robolectric.Shadows.shadowOf(service).getNextStartedActivity());
            touch(service,android.view.MotionEvent.ACTION_DOWN,40);advance(android.view.ViewConfiguration.getLongPressTimeout());
            touch(service,android.view.MotionEvent.ACTION_UP,40);advance(5000);
            assertNull(field(service,"dismissButton"));assertTrue((Boolean)field(service,"attached"));
        });
    }
    @Test public void actualDragCancelsHoldAndReleasesPinAndLockRemovesX() {
        withOverlay(service->{
            touch(service,android.view.MotionEvent.ACTION_DOWN,40);touch(service,android.view.MotionEvent.ACTION_MOVE,200);advance(800);
            touch(service,android.view.MotionEvent.ACTION_UP,200);
            assertNull(field(service,"dismissButton"));assertFalse(CompanionOverlayService.prefs(service).getBoolean("pinned",true));
            touch(service,android.view.MotionEvent.ACTION_DOWN,40);advance(android.view.ViewConfiguration.getLongPressTimeout());
            assertNotNull(field(service,"dismissButton"));
            org.robolectric.Shadows.shadowOf(service.getSystemService(android.app.KeyguardManager.class)).setKeyguardLocked(true);
            service.sendBroadcast(new android.content.Intent(android.content.Intent.ACTION_SCREEN_OFF));advance(0);
            assertNull(field(service,"dismissButton"));assertFalse((Boolean)field(service,"attached"));
        });
    }
    @Test public void holdFiresAtThePlatformTimeoutAndOnlyOnce() {
        OverlayGestures gestures = new OverlayGestures(500);
        gestures.down();
        assertEquals(OverlayGestures.Decision.NONE, gestures.hold(499));
        assertEquals(OverlayGestures.Decision.LONG_PRESS, gestures.hold(500));
        assertTrue(gestures.dismissVisible());
        assertEquals(OverlayGestures.Decision.NONE, gestures.hold(700));
        assertEquals(OverlayGestures.Decision.NONE, gestures.up(800));
        assertTrue(gestures.dismissVisible());
    }
    @Test public void tapClosesTheAffordanceWithoutOpeningChatThenNormalTapOpensChat() {
        OverlayGestures gestures = new OverlayGestures(500);
        gestures.down(); gestures.hold(500); gestures.up(600);
        gestures.down();
        assertEquals(OverlayGestures.Decision.DISMISS, gestures.up(100));
        assertFalse(gestures.dismissVisible());
        gestures.down();
        assertEquals(OverlayGestures.Decision.TAP, gestures.up(100));
    }
    @Test public void dragIsStickyEvenAfterReturningToTheStartAndNeverLongPresses() {
        OverlayGestures gestures = new OverlayGestures(500);
        gestures.down();
        assertEquals(OverlayGestures.Decision.DRAG, gestures.move(true));
        gestures.move(false);
        assertEquals(OverlayGestures.Decision.NONE, gestures.hold(900));
        assertEquals(OverlayGestures.Decision.DRAG, gestures.up(1000));
        assertFalse(gestures.dismissVisible());
    }
    @Test public void timeoutCancelAndVisibilityLossClearTheAffordance() {
        OverlayGestures gestures = new OverlayGestures(500);
        gestures.down(); gestures.hold(500);
        gestures.hide();
        assertFalse(gestures.dismissVisible());
        assertEquals(OverlayGestures.Decision.NONE, gestures.hold(1000));
        assertEquals(OverlayGestures.Decision.NONE, gestures.up(1000));
        gestures.down(); gestures.cancel();
        assertEquals(OverlayGestures.Decision.NONE, gestures.hold(1000));
        assertEquals(OverlayGestures.Decision.NONE, gestures.up(1000));
    }
    @Test public void repeatedHoldTogglesAndLateReleaseStillRecognizesLongPress() {
        OverlayGestures gestures = new OverlayGestures(500);
        gestures.down();
        assertEquals(OverlayGestures.Decision.LONG_PRESS, gestures.up(500));
        assertTrue(gestures.dismissVisible());
        gestures.down(); gestures.hold(500); gestures.up(600);
        assertFalse(gestures.dismissVisible());
    }
    @Test public void dragAlsoClearsAnAlreadyVisibleAffordance() {
        OverlayGestures gestures = new OverlayGestures(500);
        gestures.down(); gestures.hold(500); gestures.up(600);
        gestures.down(); gestures.move(true);
        assertFalse(gestures.dismissVisible());
    }
}
