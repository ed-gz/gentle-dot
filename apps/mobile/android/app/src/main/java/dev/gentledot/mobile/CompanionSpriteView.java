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
import android.view.View;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import org.json.JSONArray;
import org.json.JSONObject;

/** Atlas frames are painted with their real alpha. No WebView, GIF decoder or 60fps idle loop. */
final class CompanionSpriteView extends View {
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG | Paint.FILTER_BITMAP_FLAG);
    private final Path clipPath = new Path();
    private final Rect sourceRect = new Rect();
    private final RectF targetRect = new RectF();
    private Bitmap atlas;
    private JSONObject animation;
    private int frame;
    private boolean capri, animate;
    private String sheet = "", action = "idle";
    private final Runnable advance = () -> {
        if (!animate || animation == null) return;
        JSONArray frames = animation.optJSONArray("frames");
        if (frames == null || ++frame >= frames.length()) { frame = 0; action = "idle"; load("idle"); invalidate(); handler.postDelayed(this::resumeIdle, 30_000); return; }
        invalidate(); schedule();
    };
    CompanionSpriteView(Context context) {
        super(context); setLayerType(View.LAYER_TYPE_SOFTWARE, null);
        setContentDescription("Abrir conversación con el acompañante. Mantén pulsado para fijar o soltar.");
        setFocusable(true); setClickable(true); setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_YES);
    }
    void theme(String name) { capri = "capri".equals(name); if (capri) load(action); else release(); invalidate(); }
    void active(boolean value) { animate = value; handler.removeCallbacksAndMessages(null); if (value) play("idle"); }
    void play(String value) {
        handler.removeCallbacksAndMessages(null); action = value; frame = 0;
        if (capri) load(value);
        invalidate(); if (animate && capri) schedule();
    }
    private void resumeIdle() { if (animate) play("idle"); }
    private void schedule() {
        if (animation == null) return;
        JSONObject item = animation.optJSONArray("frames").optJSONObject(frame);
        handler.postDelayed(advance, Math.max(80, item.optInt("durationMs", 200)));
    }
    private void load(String name) {
        String next = "file-away".equals(name) ? "actions" : "core";
        try {
            JSONObject manifest;
            try (InputStream input = getContext().getAssets().open("companion/capri-motion-" + next + "-v1.json")) {
                byte[] data = new byte[input.available()]; int offset = 0, count;
                while (offset < data.length && (count = input.read(data, offset, data.length - offset)) > 0) offset += count;
                manifest = new JSONObject(new String(data, 0, offset, StandardCharsets.UTF_8));
            }
            if (!next.equals(sheet)) {
                Bitmap nextAtlas;
                try (InputStream input = getContext().getAssets().open(manifest.getString("image"))) { nextAtlas = BitmapFactory.decodeStream(input); }
                if (nextAtlas == null) throw new IllegalStateException("Missing atlas");
                if (atlas != null) atlas.recycle(); atlas = nextAtlas; sheet = next;
            }
            animation = manifest.getJSONObject("animations").getJSONObject(name);
        } catch (Exception ignored) { animation = null; /* Visible neutral dot if a theme is unavailable. */ }
    }
    @Override public boolean performClick() { return super.performClick(); }
    @Override protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        if (!capri || atlas == null || animation == null) {
            paint.setColor(Color.rgb(184, 154, 228)); canvas.drawCircle(getWidth()/2f, getHeight()/2f, getWidth()*.23f, paint);
            paint.setColor(Color.rgb(37, 29, 46)); canvas.drawCircle(getWidth()*.44f, getHeight()*.48f, getWidth()*.025f, paint);
            canvas.drawCircle(getWidth()*.56f, getHeight()*.48f, getWidth()*.025f, paint); return;
        }
        try {
            JSONObject item = animation.getJSONArray("frames").getJSONObject(frame);
            JSONObject size = animation.getJSONObject("canvas");
            float scale = Math.min(getWidth()/(float)size.getInt("width"), getHeight()/(float)size.getInt("height"));
            float ox = (getWidth()-size.getInt("width")*scale)/2, oy = (getHeight()-size.getInt("height")*scale)/2;
            int x=item.getInt("x"), y=item.getInt("y"), w=item.getInt("width"), h=item.getInt("height");
            float dx=item.optInt("offsetX"), dy=item.optInt("offsetY");
            int saved=canvas.save(); canvas.translate(ox,oy); canvas.scale(scale,scale);
            JSONArray points=item.optJSONArray("clip");
            if (points!=null && points.length()>2) {
                Path clip=clipPath; clip.reset();
                for(int i=0;i<points.length();i++) { JSONArray p=points.getJSONArray(i); float px=(float)p.getDouble(0)-x+dx, py=(float)p.getDouble(1)-y+dy; if(i==0)clip.moveTo(px,py);else clip.lineTo(px,py); }
                clip.close(); canvas.clipPath(clip);
            }
            sourceRect.set(x,y,x+w,y+h);targetRect.set(dx,dy,dx+w,dy+h);canvas.drawBitmap(atlas,sourceRect,targetRect,paint);canvas.restoreToCount(saved);
        } catch (Exception ignored) { /* Invalid optional theme cannot crash the companion service. */ }
    }
    void release() { handler.removeCallbacksAndMessages(null); if(atlas!=null)atlas.recycle();atlas=null;animation=null;sheet=""; }
    @Override protected void onDetachedFromWindow() { handler.removeCallbacksAndMessages(null); super.onDetachedFromWindow(); }
}
