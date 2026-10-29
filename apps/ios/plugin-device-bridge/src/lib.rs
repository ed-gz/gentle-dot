#[cfg(not(target_os = "ios"))]
use serde_json::json;
use serde_json::Value;
#[cfg(target_os = "ios")]
use tauri::Manager;
use tauri::{plugin::TauriPlugin, AppHandle, Runtime};
#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_device_bridge);
#[cfg(target_os = "ios")]
struct NativeBridge<R: Runtime>(tauri::plugin::PluginHandle<R>);

async fn call<R: Runtime>(
    app: AppHandle<R>,
    command: &'static str,
    args: Value,
) -> Result<Value, String> {
    #[cfg(target_os = "ios")]
    {
        let handle = app.state::<NativeBridge<R>>().0.clone();
        tauri::async_runtime::spawn_blocking(move || {
            handle.run_mobile_plugin::<Value>(command, args)
        })
        .await
        .map_err(|_| "device_bridge_failed".to_owned())?
        .map_err(|_| "device_bridge_failed".to_owned())
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = (app, command, args);
        Ok(
            json!({"ok": false, "error": "unsupported_platform", "message": "Esta función requiere Capri instalado en el iPhone."}),
        )
    }
}

// Keep a single explicit `request` envelope across Rust, Swift and TypeScript.
macro_rules! request_command {
    ($name:ident, $native:literal) => {
        #[tauri::command]
        async fn $name<R: Runtime>(app: AppHandle<R>, request: Value) -> Result<Value, String> {
            call(app, $native, request).await
        }
    };
}
request_command!(live_activity_available, "liveActivityAvailable");
request_command!(live_activity_list, "liveActivityList");
request_command!(live_activity_start, "liveActivityStart");
request_command!(live_activity_update, "liveActivityUpdate");
request_command!(live_activity_end, "liveActivityEnd");
request_command!(secret_get, "secretGet");
request_command!(secret_set, "secretSet");
request_command!(secret_delete, "secretDelete");
request_command!(pair_device, "pairDevice");
request_command!(unpair_device, "unpairDevice");
request_command!(https_request, "httpsRequest");
request_command!(https_receipt_state, "httpsReceiptState");
request_command!(https_receipt_cancel_before_start, "httpsReceiptCancelBeforeStart");
request_command!(session_upload_begin, "sessionUploadBegin");
request_command!(session_upload_write, "sessionUploadWrite");
request_command!(session_upload_send, "sessionUploadSend");
request_command!(session_upload_cancel, "sessionUploadCancel");
request_command!(oauth_authorize, "oauthAuthorize");
request_command!(oauth_cancel, "oauthCancel");
request_command!(open_external_url, "openExternalURL");
request_command!(registered_url_schemes, "registeredURLSchemes");
request_command!(crypto_random, "cryptoRandom");
request_command!(crypto_sha256, "cryptoSha256");
request_command!(crypto_hash_begin, "cryptoHashBegin");
request_command!(crypto_hash_update, "cryptoHashUpdate");
request_command!(crypto_hash_finish, "cryptoHashFinish");
request_command!(crypto_hash_cancel, "cryptoHashCancel");
request_command!(share_list, "shareList");
request_command!(share_read, "shareRead");
request_command!(share_ack, "shareAck");
request_command!(export_begin, "exportBegin");
request_command!(export_write, "exportWrite");
request_command!(export_present, "exportPresent");
request_command!(export_cancel, "exportCancel");
request_command!(pairing_scan, "pairingScan");
request_command!(pairing_scan_cancel, "pairingScanCancel");
request_command!(documents_pick, "documentsPick");
request_command!(documents_list, "documentsList");
request_command!(documents_read, "documentsRead");
request_command!(documents_ack, "documentsAck");

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("device-bridge")
        .invoke_handler(tauri::generate_handler![
            live_activity_available,
            live_activity_list,
            live_activity_start,
            live_activity_update,
            live_activity_end,
            secret_get,
            secret_set,
            secret_delete,
            pair_device,
            unpair_device,
            https_request,
            https_receipt_state,
            https_receipt_cancel_before_start,
            session_upload_begin,
            session_upload_write,
            session_upload_send,
            session_upload_cancel,
            oauth_authorize,
            oauth_cancel,
            open_external_url,
            registered_url_schemes,
            crypto_random,
            crypto_sha256,
            crypto_hash_begin,
            crypto_hash_update,
            crypto_hash_finish,
            crypto_hash_cancel,
            share_list,
            share_read,
            share_ack,
            export_begin,
            export_write,
            export_present,
            export_cancel,
            pairing_scan,
            pairing_scan_cancel,
            documents_pick,
            documents_list,
            documents_read,
            documents_ack
        ])
        .setup(|_app, _api| {
            #[cfg(target_os = "ios")]
            _app.manage(NativeBridge(
                _api.register_ios_plugin(init_plugin_device_bridge)?,
            ));
            Ok(())
        })
        .build()
}
