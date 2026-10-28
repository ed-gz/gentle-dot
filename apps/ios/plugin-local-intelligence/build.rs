fn main() {
    tauri_plugin::Builder::new(&["check_availability", "respond", "reset", "cancel"])
        .ios_path("ios")
        .build();
}
