package dev.gentledot.mobile;

import android.content.Context;
import androidx.core.app.NotificationManagerCompat;
import java.util.LinkedHashSet;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import org.json.JSONArray;
import org.json.JSONObject;

/** Read-only notification subscriber to the daemon's existing protocol. */
final class DotMonitorSocket implements AutoCloseable {
    private final Context context;
    private final String origin;
    private String token;
    private final Runnable revoked;
    private final BooleanSupplier ownerActive;
    private final Consumer<JSONObject> sessionNotice;
    private final ScheduledExecutorService retry = Executors.newSingleThreadScheduledExecutor();
    private final OkHttpClient client = new OkHttpClient.Builder()
        .followRedirects(false).followSslRedirects(false).connectTimeout(10, TimeUnit.SECONDS)
        .pingInterval(30, TimeUnit.SECONDS).build();
    private final LinkedHashSet<String> seen = new LinkedHashSet<>();
    private final ChatCatchup catchup = new ChatCatchup();
    private boolean stopped;
    private boolean connected;
    private WebSocket socket;
    private long generation;
    private int failures;
    private String agentState = "idle";
    private final LinkedHashSet<String> questions = new LinkedHashSet<>();
    // Only running tool identities/kinds, never arguments or output. Bound hostile/malformed streams.
    private final java.util.Map<String,String> tools = new java.util.LinkedHashMap<>();
    private String overlayState() {
        if ("error".equals(agentState)) return "idle"; // Error is a bounded reaction, not an endless loop.
        if (tools.isEmpty() || "needs_you".equals(agentState)) return agentState;
        for(String kind:tools.values()) if(!"read".equals(kind)&&!"search".equals(kind))return "working";
        return "reading";
    }
    private void activity(String state) {
        boolean failed = "error".equals(state) && !state.equals(agentState);
        agentState = state;
        if ("idle".equals(state)||"error".equals(state)) tools.clear();
        CompanionOverlayService.activity("dot", questions.isEmpty() ? overlayState() : "permission");
        if (failed) CompanionOverlayService.react("dotError");
    }

    DotMonitorSocket(Context context, String origin, String token, BooleanSupplier ownerActive, Runnable revoked, Consumer<JSONObject> sessionNotice) {
        this.context = context;
        this.origin = origin;
        this.token = token;
        this.ownerActive = ownerActive;
        this.revoked = revoked;
        this.sessionNotice = sessionNotice;
    }

    synchronized void start() {
        if (stopped || !ownerActive.getAsBoolean()) return;
        final long attempt = ++generation;
        Request request = new Request.Builder().url(origin.replaceFirst("^https:", "wss:") + "/ws").build();
        socket = client.newWebSocket(request, new WebSocketListener() {
            @Override public void onOpen(WebSocket webSocket, Response response) {
                synchronized (DotMonitorSocket.this) {
                    if (!current(attempt)) { webSocket.cancel(); return; }
                    try {
                        JSONObject hello = new JSONObject();
                        hello.put("type", "hello"); hello.put("protocol", 1); hello.put("token", token);
                        webSocket.send(hello.toString());
                    } catch (Exception ignored) { webSocket.cancel(); }
                }
            }
            @Override public void onMessage(WebSocket webSocket, String text) {
                synchronized (DotMonitorSocket.this) {
                    if (!current(attempt) || text.length() > 2 * 1024 * 1024) return;
                    try { receive(webSocket, attempt, new JSONObject(text)); } catch (Exception ignored) { }
                }
            }
            @Override public void onClosing(WebSocket webSocket, int code, String reason) {
                webSocket.close(code, null);
                synchronized (DotMonitorSocket.this) {
                    if (!current(attempt)) return;
                    if (code == 4401 || code == 4400) {
                        AgentMonitorService.notifyEvent(context, "dotError", "access-expired", "Revisa la conexión de Gentle Dot", "Vuelve a vincular el teléfono o actualiza la app.");
                        close();
                        revoked.run();
                    }
                }
            }
            @Override public void onClosed(WebSocket webSocket, int code, String reason) { reconnect(attempt); }
            @Override public void onFailure(WebSocket webSocket, Throwable error, Response response) { reconnect(attempt); }
        });
    }

    synchronized boolean isConnected() { return connected && !stopped; }

    private boolean current(long attempt) { return !stopped && attempt == generation && ownerActive.getAsBoolean(); }

    private synchronized void reconnect(long attempt) {
        if (!current(attempt) || retry.isShutdown()) return;
        // Invalidate every callback from the old socket before scheduling its replacement.
        generation++;
        connected = false;
        questions.clear(); activity("idle");
        failures = Math.min(failures + 1, 12);
        retry.schedule(this::start, Math.min(60, failures * 5), TimeUnit.SECONDS);
    }

    private void receive(WebSocket webSocket, long attempt, JSONObject message) {
        String type = message.optString("type");
        if ("toast".equals(type) && message.has("notificationId")) {
            sessionNotice.accept(message);
            return;
        }
        if ("ready".equals(type)) {
            connected = true;
            failures = 0;
            questions.clear(); activity(message.optString("agentState", "idle"));
            catchup.ready(message.optString("conversationId"), "idle".equals(message.optString("agentState")));
            webSocket.send("{\"type\":\"get_history\"}");
            return;
        }
        if ("agent_state".equals(type)) {
            activity(message.optString("state", "idle"));
            boolean idle = "idle".equals(message.optString("state"));
            catchup.state(idle);
            if (idle) webSocket.send("{\"type\":\"get_history\"}");
            return;
        }
        if ("activity".equals(type)) {
            JSONObject tool=message.optJSONObject("activity");
            if(tool==null)return;
            String id=tool.optString("id"), status=tool.optString("status"), kind=tool.optString("kind");
            if(id.isEmpty()||id.length()>160)return;
            if("running".equals(status)) {
                if(tools.size()<128||tools.containsKey(id))tools.put(id,("read".equals(kind)||"search".equals(kind))?kind:"other");
            } else if("done".equals(status)||"failed".equals(status))tools.remove(id);
            else return;
            activity(agentState);
            if("failed".equals(status))CompanionOverlayService.react("dotError");
            return;
        }
        if ("history".equals(type)) {
            String latest = "";
            JSONArray messages = message.optJSONArray("messages");
            if (messages == null) return;
            for (int i = messages.length() - 1; i >= 0; i--) {
                JSONObject item = messages.optJSONObject(i);
                if (item != null && "assistant".equals(item.optString("role")) && !item.optString("text").trim().isEmpty()) {
                    latest = item.optString("id") + "\n" + item.optString("text");
                    break;
                }
            }
            if (catchup.history(message.optString("conversationId"), latest)) {
                CompanionOverlayService.react("dotReply");
                AgentMonitorService.notifyUser(context, "dot-catchup", "Gentle Dot tiene respuestas nuevas", "La conexión volvió. Abre la conversación para revisar las respuestas recibidas mientras estabas sin red.");
            }
            return;
        }
        if ("ask_resolved".equals(type)) {
            questions.remove(message.optString("requestId")); activity(agentState);
            NotificationManagerCompat.from(context).cancel("gentledot:dot-ask:" + message.optString("requestId"), 2);
            return;
        }
        String id, title, body;
        String event = "dotReply";
        if ("ask".equals(type)) {
            JSONObject ask = message.optJSONObject("ask");
            if (ask == null || ask.optString("requestId").isEmpty() || !NotificationPreferences.socketQuestion(ask.optString("method"))) return;
            questions.add(ask.optString("requestId")); activity(agentState);
            id = "dot-ask:" + ask.optString("requestId");
            event = "permission";
            title = "Gentle Dot necesita tu respuesta";
            body = ask.optString("title", "Abre la conversación para continuar.");
        } else if ("message_done".equals(type)) {
            if (message.optBoolean("stopped") || message.optBoolean("intermediate") || message.optString("messageId").isEmpty()) return;
            // Empty tool-only turns are not a user-visible answer.
            if (message.optString("text").trim().isEmpty() && !message.has("error")) return;
            catchup.liveReply();
            // Live ids restart when the daemon does; they are not history page ids.
            id = "dot-message:" + attempt + ":" + message.optString("messageId");
            event = message.has("error") ? "dotError" : "dotReply";
            title = message.has("error") ? "Dot necesita atención" : "Dot respondió";
            body = "Abre la conversación para revisar el resultado.";
        } else return;
        if (!seen.add(id)) return;
        while (seen.size() > 512) seen.remove(seen.iterator().next());
        AgentMonitorService.notifyEvent(context, event, id, title, body);
    }

    @Override public synchronized void close() {
        if (stopped) return;
        stopped = true;
        connected = false;
        questions.clear(); activity("idle");
        generation++;
        token = null;
        retry.shutdownNow();
        if (socket != null) socket.cancel();
        client.dispatcher().executorService().shutdown();
        client.connectionPool().evictAll();
    }
}
