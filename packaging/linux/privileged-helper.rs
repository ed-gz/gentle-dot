//! Build separately with rustc: this binary must be installed by the OS package manager, root:root
//! 0755, at /usr/libexec/gentle-dot/privileged-helper. Never run from the writable source checkout.
#[allow(dead_code)]
#[path = "../../apps/desktop/src-tauri/src/privileged_plan.rs"]
mod plan;
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};

#[cfg(target_os = "linux")]
fn run() -> i32 {
    unsafe extern "C" {
        fn geteuid() -> u32;
    }
    if unsafe { geteuid() } != 0 {
        return 77;
    }
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args != ["install_browser", "chromium"] {
        return 64;
    }
    if !plan::trusted_file(Path::new(plan::HELPER), true) {
        return 78;
    }
    let Ok(os_path) = std::fs::canonicalize("/etc/os-release") else {
        return 78;
    };
    if !plan::trusted_file(&os_path, false) {
        return 78;
    }
    let Ok(os) = std::fs::read_to_string(os_path) else {
        return 78;
    };
    let Some(install) = plan::install_plan(&os) else {
        return 69;
    };
    if !plan::trusted_file(Path::new(install.program), true) {
        return 78;
    }
    // No process capable of modifying packages exists until the app finishes the handshake.
    // Cancelling authentication closes this pipe. Once installing, cancelling is refused rather
    // than killing the package manager and leaving its database locked or incomplete.
    if std::io::stdout()
        .write_all(plan::READY)
        .and_then(|_| std::io::stdout().flush())
        .is_err()
    {
        return 74;
    }
    let mut proceed = [0u8; plan::PROCEED.len()];
    if std::io::stdin().read_exact(&mut proceed).is_err() || proceed != plan::PROCEED {
        return 75;
    }
    // Do not inherit PKEXEC_UID, proxy, Python, loader, user package configuration, or HOME.
    let status = Command::new(install.program)
        .args(install.args)
        .env_clear()
        .env("PATH", "/usr/sbin:/usr/bin:/sbin:/bin")
        .env("HOME", "/root")
        .env("LC_ALL", "C")
        .env("DEBIAN_FRONTEND", "noninteractive")
        .current_dir("/")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    match status {
        Ok(exit) if exit.success() => 0,
        _ => 70,
    }
}
#[cfg(not(target_os = "linux"))]
fn run() -> i32 {
    69
}
fn main() {
    std::process::exit(run());
}
