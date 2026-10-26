package dev.gentledot.mobile;

import static org.junit.Assert.*;
import android.graphics.Bitmap;
import java.io.*;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk=35)
public class Companion3DTest {
    private CompanionSpriteView fixture(boolean present, boolean invalid) throws Exception {
        JSONObject animations=new JSONObject();
        for(String name:new String[]{"idle","thinking","talking","laughing","greeting","typing","error"})
            animations.put(name,new JSONObject("{\"canvas\":{\"width\":4,\"height\":6},\"frames\":[{\"x\":0,\"y\":0,\"width\":2,\"height\":2,\"offsetX\":1,\"offsetY\":2,\"durationMs\":83}]}"));
        if(invalid)animations.getJSONObject("idle").getJSONArray("frames").getJSONObject(0).put("x",4);
        byte[] json=new JSONObject().put("width",2).put("height",2).put("image","companion/capri-3d-core-v1.png").put("animations",animations).toString().getBytes(StandardCharsets.UTF_8);
        ByteArrayOutputStream png=new ByteArrayOutputStream();
        Bitmap.createBitmap(2,2,Bitmap.Config.ARGB_8888).compress(Bitmap.CompressFormat.PNG,100,png);
        return new CompanionSpriteView(RuntimeEnvironment.getApplication(),path->{
            if(path.contains("capri-3d-")) {
                if(!present)throw new FileNotFoundException(path);
                return new ByteArrayInputStream(path.endsWith(".json")?json:png.toByteArray());
            }
            return RuntimeEnvironment.getApplication().getAssets().open(path);
        });
    }
    private String sheet(CompanionSpriteView view) throws Exception {
        java.lang.reflect.Field field=CompanionSpriteView.class.getDeclaredField("sheet");field.setAccessible(true);return (String)field.get(view);
    }
    @Test public void synthetic3DManifestSelectedAndAllMappedActionsResolve() throws Exception {
        CompanionSpriteView view=fixture(true,false);assertTrue(view.theme("capri").ready);
        for(String action:new String[]{"idle","working","eyes","curious","attentive","duo-high-five","crying","follow-message","walk","greeting"}) {
            view.play(action);assertTrue(action,view.renderState().ready);assertEquals(action,"3d-core",sheet(view));
        }
        view.release();
    }
    @Test public void nativeActionsHaveExplicitNearest3DClips() throws Exception {
        String[][] cases={{"idle","idle"},{"working","thinking"},{"eyes","typing"},{"curious","thinking"},{"attentive","greeting"},{"duo-high-five","laughing"},{"crying","error"},{"follow-message","talking"},{"walk","idle"}};
        for(String[] item:cases)assertEquals(item[0],item[1],CompanionSpriteView.threeAnimationFor(item[0]));
        try { CompanionSpriteView.threeAnimationFor("unknown");fail("Unknown actions must be rejected"); } catch(IOException expected) { }
    }
    @Test public void personalGeneratedAtlasValidatesWhenPresent() throws Exception {
        try(java.io.InputStream input=RuntimeEnvironment.getApplication().getAssets().open("companion/capri-3d-core-v1.json")) { }
        catch(IOException absent) { org.junit.Assume.assumeNoException(absent); }
        CompanionSpriteView view=new CompanionSpriteView(RuntimeEnvironment.getApplication());
        assertTrue(view.theme("capri").ready);
        for(String action:new String[]{"idle","working","eyes","curious","attentive","duo-high-five","crying","follow-message"}) {
            view.play(action);assertEquals(action,"3d-core",sheet(view));
        }
        view.release();
    }
    @Test public void missing3DSheetKeepsTwoDimensionalFallback() throws Exception {
        CompanionSpriteView view=fixture(false,false);assertTrue(view.theme("capri").ready);assertEquals("core",sheet(view));view.release();
    }
    @Test public void invalid3DFrameIsRejectedAndFallsBackWithoutWeakeningValidation() throws Exception {
        CompanionSpriteView view=fixture(true,true);assertTrue(view.theme("capri").ready);assertEquals("core",sheet(view));view.release();
    }
}
