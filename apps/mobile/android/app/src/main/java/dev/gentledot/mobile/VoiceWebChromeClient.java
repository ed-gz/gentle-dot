package dev.gentledot.mobile;

import android.Manifest;
import android.content.pm.PackageManager;
import android.net.Uri;
import androidx.core.content.ContextCompat;
import android.webkit.PermissionRequest;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebChromeClient;
import java.util.Arrays;

/** Keep Capacitor's runtime permission flow, but never grant arbitrary WebView resources. */
final class VoiceWebChromeClient extends BridgeWebChromeClient {
    private final Uri appOrigin;
    private final Bridge bridge;
    private PermissionRequest pending;

    VoiceWebChromeClient(Bridge bridge) {
        super(bridge);
        this.bridge = bridge;
        appOrigin = Uri.parse(bridge.getLocalUrl());
    }

    @Override public void onPermissionRequest(PermissionRequest request) {
        Uri origin = request.getOrigin();
        if (pending != null || !ownOrigin(origin)
            || !Arrays.asList(request.getResources()).contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) {
            request.deny();
            return;
        }
        pending = request;
        // Capacitor requests RECORD_AUDIO at runtime. Its default implementation grants
        // every requested resource on success, so give it only the audio capability.
        super.onPermissionRequest(new PermissionRequest() {
            @Override public Uri getOrigin() { return origin; }
            @Override public String[] getResources() { return new String[]{RESOURCE_AUDIO_CAPTURE}; }
            @Override public void grant(String[] resources) {
                if (pending != request) return;
                pending = null;
                if (ContextCompat.checkSelfPermission(bridge.getContext(), Manifest.permission.RECORD_AUDIO)
                    == PackageManager.PERMISSION_GRANTED) {
                    request.grant(new String[]{RESOURCE_AUDIO_CAPTURE});
                } else {
                    request.deny();
                }
            }
            @Override public void deny() {
                if (pending != request) return;
                pending = null;
                request.deny();
            }
        });
    }

    private boolean ownOrigin(Uri origin) {
        return origin != null && origin.getUserInfo() == null
            && appOrigin.getScheme() != null && appOrigin.getAuthority() != null
            && appOrigin.getScheme().equals(origin.getScheme())
            && appOrigin.getAuthority().equals(origin.getAuthority());
    }

    @Override public void onPermissionRequestCanceled(PermissionRequest request) {
        if (pending == request) pending = null;
    }

    void close() {
        PermissionRequest request = pending;
        pending = null;
        if (request != null) request.deny();
    }
}
