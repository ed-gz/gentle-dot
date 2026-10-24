package dev.gentledot.mobile;

import static org.junit.Assert.*;
import android.content.Context;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import androidx.appcompat.app.AppCompatActivity;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import java.io.IOException;
import java.lang.reflect.Field;
import java.util.concurrent.atomic.AtomicReference;
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
public class CompanionRendererContractTest {
    private Context context;
    private ServiceController<CompanionOverlayService> controller;
    private GentleMobilePlugin plugin;
    private static final class Call extends PluginCall {
        JSObject result;String error;
        Call(JSObject data) { super(null,"GentleMobile","test","setCompanion",data); }
        @Override public void resolve(JSObject value) { result=value; }
        @Override public void resolve() { result=new JSObject(); }
        @Override public void reject(String message) { error=message; }
    }
    @Before public void setup() {
        context=RuntimeEnvironment.getApplication();
        CompanionOverlayService.prefs(context).edit().clear().commit();
        ShadowSettings.setCanDrawOverlays(true);
        Shadows.shadowOf(context.getSystemService(PowerManager.class)).setIsInteractive(false);
        AppCompatActivity activity=Robolectric.buildActivity(AppCompatActivity.class).get();
        plugin=new GentleMobilePlugin() {
            @Override public Context getContext() { return context; }
            @Override public AppCompatActivity getActivity() { return activity; }
        };
    }
    @After public void cleanup() { if(controller!=null)controller.destroy(); }
    private void start() {
        CompanionOverlayService.prefs(context).edit().putBoolean("enabled",true).commit();
        controller=Robolectric.buildService(CompanionOverlayService.class).create();
        controller.startCommand(0,1);assertTrue(CompanionOverlayService.running());
    }
    @Test public void changingAnActiveGentleServiceConfirmsOnlyTheLoadedCapriRenderer() {
        start();assertEquals("gentle-dot",CompanionOverlayService.renderState().appliedTheme);
        Call call=new Call(new JSObject().put("theme","capri"));plugin.setCompanion(call);
        // configure runs on the same UI turn, before promise completion.
        assertTrue(CompanionOverlayService.renderState().ready);assertEquals("capri",CompanionOverlayService.renderState().appliedTheme);
        Shadows.shadowOf(Looper.getMainLooper()).idle();
        assertNull(call.error);assertNotNull(call.result);assertTrue(call.result.getBoolean("renderReady",false));assertEquals("capri",call.result.getString("appliedTheme"));
    }
    @Test public void failureRejectsActivationAndSurvivesServiceDestructionForRetry() throws Exception {
        start();
        Field sprite=CompanionOverlayService.class.getDeclaredField("sprite");sprite.setAccessible(true);
        ((CompanionSpriteView)sprite.get(controller.get())).release();
        sprite.set(controller.get(),new CompanionSpriteView(context,path->{throw new IOException("private internal path must not escape");}));
        Call call=new Call(new JSObject().put("theme","capri"));plugin.setCompanion(call);
        Shadows.shadowOf(Looper.getMainLooper()).idle();
        assertNull(call.result);assertNotNull(call.error);assertTrue(call.error.contains("Reintenta"));assertFalse(call.error.contains("private internal"));
        assertFalse(CompanionOverlayService.prefs(context).getBoolean("enabled",true));
        controller.destroy();controller=null;
        Call state=new Call(new JSObject());plugin.companionState(state);
        assertFalse(state.result.getBoolean("active",true));assertFalse(state.result.getBoolean("renderReady",true));assertEquals(call.error,state.result.getString("renderError"));
        AtomicReference<Boolean> receipt=new AtomicReference<>();
        CompanionOverlayService.offer("permission","test","Session","Question","pane","session","",receipt::set);
        assertEquals("Notification caller receives fallback",Boolean.FALSE,receipt.get());
    }
    @Test public void savingThemeWhileDisabledDoesNotClaimItIsRenderedOrStartAService() {
        Call call=new Call(new JSObject().put("theme","capri"));plugin.setCompanion(call);
        assertNull(call.error);assertNotNull(call.result);assertFalse(call.result.getBoolean("active",true));assertFalse(call.result.getBoolean("renderReady",true));
        assertFalse(CompanionOverlayService.running());assertEquals("capri",CompanionOverlayService.prefs(context).getString("theme",""));
    }
    @Test public void disablingDuringThemeConfirmationCannotResolveActivationAsSuccessful() {
        start();
        Call activation=new Call(new JSObject().put("theme","capri"));plugin.setCompanion(activation);
        Call disable=new Call(new JSObject().put("enabled",false));plugin.setCompanion(disable);
        Shadows.shadowOf(Looper.getMainLooper()).idle();
        assertNull(activation.result);assertNotNull(activation.error);
        assertFalse(disable.result.getBoolean("active",true));assertFalse(disable.result.getBoolean("renderReady",true));
    }
    @Test public void intentionalPauseReportsReasonWithoutLosingRenderConfirmation() {
        start();
        Shadows.shadowOf(context.getSystemService(PowerManager.class)).setIsPowerSaveMode(true);
        Settings.Global.putFloat(context.getContentResolver(),Settings.Global.ANIMATOR_DURATION_SCALE,0f);
        Call battery=new Call(new JSObject());plugin.companionState(battery);
        assertEquals("battery",battery.result.getString("motionPausedReason"));
        assertTrue(battery.result.getBoolean("active",false));assertTrue(battery.result.getBoolean("renderReady",false));
        assertFalse(battery.result.has("renderError"));
        Shadows.shadowOf(context.getSystemService(PowerManager.class)).setIsPowerSaveMode(false);
        Call system=new Call(new JSObject());plugin.companionState(system);assertEquals("system",system.result.getString("motionPausedReason"));
        Settings.Global.putFloat(context.getContentResolver(),Settings.Global.ANIMATOR_DURATION_SCALE,1f);
        Call resumed=new Call(new JSObject());plugin.companionState(resumed);assertFalse(resumed.result.has("motionPausedReason"));
    }
    @Test public void enabledRequiresExplicitForegroundPermissionEvenWhenThemeIsValid() {
        ShadowSettings.setCanDrawOverlays(false);
        Call call=new Call(new JSObject().put("enabled",true).put("theme","capri"));plugin.setCompanion(call);
        assertNotNull(call.error);assertNull(call.result);assertFalse(CompanionOverlayService.running());
        assertFalse(CompanionOverlayService.prefs(context).getBoolean("enabled",false));
    }
}
