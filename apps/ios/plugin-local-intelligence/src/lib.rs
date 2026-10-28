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
async fn reset<R: Runtime>(app: AppHandle<R>) -> Result<Value, String> {
    native_call(app, "reset", json!({})).await
}

#[tauri::command]
async fn cancel<R: Runtime>(app: AppHandle<R>) -> Result<Value, String> {
    native_call(app, "cancel", json!({})).await
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("local-intelligence")
        .invoke_handler(tauri::generate_handler![
            check_availability,
            respond,
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
    use super::valid_prompt;

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
}
