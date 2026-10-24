//! Narrow operating-system authentication. Neither this app nor its daemon receives a password.
//! Linux polkit owns the dialog; the app can only request a root-owned, fixed Chromium installer.
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Request {
    pub request_id: String,
    pub operation: Operation,
    pub browser: Browser,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Operation {
    InstallBrowser,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Browser {
    Chromium,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Cancel {
    pub request_id: String,
}
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Reply {
    pub request_id: String,
    pub status: &'static str,
    pub message: &'static str,
}
impl Reply {
    pub fn new(request_id: &str, status: &'static str, message: &'static str) -> Self {
        Self {
            request_id: request_id.to_owned(),
            status,
            message,
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq)]
enum Phase {
    Authenticating,
    Cancelled,
    Installing,
}
pub struct Privileged {
    active: Mutex<HashMap<String, Arc<Mutex<Phase>>>>,
    connected: AtomicBool,
    finished: Mutex<(HashMap<String, Reply>, VecDeque<String>)>,
}
impl Default for Privileged {
    fn default() -> Self {
        Self {
            active: Mutex::new(HashMap::new()),
            connected: AtomicBool::new(true),
            finished: Mutex::new((HashMap::new(), VecDeque::new())),
        }
    }
}
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 96
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}
impl Privileged {
    pub fn connected(&self) {
        self.connected.store(true, Ordering::SeqCst);
    }
    pub fn disconnected(&self) {
        let active = self.active.lock().unwrap_or_else(PoisonError::into_inner);
        self.connected.store(false, Ordering::SeqCst);
        for phase in active.values() {
            let mut phase = phase.lock().unwrap_or_else(PoisonError::into_inner);
            if *phase == Phase::Authenticating {
                *phase = Phase::Cancelled;
            }
        }
    }
    fn remember(&self, reply: Reply) {
        let mut finished = self.finished.lock().unwrap_or_else(PoisonError::into_inner);
        if !finished.0.contains_key(&reply.request_id) {
            finished.1.push_back(reply.request_id.clone());
        }
        finished.0.insert(reply.request_id.clone(), reply);
        while finished.1.len() > 256 {
            if let Some(id) = finished.1.pop_front() {
                finished.0.remove(&id);
            }
        }
    }
    pub fn perform(&self, request: Request) -> Reply {
        let id = &request.request_id;
        if !valid_id(id) {
            return Reply::new("", "failed", "Invalid operation identifier.");
        }
        let state = Arc::new(Mutex::new(Phase::Authenticating));
        {
            let mut active = self.active.lock().unwrap_or_else(PoisonError::into_inner);
            if !self.connected.load(Ordering::SeqCst) {
                return Reply::new(
                    id,
                    "cancelled",
                    "The assistant disconnected before authentication.",
                );
            }
            if let Some(reply) = self
                .finished
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .0
                .get(id)
                .cloned()
            {
                return reply;
            }
            if !active.is_empty() {
                return Reply::new(
                    id,
                    "busy",
                    "Another installation is already awaiting authentication or running.",
                );
            }
            active.insert(id.clone(), state.clone());
        }
        let result = install(id, state);
        let mut active = self.active.lock().unwrap_or_else(PoisonError::into_inner);
        // Keep completion and removal atomic with respect to the next perform/cancel request.
        self.remember(result.clone());
        active.remove(id);
        result
    }
    pub fn cancel(&self, request: Cancel) -> Reply {
        if !valid_id(&request.request_id) {
            return Reply::new("", "failed", "Invalid operation identifier.");
        }
        let active = self.active.lock().unwrap_or_else(PoisonError::into_inner);
        let Some(state) = active.get(&request.request_id) else {
            if self
                .finished
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .0
                .contains_key(&request.request_id)
            {
                return Reply::new(
                    &request.request_id,
                    "not_found",
                    "This installation is no longer pending.",
                );
            }
            // Cancellation can arrive before its request worker starts. A bounded tombstone
            // prevents that worker from opening an authentication dialog after cancellation.
            let reply = Reply::new(
                &request.request_id,
                "cancelled",
                "Authentication cancelled.",
            );
            self.remember(reply.clone());
            return reply;
        };
        let mut phase = state.lock().unwrap_or_else(PoisonError::into_inner);
        if *phase == Phase::Installing {
            return Reply::new(
                &request.request_id,
                "installing",
                "Installation has started. Let the system package manager finish.",
            );
        }
        *phase = Phase::Cancelled;
        Reply::new(
            &request.request_id,
            "cancelled",
            "Authentication cancelled.",
        )
    }
}

#[cfg(not(target_os = "linux"))]
fn install(id: &str, _state: Arc<Mutex<Phase>>) -> Reply {
    Reply::new(
        id,
        "unsupported",
        "Operating-system installation is currently available only on supported Linux desktops.",
    )
}

#[cfg(target_os = "linux")]
fn install(id: &str, state: Arc<Mutex<Phase>>) -> Reply {
    use crate::privileged_plan::{
        install_plan, trusted_file, HELPER, PKEXEC, POLICY, PROCEED, READY,
    };
    use std::io::{Read, Write};
    use std::path::Path;
    use std::process::{Command, Stdio};
    use std::sync::mpsc;
    use std::time::{Duration, Instant};
    for (path, executable) in [(HELPER, true), (POLICY, false), (PKEXEC, true)] {
        if !trusted_file(Path::new(path), executable) {
            return Reply::new(id, "helper_unavailable", "Install the Gentle Dot desktop system helper before requesting browser installation.");
        }
    }
    let supported = std::fs::canonicalize("/etc/os-release")
        .ok()
        .filter(|path| trusted_file(path, false))
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| install_plan(&text))
        .is_some();
    if !supported {
        return Reply::new(
            id,
            "unsupported",
            "Chromium installation is supported on Debian, Fedora, and Arch Linux systems.",
        );
    }
    // pkexec uses the session's OS authentication agent. Disable its terminal/password fallback.
    // Clear inherited loader/config variables; desktop/session bus credentials are not necessary
    // for pkexec's system-bus authentication.
    let child = Command::new(PKEXEC)
        .args([
            "--disable-internal-agent",
            HELPER,
            "install_browser",
            "chromium",
        ])
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("LC_ALL", "C")
        .current_dir("/")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn();
    let Ok(mut child) = child else {
        return Reply::new(
            id,
            "failed",
            "The system authentication dialog could not be opened.",
        );
    };
    let mut input = child.stdin.take();
    let output = child.stdout.take();
    let (tx, ready) = mpsc::sync_channel(1);
    // The only child output read by the app is a fixed protocol marker, never package-manager
    // output or prompt text. The password dialog is a different OS process.
    let reader = std::thread::Builder::new()
        .name("browser-install-ready".into())
        .spawn(move || {
            let mut bytes = vec![0; READY.len()];
            let valid = output
                .is_some_and(|mut pipe| pipe.read_exact(&mut bytes).is_ok() && bytes == READY);
            let _ = tx.send(valid);
        });
    if reader.is_err() {
        let _ = child.kill();
        let _ = child.wait();
        return Reply::new(id, "failed", "The installation could not be prepared.");
    }
    let started = Instant::now();
    let mut installing = false;
    loop {
        {
            let mut phase = state.lock().unwrap_or_else(PoisonError::into_inner);
            if *phase == Phase::Cancelled
                || (!installing && started.elapsed() >= Duration::from_secs(180))
            {
                drop(input.take());
                let _ = child.kill();
                let _ = child.wait();
                return Reply::new(
                    id,
                    "cancelled",
                    "System authentication was cancelled or expired.",
                );
            }
            if !installing && ready.try_recv().ok() == Some(true) {
                // Holding the phase lock makes cancellation and starting the package manager
                // mutually exclusive. The helper does nothing until it receives this marker.
                *phase = Phase::Installing;
                installing = input.as_mut().is_some_and(|input| {
                    input.write_all(PROCEED).and_then(|_| input.flush()).is_ok()
                });
                drop(input.take());
                if !installing {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Reply::new(id, "failed", "The installation could not be started.");
                }
            }
        }
        match child.try_wait() {
            Ok(Some(status)) => return match status.code() {
                Some(0) if installing => {
                    Reply::new(id, "succeeded", "Chromium was installed successfully.")
                }
                Some(126 | 127) if !installing => Reply::new(
                    id,
                    "denied",
                    "System authentication was declined or unavailable.",
                ),
                Some(69) => Reply::new(
                    id,
                    "unsupported",
                    "This Linux distribution is not supported by the browser installer.",
                ),
                _ => Reply::new(
                    id,
                    "failed",
                    "Chromium could not be installed. Review the package manager on the computer.",
                ),
            },
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(_) => {
                return Reply::new(id, "failed", "The system installer could not be checked.")
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn no_password_command_package_or_extra_argument_can_enter() {
        let valid =
            json!({"requestId":"install-1","operation":"install_browser","browser":"chromium"});
        assert!(serde_json::from_value::<Request>(valid.clone()).is_ok());
        for (field, value) in [
            ("password", "secret"),
            ("command", "sh"),
            ("args", "--evil"),
            ("browser", "firefox"),
            ("operation", "sudo"),
        ] {
            let mut altered = valid.clone();
            altered[field] = value.into();
            assert!(serde_json::from_value::<Request>(altered).is_err());
        }
    }
    #[test]
    fn cancellation_is_tied_to_exact_pending_id_and_cannot_stop_installing() {
        let service = Privileged::default();
        let phase = Arc::new(Mutex::new(Phase::Authenticating));
        service
            .active
            .lock()
            .unwrap()
            .insert("one".into(), phase.clone());
        assert_eq!(
            service
                .cancel(Cancel {
                    request_id: "other".into()
                })
                .status,
            "cancelled"
        );
        assert_eq!(*phase.lock().unwrap(), Phase::Authenticating);
        assert_eq!(
            service
                .cancel(Cancel {
                    request_id: "one".into()
                })
                .status,
            "cancelled"
        );
        assert_eq!(*phase.lock().unwrap(), Phase::Cancelled);
        *phase.lock().unwrap() = Phase::Installing;
        assert_eq!(
            service
                .cancel(Cancel {
                    request_id: "one".into()
                })
                .status,
            "installing"
        );
        assert_eq!(*phase.lock().unwrap(), Phase::Installing);
    }
    #[test]
    fn overlapping_requests_never_spawn_a_second_authentication() {
        let service = Privileged::default();
        service
            .active
            .lock()
            .unwrap()
            .insert("one".into(), Arc::new(Mutex::new(Phase::Authenticating)));
        let request = Request {
            request_id: "two".into(),
            operation: Operation::InstallBrowser,
            browser: Browser::Chromium,
        };
        assert_eq!(service.perform(request).status, "busy");
    }
    #[test]
    fn disconnect_revokes_pending_authentication_but_does_not_kill_installation() {
        let service = Privileged::default();
        let pending = Arc::new(Mutex::new(Phase::Authenticating));
        let installing = Arc::new(Mutex::new(Phase::Installing));
        service
            .active
            .lock()
            .unwrap()
            .insert("pending".into(), pending.clone());
        service
            .active
            .lock()
            .unwrap()
            .insert("installing".into(), installing.clone());
        service.disconnected();
        assert_eq!(*pending.lock().unwrap(), Phase::Cancelled);
        assert_eq!(*installing.lock().unwrap(), Phase::Installing);
        let request = Request {
            request_id: "later".into(),
            operation: Operation::InstallBrowser,
            browser: Browser::Chromium,
        };
        assert_eq!(service.perform(request).status, "cancelled");
    }

    #[test]
    fn cancellation_before_worker_start_and_completed_results_are_idempotent() {
        let service = Privileged::default();
        service.cancel(Cancel {
            request_id: "cancelled-before-start".into(),
        });
        let request = || Request {
            request_id: "cancelled-before-start".into(),
            operation: Operation::InstallBrowser,
            browser: Browser::Chromium,
        };
        assert_eq!(service.perform(request()).status, "cancelled");
        assert_eq!(service.perform(request()).status, "cancelled");
        service.remember(Reply::new("complete", "succeeded", "Installed."));
        let request = Request {
            request_id: "complete".into(),
            operation: Operation::InstallBrowser,
            browser: Browser::Chromium,
        };
        assert_eq!(service.perform(request).status, "succeeded");
        assert!(service.active.lock().unwrap().is_empty());
    }

    #[test]
    fn ids_are_bounded_and_cannot_include_control_characters() {
        for id in ["", "../one", "a\nb", "a b", &"a".repeat(97)] {
            assert!(!valid_id(id));
        }
        assert!(valid_id("install-123_abc"));
    }
}
