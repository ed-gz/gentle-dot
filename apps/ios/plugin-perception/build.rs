fn main() {
    tauri_plugin::Builder::new(&[
        "check_voice",
        "prepare_voice",
        "start_voice",
        "stop_voice",
        "cancel_voice",
        "recognize_document",
        "cancel_document",
        "scan_pairing_code",
        "cancel_pairing_code",
    ])
    .ios_path("ios")
    .build();
}
