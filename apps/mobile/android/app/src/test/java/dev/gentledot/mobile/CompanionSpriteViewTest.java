package dev.gentledot.mobile;

import static org.junit.Assert.*;
import android.content.Context;
import android.app.Activity;
import android.widget.FrameLayout;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.os.Looper;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.Robolectric;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.GraphicsMode;
import org.robolectric.annotation.LooperMode;

@RunWith(RobolectricTestRunner.class)
@Config(sdk=35)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@LooperMode(LooperMode.Mode.PAUSED)
public class CompanionSpriteViewTest {
    private Context context;
    private ActivityController<Activity> host;
    private FrameLayout container;
    @Before public void setup() { context=RuntimeEnvironment.getApplication(); }
    @After public void cleanup() { if(host!=null)host.pause().stop().destroy(); }
    private void attach(CompanionSpriteView view) {
        if(host==null) {
            host=Robolectric.buildActivity(Activity.class).setup().visible();
            container=new FrameLayout(host.get());host.get().setContentView(container);
        }
        container.addView(view,new FrameLayout.LayoutParams(224,224));
        assertTrue(view.isAttachedToWindow());
    }
    private Bitmap draw(CompanionSpriteView view) {
        view.layout(0,0,224,224);
        Bitmap output=Bitmap.createBitmap(224,224,Bitmap.Config.ARGB_8888);
        view.draw(new Canvas(output));return output;
    }
    private int colored(Bitmap bitmap) {
        int count=0;for(int y=0;y<bitmap.getHeight();y++)for(int x=0;x<bitmap.getWidth();x++)if(Color.alpha(bitmap.getPixel(x,y))>0)count++;return count;
    }
    private void assertCapri(Bitmap bitmap) {
        assertTrue("Sprite paints real pixels",colored(bitmap)>1000);
        assertEquals("Background remains fully transparent",0,bitmap.getPixel(0,0));
        int green=0;
        for(int y=0;y<bitmap.getHeight();y++)for(int x=0;x<bitmap.getWidth();x++) {
            int color=bitmap.getPixel(x,y);
            if(Color.alpha(color)>100&&Color.green(color)>140&&Color.red(color)<100)green++;
        }
        assertTrue("User-drawn green face mask, never the Gentle dot",green>500);
    }
    @Test public void packagedManifestAndPngRenderEveryNativeActionWithAlpha() {
        CompanionSpriteView view=new CompanionSpriteView(context);
        assertTrue(view.theme("capri").ready);
        assertEquals("capri",view.renderState().appliedTheme);
        for(String action:new String[]{"idle","walk","greeting","working","file-away","perch","step-aside","crying","follow-message","curious","attentive","eyes","duo-high-five"}) {
            view.play(action);assertNull(action,view.renderState().error);
            Bitmap rendered=draw(view);
            if("eyes".equals(action)) {
                // This authored glimpse intentionally paints eyes only, not Capri's pink body.
                assertTrue(colored(rendered)>1000);assertEquals(0,rendered.getPixel(0,0));
            } else assertCapri(rendered);
        }
        view.release();
    }
    @Test public void packagedAnimationActuallyAdvancesAndGentleCanBeRestored() {
        CompanionSpriteView view=new CompanionSpriteView(context);view.theme("capri");attach(view);view.active(true);view.play("working");
        Bitmap first=draw(view);
        Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(200));
        Bitmap next=draw(view);assertFalse("Two distinct atlas frames",first.sameAs(next));assertCapri(next);
        view.theme("gentle-dot");assertEquals("gentle-dot",view.renderState().appliedTheme);
        Bitmap gentle=draw(view);assertEquals(Color.rgb(184,154,228),gentle.getPixel(112,112));view.release();
    }
    @Test public void sustainedWorkIsVisiblyDifferentFromIdleAndKeepsAnimating() {
        CompanionSpriteView view=new CompanionSpriteView(context);view.theme("capri");attach(view);view.active(true);
        Bitmap idle=draw(view);view.sustain("working");Bitmap working=draw(view);
        int changed=0;for(int y=0;y<224;y++)for(int x=0;x<224;x++)if(idle.getPixel(x,y)!=working.getPixel(x,y))changed++;
        assertTrue("Working is not a subtly altered idle pose",changed>5000);
        Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(200));assertFalse(working.sameAs(draw(view)));
        Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(12));Bitmap later=draw(view);
        Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(200));assertFalse(later.sameAs(draw(view)));view.release();
    }
    @Test public void missingOptionalActionReturnsToCapriIdle() {
        CompanionSpriteView view=new CompanionSpriteView(context,path->{
            if(path.endsWith(".json")) {
                try(java.io.InputStream input=context.getAssets().open(path)) {
                    org.json.JSONObject manifest=new org.json.JSONObject(new String(input.readAllBytes(),StandardCharsets.UTF_8));
                    manifest.getJSONObject("animations").remove("file-away");
                    return new ByteArrayInputStream(manifest.toString().getBytes(StandardCharsets.UTF_8));
                } catch(org.json.JSONException invalid) { throw new IOException(invalid); }
            }
            return context.getAssets().open(path);
        });
        view.theme("capri");Bitmap idle=draw(view);view.play("file-away");
        assertTrue(view.renderState().ready);assertEquals("capri",view.renderState().appliedTheme);assertNull(view.renderState().error);
        assertTrue(idle.sameAs(draw(view)));view.play("unknown-action");assertCapri(draw(view));view.release();
    }
    @Test public void brokenManifestFailsVisiblyAndNeverPaintsGentleForCapri() {
        CompanionSpriteView view=new CompanionSpriteView(context,path->new ByteArrayInputStream("{}".getBytes(StandardCharsets.UTF_8)));
        CompanionSpriteView.RenderState state=view.theme("capri");
        assertFalse(state.ready);assertNull(state.appliedTheme);assertTrue(state.error.contains("Reintenta"));assertEquals(0,colored(draw(view)));
        view.play("working");assertFalse(view.renderState().ready);assertEquals(0,colored(draw(view)));view.release();
    }
    @Test public void undecodableAtlasFailsButExplicitRetryRecovers() {
        AtomicBoolean missing=new AtomicBoolean(true);
        CompanionSpriteView view=new CompanionSpriteView(context,path->{
            if(missing.get()&&path.endsWith(".png"))return new ByteArrayInputStream(new byte[]{1,2,3});return context.getAssets().open(path);
        });
        assertFalse(view.theme("capri").ready);assertNotNull(view.renderState().error);assertEquals(0,colored(draw(view)));
        missing.set(false);assertTrue(view.theme("capri").ready);assertNull(view.renderState().error);assertCapri(draw(view));view.release();
    }
    @Test public void malformedLaterFrameIsRejectedBeforeCapriCanBeConfirmed() {
        CompanionSpriteView view=new CompanionSpriteView(context,path->{
            if(!path.endsWith(".json"))return context.getAssets().open(path);
            try(java.io.InputStream input=context.getAssets().open(path)) {
                org.json.JSONObject manifest=new org.json.JSONObject(new String(input.readAllBytes(),StandardCharsets.UTF_8));
                manifest.getJSONObject("animations").getJSONObject("idle").getJSONArray("frames").getJSONObject(2).put("x",manifest.getInt("width"));
                return new ByteArrayInputStream(manifest.toString().getBytes(StandardCharsets.UTF_8));
            } catch(org.json.JSONException invalid) { throw new IOException(invalid); }
        });
        assertFalse(view.theme("capri").ready);assertNotNull(view.renderState().error);assertEquals(0,colored(draw(view)));view.release();
    }
    @Test public void manifestReadDoesNotDependOnAvailable() {
        CompanionSpriteView view=new CompanionSpriteView(context,path->new java.io.FilterInputStream(context.getAssets().open(path)) {
            @Override public int available() { return 0; }
            @Override public int read(byte[] bytes,int offset,int length) throws IOException { return super.read(bytes,offset,Math.min(length,13)); }
        });
        assertTrue(view.theme("capri").ready);assertCapri(draw(view));view.release();
    }
    @Test public void idleKeepsBlinkingAcrossCyclesWithoutReloadingAssets() {
        AtomicInteger opens=new AtomicInteger();
        CompanionSpriteView view=new CompanionSpriteView(context,path->{opens.incrementAndGet();return context.getAssets().open(path);});
        view.theme("capri");attach(view);view.active(true);
        int loaded=opens.get();Bitmap first=draw(view);
        Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(3650));
        assertTrue("Idle returns to its first pose",first.sameAs(draw(view)));
        Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(1600));
        assertFalse("Second cycle blinks without a thirty-second freeze",first.sameAs(draw(view)));
        int totalChanges=0;
        for(int window=0;window<10;window++) {
            int changes=0;Bitmap previous=draw(view);
            for(int sample=0;sample<20;sample++) {
                Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(300));
                Bitmap next=draw(view);if(!previous.sameAs(next))changes++;
                previous.recycle();previous=next;
            }
            previous.recycle();totalChanges+=changes;
            assertTrue("Idle visibly changes in every six-second window "+window,changes>=2);
        }
        assertTrue("Idle stays a sparse frame sequence",totalChanges<120);
        assertEquals("Idle reuses decoded bitmap and frames",loaded,opens.get());view.release();
    }
    @Test public void detachStopsTicksAndReattachRestoresThemWithoutAnotherActiveToggle() {
        CompanionSpriteView view=new CompanionSpriteView(context);view.theme("capri");attach(view);view.active(true);view.play("working");
        container.removeView(view);Bitmap detached=draw(view);
        Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(20));
        assertTrue("No animation while detached",detached.sameAs(draw(view)));
        attach(view);
        Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(200));
        assertFalse("Reattachment restores an already-enabled clock",detached.sameAs(draw(view)));view.release();
    }
    @Test public void repeatedRefreshesDoNotDuplicateOrStarveTheFrameClock() {
        CompanionSpriteView observed=new CompanionSpriteView(context),reference=new CompanionSpriteView(context);
        observed.theme("capri");reference.theme("capri");attach(observed);attach(reference);observed.active(true);reference.active(true);
        Bitmap first=draw(observed);
        for(int interval=0;interval<54;interval++) {
            for(int call=0;call<20;call++)observed.active(true);
            Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(100));
            assertTrue("Refresh does not speed up or delay frame "+interval,draw(observed).sameAs(draw(reference)));
        }
        assertFalse("Both clocks advanced after repeated refresh",first.sameAs(draw(observed)));observed.release();reference.release();
    }
    @Test public void activeRefreshRepairsAMissingTickWithoutASeparatePollingWatchdog() throws Exception {
        CompanionSpriteView view=new CompanionSpriteView(context);view.theme("capri");attach(view);view.active(true);view.play("working");
        java.lang.reflect.Field handler=CompanionSpriteView.class.getDeclaredField("handler");handler.setAccessible(true);
        ((android.os.Handler)handler.get(view)).removeCallbacksAndMessages(null);
        Bitmap first=draw(view);view.active(true);
        Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(200));
        assertFalse("An active refresh repairs a cleared callback",first.sameAs(draw(view)));view.release();
    }
    @Test public void pauseHoldsThePoseAndResumeRestartsExactlyOneIdleCycle() {
        CompanionSpriteView view=new CompanionSpriteView(context);view.theme("capri");attach(view);view.active(true);view.play("working");
        Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(200));view.active(false);Bitmap paused=draw(view);
        Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMinutes(1));assertTrue(paused.sameAs(draw(view)));
        view.active(true);Bitmap resumed=draw(view);
        Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(1600));assertFalse(resumed.sameAs(draw(view)));view.release();
    }

}
