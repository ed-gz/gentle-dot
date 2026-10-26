pub mod alert;
pub mod app_channel;
pub mod approvals;
pub mod computer;
pub mod config;
pub mod daemon;
pub mod desktop_companion;
pub mod capri3d;
pub mod desktop_context;
#[cfg(target_os = "macos")]
pub mod disclaimed;
pub mod geometry;
mod frontend;
mod navigation;
pub mod health;
pub mod platform;
pub mod position;
pub mod privileged;
#[cfg(target_os = "linux")]
mod privileged_plan;
pub mod secure_store;
mod shell;
pub mod shortcut;
pub mod status;
pub mod voice;
#[cfg(test)]
#[path = "../build_contract.rs"]
mod build_contract;
#[cfg(all(test, target_os = "linux", feature = "custom-protocol"))]
mod frontend_smoke;

pub use shell::run;
