fn main() {
    tauri_plugin::Builder::new(&[
        "check_availability",
        "respond",
        "agent_step",
        "results_list",
        "results_acknowledge",
        "notification_status",
        "notification_configure",
        "reset",
        "cancel",
    ])
    .ios_path("ios")
    .build();
}
