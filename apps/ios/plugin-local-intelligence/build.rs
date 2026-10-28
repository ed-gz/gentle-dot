fn main() {
    tauri_plugin::Builder::new(&[
        "check_availability",
        "respond",
        "agent_step",
        "reset",
        "cancel",
    ])
    .ios_path("ios")
    .build();
}
