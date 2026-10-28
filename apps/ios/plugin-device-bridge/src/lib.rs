use serde_json::{json, Value};
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
request_command!(secret_get, "secretGet");
request_command!(secret_set, "secretSet");
request_command!(secret_delete, "secretDelete");
request_command!(pair_device, "pairDevice");
request_command!(unpair_device, "unpairDevice");
request_command!(https_request, "httpsRequest");
request_command!(oauth_authorize, "oauthAuthorize");
request_command!(oauth_cancel, "oauthCancel");
request_command!(crypto_random, "cryptoRandom");
request_command!(crypto_sha256, "cryptoSha256");
request_command!(crypto_hash_begin, "cryptoHashBegin");
request_command!(crypto_hash_update, "cryptoHashUpdate");
request_command!(crypto_hash_finish, "cryptoHashFinish");
request_command!(crypto_hash_cancel, "cryptoHashCancel");
request_command!(share_list, "shareList");
request_command!(share_read, "shareRead");
request_command!(share_ack, "shareAck");

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("device-bridge")
        .invoke_handler(tauri::generate_handler![
            secret_get,
            secret_set,
            secret_delete,
            pair_device,
            unpair_device,
            https_request,
            oauth_authorize,
            oauth_cancel,
            crypto_random,
            crypto_sha256,
            crypto_hash_begin,
            crypto_hash_update,
            crypto_hash_finish,
            crypto_hash_cancel,
            share_list,
            share_read,
            share_ack
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
