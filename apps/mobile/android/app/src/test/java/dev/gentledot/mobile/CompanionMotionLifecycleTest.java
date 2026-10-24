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
@Config(sdk=35)
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
    @After public void cleanup() { if(controller!=null)controller.destroy(); }
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
    @Test public void touchAndDragTriggerActionsAndReturnToLiveIdle() {
        Bitmap idle=draw();long time=SystemClock.uptimeMillis();
        MotionEvent down=MotionEvent.obtain(time,time,MotionEvent.ACTION_DOWN,20,20,0);sprite.dispatchTouchEvent(down);down.recycle();
        Bitmap touched=draw();assertFalse("Touch triggers a greeting",idle.sameAs(touched));
        MotionEvent drag=MotionEvent.obtain(time,time+20,MotionEvent.ACTION_MOVE,100,80,0);sprite.dispatchTouchEvent(drag);drag.recycle();
        Bitmap moving=draw();assertFalse("Drag starts walking",touched.sameAs(moving));advance(160);assertFalse("Walking advances",moving.sameAs(draw()));
        MotionEvent up=MotionEvent.obtain(time,time+200,MotionEvent.ACTION_UP,100,80,0);sprite.dispatchTouchEvent(up);up.recycle();
        advance(1600);Bitmap rested=draw();advance(1700);assertFalse("Reaction returns to blinking idle",rested.sameAs(draw()));
    }
}
