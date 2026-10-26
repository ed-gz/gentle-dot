package dev.gentledot.mobile;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.Rect;
import android.graphics.RectF;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.View;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.function.Consumer;
import org.json.JSONArray;
import org.json.JSONObject;

/** Atlas frames are painted with their real alpha. No WebView, GIF decoder or 60fps idle loop. */
final class CompanionSpriteView extends View {
    static final class RenderState {
        final String appliedTheme, error;
        final boolean ready;
        RenderState(String theme, boolean ready, String error) { this.appliedTheme=theme; this.ready=ready; this.error=error; }
        static RenderState unavailable() { return new RenderState(null,false,null); }
    }
    interface Assets { InputStream open(String path) throws IOException; }
    private static final String LOAD_ERROR="No se pudo cargar Capri en este teléfono. Reintenta el personaje desde los ajustes.";
    private final Handler handler=new Handler(Looper.getMainLooper());
    private final Object frameToken=new Object();
    private final Paint paint=new Paint(Paint.ANTI_ALIAS_FLAG|Paint.FILTER_BITMAP_FLAG);
    private final RectF targetRect=new RectF();
    private final Assets assets;
    private Bitmap atlas;
    private Animation animation;
    private int frame;
    private boolean capri, animate, attachedToWindow;
    private String sheet="", action="idle", sustained="idle", reaction="";
    private long reactionUntil;
    private final Runnable endReaction=()->{reaction="";play(sustained);};
    private volatile RenderState state=RenderState.unavailable();
    private Consumer<RenderState> stateListener;
    private final Runnable advance=()->{
        if(!canAnimate())return;
        if(++frame>=animation.frames.length){
            frame=0;
            // Idle already contains a 3.6 s breath/blink cycle. Keep its decoded frames resident.
            if(!CompanionPolicy.loop(action,sustained)&&SystemClock.uptimeMillis()>=reactionUntil)loadOrIdle(sustained);
        }
        invalidate();schedule();
    };

    CompanionSpriteView(Context context) { this(context,path->context.getAssets().open(path)); }
    CompanionSpriteView(Context context,Assets assets) {
        super(context);this.assets=assets;setLayerType(View.LAYER_TYPE_SOFTWARE,null);
        setContentDescription("Abrir conversación con el acompañante. Mantén pulsado para fijar o soltar.");
        setFocusable(true);setClickable(true);setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_YES);
    }
    RenderState renderState() { return state; }
    void onStateChanged(Consumer<RenderState> listener) { stateListener=listener; }
    private void state(RenderState value) { state=value;if(stateListener!=null)stateListener.accept(value); }
    RenderState theme(String name) {
        release();capri="capri".equals(name);frame=0;
        if(capri)loadOrIdle(sustained);else state(new RenderState("gentle-dot",true,null));
        invalidate();schedule();return state;
    }
    void active(boolean value) {
        boolean changed=animate!=value;animate=value;
        if(!value){cancelFrames();return;}
        if(changed&&state.ready)play(sustained);else schedule();
    }
    void sustain(String kind) {
        String next=CompanionPolicy.action(kind);
        if(next.equals(sustained))return;
        sustained=next;
        if(SystemClock.uptimeMillis()<reactionUntil && CompanionPolicy.priority(reaction)>CompanionPolicy.priority(next))return;
        reaction="";reactionUntil=0;handler.removeCallbacks(endReaction);
        play(next);
    }
    void react(String value) {
        if(value.equals(sustained))return;
        if(SystemClock.uptimeMillis()<reactionUntil && CompanionPolicy.priority(reaction)>CompanionPolicy.priority(value))return;
        if(CompanionPolicy.priority(sustained)>CompanionPolicy.priority(value))return;
        reaction=value;reactionUntil=SystemClock.uptimeMillis()+6500;
        handler.removeCallbacks(endReaction);handler.postAtTime(endReaction,reactionUntil);
        play(value);
    }
    void play(String value) {
        cancelFrames();frame=0;
        // Recovery reloads the theme; never paint an unvalidated atlas.
        if(capri&&state.ready)loadOrIdle("idle".equals(value)?sustained:value);
        invalidate();schedule();
    }
    private boolean canAnimate() { return animate&&attachedToWindow&&capri&&state.ready&&animation!=null; }
    private void cancelFrames() { handler.removeCallbacksAndMessages(frameToken); }
    private void schedule() {
        // Refresh/reattach is also a watchdog: repair a missing tick without resetting a live one.
        if(canAnimate()&&!handler.hasMessages(0,frameToken))
            handler.postAtTime(advance,frameToken,SystemClock.uptimeMillis()+animation.frames[frame].duration);
    }
    private void loadOrIdle(String name) {
        try { load(name); }
        catch(Exception error) {
            if(!"idle".equals(name)) {
                try { load("idle");return; } catch(Exception unavailable) { /* No valid Capri idle remains. */ }
            }
            fail();
        }
    }
    private void fail() { release();state(new RenderState(null,false,LOAD_ERROR));invalidate(); }
    private void load(String name) throws Exception {
        String next=sheetFor(name);
        JSONObject manifest;
        try(InputStream input=assets.open("companion/capri-faces-v1.json");ByteArrayOutputStream output=new ByteArrayOutputStream()) {
            byte[] chunk=new byte[8192];int count;
            while((count=input.read(chunk))!=-1) {
                output.write(chunk,0,count);
                if(output.size()>1024*1024)throw new IOException("Manifest too large");
            }
            manifest=new JSONObject(output.toString(StandardCharsets.UTF_8.name()));
        }
        int width=manifest.getInt("width"),height=manifest.getInt("height");
        if(width<=0||height<=0||width>4096||height>4096)throw new IOException("Invalid atlas dimensions");
        Animation selected=new Animation(manifest.getJSONObject("animations").getJSONObject(name),width,height);
        Bitmap nextAtlas=atlas;
        if(!next.equals(sheet)||nextAtlas==null) {
            try(InputStream input=assets.open(manifest.getString("image"))) { nextAtlas=BitmapFactory.decodeStream(input); }
            if(nextAtlas==null)throw new IOException("Missing atlas");
            if(nextAtlas.getWidth()!=width||nextAtlas.getHeight()!=height) { nextAtlas.recycle();throw new IOException("Atlas dimensions differ"); }
        }
        // Only replace a complete, validated animation. Optional action failures can return to Capri idle.
        if(atlas!=null&&atlas!=nextAtlas)atlas.recycle();
        atlas=nextAtlas;sheet=next;animation=selected;action=name;frame=0;state(new RenderState("capri",true,null));
    }
    static String sheetFor(String animation) throws IOException {
        switch(animation) {
            case "idle": case "walk": case "greeting": case "working":
            case "file-away": case "perch": case "step-aside":
            case "coffee": case "chill": case "crying": case "angry":
            case "headphones": case "dancing": case "capture": case "follow-message":
            case "snack": case "stretch": case "curious": case "attentive":
            case "eyes": case "face": case "point-left": case "point-right":
            case "duo-watch": case "duo-coffee": case "duo-couch": case "duo-high-five":
            case "typing": case "typing-watch": case "done": case "error": case "thinking":
            case "talking": case "sleep": case "sleepy": case "wake": case "glitch-transition":
            case "happy": case "sad": case "look": case "pointing": case "surprised": case "attention":
            case "face-talk": case "eyes-blink": return "faces";
            default: throw new IOException("Unknown animation");
        }
    }
    /** Debug preview does not mutate persisted preferences or agent facts. */
    void preview(String name) {
        try { sheetFor(name); } catch(IOException unknown) { return; }
        reaction=name;reactionUntil=SystemClock.uptimeMillis()+6500;
        handler.removeCallbacks(endReaction);handler.postAtTime(endReaction,reactionUntil);
        cancelFrames();if(capri&&state.ready)loadOrIdle(name);invalidate();schedule();
    }
    private static final class Animation {
        final int width,height;
        final Frame[] frames;
        Animation(JSONObject value,int atlasWidth,int atlasHeight) throws Exception {
            JSONObject size=value.getJSONObject("canvas");width=size.getInt("width");height=size.getInt("height");
            if(width<=0||height<=0||width>4096||height>4096)throw new IOException("Invalid canvas");
            JSONArray source=value.getJSONArray("frames");
            if(source.length()==0||source.length()>120)throw new IOException("Invalid frame count");
            frames=new Frame[source.length()];
            for(int i=0;i<frames.length;i++)frames[i]=new Frame(source.getJSONObject(i),atlasWidth,atlasHeight,width,height);
        }
    }
    private static final class Frame {
        final Rect source;
        final int dx,dy,duration;
        final Path clip;
        Frame(JSONObject value,int atlasWidth,int atlasHeight,int canvasWidth,int canvasHeight) throws Exception {
            int x=value.getInt("x"),y=value.getInt("y"),w=value.getInt("width"),h=value.getInt("height");
            dx=value.optInt("offsetX");dy=value.optInt("offsetY");
            if(x<0||y<0||w<=0||h<=0||w>atlasWidth-x||h>atlasHeight-y||dx<0||dy<0||w>canvasWidth-dx||h>canvasHeight-dy)throw new IOException("Invalid frame bounds");
            source=new Rect(x,y,x+w,y+h);duration=Math.max(80,value.optInt("durationMs",200));
            JSONArray points=value.optJSONArray("clip");
            if(points==null) { clip=null;return; }
            if(points.length()<3||points.length()>256)throw new IOException("Invalid clipping polygon");
            clip=new Path();
            for(int i=0;i<points.length();i++) {
                JSONArray point=points.getJSONArray(i);double px=point.getDouble(0),py=point.getDouble(1);
                if(!Double.isFinite(px)||!Double.isFinite(py)||px<x||px>x+w||py<y||py>y+h)throw new IOException("Invalid clipping coordinate");
                if(i==0)clip.moveTo((float)px-x+dx,(float)py-y+dy);else clip.lineTo((float)px-x+dx,(float)py-y+dy);
            }
            clip.close();
        }
    }
    @Override public boolean performClick() { return super.performClick(); }
    @Override protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        if(!state.ready)return; // Never substitute Gentle Dot for a failed Capri renderer.
        if(!capri) {
            paint.setColor(Color.rgb(184,154,228));canvas.drawCircle(getWidth()/2f,getHeight()/2f,getWidth()*.23f,paint);
            paint.setColor(Color.rgb(37,29,46));canvas.drawCircle(getWidth()*.44f,getHeight()*.48f,getWidth()*.025f,paint);
            canvas.drawCircle(getWidth()*.56f,getHeight()*.48f,getWidth()*.025f,paint);return;
        }
        int saved=canvas.save();
        try {
            Frame item=animation.frames[frame];
            float scale=Math.min(getWidth()/(float)animation.width,getHeight()/(float)animation.height);
            canvas.translate((getWidth()-animation.width*scale)/2,(getHeight()-animation.height*scale)/2);canvas.scale(scale,scale);
            if(item.clip!=null)canvas.clipPath(item.clip);
            targetRect.set(item.dx,item.dy,item.dx+item.source.width(),item.dy+item.source.height());
            canvas.drawBitmap(atlas,item.source,targetRect,paint);
        } catch(RuntimeException error) { fail(); }
        finally { canvas.restoreToCount(saved); }
    }
    void release() { cancelFrames();handler.removeCallbacks(endReaction);reaction="";reactionUntil=0;if(atlas!=null)atlas.recycle();atlas=null;animation=null;sheet="";state=RenderState.unavailable(); }
    @Override protected void onAttachedToWindow() { super.onAttachedToWindow();attachedToWindow=true;schedule(); }
    @Override protected void onDetachedFromWindow() { attachedToWindow=false;cancelFrames();super.onDetachedFromWindow(); }
}
