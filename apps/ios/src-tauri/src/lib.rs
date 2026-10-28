#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_local_intelligence::init())
        .plugin(tauri_plugin_perception::init())
        .plugin(tauri_plugin_device_bridge::init())
        .run(tauri::generate_context!())
        .expect("failed to run Capri");
}
