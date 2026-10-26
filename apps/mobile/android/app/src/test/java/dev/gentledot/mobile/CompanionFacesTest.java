package dev.gentledot.mobile;

import static org.junit.Assert.*;
import android.content.Context;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk=35)
public class CompanionFacesTest {
 @Test public void everyActionLoadsOnlyTheValidatedFacesAtlas() throws Exception {
  Context context=RuntimeEnvironment.getApplication();
  JSONObject manifest;
  try(java.io.InputStream input=context.getAssets().open("companion/capri-faces-v1.json")) {
   manifest=new JSONObject(new String(input.readAllBytes(),StandardCharsets.UTF_8));
  }
  assertEquals(1792,manifest.getInt("width"));
  for(String action:new String[]{"idle","walk","greeting","working","file-away","perch","step-aside","coffee","chill","crying","angry","headphones","dancing","capture","follow-message","snack","stretch","curious","attentive","eyes","face","point-left","point-right","duo-watch","duo-coffee","duo-couch","duo-high-five","typing","done","error","thinking","talking","sleep","wake","glitch-transition"}) {
   assertEquals(action,"faces",CompanionSpriteView.sheetFor(action));
   assertTrue(action,manifest.getJSONObject("animations").has(action));
   CompanionSpriteView view=new CompanionSpriteView(context,path->{
    assertTrue(path,path.contains("capri-faces-v1"));return context.getAssets().open(path);
   });
   assertTrue(view.theme("capri").ready);view.play(action);assertTrue(action,view.renderState().ready);view.release();
  }
 }
}
