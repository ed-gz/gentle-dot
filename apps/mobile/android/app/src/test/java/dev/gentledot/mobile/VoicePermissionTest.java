package dev.gentledot.mobile;

import static org.junit.Assert.*;
import android.Manifest;
import android.net.Uri;
import android.webkit.PermissionRequest;
import android.webkit.WebView;
import androidx.activity.result.ActivityResultCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContract;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityOptionsCompat;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebChromeClient;
import com.getcapacitor.CapConfig;
import com.getcapacitor.Plugin;
import com.getcapacitor.ServerPath;
import androidx.fragment.app.Fragment;
import com.getcapacitor.cordova.MockCordovaInterfaceImpl;
import java.util.*;
import org.apache.cordova.CordovaPreferences;
import org.apache.cordova.PluginManager;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.Implementation;
import org.robolectric.annotation.Implements;

@RunWith(RobolectricTestRunner.class)
@Config(sdk=35, shadows=VoicePermissionTest.ShadowBridge.class)
public class VoicePermissionTest {
    @Implements(Bridge.class)
    public static class ShadowBridge {
        @Implementation protected void __constructor__(AppCompatActivity activity, WebView webView,
            List<Class<? extends Plugin>> plugins, MockCordovaInterfaceImpl cordova,
            PluginManager manager, CordovaPreferences preferences, CapConfig config) {}
        // The public constructor delegates here; skip WebView initialization for unit tests.
        @Implementation protected void __constructor__(AppCompatActivity activity, ServerPath serverPath,
            Fragment fragment, WebView webView, List<Class<? extends Plugin>> plugins, List<Plugin> instances,
            MockCordovaInterfaceImpl cordova, PluginManager manager, CordovaPreferences preferences, CapConfig config) {}
    }
    static class TestBridge extends Bridge {
        ActivityResultCallback<Map<String,Boolean>> permissionCallback;
        String[] requested;
        TestBridge() { super(null,null,null,null,null,null,null); }
        @Override public String getLocalUrl() { return "https://localhost/"; }
        @Override public android.content.Context getContext() { return RuntimeEnvironment.getApplication(); }
        @Override public <I,O> ActivityResultLauncher<I> registerForActivityResult(
            ActivityResultContract<I,O> contract, ActivityResultCallback<O> callback) {
            if (contract instanceof androidx.activity.result.contract.ActivityResultContracts.RequestMultiplePermissions)
                permissionCallback = (ActivityResultCallback<Map<String,Boolean>>) (Object) callback;
            return new ActivityResultLauncher<I>() {
                @Override public void launch(I input, ActivityOptionsCompat options) { requested=(String[])input; }
                @Override public void unregister() {}
                @Override public ActivityResultContract<I,?> getContract() { return contract; }
            };
        }
    }
    static class Request extends PermissionRequest {
        final Uri origin;
        final String[] resources;
        String[] granted;
        boolean denied;
        Request(String origin,String... resources) { this.origin=Uri.parse(origin); this.resources=resources; }
        @Override public Uri getOrigin() { return origin; }
        @Override public String[] getResources() { return resources; }
        @Override public void grant(String[] resources) { granted=resources; }
        @Override public void deny() { denied=true; }
    }
    private BridgeWebChromeClient client(TestBridge bridge) {
        return new VoiceWebChromeClient(bridge);
    }
    @Test public void manifestDeclaresWebViewMicrophonePermissions() throws Exception {
        android.content.Context app=RuntimeEnvironment.getApplication();
        String[] permissions=app.getPackageManager().getPackageInfo(app.getPackageName(),
            android.content.pm.PackageManager.GET_PERMISSIONS).requestedPermissions;
        assertTrue(Arrays.asList(permissions).contains(Manifest.permission.RECORD_AUDIO));
        assertTrue(Arrays.asList(permissions).contains(Manifest.permission.MODIFY_AUDIO_SETTINGS));
    }
    @Test public void grantsOnlyAudioAfterRuntimeApproval() throws Exception {
        TestBridge bridge=new TestBridge();
        Request request=new Request("https://localhost",PermissionRequest.RESOURCE_AUDIO_CAPTURE,PermissionRequest.RESOURCE_VIDEO_CAPTURE);
        client(bridge).onPermissionRequest(request);
        assertNull("Must wait for Android approval",request.granted);
        assertArrayEquals(new String[]{Manifest.permission.MODIFY_AUDIO_SETTINGS,Manifest.permission.RECORD_AUDIO},bridge.requested);
        Shadows.shadowOf(RuntimeEnvironment.getApplication()).grantPermissions(Manifest.permission.RECORD_AUDIO);
        bridge.permissionCallback.onActivityResult(Map.of(Manifest.permission.RECORD_AUDIO,true,Manifest.permission.MODIFY_AUDIO_SETTINGS,true));
        assertArrayEquals(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE},request.granted);
    }
    @Test public void denialNeverGrantsAudio() throws Exception {
        TestBridge bridge=new TestBridge();
        Request request=new Request("https://localhost",PermissionRequest.RESOURCE_AUDIO_CAPTURE);
        client(bridge).onPermissionRequest(request);
        bridge.permissionCallback.onActivityResult(Map.of(Manifest.permission.RECORD_AUDIO,false));
        assertTrue(request.denied);
        assertNull(request.granted);
    }
    @Test public void foreignOriginsAndNonAudioResourcesAreDeniedWithoutPrompt() throws Exception {
        for (String origin:new String[]{"https://localhost.evil.test","http://localhost","https://localhost:444","https://other.test","https://user@localhost"}) {
            TestBridge bridge=new TestBridge();
            Request request=new Request(origin,PermissionRequest.RESOURCE_AUDIO_CAPTURE);
            client(bridge).onPermissionRequest(request);
            assertTrue(origin,request.denied);
            assertNull(bridge.requested);
        }
        TestBridge bridge=new TestBridge();
        Request request=new Request("https://localhost",PermissionRequest.RESOURCE_VIDEO_CAPTURE);
        client(bridge).onPermissionRequest(request);
        assertTrue(request.denied);
        assertNull(bridge.requested);
    }
    @Test public void emptyPermissionResultCannotGrantUnapprovedAudio() throws Exception {
        TestBridge bridge=new TestBridge();
        Request request=new Request("https://localhost",PermissionRequest.RESOURCE_AUDIO_CAPTURE);
        client(bridge).onPermissionRequest(request);
        bridge.permissionCallback.onActivityResult(Collections.emptyMap());
        assertTrue(request.denied);
        assertNull(request.granted);
    }
    @Test public void cancelledRequestCannotReceiveLateRuntimeGrant() throws Exception {
        TestBridge bridge=new TestBridge();
        BridgeWebChromeClient client=client(bridge);
        Request request=new Request("https://localhost",PermissionRequest.RESOURCE_AUDIO_CAPTURE);
        client.onPermissionRequest(request);
        client.onPermissionRequestCanceled(request);
        bridge.permissionCallback.onActivityResult(Map.of(Manifest.permission.RECORD_AUDIO,true));
        assertNull(request.granted);
    }
}
