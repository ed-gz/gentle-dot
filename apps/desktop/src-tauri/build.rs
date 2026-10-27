use std::env;
use std::path::{Path, PathBuf};
mod build_contract;

/// Commands the UI may invoke; each one gets an `allow-<command>` permission.
const COMMANDS: &[&str] = &[
    "connection_info",
    "capri2d_asset",
    "capri3d_asset",
    "capri3d_surface",
    "desktop_companion_get",
    "desktop_companion_set",
    "desktop_companion_interaction",
    "desktop_companion_recall",
    "desktop_companion_move",
    "desktop_companion_hide",
    "desktop_companion_menu",
    "desktop_companion_context",
    "desktop_companion_context_dismiss",
    "desktop_companion_context_ready",
    "desktop_companion_context_open",
    "toggle_panel",
    "hide_panel",
    "set_dot_state",
    "rose_hidden",
    "set_rose_hidden",
    "set_panel_fullscreen",
    "computer_endpoint",
    "computer_permissions",
    "computer_request_permission",
    "computer_stop",
    "computer_status",
    "computer_set_yolo",
    "computer_working_ready",
    "voice_status",
    "voice_start",
    "voice_stop",
    "voice_cancel",
    "voice_model_status",
    "voice_model_download",
    "voice_model_cancel",
    "voice_model_remove",
    "shortcut_get",
    "shortcut_set",
    "connector_command",
];

fn find_in_path(program: &str, path: &str) -> Option<PathBuf> {
    env::split_paths(path)
        .map(|dir| dir.join(program))
        .find(|candidate| candidate.is_file())
}

fn main() {
    build_contract::require_embedded_release(&env::var("PROFILE").unwrap_or_default(), tauri_build::is_dev())
        .unwrap_or_else(|message| panic!("{message}"));
    // Hashed Vite filenames change between builds. Watching the directory prevents a native
    // binary from silently keeping a previous UI when only the frontend was rebuilt.
    println!("cargo:rerun-if-changed=../../../packages/ui/dist/app");
    // Apps launched from Finder get a minimal PATH, so record what the build saw:
    // the absolute `node`, the daemon entry point, and PATH itself (the daemon
    // needs it to find `gentle-shell`). Runtime env vars override the first two.
    let path = env::var("PATH").unwrap_or_default();
    let node = find_in_path("node", &path)
        .map(|p| p.display().to_string())
        .unwrap_or_else(|| "node".into());
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let script = manifest_dir.join("../../../packages/daemon/src/cli.ts");
    let script = script.canonicalize().unwrap_or(script);

    println!("cargo:rustc-env=GENTLE_DOT_BUILD_NODE={node}");
    println!("cargo:rustc-env=GENTLE_DOT_BUILD_DAEMON_SCRIPT={}", script.display());
    println!("cargo:rustc-env=GENTLE_DOT_BUILD_PATH={path}");
    println!("cargo:rerun-if-env-changed=PATH");
    println!(
        "cargo:rerun-if-changed={}",
        Path::new("../../../packages/daemon/src/cli.ts").display()
    );

    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
