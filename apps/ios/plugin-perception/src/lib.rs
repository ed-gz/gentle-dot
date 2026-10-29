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

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RetainedVoiceRecord {
    id: String,
    owner: String,
    destination: String,
    locale: String,
    kind: String,
    created_at: u64,
    state: String,
    byte_count: Option<u64>,
    sha256: Option<String>,
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

fn valid_retention_destination(value: &str) -> bool {
    value == "chat"
        || value.strip_prefix("session:").is_some_and(|hash| {
            hash.len() == 64
                && hash
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
}

fn valid_retained_voice(record: &RetainedVoiceRecord) -> bool {
    let ready = record.state == "ready"
        && record
            .byte_count
            .is_some_and(|n| n > 0 && n <= 128 * 1024 * 1024)
        && record.sha256.as_deref().is_some_and(|hash| {
            hash.len() == 64
                && hash
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        });
    let capturing =
        record.state == "capturing" && record.byte_count.is_none() && record.sha256.is_none();
    let locale = record.locale.split('-').collect::<Vec<_>>();
    (ready || capturing)
        && valid_session_id(&record.id)
        && valid_session_id(&record.owner)
        && !record.id.eq_ignore_ascii_case(&record.owner)
        && valid_retention_destination(&record.destination)
        && record.created_at > 0
        && matches!(record.kind.as_str(), "speech" | "dictation")
        && locale
            .first()
            .is_some_and(|part| part.eq_ignore_ascii_case("es"))
        && record.locale.len() <= 40
        && locale.iter().all(|part| {
            !part.is_empty() && part.len() <= 8 && part.bytes().all(|b| b.is_ascii_alphanumeric())
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
    retain_destination: Option<String>,
) -> Result<Value, String> {
    if owner_id.as_deref().is_some_and(|id| !valid_session_id(id)) {
        return Err("invalid_voice_owner".into());
    }
    if retain_destination
        .as_deref()
        .is_some_and(|destination| owner_id.is_none() || !valid_retention_destination(destination))
    {
        return Err("invalid_voice_retention".into());
    }
    native_call(
        app,
        "startVoice",
        json!({"ownerId": owner_id, "retainDestination": retain_destination}),
    )
    .await
}
#[tauri::command]
async fn stop_voice<R: Runtime>(
    app: AppHandle<R>,
    session_id: String,
    owner_id: Option<String>,
    retain_destination: Option<String>,
) -> Result<Value, String> {
    if !valid_session_id(&session_id) {
        return Err("invalid_voice_session".into());
    }
    match (&owner_id, &retain_destination) {
        (None, None) => {}
        (Some(owner), Some(destination))
            if valid_session_id(owner) && valid_retention_destination(destination) => {}
        _ => return Err("invalid_voice_retention".into()),
    }
    native_call(app, "stopVoice", json!({"sessionId": session_id, "ownerId": owner_id, "retainDestination": retain_destination})).await
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
async fn inspect_retained_voice<R: Runtime>(app: AppHandle<R>) -> Result<Value, String> {
    native_call(app, "inspectRetainedVoice", json!({})).await
}

#[tauri::command]
async fn discard_retained_voice<R: Runtime>(
    app: AppHandle<R>,
    record: RetainedVoiceRecord,
) -> Result<Value, String> {
    if !valid_retained_voice(&record) {
        return Err("invalid_voice_retention".into());
    }
    native_call(app, "discardRetainedVoice", json!({"record": record})).await
}

#[tauri::command]
async fn attach_retained_voice<R: Runtime>(
    app: AppHandle<R>,
    record: RetainedVoiceRecord,
) -> Result<Value, String> {
    if !valid_retained_voice(&record) || record.state != "ready" {
        return Err("invalid_voice_retention".into());
    }
    native_call(app, "attachRetainedVoice", json!({"record": record})).await
}

#[tauri::command]
async fn list_voice_receipts<R: Runtime>(app: AppHandle<R>) -> Result<Value, String> {
    native_call(app, "listVoiceReceipts", json!({})).await
}

#[tauri::command]
async fn get_voice_receipt<R: Runtime>(
    app: AppHandle<R>,
    session_id: String,
) -> Result<Value, String> {
    if !valid_session_id(&session_id) {
        return Err("invalid_voice_session".into());
    }
    native_call(app, "getVoiceReceipt", json!({"sessionId": session_id})).await
}

#[tauri::command]
async fn discard_voice_receipt<R: Runtime>(
    app: AppHandle<R>,
    receipt: Value,
) -> Result<Value, String> {
    if !receipt.is_object() || receipt.to_string().len() > 1_500_000 {
        return Err("invalid_voice_receipt".into());
    }
    native_call(app, "discardVoiceReceipt", json!({"receipt": receipt})).await
}

#[tauri::command]
async fn release_retained_voice<R: Runtime>(
    app: AppHandle<R>,
    receipt: Value,
) -> Result<Value, String> {
    if !receipt.is_object() || receipt.to_string().len() > 1_500_000 {
        return Err("invalid_voice_receipt".into());
    }
    native_call(app, "releaseRetainedVoice", json!({"receipt": receipt})).await
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
            inspect_retained_voice,
            discard_retained_voice,
            attach_retained_voice,
            list_voice_receipts,
            get_voice_receipt,
            discard_voice_receipt,
            release_retained_voice,
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
    fn retention_destinations_are_explicit_and_bounded() {
        assert!(valid_retention_destination("chat"));
        assert!(valid_retention_destination(&format!(
            "session:{}",
            "a".repeat(64)
        )));
        for invalid in ["", "../chat", "session:", "session:ABC", "session:../x"] {
            assert!(!valid_retention_destination(invalid));
        }
    }
    #[test]
    fn retained_record_rejects_wrong_binding_or_unverified_bytes() {
        let mut record = RetainedVoiceRecord {
            id: "01234567-89ab-cdef-0123-456789abcdef".into(),
            owner: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".into(),
            destination: "chat".into(),
            locale: "es-MX".into(),
            kind: "speech".into(),
            created_at: 1,
            state: "ready".into(),
            byte_count: Some(3),
            sha256: Some("a".repeat(64)),
        };
        assert!(valid_retained_voice(&record));
        record.owner = record.id.clone();
        assert!(!valid_retained_voice(&record));
        record.owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".into();
        record.byte_count = Some(0);
        assert!(!valid_retained_voice(&record));
        record.byte_count = Some(3);
        record.sha256 = Some("A".repeat(64));
        assert!(!valid_retained_voice(&record));
        record.state = "capturing".into();
        record.byte_count = None;
        record.sha256 = None;
        assert!(valid_retained_voice(&record));
        record.locale = "en-US".into();
        assert!(!valid_retained_voice(&record));
    }
    #[test]
    fn discard_pending_record_survives_the_rust_to_swift_contract() {
        let base = json!({
            "id": "01234567-89ab-cdef-0123-456789abcdef",
            "owner": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "destination": "chat", "locale": "es-MX", "kind": "speech",
            "createdAt": 1, "state": "capturing"
        });
        for record in [
            base.clone(),
            json!({
                "id": base["id"], "owner": base["owner"], "destination": "chat",
                "locale": "es-MX", "kind": "speech", "createdAt": 1,
                "state": "ready", "byteCount": 3, "sha256": "a".repeat(64)
            }),
        ] {
            let parsed: RetainedVoiceRecord = serde_json::from_value(record.clone()).unwrap();
            assert!(valid_retained_voice(&parsed));
            let forwarded = json!({"record": parsed});
            assert_eq!(forwarded["record"]["id"], record["id"]);
            assert_eq!(forwarded["record"]["state"], record["state"]);
            assert_eq!(forwarded["record"]["byteCount"], record["byteCount"]);
            assert_eq!(forwarded["record"]["sha256"], record["sha256"]);
            let response = json!({"ok": true, "discardPending": record});
            assert!(response.get("retainedAudio").is_none());
            assert!(response["discardPending"].is_object());
        }
        let mut injected = base;
        injected["unexpected"] = json!(true);
        assert!(serde_json::from_value::<RetainedVoiceRecord>(injected).is_err());
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
