package dev.gentledot.mobile;

import static org.junit.Assert.*;
import android.content.Context;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk=35)
public class CompanionReactionsTest {
    private java.io.InputStream twoD(String path) throws java.io.IOException {
        if(path.contains("capri-3d-"))throw new java.io.IOException("2D regression fixture");
        return RuntimeEnvironment.getApplication().getAssets().open(path);
    }
    @Test public void purposefulKindsSelectDistinctShippedAnimations() {
        String[][] cases={{"working","working"},{"run","working"},{"reading","eyes"},{"read","eyes"},
            {"thinking","curious"},{"typing","eyes"},{"permission","attentive"},{"agentAttention","attentive"},
            {"done","duo-high-five"},{"agentCompleted","duo-high-five"},{"dotReply","duo-high-five"},
            {"error","crying"},{"agentError","crying"},{"idle","idle"},{"submitted","follow-message"}};
        for(String[] item:cases)assertEquals(item[0],item[1],CompanionPolicy.action(item[0]));
    }
    @Test public void aggregationPreservesPriorityAndThinkingInsteadOfFlatteningEverythingToWorking() {
        assertEquals("permission",CompanionPolicy.aggregate(Arrays.asList("done","typing","permission")));
        assertEquals("error",CompanionPolicy.aggregate(Arrays.asList("typing","error","working")));
        assertEquals("done",CompanionPolicy.aggregate(Arrays.asList("working","done")));
        assertEquals("typing",CompanionPolicy.aggregate(Arrays.asList("working","typing")));
        assertEquals("working",CompanionPolicy.aggregate(Arrays.asList("reading","working")));
        assertEquals("thinking",CompanionPolicy.aggregate(Arrays.asList("idle","thinking")));
        assertEquals("reading",CompanionPolicy.aggregate(Arrays.asList("reading","idle")));
    }
    @Test public void everyShippedManifestSelectsItsOwnSheetAndValidatesEveryAnimation() throws Exception {
        Context context=RuntimeEnvironment.getApplication();
        for(String sheet:new String[]{"core","actions","reactions","context","life","glimpses","friends"}) {
            JSONObject manifest;
            try(java.io.InputStream input=context.getAssets().open("companion/capri-motion-"+sheet+"-v1.json")) {
                manifest=new JSONObject(new String(input.readAllBytes(),java.nio.charset.StandardCharsets.UTF_8));
            }
            java.util.Iterator<String> names=manifest.getJSONObject("animations").keys();
            while(names.hasNext()) {
                String animation=names.next();List<String> opened=new ArrayList<>();
                CompanionSpriteView view=new CompanionSpriteView(context,path->{opened.add(path);return twoD(path);});
                view.theme("capri");opened.clear();view.play(animation);
                assertTrue(animation,view.renderState().ready);
                assertTrue(animation+" selects "+sheet,opened.contains("companion/capri-motion-"+sheet+"-v1.json"));
                java.lang.reflect.Field selected=CompanionSpriteView.class.getDeclaredField("action");selected.setAccessible(true);
                assertEquals("Must not silently fall back to idle",animation,selected.get(view));view.release();
            }
        }
    }
    @Test public void debugReceiverRegistersOnlyForDebugAndRejectsUnknownAnimation() {
        Context context=RuntimeEnvironment.getApplication();List<String> received=new ArrayList<>();
        assertNull(CompanionDebug.register(context,false,received::add));
        context.sendBroadcast(new android.content.Intent(CompanionDebug.ACTION).putExtra("animation","crying"));
        org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();assertTrue(received.isEmpty());
        android.content.BroadcastReceiver receiver=CompanionDebug.register(context,true,received::add);
        try {
            context.sendBroadcast(new android.content.Intent(CompanionDebug.ACTION).putExtra("animation","crying"));
            context.sendBroadcast(new android.content.Intent(CompanionDebug.ACTION).putExtra("animation","../../unknown"));
            org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();
            assertEquals(Arrays.asList("crying"),received);
        } finally { context.unregisterReceiver(receiver); }
    }
    @Test public void malformedFramesInEachAdditionalAtlasFallBackWithoutReplacingValidatedIdle() throws Exception {
        Context context=RuntimeEnvironment.getApplication();
        String[][] cases={{"reactions","crying"},{"context","follow-message"},{"life","attentive"},{"glimpses","eyes"},{"friends","duo-high-five"}};
        for(String[] item:cases) {
            CompanionSpriteView view=new CompanionSpriteView(context,path->{
                if(!path.equals("companion/capri-motion-"+item[0]+"-v1.json"))return twoD(path);
                try(java.io.InputStream input=context.getAssets().open(path)) {
                    JSONObject manifest=new JSONObject(new String(input.readAllBytes(),java.nio.charset.StandardCharsets.UTF_8));
                    manifest.getJSONObject("animations").getJSONObject(item[1]).getJSONArray("frames").getJSONObject(1).put("width",99999);
                    return new java.io.ByteArrayInputStream(manifest.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
                } catch(org.json.JSONException invalid) { throw new java.io.IOException(invalid); }
            });
            view.theme("capri");view.play(item[1]);assertTrue(view.renderState().ready);
            java.lang.reflect.Field action=CompanionSpriteView.class.getDeclaredField("action");action.setAccessible(true);
            assertEquals(item[0],"idle",action.get(view));view.release();
        }
    }
    @Test public void switchingSheetsRecyclesPreviousBitmap() throws Exception {
        CompanionSpriteView view=new CompanionSpriteView(RuntimeEnvironment.getApplication(),this::twoD);view.theme("capri");
        java.lang.reflect.Field atlas=CompanionSpriteView.class.getDeclaredField("atlas");atlas.setAccessible(true);
        android.graphics.Bitmap previous=(android.graphics.Bitmap)atlas.get(view);
        for(String name:new String[]{"crying","eyes","curious","duo-high-five","follow-message","idle"}) {
            view.play(name);assertTrue(previous.isRecycled());previous=(android.graphics.Bitmap)atlas.get(view);
        }
        view.release();assertTrue(previous.isRecycled());
    }
    @Test public void debugBroadcastIsExplicitlyDisabledForRelease() throws Exception {
        Class<?> policy=Class.forName("dev.gentledot.mobile.CompanionDebug");
        java.lang.reflect.Method enabled=policy.getDeclaredMethod("enabled",boolean.class);enabled.setAccessible(true);
        assertEquals(false,enabled.invoke(null,false));assertEquals(true,enabled.invoke(null,true));
    }
}
