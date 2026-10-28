use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
#[cfg(target_os = "ios")]
use tauri::Manager;
use tauri::{plugin::TauriPlugin, AppHandle, Runtime};

const MAX_DOCUMENT_BYTES: usize = 12 * 1024 * 1024;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DocumentRequest {
    base64: String,
    mime_type: String,
    file_name: String,
}

fn valid_document(request: &DocumentRequest) -> bool {
    let bytes = request.base64.as_bytes();
    let padding = bytes.iter().rev().take_while(|b| **b == b'=').count();
    let size = bytes.len() / 4 * 3;
    let mime_allowed = matches!(
        request.mime_type.as_str(),
        "image/png"
            | "image/jpeg"
            | "image/heic"
            | "image/heif"
            | "image/webp"
            | "image/tiff"
            | "application/pdf"
    );
    mime_allowed
        && !request.file_name.is_empty()
        && request.file_name.chars().count() <= 255
        && !request.file_name.chars().any(char::is_control)
        && !bytes.is_empty()
        && bytes.len() <= MAX_DOCUMENT_BYTES.div_ceil(3) * 4
        && bytes.len() % 4 == 0
        && padding <= 2
        && size > padding
        && size - padding <= MAX_DOCUMENT_BYTES
        && bytes[..bytes.len() - padding]
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || *b == b'+' || *b == b'/')
}

fn valid_session_id(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(i, b)| {
            if matches!(i, 8 | 13 | 18 | 23) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}

fn valid_pairing_image(request: &DocumentRequest) -> bool {
    valid_document(request) && request.mime_type != "application/pdf"
}

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_perception);
#[cfg(target_os = "ios")]
struct NativeBridge<R: Runtime>(tauri::plugin::PluginHandle<R>);

async fn native_call<R: Runtime>(
    app: AppHandle<R>,
    command: &'static str,
    payload: Value,
) -> Result<Value, String> {
    #[cfg(target_os = "ios")]
    {
        let handle = app.state::<NativeBridge<R>>().0.clone();
        tauri::async_runtime::spawn_blocking(move || {
            handle.run_mobile_plugin::<Value>(command, payload)
        })
        .await
        .map_err(|_| "perception_bridge_failed".to_owned())?
        .map_err(|_| "perception_bridge_failed".to_owned())
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = (app, command, payload);
        Ok(
            json!({"ok": false, "available": false, "status": "platform_unsupported", "error": "platform_unsupported", "message": "La voz y Vision requieren Capri instalada en un iPhone compatible."}),
        )
    }
}

#[tauri::command]
async fn check_voice<R: Runtime>(app: AppHandle<R>) -> Result<Value, String> {
    native_call(app, "checkVoice", json!({})).await
}
#[tauri::command]
async fn prepare_voice<R: Runtime>(
    app: AppHandle<R>,
    owner_id: Option<String>,
) -> Result<Value, String> {
    if owner_id.as_deref().is_some_and(|id| !valid_session_id(id)) {
        return Err("invalid_voice_owner".into());
    }
    native_call(app, "prepareVoice", json!({"ownerId": owner_id})).await
}
#[tauri::command]
async fn start_voice<R: Runtime>(
    app: AppHandle<R>,
    owner_id: Option<String>,
) -> Result<Value, String> {
    if owner_id.as_deref().is_some_and(|id| !valid_session_id(id)) {
        return Err("invalid_voice_owner".into());
    }
    native_call(app, "startVoice", json!({"ownerId": owner_id})).await
}
#[tauri::command]
async fn stop_voice<R: Runtime>(app: AppHandle<R>, session_id: String) -> Result<Value, String> {
    if !valid_session_id(&session_id) {
        return Err("invalid_voice_session".into());
    }
    native_call(app, "stopVoice", json!({"sessionId": session_id})).await
}
#[tauri::command]
async fn cancel_voice<R: Runtime>(
    app: AppHandle<R>,
    owner_id: Option<String>,
) -> Result<Value, String> {
    if owner_id.as_deref().is_some_and(|id| !valid_session_id(id)) {
        return Err("invalid_voice_owner".into());
    }
    native_call(app, "cancelVoice", json!({"ownerId": owner_id})).await
}
#[tauri::command]
async fn cancel_document<R: Runtime>(app: AppHandle<R>) -> Result<Value, String> {
    native_call(app, "cancelDocument", json!({})).await
}
#[tauri::command]
async fn recognize_document<R: Runtime>(
    app: AppHandle<R>,
    request: DocumentRequest,
) -> Result<Value, String> {
    if !valid_document(&request) {
        return Err("invalid_document".into());
    }
    native_call(app, "recognizeDocument", json!(request)).await
}

#[tauri::command]
async fn scan_pairing_code<R: Runtime>(
    app: AppHandle<R>,
    request: DocumentRequest,
) -> Result<Value, String> {
    if !valid_pairing_image(&request) {
        return Err("invalid_pairing_image".into());
    }
    native_call(app, "scanPairingCode", json!(request)).await
}

#[tauri::command]
async fn cancel_pairing_code<R: Runtime>(app: AppHandle<R>) -> Result<Value, String> {
    native_call(app, "cancelPairingCode", json!({})).await
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("perception")
        .invoke_handler(tauri::generate_handler![
            check_voice,
            prepare_voice,
            start_voice,
            stop_voice,
            cancel_voice,
            recognize_document,
            cancel_document,
            scan_pairing_code,
            cancel_pairing_code
        ])
        .setup(|_app, _api| {
            #[cfg(target_os = "ios")]
            _app.manage(NativeBridge(
                _api.register_ios_plugin(init_plugin_perception)?,
            ));
            Ok(())
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request() -> DocumentRequest {
        DocumentRequest {
            base64: "eA==".into(),
            mime_type: "image/png".into(),
            file_name: "error.png".into(),
        }
    }
    #[test]
    fn document_rejects_oversize_malformed_base64_and_active_content() {
        assert!(valid_document(&request()));
        for value in [
            "",
            "eA=",
            "===e",
            "e==A",
            "eA===",
            "\neA==",
            "data:image/png;base64,eA==",
        ] {
            let mut r = request();
            r.base64 = value.into();
            assert!(!valid_document(&r), "{value}");
        }
        let mut r = request();
        r.base64 = "A".repeat(MAX_DOCUMENT_BYTES.div_ceil(3) * 4 + 4);
        assert!(!valid_document(&r));
        for mime in ["image/svg+xml", "text/html", "", "application/octet-stream"] {
            let mut r = request();
            r.mime_type = mime.into();
            assert!(!valid_document(&r));
        }
        for name in ["", "x\n.png", "\0"] {
            let mut r = request();
            r.file_name = name.into();
            assert!(!valid_document(&r));
        }
    }
    #[test]
    fn session_ids_do_not_accept_paths_or_arbitrary_payloads() {
        assert!(valid_session_id("01234567-89ab-CDEF-0123-456789abcdef"));
        for id in [
            "",
            "../../tmp/file",
            "0123456789ab-CDEF-0123-456789abcdef",
            "z1234567-89ab-CDEF-0123-456789abcdef",
        ] {
            assert!(!valid_session_id(id));
        }
    }
    #[test]
    fn pairing_accepts_only_bounded_image_requests() {
        let mut image = request();
        assert!(valid_pairing_image(&image));
        image.mime_type = "application/pdf".into();
        assert!(valid_document(&image));
        assert!(!valid_pairing_image(&image));
        image.mime_type = "image/svg+xml".into();
        assert!(!valid_pairing_image(&image));
        image.mime_type = "image/png".into();
        image.base64 = "A".repeat(MAX_DOCUMENT_BYTES.div_ceil(3) * 4 + 4);
        assert!(!valid_pairing_image(&image));
    }
}
