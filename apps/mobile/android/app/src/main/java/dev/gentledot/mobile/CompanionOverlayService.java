package dev.gentledot.mobile;

import android.app.KeyguardManager;
import android.annotation.SuppressLint;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.Point;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.WindowManager;
import android.view.accessibility.AccessibilityNodeInfo;
import android.widget.TextView;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;
import java.lang.ref.WeakReference;
import java.util.function.Consumer;
import java.util.concurrent.atomic.AtomicBoolean;
import android.view.ViewTreeObserver;

/** User-started, small alpha windows only. Never reads other apps or keeps the screen awake. */
@SuppressLint("RtlHardcoded") // Positions are physical screen coordinates from raw drag input, not text direction.
public final class CompanionOverlayService extends Service {
    static final String STOP="dev.gentledot.mobile.COMPANION_STOP";
    static final String PREFS="gentledot-companion-native-v1";
    private static final int NOTICE=731, PIN=0x01020001, LEFT=0x01020002, RIGHT=0x01020003, HIDE=0x01020004;
    private static volatile WeakReference<CompanionOverlayService> current=new WeakReference<>(null);
    private static volatile CompanionSpriteView.RenderState lastRenderState=CompanionSpriteView.RenderState.unavailable();
    private final Handler handler=new Handler(Looper.getMainLooper());
    private WindowManager windows;
    private CompanionSpriteView sprite;
    private TextView speech;
    private WindowManager.LayoutParams position, speechPosition;
    private volatile boolean attached, started;
    private boolean speechAttached;
    private String latestTitle="",latestBody="",latestEvent="",latestPane="",latestSession="",latestConversation="";
    static SharedPreferences prefs(Context context){return context.getSharedPreferences(PREFS,Context.MODE_PRIVATE);}
    static boolean permitted(Context context){return Build.VERSION.SDK_INT>=26 && Settings.canDrawOverlays(context);}
    static boolean presenting(){CompanionOverlayService value=current.get();return value!=null && value.attached && value.sprite.renderState().ready;}
    static boolean running(){CompanionOverlayService value=current.get();return value!=null && value.started;}
    static void refresh(){CompanionOverlayService value=current.get();if(value!=null)value.handler.post(value::updateVisibility);}
    static CompanionSpriteView.RenderState renderState(){
        CompanionOverlayService value=current.get();return value!=null&&value.sprite!=null?value.sprite.renderState():lastRenderState;
    }
    /** Called by the plugin on the UI thread: a theme update is verified before it returns. */
    static void configure(){
        if(Looper.myLooper()!=Looper.getMainLooper())throw new IllegalStateException("Companion configuration requires the UI thread");
        CompanionOverlayService value=current.get();
        if(value==null){lastRenderState=CompanionSpriteView.RenderState.unavailable();return;}
        String requested=prefs(value).getString("theme","gentle-dot");
        if(!value.sprite.renderState().ready || !requested.equals(value.sprite.renderState().appliedTheme))value.sprite.theme(requested);
        value.updateVisibility();
    }
    private void rendererChanged(CompanionSpriteView.RenderState state){
        lastRenderState=state;
        if(state.error!=null)handler.post(()->{
            if(current.get()==this&&!sprite.renderState().ready){hideSpeech();stopEnabled();}
        });
    }
    static void offer(String kind,String id,String title,String body,String pane,String session,String conversation,Consumer<Boolean> receipt){
        CompanionOverlayService value=current.get();if(value==null){receipt.accept(false);return;}
        AtomicBoolean done=new AtomicBoolean();
        Handler receiptHandler=new Handler(Looper.getMainLooper());
        Runnable timeout=()->{if(done.compareAndSet(false,true))receipt.accept(false);};
        // Register before posting to the service: destruction may remove that queued work.
        receiptHandler.postDelayed(timeout,400);
        value.handler.post(()->{
            if(done.get())return;
            if(current.get()!=value || !value.present(kind,id,title,body,pane,session,conversation)){
                if(done.compareAndSet(false,true)){receiptHandler.removeCallbacks(timeout);receipt.accept(false);}return;
            }
            TextView candidate=value.speech;
            candidate.getViewTreeObserver().addOnDrawListener(new ViewTreeObserver.OnDrawListener(){
                @Override public void onDraw(){receiptHandler.post(()->{
                    if(candidate.getViewTreeObserver().isAlive())candidate.getViewTreeObserver().removeOnDrawListener(this);
                    if(!done.compareAndSet(false,true))return;
                    receiptHandler.removeCallbacks(timeout);
                    receipt.accept(current.get()==value && value.attached && value.speechAttached && value.speech==candidate && !MainActivity.isVisible()
                        && value.sprite.renderState().ready && !value.getSystemService(KeyguardManager.class).isKeyguardLocked());
                });}
            });
        });
    }
    private final BroadcastReceiver stateReceiver=new BroadcastReceiver(){@Override public void onReceive(Context c,Intent i){updateVisibility();}};
    @Override public void onCreate(){
        super.onCreate();if(Build.VERSION.SDK_INT<26){stopSelf();return;}current=new WeakReference<>(this);windows=getSystemService(WindowManager.class);
        sprite=new CompanionSpriteView(this);sprite.onStateChanged(this::rendererChanged);sprite.theme(prefs(this).getString("theme","gentle-dot"));
        int size=dp(112);
        position=new WindowManager.LayoutParams(size,size,WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE|WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,PixelFormat.TRANSLUCENT);
        position.gravity=Gravity.TOP|Gravity.LEFT;position.x=prefs(this).getInt("x",dp(12));position.y=prefs(this).getInt("y",dp(160));
        sprite.setOnClickListener(v->openChat());
        sprite.setOnLongClickListener(v->{togglePin();return true;});
        sprite.setAccessibilityDelegate(new View.AccessibilityDelegate(){
            @Override public void onInitializeAccessibilityNodeInfo(View view,AccessibilityNodeInfo info){super.onInitializeAccessibilityNodeInfo(view,info);
                info.addAction(new AccessibilityNodeInfo.AccessibilityAction(PIN,prefs(CompanionOverlayService.this).getBoolean("pinned",false)?"Soltar posición":"Fijar posición"));
                info.addAction(new AccessibilityNodeInfo.AccessibilityAction(LEFT,"Mover a la izquierda"));info.addAction(new AccessibilityNodeInfo.AccessibilityAction(RIGHT,"Mover a la derecha"));info.addAction(new AccessibilityNodeInfo.AccessibilityAction(HIDE,"Ocultar acompañante"));}
            @Override public boolean performAccessibilityAction(View view,int action,android.os.Bundle args){
                if(action==PIN){togglePin();return true;}if(action==LEFT||action==RIGHT){position.x=action==LEFT?dp(8):screen().x-position.width-dp(8);move();savePosition();return true;}
                if(action==HIDE){stopEnabled();return true;}return super.performAccessibilityAction(view,action,args);}
        });
        sprite.setOnTouchListener(new View.OnTouchListener(){float x,y;int sx,sy;boolean moved;final int slop=ViewConfiguration.get(CompanionOverlayService.this).getScaledTouchSlop();
            @SuppressLint("ClickableViewAccessibility") // Taps/long presses return false to View's native performClick handling; only actual drags are consumed.
            @Override public boolean onTouch(View view,MotionEvent event){
                if(prefs(CompanionOverlayService.this).getBoolean("pinned",false))return false;
                if(event.getActionMasked()==MotionEvent.ACTION_DOWN){x=event.getRawX();y=event.getRawY();sx=position.x;sy=position.y;moved=false;return false;}
                if(event.getActionMasked()==MotionEvent.ACTION_MOVE){float dx=event.getRawX()-x,dy=event.getRawY()-y;if(Math.abs(dx)+Math.abs(dy)>slop)moved=true;
                    if(moved){view.cancelLongPress();hideSpeech();position.x=sx+(int)dx;position.y=sy+(int)dy;move();return true;}}
                if(event.getActionMasked()==MotionEvent.ACTION_UP&&moved){view.setPressed(false);savePosition();return true;}return false;
            }});
        IntentFilter filter=new IntentFilter();filter.addAction(Intent.ACTION_SCREEN_OFF);filter.addAction(Intent.ACTION_SCREEN_ON);filter.addAction(Intent.ACTION_USER_PRESENT);filter.addAction(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED);
        ContextCompat.registerReceiver(this,stateReceiver,filter,ContextCompat.RECEIVER_NOT_EXPORTED);
    }
    @Override public int onStartCommand(Intent intent,int flags,int startId){
        if(intent!=null&&STOP.equals(intent.getAction())){stopEnabled();return START_NOT_STICKY;}
        if(Build.VERSION.SDK_INT<26||!permitted(this)||!prefs(this).getBoolean("enabled",false)){stopSelf();return START_NOT_STICKY;}
        NotificationManager manager=getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel("companion-presence","Acompañante sobre otras apps",NotificationManager.IMPORTANCE_LOW));
        PendingIntent stop=PendingIntent.getService(this,NOTICE,new Intent(this,CompanionOverlayService.class).setAction(STOP),PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
        PendingIntent open=PendingIntent.getActivity(this,NOTICE,new Intent(this,CompanionChatActivity.class),PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
        Notification notice=new NotificationCompat.Builder(this,"companion-presence").setSmallIcon(R.drawable.ic_notification).setContentTitle("Tu acompañante está disponible")
            .setContentText("Toca para conversar. Se pausa al bloquear la pantalla.").setContentIntent(open).setOngoing(true).setOnlyAlertOnce(true).setSilent(true)
            .addAction(0,"Ocultar",stop).setVisibility(NotificationCompat.VISIBILITY_SECRET).build();
        try {if(Build.VERSION.SDK_INT>=34)startForeground(NOTICE,notice,ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);else startForeground(NOTICE,notice);started=true;if(sprite.renderState().ready)updateVisibility();else stopEnabled();}
        catch(RuntimeException error){stopSelf();}
        return START_NOT_STICKY;
    }
    private void togglePin(){boolean value=!prefs(this).getBoolean("pinned",false);prefs(this).edit().putBoolean("pinned",value).apply();sprite.announceForAccessibility(value?"Posición fijada":"Puedes mover el acompañante");}
    private void updateVisibility(){
        PowerManager power=getSystemService(PowerManager.class);KeyguardManager keyguard=getSystemService(KeyguardManager.class);
        boolean visible=sprite.renderState().ready && CompanionPolicy.visible(prefs(this).getBoolean("enabled",false),permitted(this),power.isInteractive(),keyguard.isKeyguardLocked(),MainActivity.isVisible());
        if(visible&&!attached){try{clamp();windows.addView(sprite,position);attached=true;}catch(RuntimeException denied){stopEnabled();return;}}
        if(!visible){hideSpeech();if(attached){windows.removeView(sprite);attached=false;}}
        boolean motion=CompanionPolicy.animate(visible,power.isPowerSaveMode(),Settings.Global.getFloat(getContentResolver(),Settings.Global.ANIMATOR_DURATION_SCALE,1f)==0f);
        sprite.active(motion);
    }
    private boolean present(String kind,String id,String title,String body,String pane,String session,String conversation){
        if(Build.VERSION.SDK_INT<26 || !attached || getSystemService(KeyguardManager.class).isKeyguardLocked())return false;
        latestEvent=safe(id,160);latestTitle=safe(title,120);latestBody=safe(body,1000);latestPane=safe(pane,160);latestSession=safe(session,160);latestConversation=safe(conversation,160);
        sprite.play(CompanionPolicy.action(kind));if(!sprite.renderState().ready)return false;if("capture".equals(kind)||"download".equals(kind)){hideSpeech();return false;}
        hideSpeech();
        // The existing preview setting controls the lock screen; this window never appears there.
        String displayTitle=latestTitle, displayBody=latestBody;
        speech=new TextView(this);speech.setText(getString(R.string.companion_notice, displayTitle, displayBody));speech.setTextColor(Color.rgb(239,237,244));speech.setTextSize(14);speech.setPadding(dp(14),dp(10),dp(14),dp(10));speech.setMaxLines(4);
        GradientDrawable background=new GradientDrawable();background.setColor(Color.rgb(32,29,39));background.setCornerRadius(dp(18));speech.setBackground(background);speech.setOnClickListener(v->openChat());
        speech.setContentDescription("Nuevo aviso. "+displayTitle+". "+displayBody+". Abrir conversación");
        Point screen=screen();int width=Math.min(dp(280),screen.x-dp(16));
        speechPosition=new WindowManager.LayoutParams(width,WindowManager.LayoutParams.WRAP_CONTENT,WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE|WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,PixelFormat.TRANSLUCENT);
        speechPosition.gravity=Gravity.TOP|Gravity.LEFT;speechPosition.x=CompanionPolicy.bound(position.x,screen.x,width,dp(8));speechPosition.y=CompanionPolicy.bound(position.y-dp(110),screen.y,dp(110),dp(24));
        try{windows.addView(speech,speechPosition);speechAttached=true;handler.postDelayed(hideSpeechTask,6000);return true;}catch(RuntimeException ignored){speech=null;return false;}
    }
    private void openChat(){
        Intent intent=new Intent(this,CompanionChatActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK|Intent.FLAG_ACTIVITY_SINGLE_TOP|Intent.FLAG_ACTIVITY_CLEAR_TOP);
        intent.putExtra("companion.openChat",true).putExtra("companion.eventId",latestEvent).putExtra("companion.title",latestTitle).putExtra("companion.body",latestBody).putExtra("companion.paneId",latestPane).putExtra("companion.sessionId",latestSession).putExtra("companion.conversationId",latestConversation);
        try{startActivity(intent);hideSpeech();}catch(RuntimeException ignored){}
    }
    private void hideSpeech(){handler.removeCallbacks(hideSpeechTask);if(speechAttached){try{windows.removeView(speech);}catch(RuntimeException ignored){}speechAttached=false;}speech=null;}
    private final Runnable hideSpeechTask=this::hideSpeech;
    private Point screen(){Point size=new Point();windows.getDefaultDisplay().getSize(size);return size;}
    private void clamp(){Point size=screen();position.x=CompanionPolicy.bound(position.x,size.x,position.width,dp(8));position.y=CompanionPolicy.bound(position.y,size.y,position.height,dp(24));}
    private void move(){clamp();if(attached)windows.updateViewLayout(sprite,position);}
    private void savePosition(){prefs(this).edit().putInt("x",position.x).putInt("y",position.y).apply();}
    private int dp(int value){return Math.round(value*getResources().getDisplayMetrics().density);}
    private static String safe(String value,int length){return value==null?"":value.substring(0,Math.min(length,value.length()));}
    private void stopEnabled(){prefs(this).edit().putBoolean("enabled",false).apply();stopSelf();}
    @Override public void onConfigurationChanged(Configuration config){super.onConfigurationChanged(config);hideSpeech();move();}
    @Override public void onDestroy(){started=false;handler.removeCallbacksAndMessages(null);hideSpeech();if(attached)windows.removeView(sprite);if(sprite!=null){CompanionSpriteView.RenderState state=sprite.renderState();lastRenderState=new CompanionSpriteView.RenderState(null,false,state.error);sprite.release();unregisterReceiver(stateReceiver);}if(current.get()==this)current.clear();stopForeground(STOP_FOREGROUND_REMOVE);super.onDestroy();}
    @Override public IBinder onBind(Intent intent){return null;}
}
