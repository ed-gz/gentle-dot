package dev.gentledot.mobile;

import static org.junit.Assert.*;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk=35)
public class CompanionMonitorActivityTest {
    @Test public void realDaemonToolPayloadsReachOverlayWithoutChangingAuthentication() throws Exception {
        // Exercise the socket parser itself, with a fake already-authenticated owner and no network.
        DotMonitorSocket socket=new DotMonitorSocket(org.robolectric.RuntimeEnvironment.getApplication(),"https://example.ts.net","unused",()->true,()->{},notice->{});
        java.lang.reflect.Method receive=DotMonitorSocket.class.getDeclaredMethod("receive",okhttp3.WebSocket.class,long.class,JSONObject.class);receive.setAccessible(true);
        java.lang.reflect.Field activities=CompanionOverlayService.class.getDeclaredField("activities");activities.setAccessible(true);
        @SuppressWarnings("unchecked") java.util.Map<String,String> states=(java.util.Map<String,String>)activities.get(null);
        try {
            receive.invoke(socket,null,1L,new JSONObject("{\"type\":\"agent_state\",\"state\":\"thinking\"}"));
            assertEquals("thinking",states.get("dot"));
            receive.invoke(socket,null,1L,new JSONObject("{\"type\":\"agent_state\",\"state\":\"working\"}"));
            receive.invoke(socket,null,1L,new JSONObject("{\"type\":\"activity\",\"messageId\":\"m1\",\"activity\":{\"id\":\"t1\",\"kind\":\"read\",\"status\":\"running\"}}"));
            assertEquals("reading",states.get("dot"));
            receive.invoke(socket,null,1L,new JSONObject("{\"type\":\"activity\",\"activity\":{\"id\":\"t2\",\"kind\":\"run\",\"status\":\"running\"}}"));
            assertEquals("working",states.get("dot"));
            receive.invoke(socket,null,1L,new JSONObject("{\"type\":\"activity\",\"activity\":{\"id\":\"t2\",\"kind\":\"run\",\"status\":\"done\"}}"));
            assertEquals("reading",states.get("dot"));
        } finally { socket.close();states.clear(); }
    }
}
