package dev.gentledot.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.os.Build;
import android.os.Bundle;
import android.service.notification.StatusBarNotification;
import android.os.IBinder;
import android.os.Handler;
import android.os.Looper;
import android.os.ResultReceiver;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Set;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import javax.net.ssl.HttpsURLConnection;
import org.json.JSONArray;
import org.json.JSONObject;

/** User-started remote messaging monitor; never answers or grants permissions. */
public class AgentMonitorService extends Service {
    private static volatile AgentMonitorService current;
    private static final String STATUS_CHANNEL = "gentledot-connection";
    private static final String ALERT_CHANNEL = "gentledot-agents";
    private static final String DOT_CHANNEL = "gentledot-dot";
    private static final String PERMISSION_CHANNEL = "gentledot-permissions";
    private static final int STATUS_ID = 1;
    private static final String STOP = "dev.gentledot.mobile.STOP_MONITOR";
    private volatile MonitorSession session;

    public static String notificationMode(Context context) {
        String mode = context.getSharedPreferences("gentledot-notifications", Context.MODE_PRIVATE).getString("mode", "all");
        return NotificationMode.valid(mode) ? mode : "all";
    }

    public static boolean setNotificationMode(Context context, String mode) {
        if (!NotificationMode.valid(mode)) return false;
        SharedPreferences.Editor editor = context.getSharedPreferences("gentledot-notifications", Context.MODE_PRIVATE).edit().putString("mode", mode);
        // Explicit legacy calls reset the granular source filters, preserving presentation choices.
        NotificationPreferences migrated = new NotificationPreferences(mode, null);
        for (String key : new String[] { "dotReplies", "dotErrors", "agentCompleted", "agentAttention", "agentErrors", "agentAvailable", "permissions" }) editor.putBoolean(key, migrated.get(key));
        return editor.commit();
    }

    static NotificationPreferences preferences(Context context) {
        return new NotificationPreferences(notificationMode(context), context.getSharedPreferences("gentledot-notifications", Context.MODE_PRIVATE).getAll());
    }

    static boolean savePreferences(Context context, Map<String, Boolean> values) {
        SharedPreferences.Editor editor = context.getSharedPreferences("gentledot-notifications", Context.MODE_PRIVATE).edit();
        for (Map.Entry<String, Boolean> entry : values.entrySet()) {
            if (!NotificationPreferences.knownKey(entry.getKey()) || entry.getValue() == null) return false;
            editor.putBoolean(entry.getKey(), entry.getValue());
        }
        if (!editor.commit()) return false;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        NotificationPreferences preferences = preferences(context);
        for (StatusBarNotification active : manager.getActiveNotifications()) {
            if (active.getTag() == null || !active.getTag().startsWith("gentledot:")) continue;
            String event = active.getNotification().extras.getString("gentledot.event", "unknown");
            if (!preferences.allows(event)) manager.cancel(active.getTag(), active.getId());
        }
        return true;
    }

    public static boolean isActive() {
        AgentMonitorService service = current;
        MonitorSession monitor = service == null ? null : service.session;
        return monitor != null && monitor.ownsMonitor();
    }

    static void resumeSaved(Context context) {
        JSONObject saved = MonitorCredentials.load(context);
        if (!MonitorStartPolicy.shouldStart(saved != null, NotificationManagerCompat.from(context).areNotificationsEnabled(), isActive())) return;
        try {
            ContextCompat.startForegroundService(context, new Intent(context, AgentMonitorService.class)
                .putExtra("url", saved.optString("url")).putExtra("token", saved.optString("token")));
        } catch (Exception ignored) { /* The settings screen exposes an inactive monitor for manual retry. */ }
    }

    static String monitorStatus(Context context) {
        return MonitorStartPolicy.status(MonitorCredentials.load(context) != null,
            NotificationManagerCompat.from(context).areNotificationsEnabled(), isActive(), isConnected());
    }

    public static boolean isConnected() {
        AgentMonitorService service = current;
        MonitorSession monitor = service == null ? null : service.session;
        return monitor != null && monitor.ownsMonitor() &&
            ((monitor.dotSocket != null && monitor.dotSocket.isConnected()) ||
             (monitor.lastReached > 0 && System.currentTimeMillis() - monitor.lastReached < 30_000));
    }

    /** Called on the main thread before resolving a user's stop request. */
    public static void stopCurrent() {
        AgentMonitorService service = current;
        if (service != null) { MonitorCredentials.clear(service); service.stopMonitoring(); }
    }

    private void stopMonitoring() {
        MonitorSession previous = session;
        session = null;
        if (current == this) current = null;
        if (previous != null) previous.close();
        CompanionOverlayService.activity("dot", "idle");
        CompanionOverlayService.activity("sessions", "idle");
        CompanionOverlayService.activity("dotApprovals", "idle");
    }

    public static boolean validOrigin(String input) {
        try {
            URI uri = new URI(input);
            String host = uri.getHost();
            return "https".equals(uri.getScheme()) && host != null
                && host.matches("[a-zA-Z0-9-]+(?:\\.[a-zA-Z0-9-]+)+\\.ts\\.net")
                && uri.getRawUserInfo() == null && uri.getPort() == -1
                && (uri.getPath() == null || uri.getPath().isEmpty())
                && uri.getQuery() == null && uri.getFragment() == null;
        } catch (Exception error) { return false; }
    }

    private static void channels(Context context) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel(STATUS_CHANNEL, "Conexión con el equipo", NotificationManager.IMPORTANCE_LOW));
    }

    private static PendingIntent openApp(Context context) {
        Intent intent = new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private static PendingIntent openConversation(Context context, String id, String title, String body, String pane, String session, String conversation) {
        Intent intent = new Intent(context, CompanionOverlayService.running() ? CompanionChatActivity.class : MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP)
            .putExtra("companion.openChat", true).putExtra("companion.eventId", id).putExtra("companion.title", title).putExtra("companion.body", body)
            .putExtra("companion.paneId", pane).putExtra("companion.sessionId", session).putExtra("companion.conversationId", conversation);
        return PendingIntent.getActivity(context, id.hashCode(), intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private Notification status(String body) {
        Intent stop = new Intent(this, AgentMonitorService.class).setAction(STOP);
        PendingIntent action = PendingIntent.getService(this, 1, stop, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new NotificationCompat.Builder(this, STATUS_CHANNEL)
            .setSmallIcon(R.drawable.ic_notification).setContentTitle("Gentle Dot")
            .setContentText(body).setContentIntent(openApp(this)).setOngoing(true).setOnlyAlertOnce(true)
            .addAction(0, "Detener avisos", action).setVisibility(NotificationCompat.VISIBILITY_PRIVATE).build();
    }

    public static void notifyUser(Context context, String id, String title, String body) {
        notifyUser(context, "dot", id, title, body);
    }

    public static void notifyUser(Context context, String source, String id, String title, String body) {
        notifyEvent(context, NotificationPreferences.legacyEvent(source), id, title, body);
    }

    public static void notifyEvent(Context context, String event, String id, String title, String body) {
        notifyEvent(context, event, id, title, body, null, null, true);
    }

    static void notifyEvent(Context context, String event, String id, String title, String body,
            String paneId, String sessionId, boolean monitorEvent) {
        deliver(context, event, id, title, body, paneId, sessionId, null, monitorEvent);
    }
    private static void deliver(Context context, String event, String id, String title, String body,
            String paneId, String sessionId, String conversationId, boolean monitorEvent) {
        CompanionOverlayService.react(event);
        NotificationPreferences preferences = preferences(context);
        NotificationDelivery.Route route = NotificationDelivery.route(preferences, event, MainActivity.isVisible(), monitorEvent);
        if (route == NotificationDelivery.Route.NONE) return;
        if (route == NotificationDelivery.Route.FOREGROUND
                && GentleMobilePlugin.foregroundNotification(event, id, title, body, paneId, sessionId)) return;
        boolean normalInterruptionMode = false;
        try { normalInterruptionMode = context.getSystemService(NotificationManager.class).getCurrentInterruptionFilter() == NotificationManager.INTERRUPTION_FILTER_ALL; }
        catch (RuntimeException ignored) { /* Unknown interruption policy stays with the system notification route. */ }
        if (!CompanionPolicy.offerNotice(NotificationManagerCompat.from(context).areNotificationsEnabled(), normalInterruptionMode)) {
            systemNotice(context, event, id, title, body, paneId, sessionId, conversationId, false); return;
        }
        CompanionOverlayService.offer(event, id, title, body, paneId, sessionId, conversationId,
            drawn -> systemNotice(context, event, id, title, body, paneId, sessionId, conversationId, drawn));
    }

    private static void systemNotice(Context context, String event, String id, String title, String body,
            String paneId, String sessionId, String conversationId, boolean companionVisible) {
        NotificationPreferences preferences = preferences(context);
        if (!preferences.allows(event)) return;
        if (!companionVisible && MainActivity.isVisible() && preferences.get("inApp")
                && GentleMobilePlugin.foregroundNotification(event, id, title, body, paneId, sessionId)) return;
        // Keep the normal heads-up fallback unless the overlay actually drew this notice.
        channels(context);
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return;
        title = title.substring(0, Math.min(title.length(), 120));
        body = body.substring(0, Math.min(body.length(), 1000));
        String source = "permission".equals(event) ? PERMISSION_CHANNEL : event.startsWith("dot") ? DOT_CHANNEL : ALERT_CHANNEL;
        String channel = source + "-v2-" + preferences.channelSuffix() + (companionVisible ? "-companion" : "");
        if (Build.VERSION.SDK_INT >= 26) {
            String name = "permission".equals(event) ? "Solicitudes de permiso" : event.startsWith("dot") ? "Alertas de Dot" : "Alertas de sesiones";
            NotificationChannel settings = new NotificationChannel(channel, name, companionVisible ? NotificationManager.IMPORTANCE_LOW : NotificationManager.IMPORTANCE_HIGH);
            settings.setDescription("Personaliza los avisos desde Ajustes → Alertas en Gentle Dot.");
            settings.enableVibration(preferences.get("vibration"));
            settings.setSound(preferences.get("sound") ? RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION) : null,
                new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION).build());
            context.getSystemService(NotificationManager.class).createNotificationChannel(settings);
        }
        Notification publicVersion = new NotificationCompat.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_notification).setContentTitle("Gentle Dot").setContentText("Tienes una nueva alerta.").build();
        Bundle extras = new Bundle(); extras.putString("gentledot.event", event);
        Notification notification = new NotificationCompat.Builder(context, channel)
            .addExtras(extras).setSmallIcon(R.drawable.ic_notification).setContentTitle(title)
            .setContentText(body).setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH).setOnlyAlertOnce(true)
            .setDefaults((preferences.get("sound") ? Notification.DEFAULT_SOUND : 0) | (preferences.get("vibration") ? Notification.DEFAULT_VIBRATE : 0))
            .setContentIntent(openConversation(context, id, title, body, paneId, sessionId, conversationId)).setAutoCancel(true).setOngoing(false)
            .setTimeoutAfter("permission".equals(event) ? 30 * 60_000 : 5 * 60_000)
            .setPublicVersion(publicVersion)
            .setVisibility(preferences.get("preview") ? NotificationCompat.VISIBILITY_PUBLIC : NotificationCompat.VISIBILITY_PRIVATE).build();
        try { NotificationManagerCompat.from(context).notify("gentledot:" + id, 2, notification); }
        catch (SecurityException ignored) { /* Permission can be withdrawn while connected. */ }
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && STOP.equals(intent.getAction())) {
            MonitorCredentials.clear(this); stopMonitoring(); stopSelf(); return START_NOT_STICKY;
        }
        if (!NotificationManagerCompat.from(this).areNotificationsEnabled()) {
            stopMonitoring(); stopSelf(); return START_NOT_STICKY;
        }
        // Android can reclaim the process while the phone sleeps. Restore only a
        // previously opted-in monitor, never a new pairing or revoked token.
        if (intent == null) {
            JSONObject saved = MonitorCredentials.load(this);
            if (saved == null) { stopSelf(); return START_NOT_STICKY; }
            intent = new Intent().putExtra("url", saved.optString("url")).putExtra("token", saved.optString("token"));
        }
        @SuppressWarnings("deprecation") ResultReceiver reply = intent.getParcelableExtra("reply");
        String newOrigin = intent.getStringExtra("url");
        String newToken = intent.getStringExtra("token");
        if (newOrigin == null || !validOrigin(newOrigin) || newToken == null || !newToken.matches("[A-Za-z0-9_-]{32,1024}")) {
            if (reply != null) reply.send(0, null);
            if (!isActive()) stopSelf();
            return isActive() ? START_STICKY : START_NOT_STICKY;
        }
        MonitorSession previous = session;
        if (previous != null && previous.ownsMonitor() && newOrigin.equals(previous.origin) && newToken.equals(previous.token)) {
            if (reply != null) reply.send(1, null);
            return START_STICKY;
        }
        stopMonitoring();
        channels(this);
        try { startForeground(STATUS_ID, status("Conectando con tu equipo por Tailscale…")); }
        catch (Exception error) {
            if (reply != null) reply.send(0, null);
            stopSelf(); return START_NOT_STICKY;
        }
        try { MonitorCredentials.save(this, newOrigin, newToken); }
        catch (Exception error) {
            if (reply != null) reply.send(0, null);
            stopForeground(STOP_FOREGROUND_REMOVE); stopSelf(); return START_NOT_STICKY;
        }
        MonitorSession next = new MonitorSession(newOrigin, newToken);
        session = next;
        current = this;
        next.start();
        if (reply != null) reply.send(1, null);
        return START_STICKY;
    }

    /** Every start has its own executor, credentials and cancellation scope. */
    private final class MonitorSession implements AutoCloseable {
        private final String origin;
        private final String token;
        private final ScheduledExecutorService executor = Executors.newSingleThreadScheduledExecutor();
        private final SessionNoticeLedger notices = new SessionNoticeLedger();
        private volatile Set<String> approvals = new HashSet<>();
        private volatile Set<String> dotApprovals = new HashSet<>();
        private volatile HttpsURLConnection request;
        private volatile boolean closed;
        private ScheduledFuture<?> nextPoll;
        private DotMonitorSocket dotSocket;
        private int failures;
        private volatile long lastReached;
        private String lastStatus;

        MonitorSession(String origin, String token) { this.origin = origin; this.token = token; }
        boolean ownsMonitor() { return !closed && current == AgentMonitorService.this && session == this; }
        void start() {
            dotSocket = new DotMonitorSocket(AgentMonitorService.this, origin, token, this::ownsMonitor, this::revoked, this::receiveNotice);
            dotSocket.start();
            executor.execute(this::poll);
        }
        void revoked() {
            new Handler(Looper.getMainLooper()).post(() -> {
                if (ownsMonitor()) { MonitorCredentials.clear(AgentMonitorService.this); stopMonitoring(); stopSelf(); }
            });
        }
        void receiveNotice(JSONObject notice) {
            if (!ownsMonitor() || executor.isShutdown()) return;
            String event = notice.optString("notificationEvent");
            String id = notice.optString("notificationId");
            if (id.isEmpty()) return;
            if (!"permission".equals(event)) {
                // The socket must not wait behind a slow HTTP request to deliver a reply.
                if (notices.live(id)) {
                    JSONObject identity = notice.optJSONObject("session");
                    alert(event, "event:" + id, notice.optString("title", "Gentle Dot"),
                        notice.optString("message", "Hay una actualización en tu sesión."),
                        identity == null ? new JSONObject() : identity);
                }
                return;
            }
            CompanionOverlayService.react(event);
            try { executor.execute(() -> {
                if (!ownsMonitor()) return;
                // Fetch the concrete request id so its notification is removed
                // on resolution and never duplicated by the regular poll.
                if (nextPoll != null) nextPoll.cancel(false);
                poll();
            }); } catch (java.util.concurrent.RejectedExecutionException ignored) { }
        }
        void alert(String event, String id, String title, String body, JSONObject identity) {
            if (ownsMonitor()) notifyEvent(AgentMonitorService.this, event, id, title, body,
                identity.optString("paneId"), identity.optString("sessionId"), true);
        }
        void updateStatus(String body) {
            if (!ownsMonitor() || body.equals(lastStatus)) return;
            try {
                NotificationManagerCompat.from(AgentMonitorService.this).notify(STATUS_ID, status(body));
                lastStatus = body;
            } catch (SecurityException ignored) { }
        }
        private void poll() {
            if (!ownsMonitor()) return;
            NotificationPreferences preferences = preferences(AgentMonitorService.this);
            if (!MonitorPollPolicy.needsSessions(preferences) && !CompanionOverlayService.prefs(AgentMonitorService.this).getBoolean("enabled", false)) {
                // If the source is enabled later, start from a fresh baseline instead of replaying muted events.
                notices.resetBaseline();
                failures = 0;
                updateStatus(dotSocket != null && dotSocket.isConnected() ? "Alertas conectadas" : "Conectando con tu equipo…");
                scheduleNext();
                return;
            }
            HttpsURLConnection connection = null;
            boolean hostReached = false;
            try {
                connection = (HttpsURLConnection) new URL(origin + "/orchestration").openConnection();
                request = connection;
                connection.setInstanceFollowRedirects(false);
                connection.setConnectTimeout(8000);
                connection.setReadTimeout(8000);
                connection.setRequestProperty("Authorization", "Bearer " + token);
                connection.setRequestProperty("Accept", "application/json");
                int status = connection.getResponseCode();
                hostReached = true;
                if (!ownsMonitor()) return;
                if (status == 401 || status == 403) {
                    notifyEvent(AgentMonitorService.this, "dotError", "access-expired", "Vuelve a vincular Gentle Dot", "El equipo revocó el acceso de este teléfono.");
                    revoked(); return;
                }
                if (status != 200) throw new Exception("unavailable");
                ByteArrayOutputStream bytes = new ByteArrayOutputStream();
                try (InputStream input = connection.getInputStream()) {
                    byte[] buffer = new byte[8192]; int count;
                    while ((count = input.read(buffer)) != -1) {
                        if (!ownsMonitor()) return;
                        if (bytes.size() + count > 2 * 1024 * 1024) throw new Exception("response too large");
                        bytes.write(buffer, 0, count);
                    }
                }
                JSONObject snapshot = new JSONObject(bytes.toString(StandardCharsets.UTF_8.name()));
                if (!ownsMonitor()) return;
                lastReached = System.currentTimeMillis();
                if (snapshot.optBoolean("available")) process(snapshot);
                failures = 0;
                updateStatus(snapshot.optBoolean("available") ? "Alertas conectadas" : "Buscando sesiones…");
            } catch (Exception error) {
                failures = Math.min(failures + 1, 6);
                updateStatus("Sin conexión. Revisa Tailscale y tu equipo.");
            } finally {
                request = null;
                if (connection != null) connection.disconnect();
            }
            // A failed connection already spent the network timeout. Do not immediately repeat it for a second path.
            // An HTTP error still proves the host is reachable; its independent permission broker can remain usable.
            if (ownsMonitor() && MonitorPollPolicy.needsDotApprovals(preferences, hostReached)) {
                try { pollDotApprovals(); } catch (Exception ignored) { /* Keep known requests on a temporary network failure. */ }
            }
            scheduleNext();
        }

        private void scheduleNext() {
            if (ownsMonitor() && !executor.isShutdown()) {
                try {
                    if (nextPoll != null) nextPoll.cancel(false);
                    nextPoll = executor.schedule(this::poll, failures > 0 ? Math.min(60, failures * 10) : 10, TimeUnit.SECONDS);
                }
                catch (java.util.concurrent.RejectedExecutionException ignored) { /* Stopped between check and scheduling. */ }
            }
        }

        private void pollDotApprovals() throws Exception {
            HttpsURLConnection connection = (HttpsURLConnection) new URL(origin + "/api/mobile/approvals").openConnection();
            request = connection;
            try {
                connection.setInstanceFollowRedirects(false); connection.setConnectTimeout(8000); connection.setReadTimeout(8000);
                connection.setRequestProperty("Authorization", "Bearer " + token); connection.setRequestProperty("Accept", "application/json");
                if (!ownsMonitor() || connection.getResponseCode() != 200) return;
                ByteArrayOutputStream bytes = new ByteArrayOutputStream();
                try (InputStream input = connection.getInputStream()) {
                    byte[] buffer = new byte[8192]; int count;
                    while ((count = input.read(buffer)) != -1) {
                        if (!ownsMonitor()) return;
                        if (bytes.size() + count > 2 * 1024 * 1024) throw new Exception("response too large");
                        bytes.write(buffer, 0, count);
                    }
                }
                JSONObject snapshot = new JSONObject(bytes.toString(StandardCharsets.UTF_8.name()));
                JSONArray pending = snapshot.optJSONArray("approvals");
                if (pending == null || !ownsMonitor()) return;
                Set<String> next = new HashSet<>();
                for (int i = 0; i < pending.length(); i++) {
                    JSONObject item = pending.optJSONObject(i); if (item == null) continue;
                    String id = item.optString("id"); if (id.isEmpty()) continue;
                    next.add(id);
                    if (!dotApprovals.contains(id) && ownsMonitor()) {
                        String title = "Dot necesita tu permiso";
                        String body = item.optString("title", "Revisa la solicitud en Dot.");
                        body = body.substring(0, Math.min(body.length(), 240));
                        notifyEvent(AgentMonitorService.this, "permission", "dot-approval:" + id, title, body);
                    }
                }
                for (String id : dotApprovals) if (!next.contains(id)) NotificationManagerCompat.from(AgentMonitorService.this).cancel("gentledot:dot-approval:" + id, 2);
                dotApprovals = next;
                CompanionOverlayService.activity("dotApprovals", next.isEmpty() ? "idle" : "permission");
            } finally { request = null; connection.disconnect(); }
        }

        private void process(JSONObject snapshot) {
            java.util.List<String> states = new java.util.ArrayList<>();
            JSONArray sessions = snapshot.optJSONArray("sessions");
            if (sessions != null) for (int i = 0; i < sessions.length(); i++) {
                JSONObject item = sessions.optJSONObject(i);
                if (item != null && item.optBoolean("connected")) states.add(item.optString("state"));
            }
            JSONArray pending = snapshot.optJSONArray("approvals");
            if (pending != null && pending.length() > 0) states.add("permission");
            CompanionOverlayService.activity("sessions", CompanionPolicy.aggregate(states));
            Set<String> currentApprovals = new HashSet<>();
            if (pending != null) for (int i = 0; i < pending.length(); i++) {
                JSONObject item = pending.optJSONObject(i); if (item == null) continue;
                String id = item.optString("id"); if (id.isEmpty()) continue;
                currentApprovals.add(id);
                if (!approvals.contains(id)) alert("permission", "approval:" + id, "Un agente necesita tu permiso",
                    item.optString("title", "Abre Gentle Dot para revisar la solicitud."), item);
            }
            for (String previous : approvals) if (ownsMonitor() && !currentApprovals.contains(previous)) NotificationManagerCompat.from(AgentMonitorService.this).cancel("gentledot:approval:" + previous, 2);
            approvals = currentApprovals;
            JSONArray events = snapshot.optJSONArray("events");
            if (events != null) for (int i = 0; i < events.length(); i++) {
                JSONObject event = events.optJSONObject(i); if (event == null) continue;
                String id = event.optString("id");
                if (!notices.snapshot(id) || event.optBoolean("intentional")) continue;
                // A concrete permission already has its own notification above.
                if (NotificationPreferences.hasSessionPermission(event.optString("requestId"), event.optString("approvalId"))) continue;
                Object changed = event.opt("resultChanged");
                String kind = NotificationPreferences.agentEvent(event.optString("type"), !event.optString("assistantMessageId").isEmpty(), false, changed instanceof Boolean ? (Boolean) changed : null);
                String title = "agentCompleted".equals(kind) ? "Sesión completada" : "agentAvailable".equals(kind) ? "Sesión disponible" : "agentError".equals(kind) ? "Se perdió la conexión" : "Una sesión necesita atención";
                String body = "agentCompleted".equals(kind) ? "Hay una nueva respuesta en tu sesión." : "agentAvailable".equals(kind) ? "Puedes continuar la conversación." : "Abre Sesiones para revisar el estado.";
                alert(kind, "event:" + id, title, body, event);
            }
            notices.baselineComplete();
        }

        @Override public void close() {
            closed = true;
            executor.shutdownNow();
            if (dotSocket != null) dotSocket.close();
            HttpsURLConnection connection = request;
            if (connection != null) connection.disconnect();
            for (String id : approvals) NotificationManagerCompat.from(AgentMonitorService.this).cancel("gentledot:approval:" + id, 2);
            for (String id : dotApprovals) NotificationManagerCompat.from(AgentMonitorService.this).cancel("gentledot:dot-approval:" + id, 2);
        }
    }

    @Override public void onDestroy() {
        stopMonitoring();
        super.onDestroy();
    }
    @Override public IBinder onBind(Intent intent) { return null; }
}
