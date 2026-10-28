fn main() {
    tauri_plugin::Builder::new(&[
        "check_voice",
        "prepare_voice",
        "start_voice",
        "stop_voice",
        "cancel_voice",
        "recognize_document",
        "cancel_document",
    ])
    .ios_path("ios")
    .build();
}
