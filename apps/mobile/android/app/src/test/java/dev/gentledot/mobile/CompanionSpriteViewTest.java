package dev.gentledot.mobile;

import static org.junit.Assert.*;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.os.Looper;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
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
    @Before public void setup() { context=RuntimeEnvironment.getApplication(); }
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
        int pink=0;
        for(int y=0;y<bitmap.getHeight();y++)for(int x=0;x<bitmap.getWidth();x++) {
            int color=bitmap.getPixel(x,y);
            if(Color.alpha(color)>100&&Color.red(color)>170&&Color.green(color)<90&&Color.blue(color)>30)pink++;
        }
        assertTrue("Capri's magenta silhouette, never the Gentle dot",pink>200);
    }
    @Test public void packagedManifestAndPngRenderEveryNativeActionWithAlpha() {
        CompanionSpriteView view=new CompanionSpriteView(context);
        assertTrue(view.theme("capri").ready);
        assertEquals("capri",view.renderState().appliedTheme);
        for(String action:new String[]{"idle","walk","greeting","working","file-away","perch","step-aside"}) {
            view.play(action);assertNull(action,view.renderState().error);assertCapri(draw(view));
        }
        view.release();
    }
    @Test public void packagedAnimationActuallyAdvancesAndGentleCanBeRestored() {
        CompanionSpriteView view=new CompanionSpriteView(context);view.theme("capri");view.active(true);view.play("working");
        Bitmap first=draw(view);
        Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(200));
        Bitmap next=draw(view);assertFalse("Two distinct atlas frames",first.sameAs(next));assertCapri(next);
        view.theme("gentle-dot");assertEquals("gentle-dot",view.renderState().appliedTheme);
        Bitmap gentle=draw(view);assertEquals(Color.rgb(184,154,228),gentle.getPixel(112,112));view.release();
    }
    @Test public void missingOptionalActionReturnsToCapriIdle() {
        CompanionSpriteView view=new CompanionSpriteView(context,path->{
            if(path.contains("actions"))throw new IOException("missing optional atlas");return context.getAssets().open(path);
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
                manifest.getJSONObject("animations").getJSONObject("idle").getJSONArray("frames").getJSONObject(2).put("x",1536);
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
}
