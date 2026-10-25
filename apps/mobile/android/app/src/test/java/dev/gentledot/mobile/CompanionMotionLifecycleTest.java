package dev.gentledot.mobile;

import static org.junit.Assert.*;
import android.app.KeyguardManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.provider.Settings;
import android.view.MotionEvent;
import java.lang.reflect.Field;
import java.time.Duration;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.android.controller.ServiceController;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.GraphicsMode;
import org.robolectric.annotation.LooperMode;
import org.robolectric.shadows.ShadowSettings;

@RunWith(RobolectricTestRunner.class)
@Config(sdk=35, shadows=CompanionChatActivityTest.ShadowBridgeActivity.class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@LooperMode(LooperMode.Mode.PAUSED)
public class CompanionMotionLifecycleTest {
    private Context context;
    private PowerManager power;
    private ServiceController<CompanionOverlayService> controller;
    private CompanionSpriteView sprite;
    @Before public void setup() throws Exception {
        context=RuntimeEnvironment.getApplication();power=context.getSystemService(PowerManager.class);
        ShadowSettings.setCanDrawOverlays(true);Shadows.shadowOf(power).setIsInteractive(true);
        Shadows.shadowOf(context.getSystemService(KeyguardManager.class)).setKeyguardLocked(false);
        Settings.Global.putFloat(context.getContentResolver(),Settings.Global.ANIMATOR_DURATION_SCALE,1f);
        CompanionOverlayService.prefs(context).edit().clear().putBoolean("enabled",true).putString("theme","capri").commit();
        controller=Robolectric.buildService(CompanionOverlayService.class).create().startCommand(0,1);
        Field field=CompanionOverlayService.class.getDeclaredField("sprite");field.setAccessible(true);sprite=(CompanionSpriteView)field.get(controller.get());
        Shadows.shadowOf(Looper.getMainLooper()).idle();assertTrue(sprite.isAttachedToWindow());
    }
    @After public void cleanup() { CompanionOverlayService.activity("test","idle"); if(controller!=null)controller.destroy(); }
    private Bitmap draw() {
        sprite.layout(0,0,224,224);Bitmap bitmap=Bitmap.createBitmap(224,224,Bitmap.Config.ARGB_8888);sprite.draw(new Canvas(bitmap));return bitmap;
    }
    private void event(String action) { context.sendBroadcast(new Intent(action));Shadows.shadowOf(Looper.getMainLooper()).idle(); }
    private void advance(long millis) { Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(millis)); }
    @Test public void batterySaverPausesAndResumesTheActualRenderer() {
        Shadows.shadowOf(power).setIsPowerSaveMode(true);event(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED);
        Bitmap quiet=draw();advance(15_000);assertTrue("Battery saver holds the pose",quiet.sameAs(draw()));
        Shadows.shadowOf(power).setIsPowerSaveMode(false);event(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED);
        Bitmap resumed=draw();advance(1700);assertFalse("Leaving saver resumes a discrete idle cycle",resumed.sameAs(draw()));
    }
    @Test public void reducedMotionChangesPauseWithoutReopeningTheApp() {
        Settings.Global.putFloat(context.getContentResolver(),Settings.Global.ANIMATOR_DURATION_SCALE,0f);
        context.getContentResolver().notifyChange(Settings.Global.getUriFor(Settings.Global.ANIMATOR_DURATION_SCALE),null);
        Shadows.shadowOf(Looper.getMainLooper()).idle();Bitmap quiet=draw();advance(15_000);assertTrue(quiet.sameAs(draw()));
        Settings.Global.putFloat(context.getContentResolver(),Settings.Global.ANIMATOR_DURATION_SCALE,1f);
        context.getContentResolver().notifyChange(Settings.Global.getUriFor(Settings.Global.ANIMATOR_DURATION_SCALE),null);
        Shadows.shadowOf(Looper.getMainLooper()).idle();Bitmap resumed=draw();advance(1700);assertFalse(resumed.sameAs(draw()));
    }
    @Test public void lockAndScreenOffHideAndStopThenUnlockRestartsAnimation() {
        Shadows.shadowOf(power).setIsInteractive(false);event(Intent.ACTION_SCREEN_OFF);assertFalse(CompanionOverlayService.presenting());
        Bitmap off=draw();advance(15_000);assertTrue(off.sameAs(draw()));
        Shadows.shadowOf(context.getSystemService(KeyguardManager.class)).setKeyguardLocked(true);
        Shadows.shadowOf(power).setIsInteractive(true);event(Intent.ACTION_SCREEN_ON);assertFalse(CompanionOverlayService.presenting());
        Shadows.shadowOf(context.getSystemService(KeyguardManager.class)).setKeyguardLocked(false);event(Intent.ACTION_USER_PRESENT);
        assertTrue(CompanionOverlayService.presenting());Bitmap awake=draw();advance(1700);assertFalse(awake.sameAs(draw()));
    }
    @Test public void chatKeepsActualOverlayAndTapIsANoOpButFullAppHidesIt() {
        try (org.robolectric.android.controller.ActivityController<CompanionChatActivity> chat=
                Robolectric.buildActivity(CompanionChatActivity.class).setup()) {
            Shadows.shadowOf(Looper.getMainLooper()).idle();
            assertTrue("Service keeps the sprite attached over partial chat",sprite.isAttachedToWindow());
            sprite.performClick();
            assertNull(Shadows.shadowOf(controller.get()).getNextStartedActivity());
            Shadows.shadowOf(context.getSystemService(KeyguardManager.class)).setKeyguardLocked(true);
            event(Intent.ACTION_SCREEN_ON);
            assertFalse("Chat does not bypass keyguard",sprite.isAttachedToWindow());
            Shadows.shadowOf(context.getSystemService(KeyguardManager.class)).setKeyguardLocked(false);
            event(Intent.ACTION_USER_PRESENT);
            assertTrue(sprite.isAttachedToWindow());
        }
        try (org.robolectric.android.controller.ActivityController<MainActivity> app=
                Robolectric.buildActivity(MainActivity.class).setup()) {
            Shadows.shadowOf(Looper.getMainLooper()).idle();
            assertFalse("Full app composer remains unobstructed",sprite.isAttachedToWindow());
        }
        Shadows.shadowOf(Looper.getMainLooper()).idle();
        assertTrue("Leaving the full app restores Capri",sprite.isAttachedToWindow());
    }
    @Test public void stickyNullIntentRestoresEnabledOverlay() {
        assertEquals(android.app.Service.START_STICKY,controller.get().onStartCommand(null,0,2));
        assertTrue(CompanionOverlayService.running());
        assertTrue(CompanionOverlayService.presenting());
    }
    @Test public void userPresentRechecksWhenKeyguardDismissalIsLate() {
        Shadows.shadowOf(context.getSystemService(KeyguardManager.class)).setKeyguardLocked(true);
        event(Intent.ACTION_SCREEN_ON);event(Intent.ACTION_USER_PRESENT);
        assertFalse(CompanionOverlayService.presenting());
        Shadows.shadowOf(context.getSystemService(KeyguardManager.class)).setKeyguardLocked(false);
        advance(600);assertTrue(CompanionOverlayService.presenting());
    }
    @Test public void workingLoopsAndReturnsAfterTemporaryReaction() throws Exception {
        CompanionOverlayService.activity("test","working");Shadows.shadowOf(Looper.getMainLooper()).idle();
        Field action=CompanionSpriteView.class.getDeclaredField("action");action.setAccessible(true);
        advance(12_000);assertEquals("working",action.get(sprite));
        CompanionOverlayService.react("agentAvailable");Shadows.shadowOf(Looper.getMainLooper()).idle();
        assertEquals("An available agent cannot cancel another working agent","working",action.get(sprite));
        CompanionOverlayService.react("agentCompleted");Shadows.shadowOf(Looper.getMainLooper()).idle();
        assertEquals("duo-high-five",action.get(sprite));
        advance(12_000);assertEquals("working",action.get(sprite));
        CompanionOverlayService.activity("test","idle");Shadows.shadowOf(Looper.getMainLooper()).idle();
        assertEquals("idle",action.get(sprite));
    }
    @Test public void socketAgentStateAndPermissionReachSpriteWithoutJavaScript() throws Exception {
        DotMonitorSocket socket=new DotMonitorSocket(context,"https://test.example.ts.net","unused",()->true,()->{},notice->{});
        okhttp3.WebSocket wire=(okhttp3.WebSocket)java.lang.reflect.Proxy.newProxyInstance(
            getClass().getClassLoader(),new Class<?>[]{okhttp3.WebSocket.class},(proxy,method,args)->"send".equals(method.getName())?true:null);
        java.lang.reflect.Method receive=DotMonitorSocket.class.getDeclaredMethod("receive",okhttp3.WebSocket.class,long.class,org.json.JSONObject.class);
        receive.setAccessible(true);
        Field action=CompanionSpriteView.class.getDeclaredField("action");action.setAccessible(true);
        try {
            receive.invoke(socket,wire,1L,new org.json.JSONObject("{\"type\":\"ready\",\"agentState\":\"thinking\"}"));
            Shadows.shadowOf(Looper.getMainLooper()).idle();assertEquals("curious",action.get(sprite));
            receive.invoke(socket,wire,1L,new org.json.JSONObject("{\"type\":\"agent_state\",\"state\":\"working\"}"));
            Shadows.shadowOf(Looper.getMainLooper()).idle();assertEquals("working",action.get(sprite));
            receive.invoke(socket,wire,1L,new org.json.JSONObject("{\"type\":\"ask\",\"ask\":{\"requestId\":\"q1\",\"method\":\"confirm\"}}"));
            Shadows.shadowOf(Looper.getMainLooper()).idle();assertEquals("attentive",action.get(sprite));
            receive.invoke(socket,wire,1L,new org.json.JSONObject("{\"type\":\"ask_resolved\",\"requestId\":\"q1\"}"));
            Shadows.shadowOf(Looper.getMainLooper()).idle();assertEquals("working",action.get(sprite));
            receive.invoke(socket,wire,1L,new org.json.JSONObject("{\"type\":\"agent_state\",\"state\":\"idle\"}"));
            Shadows.shadowOf(Looper.getMainLooper()).idle();assertEquals("idle",action.get(sprite));
            receive.invoke(socket,wire,1L,new org.json.JSONObject("{\"type\":\"agent_state\",\"state\":\"needs_you\"}"));
            Shadows.shadowOf(Looper.getMainLooper()).idle();assertEquals("attentive",action.get(sprite));
            receive.invoke(socket,wire,1L,new org.json.JSONObject("{\"type\":\"agent_state\",\"state\":\"error\"}"));
            Shadows.shadowOf(Looper.getMainLooper()).idle();assertEquals("crying",action.get(sprite));
            advance(12_000);assertEquals("idle",action.get(sprite));
        } finally { socket.close(); }
    }
    @Test public void outcomeSurvivesStateChangesButAttentionPreemptsItAndResolutionResumesWork() throws Exception {
        Field action=CompanionSpriteView.class.getDeclaredField("action");action.setAccessible(true);
        CompanionOverlayService.activity("test","working");Shadows.shadowOf(Looper.getMainLooper()).idle();
        CompanionOverlayService.react("done");Shadows.shadowOf(Looper.getMainLooper()).idle();
        advance(3000);assertEquals("duo-high-five",action.get(sprite));
        CompanionOverlayService.activity("test","idle");Shadows.shadowOf(Looper.getMainLooper()).idle();
        assertEquals("duo-high-five",action.get(sprite));advance(3600);assertEquals("idle",action.get(sprite));
        CompanionOverlayService.react("error");Shadows.shadowOf(Looper.getMainLooper()).idle();assertEquals("crying",action.get(sprite));
        CompanionOverlayService.activity("test","permission");Shadows.shadowOf(Looper.getMainLooper()).idle();assertEquals("attentive",action.get(sprite));
        CompanionOverlayService.react("done");Shadows.shadowOf(Looper.getMainLooper()).idle();assertEquals("attentive",action.get(sprite));
        CompanionOverlayService.activity("test","working");Shadows.shadowOf(Looper.getMainLooper()).idle();assertEquals("working",action.get(sprite));
    }
    @Test public void transientRendererFailureKeepsOptInAndRetries() throws Exception {
        sprite.release();
        java.lang.reflect.Method changed=CompanionOverlayService.class.getDeclaredMethod("rendererChanged",CompanionSpriteView.RenderState.class);
        changed.setAccessible(true);changed.invoke(controller.get(),new CompanionSpriteView.RenderState(null,false,"temporary"));
        Shadows.shadowOf(Looper.getMainLooper()).idle();
        assertTrue(CompanionOverlayService.prefs(context).getBoolean("enabled",false));
        assertFalse(CompanionOverlayService.presenting());
        advance(3100);assertTrue(CompanionOverlayService.presenting());
    }
    @Test public void touchAndDragTriggerActionsAndReturnToLiveIdle() {
        Bitmap idle=draw();long time=SystemClock.uptimeMillis();
        MotionEvent down=MotionEvent.obtain(time,time,MotionEvent.ACTION_DOWN,20,20,0);sprite.dispatchTouchEvent(down);down.recycle();
        Bitmap touched=draw();assertFalse("Touch triggers a greeting",idle.sameAs(touched));
        MotionEvent drag=MotionEvent.obtain(time,time+20,MotionEvent.ACTION_MOVE,100,80,0);sprite.dispatchTouchEvent(drag);drag.recycle();
        Bitmap moving=draw();assertFalse("Drag starts walking",touched.sameAs(moving));advance(160);assertFalse("Walking advances",moving.sameAs(draw()));
        MotionEvent up=MotionEvent.obtain(time,time+200,MotionEvent.ACTION_UP,100,80,0);sprite.dispatchTouchEvent(up);up.recycle();
        advance(1600);Bitmap rested=draw();advance(1700);assertFalse("Reaction returns to blinking idle",rested.sameAs(draw()));
    }
    @Test public void dragMovesAPinnedCompanionAndReleasesThePin() {
        CompanionOverlayService.prefs(context).edit().putBoolean("pinned",true).putInt("x",200).putInt("y",400).apply();
        long time=SystemClock.uptimeMillis();
        MotionEvent down=MotionEvent.obtain(time,time,MotionEvent.ACTION_DOWN,20,20,0);sprite.dispatchTouchEvent(down);down.recycle();
        MotionEvent drag=MotionEvent.obtain(time,time+20,MotionEvent.ACTION_MOVE,140,90,0);sprite.dispatchTouchEvent(drag);drag.recycle();
        MotionEvent up=MotionEvent.obtain(time,time+200,MotionEvent.ACTION_UP,140,90,0);sprite.dispatchTouchEvent(up);up.recycle();
        assertFalse("Dragging is an explicit move request",CompanionOverlayService.prefs(context).getBoolean("pinned",true));
        assertTrue("The new position is saved",CompanionOverlayService.prefs(context).getInt("x",200)!=200);
    }
    @Test public void longPressNeverPinsSilently() {
        sprite.performLongClick();
        assertFalse(CompanionOverlayService.prefs(context).getBoolean("pinned",false));
    }
}
