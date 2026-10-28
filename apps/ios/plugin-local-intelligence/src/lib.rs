use serde_json::{json, Value};
use tauri::{plugin::TauriPlugin, AppHandle, Runtime};

#[cfg(target_os = "ios")]
use tauri::Manager;

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_local_intelligence);

#[cfg(target_os = "ios")]
struct NativeBridge<R: Runtime>(tauri::plugin::PluginHandle<R>);

fn valid_prompt(prompt: &str) -> bool {
    !prompt.trim().is_empty() && prompt.chars().count() <= 4_000
}

fn valid_agent_prompt(prompt: &str) -> bool {
    !prompt.trim().is_empty() && prompt.chars().count() <= 8_000
}

async fn native_call<R: Runtime>(
    app: AppHandle<R>,
    command: &'static str,
    payload: Value,
) -> Result<Value, String> {
    #[cfg(target_os = "ios")]
    {
        let handle = app.state::<NativeBridge<R>>().0.clone();
        // Tauri 2.2's mobile bridge blocks until Swift resolves the invocation.
        // Keep that wait away from both the UI and async runtime worker threads.
        tauri::async_runtime::spawn_blocking(move || {
            handle.run_mobile_plugin::<Value>(command, payload)
        })
        .await
        .map_err(|_| "local_model_bridge_failed".to_owned())?
        .map_err(|_| "local_model_bridge_failed".to_owned())
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = (app, payload);
        Ok(if command == "checkAvailability" {
            json!({"available": false, "status": "unsupported_platform", "supportsSpanish": false})
        } else {
            json!({"ok": false, "error": "unsupported_platform", "message": "La IA local requiere la app de iPhone."})
        })
    }
}

#[tauri::command]
async fn check_availability<R: Runtime>(app: AppHandle<R>) -> Result<Value, String> {
    native_call(app, "checkAvailability", json!({})).await
}

#[tauri::command]
async fn respond<R: Runtime>(app: AppHandle<R>, prompt: String) -> Result<Value, String> {
    if !valid_prompt(&prompt) {
        return Ok(
            json!({"ok": false, "error": "invalid_prompt", "message": "Escribe entre 1 y 4000 caracteres."}),
        );
    }
    native_call(app, "respond", json!({"prompt": prompt})).await
}

#[tauri::command]
async fn agent_step<R: Runtime>(
    app: AppHandle<R>,
    prompt: String,
    turn_id: Option<String>,
) -> Result<Value, String> {
    if !valid_agent_prompt(&prompt) {
        return Ok(json!({"ok": false, "error": "invalid_prompt",
            "message": "El contexto del paso debe contener entre 1 y 8000 caracteres."}));
    }
    if turn_id.as_ref().is_some_and(|id| !valid_id(id)) {
        return Ok(json!({"ok": false, "error": "invalid_identity"}));
    }
    native_call(
        app,
        "agentStep",
        json!({"prompt": prompt, "turnId": turn_id}),
    )
    .await
}

fn valid_id(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
            }
        })
}

#[tauri::command]
async fn results_list<R: Runtime>(app: AppHandle<R>) -> Result<Value, String> {
    native_call(app, "resultsList", json!({})).await
}

#[tauri::command]
async fn results_acknowledge<R: Runtime>(
    app: AppHandle<R>,
    turn_id: String,
    revision: String,
) -> Result<Value, String> {
    if !valid_id(&turn_id) || !valid_id(&revision) {
        return Ok(json!({"ok": false, "error": "invalid_identity"}));
    }
    native_call(
        app,
        "resultsAcknowledge",
        json!({"turnId": turn_id, "revision": revision}),
    )
    .await
}

#[tauri::command]
async fn reset<R: Runtime>(app: AppHandle<R>) -> Result<Value, String> {
    native_call(app, "reset", json!({})).await
}

#[tauri::command]
async fn cancel<R: Runtime>(app: AppHandle<R>, turn_id: Option<String>) -> Result<Value, String> {
    if turn_id.as_ref().is_some_and(|id| !valid_id(id)) {
        return Ok(json!({"ok": false, "error": "invalid_identity"}));
    }
    native_call(app, "cancel", json!({"turnId": turn_id})).await
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("local-intelligence")
        .invoke_handler(tauri::generate_handler![
            check_availability,
            respond,
            agent_step,
            results_list,
            results_acknowledge,
            reset,
            cancel
        ])
        .setup(|_app, _api| {
            #[cfg(target_os = "ios")]
            _app.manage(NativeBridge(
                _api.register_ios_plugin(init_plugin_local_intelligence)?,
            ));
            Ok(())
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::{valid_agent_prompt, valid_id, valid_prompt};

    #[test]
    fn journal_ids_are_canonical_and_cannot_be_paths() {
        assert!(valid_id("d3dba896-4b5c-4c1c-98c9-4e60238fe6b9"));
        for id in [
            "../../state",
            "",
            "D3DBA896-4B5C-4C1C-98C9-4E60238FE6B9",
            "d3dba896_4b5c-4c1c-98c9-4e60238fe6b9",
        ] {
            assert!(!valid_id(id));
        }
    }

    #[test]
    fn accepts_spanish_and_unicode_up_to_the_character_limit() {
        assert!(valid_prompt("¿Qué hacemos hoy, Capri?"));
        assert!(valid_prompt(&"🦖".repeat(4_000)));
        assert!(!valid_prompt(&"a".repeat(4_001)));
    }

    #[test]
    fn rejects_empty_or_whitespace_only_requests() {
        assert!(!valid_prompt(""));
        assert!(!valid_prompt(" \n\t\u{2003}"));
    }

    #[test]
    fn agent_step_has_a_separate_unicode_budget() {
        assert!(valid_agent_prompt(&"🦖".repeat(8_000)));
        assert!(!valid_agent_prompt(&"🦖".repeat(8_001)));
        assert!(!valid_agent_prompt(" \n\t"));
        assert!(!valid_prompt(&"a".repeat(4_001)));
    }
}
