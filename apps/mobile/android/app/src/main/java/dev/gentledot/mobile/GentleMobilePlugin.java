package dev.gentledot.mobile;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.os.Bundle;
import android.os.ResultReceiver;
import android.speech.RecognizerIntent;
import androidx.activity.result.ActivityResult;
import androidx.core.content.ContextCompat;
import androidx.core.app.NotificationManagerCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.util.ArrayList;
import java.util.Locale;
import java.util.LinkedHashMap;
import java.util.Iterator;
import java.util.Map;
import java.lang.ref.WeakReference;
import android.provider.Settings;
import android.net.Uri;
import java.util.concurrent.atomic.AtomicBoolean;

@CapacitorPlugin(name = "GentleMobile", permissions = {
    @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
})
public class GentleMobilePlugin extends Plugin {
    private static volatile WeakReference<GentleMobilePlugin> current = new WeakReference<>(null);
    private volatile boolean listening;
    private MobileFileReceiver files;

    @Override protected void handleOnResume() { current = new WeakReference<>(this); }

    @Override public void load() { files = new MobileFileReceiver(this); current = new WeakReference<>(this); }

    static void foregroundNotification(String id, String title, String body) {
        foregroundNotification("permission", id, title, body, null, null);
    }

    static boolean foregroundNotification(String kind, String id, String title, String body, String paneId, String sessionId) {
        GentleMobilePlugin plugin = current.get();
        if (plugin == null || !MainActivity.isVisible() || !plugin.hasListeners("foregroundNotification")) return false;
        JSObject event = new JSObject();
        event.put("id", id); event.put("title", title); event.put("body", body); event.put("event", kind);
        if (paneId != null && !paneId.isEmpty()) {
            JSObject session = new JSObject(); session.put("paneId", paneId);
            if (sessionId != null && !sessionId.isEmpty()) session.put("sessionId", sessionId);
            event.put("session", session);
        }
        // Do not retain request payloads across listener teardown or a later host switch.
        // Before the WebView is listening, the caller falls back to Android delivery.
        plugin.notifyListeners("foregroundNotification", event);
        return true;
    }

    private static final java.util.concurrent.ExecutorService draftWorker = java.util.concurrent.Executors.newSingleThreadExecutor();
    @PluginMethod
    public void readDraft(PluginCall call) {
        String input = call.getString("scope");
        draftWorker.execute(() -> {
            try {
                DraftLedger.Record record = MobileDraftStore.ledger(getContext()).read(MobileDraftStore.scope(input));
                JSObject result = new JSObject(); result.put("text", record.text); result.put("revision", record.revision); call.resolve(result);
            } catch (Exception error) { call.reject("No se pudo recuperar el borrador del almacenamiento seguro."); }
        });
    }
    @PluginMethod
    public void saveDraft(PluginCall call) {
        String input = call.getString("scope"), text = call.getString("text"), expected = call.getString("expectedRevision");
        draftWorker.execute(() -> {
            try {
                MobileDraftStore.validateText(text);
                if (expected == null || expected.isEmpty() || expected.length() > 80) throw new IllegalArgumentException();
                DraftLedger.Result saved = MobileDraftStore.ledger(getContext()).save(MobileDraftStore.scope(input), text, expected);
                JSObject result = new JSObject(); result.put("text", saved.record.text); result.put("revision", saved.record.revision);
                result.put("applied", saved.applied); call.resolve(result);
            } catch (Exception error) { call.reject("No se pudo guardar el borrador en este teléfono. El texto se conserva en el editor."); }
        });
    }

    @PluginMethod
    public void companionState(PluginCall call) { call.resolve(companionStateValue()); }

    private JSObject companionStateValue() {
        JSObject value = new JSObject();
        value.put("supported", Build.VERSION.SDK_INT >= 26);
        value.put("permission", CompanionOverlayService.permitted(getContext()));
        boolean enabled = CompanionOverlayService.prefs(getContext()).getBoolean("enabled", false);
        value.put("enabled", enabled);
        CompanionSpriteView.RenderState render = CompanionOverlayService.renderState();
        boolean ready = enabled && CompanionOverlayService.running() && render.ready;
        value.put("active", ready);
        value.put("renderReady", ready);
        if (ready && render.appliedTheme != null) value.put("appliedTheme", render.appliedTheme);
        if (render.error != null) value.put("renderError", render.error);
        String paused = CompanionPolicy.motionPausedReason(
            getContext().getSystemService(PowerManager.class).isPowerSaveMode(),
            Settings.Global.getFloat(getContext().getContentResolver(), Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f);
        if (paused != null) value.put("motionPausedReason", paused);
        value.put("pinned", CompanionOverlayService.prefs(getContext()).getBoolean("pinned", false));
        value.put("theme", CompanionOverlayService.prefs(getContext()).getString("theme", "gentle-dot"));
        value.put("partialChat", getActivity() instanceof CompanionChatActivity);
        return value;
    }

    @PluginMethod
    public void requestCompanionPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < 26) { call.reject("El acompañante sobre otras apps requiere Android 8 o posterior."); return; }
        try { getActivity().startActivity(new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
            Uri.parse("package:" + getContext().getPackageName()))); call.resolve(); }
        catch (Exception error) { call.reject("Abre los ajustes de Android y permite Mostrar sobre otras apps para Gentle Dot."); }
    }

    @PluginMethod
    public void openCompanionAppSettings(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) { call.reject("Abre Gentle Dot e inténtalo de nuevo para ver sus ajustes."); return; }
        activity.runOnUiThread(() -> {
            if (activity.isFinishing() || activity.isDestroyed()) {
                call.reject("Abre Gentle Dot e inténtalo de nuevo para ver sus ajustes."); return;
            }
            try {
                Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    Uri.fromParts("package", getContext().getPackageName(), null));
                activity.startActivity(intent);
                call.resolve();
            } catch (RuntimeException error) {
                call.reject("No se pudieron abrir los ajustes de Gentle Dot. Abre Ajustes de Android, Aplicaciones y Gentle Dot.");
            }
        });
    }

    @PluginMethod
    public void setCompanion(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) { call.reject("Abre Gentle Dot e inténtalo de nuevo."); return; }
        activity.runOnUiThread(() -> {
            Boolean enabled = call.getBoolean("enabled");
            String theme = call.getString("theme");
            Boolean pinned = call.getBoolean("pinned");
            if (theme != null && !theme.equals("gentle-dot") && !theme.equals("capri")) { call.reject("Tema no válido."); return; }
            if (Boolean.TRUE.equals(enabled) && (!CompanionOverlayService.permitted(getContext()) || !MainActivity.isVisible())) {
                call.reject("Permite Mostrar sobre otras apps y activa el acompañante desde la app abierta."); return;
            }
            android.content.SharedPreferences.Editor edit = CompanionOverlayService.prefs(getContext()).edit();
            if (enabled != null) edit.putBoolean("enabled", enabled);
            if (theme != null) edit.putString("theme", theme);
            if (pinned != null) edit.putBoolean("pinned", pinned);
            if (!edit.commit()) { call.reject("No se pudo guardar el acompañante."); return; }
            String requestedTheme = CompanionOverlayService.prefs(getContext()).getString("theme", "gentle-dot");
            try {
                if (Boolean.FALSE.equals(enabled)) {
                    getContext().stopService(new Intent(getContext(), CompanionOverlayService.class));
                    call.resolve(companionStateValue());return;
                }
                if (Boolean.TRUE.equals(enabled)) ContextCompat.startForegroundService(getContext(), new Intent(getContext(), CompanionOverlayService.class));
                CompanionOverlayService.configure();
                // A stored preference is not a rendered character. Only a running renderer may confirm activation.
                if (Boolean.TRUE.equals(enabled) || CompanionOverlayService.running()) {
                    Handler handler = new Handler(Looper.getMainLooper());
                    long deadline = android.os.SystemClock.uptimeMillis() + 3000;
                    handler.post(new Runnable() {
                        @Override public void run() {
                            if (!requestedTheme.equals(CompanionOverlayService.prefs(getContext()).getString("theme", "gentle-dot"))) {
                                call.reject("El tema cambió mientras se activaba el acompañante. Revisa el tema seleccionado.");return;
                            }
                            CompanionSpriteView.RenderState render = CompanionOverlayService.renderState();
                            if (render.error != null) {
                                CompanionOverlayService.prefs(getContext()).edit().putBoolean("enabled", false).apply();
                                getContext().stopService(new Intent(getContext(), CompanionOverlayService.class));
                                call.reject(render.error);return;
                            }
                            if (!CompanionOverlayService.prefs(getContext()).getBoolean("enabled", false)) {
                                call.reject("Se canceló la activación del acompañante.");return;
                            }
                            if (CompanionOverlayService.running() && render.ready && requestedTheme.equals(render.appliedTheme)) call.resolve(companionStateValue());
                            else if (android.os.SystemClock.uptimeMillis() < deadline) handler.postDelayed(this, 50);
                            else {
                                CompanionOverlayService.prefs(getContext()).edit().putBoolean("enabled", false).apply();
                                getContext().stopService(new Intent(getContext(), CompanionOverlayService.class));
                                call.reject("Android no confirmó el personaje del acompañante. Vuelve a intentarlo con la app abierta.");
                            }
                        }
                    });
                } else call.resolve(companionStateValue());
            } catch (RuntimeException error) {
                CompanionOverlayService.prefs(getContext()).edit().putBoolean("enabled", false).apply();
                getContext().stopService(new Intent(getContext(), CompanionOverlayService.class));
                call.reject("Android no pudo activar el acompañante. Inténtalo con la app abierta.");
            }
        });
    }

    @PluginMethod
    public void closeCompanionChat(PluginCall call) {
        if (getActivity() instanceof CompanionChatActivity) getActivity().runOnUiThread(() -> getActivity().moveTaskToBack(true));
        call.resolve();
    }

    @PluginMethod
    public void companionLaunchContext(PluginCall call) {
        Intent intent = getActivity().getIntent(); JSObject result = new JSObject();
        result.put("openChat", intent.getBooleanExtra("companion.openChat", false)); intent.removeExtra("companion.openChat");
        for (String name : new String[]{"eventId", "title", "body", "paneId", "sessionId", "conversationId"}) {
            String value = intent.getStringExtra("companion." + name);
            if (value != null && !value.isEmpty()) result.put(name, value);
            intent.removeExtra("companion." + name);
        }
        call.resolve(result);
    }

    @PluginMethod
    public void receiveFile(PluginCall call) {
        if (listening) { call.reject("Termina el dictado antes de recibir el archivo.", "FILE_BUSY"); return; }
        files.receive(call);
    }

    @PluginMethod
    public void cancelReceiveFile(PluginCall call) { files.cancel(); call.resolve(); }

    @ActivityCallback
    private void receivedFileDestination(PluginCall call, ActivityResult result) { files.destination(call, result); }

    @Override protected void handleOnDestroy() { if (current.get() == this) current.clear(); files.destroy(); }

    @PluginMethod
    public void transcribe(PluginCall call) {
        getActivity().runOnUiThread(() -> beginTranscription(call));
    }

    private void beginTranscription(PluginCall call) {
        if (listening) { call.reject("Ya hay un dictado abierto."); return; }
        if (files.busy()) { call.reject("Termina o cancela la transferencia antes de dictar."); return; }
        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, call.getString("language", Locale.getDefault().toLanguageTag()));
        intent.putExtra(RecognizerIntent.EXTRA_PROMPT, "Dicta tu mensaje. Podrás revisarlo antes de enviarlo.");
        intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
        try {
            listening = true;
            startActivityForResult(call, intent, "speechResult");
        } catch (ActivityNotFoundException error) {
            listening = false;
            call.reject("No hay un servicio de dictado en este teléfono. Activa el reconocimiento de voz de Android o escribe el mensaje.");
        } catch (Exception error) {
            listening = false;
            call.reject("No se pudo abrir el dictado de Android.");
        }
    }

    @ActivityCallback
    private void speechResult(PluginCall call, ActivityResult result) {
        listening = false;
        if (call == null) return;
        JSObject response = new JSObject();
        response.put("text", "");
        Intent data = result.getData();
        if (result.getResultCode() == Activity.RESULT_OK && data != null) {
            ArrayList<String> values = data.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS);
            if (values != null && !values.isEmpty()) response.put("text", values.get(0));
        }
        call.resolve(response);
    }

    @PluginMethod
    public void startMonitor(PluginCall call) {
        String mode = call.getString("mode");
        if (mode != null && !NotificationMode.valid(mode)) { call.reject("Elige una opción de avisos válida."); return; }
        if (!canNotify()) { requestPermissionForAlias("notifications", call, "notificationsResult"); return; }
        beginMonitor(call);
    }

    @PermissionCallback
    private void notificationsResult(PluginCall call) {
        if (!canNotify()) { call.reject("Activa las notificaciones de Gentle Dot para recibir avisos de tus agentes."); return; }
        beginMonitor(call);
    }

    private boolean canNotify() {
        return Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED;
    }

    private void beginMonitor(PluginCall call) {
        if (!NotificationManagerCompat.from(getContext()).areNotificationsEnabled()) { call.reject("Activa las notificaciones de Gentle Dot en los ajustes de Android."); return; }
        String url = call.getString("url", "");
        String token = call.getString("token", "");
        if (!AgentMonitorService.validOrigin(url) || !token.matches("[A-Za-z0-9_-]{32,1024}")) {
            call.reject("Conexión de Tailscale no válida."); return;
        }
        String mode = call.getString("mode");
        if (mode != null && !AgentMonitorService.setNotificationMode(getContext(), mode)) {
            call.reject("No se pudo guardar la opción de avisos."); return;
        }
        try {
            Handler handler = new Handler(Looper.getMainLooper());
            AtomicBoolean settled = new AtomicBoolean();
            Runnable timeout = () -> {
                if (settled.compareAndSet(false, true)) call.reject("Android no confirmó el inicio de los avisos. Vuelve a abrir la app y comprueba su estado.");
            };
            Intent intent = new Intent(getContext(), AgentMonitorService.class);
            intent.putExtra("url", url);
            intent.putExtra("token", token);
            intent.putExtra("reply", new ResultReceiver(handler) {
                @Override protected void onReceiveResult(int code, Bundle data) {
                    handler.removeCallbacks(timeout);
                    if (!settled.compareAndSet(false, true)) return;
                    if (code == 1) call.resolve();
                    else call.reject("Android no pudo activar los avisos. Mantén la app abierta y vuelve a intentarlo.");
                }
            });
            ContextCompat.startForegroundService(getContext(), intent);
            handler.postDelayed(timeout, 10000);
        } catch (Exception error) { call.reject("No se pudieron activar los avisos. Mantén la app abierta y vuelve a intentarlo."); }
    }

    @PluginMethod
    public void stopMonitor(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            MonitorCredentials.clear(getContext());
            AgentMonitorService.stopCurrent();
            getContext().stopService(new Intent(getContext(), AgentMonitorService.class));
            call.resolve();
        });
    }

    @PluginMethod
    public void monitorState(PluginCall call) {
        JSObject result = new JSObject();
        result.put("active", AgentMonitorService.isActive());
        result.put("connected", AgentMonitorService.isConnected());
        result.put("notificationsEnabled", NotificationManagerCompat.from(getContext()).areNotificationsEnabled());
        result.put("mode", AgentMonitorService.notificationMode(getContext()));
        result.put("preferences", preferencesResult());
        call.resolve(result);
    }

    @PluginMethod
    public void setNotificationMode(PluginCall call) {
        if (!AgentMonitorService.setNotificationMode(getContext(), call.getString("mode", ""))) {
            call.reject("No se pudo guardar la opción de avisos."); return;
        }
        call.resolve();
    }

    private JSObject preferencesResult() {
        JSObject result = new JSObject();
        for (Map.Entry<String, Boolean> entry : AgentMonitorService.preferences(getContext()).values().entrySet()) result.put(entry.getKey(), entry.getValue());
        return result;
    }

    @PluginMethod
    public void setNotificationPreferences(PluginCall call) {
        JSObject value = call.getObject("preferences");
        if (value == null) { call.reject("Elige una configuración de alertas válida."); return; }
        Map<String, Boolean> values = new LinkedHashMap<>();
        Iterator<String> keys = value.keys();
        while (keys.hasNext()) {
            String key = keys.next(); Object item = value.opt(key);
            if (!NotificationPreferences.knownKey(key) || !(item instanceof Boolean)) { call.reject("Elige una configuración de alertas válida."); return; }
            values.put(key, (Boolean) item);
        }
        if (!AgentMonitorService.savePreferences(getContext(), values)) { call.reject("No se pudieron guardar las alertas."); return; }
        JSObject result = new JSObject(); result.put("preferences", preferencesResult()); call.resolve(result);
    }

    @PluginMethod
    public void openNotificationSettings(PluginCall call) {
        try {
            Intent intent = Build.VERSION.SDK_INT >= 26
                ? new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, getContext().getPackageName())
                : new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).setData(Uri.parse("package:" + getContext().getPackageName()));
            getActivity().startActivity(intent); call.resolve();
        } catch (Exception error) { call.reject("No se pudieron abrir los ajustes de Android."); }
    }

    @PluginMethod
    public void notify(PluginCall call) {
        if (!canNotify()) { call.resolve(); return; }
        // The UI already owns foreground presentation for direct calls; do not feed it back.
        JSObject session = call.getObject("session");
        AgentMonitorService.notifyEvent(getContext(), call.getString("event", NotificationPreferences.legacyEvent(call.getString("source", "agents"))),
            call.getString("id", "gentledot"), call.getString("title", "Gentle Dot"), call.getString("body", "Abre la conversación para continuar."),
            session == null ? null : session.optString("paneId"), session == null ? null : session.optString("sessionId"), false);
        call.resolve();
    }
}
