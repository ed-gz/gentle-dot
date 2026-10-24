//! Linux desktop adapter. Hyprland uses compositor IPC and native Wayland input;
//! a real X11 session uses XTest. Xwayland is never mistaken for the whole desktop.
//! Commands have fixed executables, separated arguments, bounded output and deadlines.

use super::blocklist::{blocked_reason, AppIdentity};
use super::coords::{fit_long_edge, Point, ScreenshotGeometry, MAX_LONG_EDGE};
use super::keys::KeyCombo;
use super::risk::{AxElement, Focus};
use super::{
    AppInfo, AppWindow, Capture, Desktop, InputEvent, MouseButton, PermissionKind, Permissions,
};
use serde_json::Value;
use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const COMMAND_TIMEOUT: Duration = Duration::from_secs(4);
const MAX_OUTPUT: usize = 12 * 1024 * 1024;
const ATSPI: &str = include_str!("linux/atspi.py");
// Only the native shell writes this after making its exact rose window transparent and
// click-through. It is cleared before restoring input or paint; never set by an MCP call.
static HIDDEN_ROSE: Mutex<Option<String>> = Mutex::new(None);
static HIDDEN_COMPANION_LAUNCHER: Mutex<Option<String>> = Mutex::new(None);
static HIDDEN_COMPANION_BUBBLE: Mutex<Option<String>> = Mutex::new(None);

#[derive(Clone, Copy, Debug, PartialEq)]
enum Session {
    Hyprland,
    X11,
    Unsupported,
}

fn session_for(wayland: bool, hyprland: bool, x11: bool) -> Session {
    if wayland {
        if hyprland {
            Session::Hyprland
        } else {
            Session::Unsupported
        }
    } else if x11 {
        Session::X11
    } else {
        Session::Unsupported
    }
}

fn executable(name: &str) -> Option<PathBuf> {
    // The optional user-local input helpers do not need root or /dev/uinput access.
    let mut dirs = Vec::new();
    if let Some(home) = std::env::var_os("HOME") {
        dirs.push(PathBuf::from(&home).join(".local/lib/gentle-dot/bin"));
        dirs.push(PathBuf::from(home).join(".local/bin"));
    }
    dirs.extend(std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    ));
    dirs.into_iter().map(|dir| dir.join(name)).find(|path| {
        use std::os::unix::fs::PermissionsExt;
        path.metadata()
            .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
    })
}

fn drain(reader: &mut impl Read, into: &mut Vec<u8>, limit: usize) -> Result<(), String> {
    let mut buffer = [0u8; 8192];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => return Ok(()),
            Ok(n) => {
                if into.len() + n > limit {
                    return Err("desktop command produced too much output".into());
                }
                into.extend_from_slice(&buffer[..n]);
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => return Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(format!("cannot read desktop command: {e}")),
        }
    }
}

pub(crate) fn run(name: &str, args: &[&str], input: Option<&str>) -> Result<Vec<u8>, String> {
    let binary = executable(name).ok_or_else(|| {
        format!("Linux desktop control needs `{name}` installed in this user's session.")
    })?;
    run_path(&binary, args, input, COMMAND_TIMEOUT, MAX_OUTPUT)
}

fn run_path(
    binary: &Path,
    args: &[&str],
    input: Option<&str>,
    timeout: Duration,
    limit: usize,
) -> Result<Vec<u8>, String> {
    let mut child = Command::new(binary)
        .args(args)
        .process_group(0)
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("cannot start {}: {e}", binary.display()))?;
    let mut stdout = child.stdout.take().ok_or("desktop stdout unavailable")?;
    let mut stderr = child.stderr.take().ok_or("desktop stderr unavailable")?;
    for fd in [stdout.as_raw_fd(), stderr.as_raw_fd()] {
        // SAFETY: these owned pipe descriptors are valid until the child has been reaped.
        unsafe {
            libc::fcntl(fd, libc::F_SETFL, libc::O_NONBLOCK);
        }
    }
    // Input text is never a command argument, log message, shell expression or temp file.
    // The MCP text chunks are small, but a separate writer also bounds a stalled reader.
    let writer = input.map(|text| {
        let text = text.as_bytes().to_vec();
        let mut stdin = child.stdin.take().expect("piped input");
        std::thread::spawn(move || stdin.write_all(&text))
    });
    let (mut out, mut err) = (Vec::new(), Vec::new());
    let started = Instant::now();
    let result = loop {
        if let Err(e) = drain(&mut stdout, &mut out, limit)
            .and_then(|_| drain(&mut stderr, &mut err, 64 * 1024))
        {
            break Err(e);
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                let read = drain(&mut stdout, &mut out, limit)
                    .and_then(|_| drain(&mut stderr, &mut err, 64 * 1024));
                if let Err(e) = read {
                    break Err(e);
                }
                // Child stderr may echo input text. Do not surface it to the model or logs.
                break if status.success() {
                    Ok(out)
                } else {
                    Err(format!(
                        "{} failed ({}). Check the desktop session and its permissions.",
                        binary.file_name().unwrap_or_default().to_string_lossy(),
                        status
                    ))
                };
            }
            Ok(None) if started.elapsed() < timeout => std::thread::sleep(Duration::from_millis(5)),
            Ok(None) => {
                break Err(format!(
                    "{} timed out; the action was stopped.",
                    binary.file_name().unwrap_or_default().to_string_lossy()
                ))
            }
            Err(e) => break Err(format!("cannot wait for desktop command: {e}")),
        }
    };
    if result.is_err() {
        // The helper and any descendants share this fresh process group. Kill all of them
        // before joining the stdin writer; no inherited pipe can keep an action alive.
        unsafe {
            libc::kill(-(child.id() as i32), libc::SIGKILL);
        }
        let _ = child.kill();
    }
    let _ = child.wait();
    if let Some(writer) = writer {
        let _ = writer.join();
    }
    result
}

fn json_command(name: &str, args: &[&str]) -> Result<Value, String> {
    serde_json::from_slice(&run(name, args, None)?)
        .map_err(|_| format!("{name} returned invalid desktop metadata"))
}
pub(crate) fn hypr(query: &str) -> Result<Value, String> {
    json_command("hyprctl", &["-j", query])
}
fn lua_dispatch(action: &str, args: &str) -> Result<String, String> {
    // Hyprland 0.56's Lua configuration uses a different IPC grammar. These are fixed
    // expressions built only from validated numbers/addresses, never model-written Lua.
    match action {
        "focuswindow" => {
            let id = args
                .strip_prefix("address:")
                .filter(|s| {
                    s.starts_with("0x")
                        && s.len() > 2
                        && s[2..].bytes().all(|b| b.is_ascii_hexdigit())
                })
                .ok_or("invalid Hyprland window ID")?;
            Ok(format!("hl.dsp.focus({{window='address:{id}'}})"))
        }
        "movecursor" => {
            let coords = args
                .split_whitespace()
                .map(str::parse::<i32>)
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| "invalid cursor coordinates")?;
            if coords.len() != 2 || coords.iter().any(|n| n.unsigned_abs() > 100_000) {
                return Err("invalid cursor coordinates".into());
            }
            Ok(format!(
                "hl.dsp.cursor.move({{x={},y={}}})",
                coords[0], coords[1]
            ))
        }
        "sendshortcut" => {
            let fields = args.split(',').collect::<Vec<_>>();
            if fields.len() != 3 || !fields[2].is_empty() {
                return Err("unsupported shortcut target".into());
            }
            let (mods, key) = (fields[0], fields[1]);
            if !mods
                .split_whitespace()
                .all(|m| ["SUPER", "CTRL", "ALT", "SHIFT"].contains(&m))
                || key.is_empty()
                || !(key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
                    || ["mouse:272", "mouse:273"].contains(&key))
            {
                return Err("unsupported shortcut key or modifiers".into());
            }
            Ok(format!(
                "hl.dsp.send_shortcut({{mods='{mods}',key='{key}'}})"
            ))
        }
        "sendkeystate" => match args {
            ",mouse:272,down," => {
                Ok("hl.dsp.send_key_state({mods='',key='mouse:272',state='down'})".into())
            }
            ",mouse:272,up," => {
                Ok("hl.dsp.send_key_state({mods='',key='mouse:272',state='up'})".into())
            }
            _ => Err("unsupported pointer state".into()),
        },
        _ => Err("unsupported compositor action".into()),
    }
}
fn uses_lua_dispatch() -> bool {
    static LUA: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *LUA.get_or_init(|| {
        hypr("status")
            .ok()
            .and_then(|status| {
                status
                    .get("configProvider")
                    .and_then(Value::as_str)
                    .map(|provider| provider == "lua")
            })
            .unwrap_or(false)
    })
}
fn dispatch(action: &str, args: &str) -> Result<(), String> {
    let result = if uses_lua_dispatch() {
        run("hyprctl", &["dispatch", &lua_dispatch(action, args)?], None)?
    } else {
        run("hyprctl", &["dispatch", action, args], None)?
    };
    if String::from_utf8_lossy(&result).trim() != "ok" {
        return Err(format!("Hyprland could not execute {action}."));
    }
    Ok(())
}
fn number(value: &Value, field: &str) -> Option<f64> {
    value.get(field)?.as_f64().filter(|n| n.is_finite())
}
fn pair(value: &Value, field: &str) -> Option<(f64, f64)> {
    let array = value.get(field)?.as_array()?;
    Some((array.first()?.as_f64()?, array.get(1)?.as_f64()?))
}
fn contains(at: Point, rect: (f64, f64, f64, f64)) -> bool {
    let (x, y, w, h) = rect;
    w > 0.0 && h > 0.0 && at.x >= x && at.y >= y && at.x < x + w && at.y < y + h
}
fn rect(window: &Value) -> Option<(f64, f64, f64, f64)> {
    let (x, y) = pair(window, "at")?;
    let (w, h) = pair(window, "size")?;
    Some((x, y, w, h))
}
fn identity(window: &Value) -> Option<AppIdentity> {
    let pid = i32::try_from(window.get("pid")?.as_i64()?)
        .ok()
        .filter(|pid| *pid > 0)?;
    let class = window.get("class")?.as_str()?.trim();
    if class.is_empty() {
        return None;
    }
    Some(AppIdentity {
        pid,
        name: class.to_string(),
        bundle_id: Some(class.to_string()),
    })
}
fn address(window: &Value) -> Option<&str> {
    window.get("address")?.as_str().filter(|s| {
        s.starts_with("0x") && s.len() > 2 && s[2..].bytes().all(|b| b.is_ascii_hexdigit())
    })
}
fn unique_rose_address(clients: &[Value], own_pid: i32, title: &str) -> Result<String, String> {
    let mut candidates = clients.iter().filter(|window| {
        window.get("pid").and_then(Value::as_i64) == Some(i64::from(own_pid))
            && window.get("title").and_then(Value::as_str) == Some(title)
            && window.get("mapped").and_then(Value::as_bool) == Some(true)
    });
    let candidate = candidates
        .next()
        .ok_or("Cannot identify the rose window before hiding it.")?;
    if candidates.next().is_some() || identity(candidate).is_none() {
        return Err("The rose window is ambiguous; computer control was not started.".into());
    }
    address(candidate)
        .map(str::to_string)
        .ok_or("The rose window has no valid native identity.".into())
}
fn hidden_rose_matches(
    hidden: Option<&str>,
    backend: &str,
    id: &str,
    pid: Option<i32>,
    own_pid: i32,
) -> bool {
    pid == Some(own_pid) && hidden.is_some_and(|hidden| hidden.strip_prefix(backend) == Some(id))
}
fn is_hidden_rose_client(window: &Value, hidden: Option<&str>, own_pid: i32) -> bool {
    address(window).is_some_and(|id| {
        hidden_rose_matches(
            hidden,
            "hyprland:",
            id,
            identity(window).map(|app| app.pid),
            own_pid,
        ) || (window.get("title").and_then(Value::as_str) == Some(crate::desktop_companion::LAUNCHER_TITLE)
            && HIDDEN_COMPANION_LAUNCHER.lock().ok().is_some_and(|launcher| {
                hidden_rose_matches(launcher.as_deref(), "hyprland:", id, identity(window).map(|app| app.pid), own_pid)
            })) || (window.get("title").and_then(Value::as_str) == Some(crate::desktop_companion::BUBBLE_TITLE)
            && HIDDEN_COMPANION_BUBBLE.lock().ok().is_some_and(|bubble| {
                hidden_rose_matches(bubble.as_deref(), "hyprland:", id, identity(window).map(|app| app.pid), own_pid)
            }))
    })
}
fn visible(window: &Value, monitors: &[Value]) -> bool {
    if window.get("mapped").and_then(Value::as_bool) != Some(true)
        || window.get("hidden").and_then(Value::as_bool) == Some(true)
    {
        return false;
    }
    if window.get("visible").and_then(Value::as_bool) == Some(false) {
        return false;
    }
    if window.get("pinned").and_then(Value::as_bool) == Some(true) {
        return true;
    }
    let workspace = window.pointer("/workspace/id").and_then(Value::as_i64);
    workspace.is_some()
        && monitors.iter().any(|m| {
            workspace == m.pointer("/activeWorkspace/id").and_then(Value::as_i64)
                || workspace == m.pointer("/specialWorkspace/id").and_then(Value::as_i64)
        })
}
fn owner_at<'a>(clients: &'a [Value], monitors: &[Value], at: Point) -> Option<&'a Value> {
    // Hyprland's focus history determines stacking within each floating/tiled group.
    clients
        .iter()
        .filter(|w| visible(w, monitors) && rect(w).is_some_and(|r| contains(at, r)))
        .min_by_key(|w| {
            (
                w.get("floating").and_then(Value::as_bool) != Some(true),
                w.get("focusHistoryID")
                    .and_then(Value::as_i64)
                    .unwrap_or(i64::MAX),
            )
        })
}
fn logical_monitor(monitor: &Value) -> Option<(f64, f64, f64, f64)> {
    let scale = number(monitor, "scale")?.max(0.1);
    let (mut width, mut height) = (number(monitor, "width")?, number(monitor, "height")?);
    if monitor
        .get("transform")
        .and_then(Value::as_u64)
        .unwrap_or(0)
        % 2
        == 1
    {
        std::mem::swap(&mut width, &mut height);
    }
    Some((
        number(monitor, "x")?,
        number(monitor, "y")?,
        width / scale,
        height / scale,
    ))
}

fn hypr_apps(clients: &[Value], monitors: &[Value], active: Option<&str>) -> Vec<AppInfo> {
    let mut apps: Vec<AppInfo> = Vec::new();
    let mut app_ids: Vec<String> = Vec::new();
    for client in clients {
        let (Some(app), Some(id)) = (identity(client), address(client)) else {
            continue;
        };
        if client.get("mapped").and_then(Value::as_bool) != Some(true) {
            continue;
        }
        let is_active = active == Some(id);
        let window = AppWindow {
            id: id.to_string(),
            title: client
                .get("title")
                .and_then(Value::as_str)
                .map(|s| s.chars().take(1024).collect()),
            workspace: client
                .pointer("/workspace/name")
                .and_then(Value::as_str)
                .map(str::to_string),
            workspace_id: client.pointer("/workspace/id").and_then(Value::as_i64),
            active: is_active,
            visible: visible(client, monitors),
        };
        if let Some(index) = app_ids
            .iter()
            .position(|id| id.eq_ignore_ascii_case(app.bundle_id.as_deref().unwrap_or(&app.name)))
        {
            apps[index].active |= is_active;
            apps[index].windows.as_mut().unwrap().push(window);
        } else {
            app_ids.push(app.bundle_id.as_deref().unwrap_or(&app.name).to_string());
            apps.push(AppInfo {
                name: app.name,
                bundle_id: app.bundle_id,
                active: is_active,
                windows: Some(vec![window]),
            });
        }
    }
    apps
}

pub struct LinuxDesktop {
    session: Session,
    own_pid: i32,
}
impl Default for LinuxDesktop {
    fn default() -> Self {
        Self::new()
    }
}
impl LinuxDesktop {
    pub fn new() -> Self {
        Self {
            session: session_for(
                std::env::var_os("WAYLAND_DISPLAY").is_some(),
                std::env::var_os("HYPRLAND_INSTANCE_SIGNATURE").is_some(),
                std::env::var_os("DISPLAY").is_some(),
            ),
            own_pid: std::process::id() as i32,
        }
    }
    /// Called by the native shell on a worker, before hiding its known `dot` window.
    /// A title only resolves an exact native ID; it is never itself a hit-test exception.
    pub(crate) fn resolve_rose_window(title: &str) -> Result<String, String> {
        if title.is_empty() {
            return Err("The rose window title is unavailable.".into());
        }
        let desktop = Self::new();
        match desktop.session {
            Session::Hyprland => unique_rose_address(&desktop.clients()?, desktop.own_pid, title)
                .map(|id| format!("hyprland:{id}")),
            Session::X11 => {
                let mut candidates = Vec::new();
                for id in desktop.x11_ids()? {
                    if desktop
                        .x11_identity(&id)
                        .is_none_or(|app| app.pid != desktop.own_pid)
                    {
                        continue;
                    }
                    let name = run("xdotool", &["getwindowname", &id], None)?;
                    if String::from_utf8_lossy(&name).trim_end_matches('\n') == title {
                        candidates.push(id);
                    }
                }
                if candidates.len() != 1 {
                    return Err("Cannot uniquely identify the rose window before hiding it.".into());
                }
                Ok(format!("x11:{}", candidates[0]))
            }
            Session::Unsupported => Err(unsupported()),
        }
    }
    /// Native shell only, after disabling paint/input and before restoring either.
    pub(crate) fn set_hidden_rose(id: Option<String>) {
        if let Ok(mut current) = HIDDEN_ROSE.lock() {
            *current = id;
        }
    }
    pub(crate) fn set_hidden_companion_launcher(id: Option<String>) {
        if let Ok(mut current) = HIDDEN_COMPANION_LAUNCHER.lock() { *current = id; }
    }
    pub(crate) fn set_hidden_companion_bubble(id: Option<String>) {
        if let Ok(mut current) = HIDDEN_COMPANION_BUBBLE.lock() { *current = id; }
    }
    fn hidden_rose(&self) -> Option<String> {
        HIDDEN_ROSE.lock().ok().and_then(|current| current.clone())
    }
    fn dependencies(&self, kind: PermissionKind) -> &'static [&'static str] {
        match (self.session, kind) {
            (Session::Hyprland, PermissionKind::Accessibility) => &["hyprctl", "wtype", "wlrctl"],
            (Session::Hyprland, PermissionKind::ScreenRecording) => &["hyprctl", "grim"],
            (Session::X11, PermissionKind::Accessibility) => &["xdotool", "xprop"],
            (Session::X11, PermissionKind::ScreenRecording) => &["xdotool", "xprop", "import"],
            _ => &[],
        }
    }
    fn available(&self, kind: PermissionKind) -> bool {
        self.session != Session::Unsupported
            && self
                .dependencies(kind)
                .iter()
                .all(|name| executable(name).is_some())
    }
    fn clients(&self) -> Result<Vec<Value>, String> {
        hypr("clients")?
            .as_array()
            .cloned()
            .ok_or("Hyprland clients unavailable".into())
    }
    fn monitors(&self) -> Result<Vec<Value>, String> {
        hypr("monitors")?
            .as_array()
            .cloned()
            .filter(|m| !m.is_empty())
            .ok_or("No active Hyprland display".into())
    }
    fn pointer(&self) -> Result<Point, String> {
        let pointer = hypr("cursorpos")?;
        Ok(Point {
            x: number(&pointer, "x").ok_or("unknown pointer x")?,
            y: number(&pointer, "y").ok_or("unknown pointer y")?,
        })
    }
    fn move_pointer(&self, at: Point) -> Result<(), String> {
        if !at.x.is_finite()
            || !at.y.is_finite()
            || at.x.abs() > 100_000.0
            || at.y.abs() > 100_000.0
        {
            return Err("invalid desktop coordinates".into());
        }
        let (x, y) = (format!("{:.0}", at.x), format!("{:.0}", at.y));
        match self.session {
            Session::Hyprland => dispatch("movecursor", &format!("{x} {y}")),
            Session::X11 => run("xdotool", &["mousemove", "--", &x, &y], None).map(|_| ()),
            _ => Err(unsupported()),
        }
    }
    fn ensure_target(&self, event: &InputEvent) -> Result<(), String> {
        if self.session == Session::Hyprland && self.protected_layer_present()? {
            return Err("A protected Linux authorization or lock surface is present; handle it yourself before continuing.".into());
        }
        let target = match event {
            InputEvent::Move(at) | InputEvent::Click { at, .. } | InputEvent::Scroll { at, .. } => {
                self.window_owner_at(*at)
            }
            InputEvent::Drag { from, .. } => self.window_owner_at(*from),
            _ => self.frontmost_app(),
        }
        .ok_or("Cannot identify the receiving Linux application; nothing was sent.")?;
        if let Some(reason) = blocked_reason(&target, self.own_pid) {
            return Err(format!("Gentle Dot does not control {reason}."));
        }
        Ok(())
    }
    fn protected_layer_present(&self) -> Result<bool, String> {
        let layers = hypr("layers")?;
        let Some(displays) = layers.as_object() else {
            return Err("Cannot inspect Linux overlay ownership.".into());
        };
        for display in displays.values() {
            let Some(levels) = display.get("levels").and_then(Value::as_object) else {
                continue;
            };
            for level in ["2", "3"] {
                for surface in levels
                    .get(level)
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    let namespace = surface
                        .get("namespace")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    if super::blocklist::blocked_name(namespace).is_some() {
                        return Ok(true);
                    }
                    if let Some(pid) = surface
                        .get("pid")
                        .and_then(Value::as_u64)
                        .filter(|pid| *pid > 0)
                    {
                        if let Ok(name) = std::fs::read_to_string(format!("/proc/{pid}/comm")) {
                            if super::blocklist::blocked_name(name.trim()).is_some() {
                                return Ok(true);
                            }
                        }
                    }
                }
            }
        }
        Ok(false)
    }
    fn x11_window(&self) -> Option<String> {
        let output = run("xdotool", &["getactivewindow"], None).ok()?;
        let id = String::from_utf8(output).ok()?.trim().to_string();
        (!id.is_empty() && id.bytes().all(|b| b.is_ascii_digit())).then_some(id)
    }
    fn x11_identity(&self, id: &str) -> Option<AppIdentity> {
        let metadata = run("xprop", &["-id", id, "_NET_WM_PID", "WM_CLASS"], None).ok()?;
        x11_identity(&String::from_utf8_lossy(&metadata))
    }
}
fn unsupported() -> String {
    "This Wayland compositor is not supported by desktop control yet. Use Hyprland or a real X11 session, or Gentle Dot's dedicated browser. GNOME/KDE Wayland need a portal backend.".into()
}

fn key_name(combo: &KeyCombo) -> &'static str {
    match combo.key {
        "return" => "Return",
        "escape" => "Escape",
        "delete" => "BackSpace",
        "forwarddelete" => "Delete",
        "pageup" => "Page_Up",
        "pagedown" => "Page_Down",
        "left" => "Left",
        "right" => "Right",
        "up" => "Up",
        "down" => "Down",
        "tab" => "Tab",
        "space" => "space",
        "home" => "Home",
        "end" => "End",
        "'" => "apostrophe",
        ";" => "semicolon",
        "=" => "equal",
        "-" => "minus",
        "," => "comma",
        "." => "period",
        "/" => "slash",
        "\\" => "backslash",
        "[" => "bracketleft",
        "]" => "bracketright",
        "`" => "grave",
        "f1" => "F1",
        "f2" => "F2",
        "f3" => "F3",
        "f4" => "F4",
        "f5" => "F5",
        "f6" => "F6",
        "f7" => "F7",
        "f8" => "F8",
        "f9" => "F9",
        "f10" => "F10",
        "f11" => "F11",
        "f12" => "F12",
        key => key,
    }
}
fn modifiers(combo: &KeyCombo) -> Vec<&'static str> {
    [
        (combo.modifiers.cmd, "super"),
        (combo.modifiers.ctrl, "ctrl"),
        (combo.modifiers.alt, "alt"),
        (combo.modifiers.shift, "shift"),
    ]
    .into_iter()
    .filter_map(|(set, name)| set.then_some(name))
    .collect()
}
fn x11_identity(text: &str) -> Option<AppIdentity> {
    let pid = text
        .lines()
        .find(|l| l.starts_with("_NET_WM_PID("))?
        .split('=')
        .nth(1)?
        .trim()
        .parse::<i32>()
        .ok()
        .filter(|pid| *pid > 0)?;
    let class_line = text.lines().find(|l| l.starts_with("WM_CLASS("))?;
    let name = class_line.rsplit('"').nth(1)?.trim();
    (!name.is_empty()).then(|| AppIdentity {
        pid,
        name: name.into(),
        bundle_id: Some(name.into()),
    })
}
fn desktop_entry(name: &str) -> Option<PathBuf> {
    if name.trim().is_empty() || name.len() > 256 || name.contains(['/', '\\', '\n', '\0']) {
        return None;
    }
    let mut roots = Vec::new();
    if let Some(home) = std::env::var_os("HOME") {
        roots.push(PathBuf::from(&home).join(".local/share/applications"));
        roots.push(PathBuf::from(home).join(".local/share/flatpak/exports/share/applications"));
    }
    roots.extend(
        [
            "/usr/local/share/applications",
            "/usr/share/applications",
            "/var/lib/flatpak/exports/share/applications",
        ]
        .map(PathBuf::from),
    );
    for root in roots {
        let Ok(entries) = std::fs::read_dir(root) else {
            continue;
        };
        for entry in entries.flatten().take(4096) {
            let path = entry.path();
            if path.extension().is_none_or(|ext| ext != "desktop")
                || path.metadata().is_err()
                || path.metadata().ok()?.len() > 128 * 1024
            {
                continue;
            }
            let Ok(content) = std::fs::read_to_string(&path) else {
                continue;
            };
            let mut main = false;
            let mut names = vec![path.file_stem()?.to_string_lossy().to_string()];
            let mut hidden = false;
            for line in content.lines() {
                if line.starts_with('[') {
                    main = line == "[Desktop Entry]";
                    continue;
                }
                if !main {
                    continue;
                }
                if line == "Hidden=true" {
                    hidden = true;
                }
                if let Some(value) = line
                    .strip_prefix("Name=")
                    .or_else(|| line.strip_prefix("StartupWMClass="))
                {
                    names.push(value.to_string());
                }
            }
            if !hidden
                && names.iter().any(|candidate| {
                    candidate.eq_ignore_ascii_case(name.trim().trim_end_matches(".desktop"))
                })
            {
                return Some(path);
            }
        }
    }
    None
}

impl Desktop for LinuxDesktop {
    fn capabilities(&self) -> Value {
        let mut missing = self
            .dependencies(PermissionKind::Accessibility)
            .iter()
            .chain(self.dependencies(PermissionKind::ScreenRecording))
            .filter(|name| executable(name).is_none())
            .copied()
            .collect::<Vec<_>>();
        missing.sort_unstable();
        missing.dedup();
        let backend = match self.session {
            Session::Hyprland => "hyprland",
            Session::X11 => "x11",
            Session::Unsupported if std::env::var_os("WAYLAND_DISPLAY").is_some() => {
                "unsupported-wayland"
            }
            _ => "unavailable",
        };
        let mut limitations = vec!["Session approval covers ordinary clicks, typing and navigation. Accessibility metadata depends on each application; detected sensitive actions still require confirmation.", "Protected authorization dialogs and password fields must be handled by you."];
        if self.session == Session::Unsupported {
            limitations.push("Desktop control supports Hyprland Wayland and real X11 sessions. Other Wayland compositors require a portal backend.");
        }
        serde_json::json!({"platform":"linux", "backend":backend, "supported":self.session != Session::Unsupported,
            "permissions":self.permissions(), "missingDependencies":missing, "limitations":limitations})
    }
    fn text_chunk_units(&self) -> usize {
        // wtype emits roughly 4 ms per character. A chunk stays below the command timeout
        // and lets the MCP helper recheck Stop, expiration and target between short slices.
        256
    }
    fn permissions(&self) -> Permissions {
        Permissions {
            accessibility: self.available(PermissionKind::Accessibility),
            screen_recording: self.available(PermissionKind::ScreenRecording),
            screenshots_supported: self.session != Session::Unsupported,
        }
    }
    fn capture(&self) -> Result<Capture, String> {
        if self.session == Session::Hyprland && self.protected_layer_present()? {
            return Err("A protected Linux authorization or lock surface is present. Close it before taking a screenshot.".into());
        }
        let (bytes, origin, logical_width, masks) = match self.session {
            Session::Hyprland => {
                let monitors = self.monitors()?;
                let pointer = self.pointer()?;
                let monitor = monitors
                    .iter()
                    .find(|m| logical_monitor(m).is_some_and(|rect| contains(pointer, rect)))
                    .or_else(|| {
                        monitors
                            .iter()
                            .find(|m| m.get("focused").and_then(Value::as_bool) == Some(true))
                    })
                    .ok_or("Cannot identify the display under the pointer")?;
                let (x, y, width, _) =
                    logical_monitor(monitor).ok_or("invalid display geometry")?;
                let name = monitor
                    .get("name")
                    .and_then(Value::as_str)
                    .ok_or("display name missing")?;
                let output_width = number(monitor, "width").ok_or("display width missing")?;
                let output_height = number(monitor, "height").ok_or("display height missing")?;
                let factor = (f64::from(MAX_LONG_EDGE) / output_width.max(output_height)).min(1.0)
                    * number(monitor, "scale").unwrap_or(1.0);
                let scale = factor.to_string();
                let bytes = run(
                    "grim",
                    &["-t", "jpeg", "-q", "85", "-s", &scale, "-o", name, "-"],
                    None,
                )?;
                let hidden_rose = self.hidden_rose();
                let masks = self
                    .clients()?
                    .into_iter()
                    .filter(|w| {
                        visible(w, &monitors)
                            && !is_hidden_rose_client(w, hidden_rose.as_deref(), self.own_pid)
                            && identity(w)
                                .is_some_and(|app| blocked_reason(&app, self.own_pid).is_some())
                    })
                    .filter_map(|w| rect(&w))
                    .collect::<Vec<_>>();
                (bytes, Point { x, y }, width, masks)
            }
            Session::X11 => {
                let size = run("xdotool", &["getdisplaygeometry"], None)?;
                let geometry = String::from_utf8_lossy(&size)
                    .split_whitespace()
                    .map(str::parse::<u32>)
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|_| "invalid X11 display size")?;
                let width = *geometry
                    .first()
                    .filter(|w| **w > 0)
                    .ok_or("invalid X11 width")?;
                let masks = self.x11_masks()?;
                (
                    run(
                        "import",
                        &["-window", "root", "-quality", "85", "jpeg:-"],
                        None,
                    )?,
                    Point { x: 0.0, y: 0.0 },
                    f64::from(width),
                    masks,
                )
            }
            _ => return Err(unsupported()),
        };
        let mut image = image::load_from_memory_with_format(&bytes, image::ImageFormat::Jpeg)
            .map_err(|_| "cannot decode desktop screenshot")?
            .to_rgb8();
        let scale = f64::from(image.width()) / logical_width;
        for (x, y, w, h) in masks {
            let left = ((x - origin.x) * scale).floor().max(0.0) as u32;
            let top = ((y - origin.y) * scale).floor().max(0.0) as u32;
            let right = (((x + w - origin.x) * scale).ceil().max(0.0) as u32).min(image.width());
            let bottom = (((y + h - origin.y) * scale).ceil().max(0.0) as u32).min(image.height());
            for row in top..bottom {
                for col in left..right {
                    image.put_pixel(col, row, image::Rgb([20, 20, 24]));
                }
            }
        }
        let (width, height) = fit_long_edge(image.width(), image.height(), MAX_LONG_EDGE);
        let image =
            image::imageops::resize(&image, width, height, image::imageops::FilterType::Triangle);
        let mut data = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut data, super::encode::JPEG_QUALITY)
            .encode(&image, width, height, image::ExtendedColorType::Rgb8)
            .map_err(|_| "cannot encode Linux screenshot")?;
        Ok(Capture {
            data,
            mime_type: "image/jpeg",
            geometry: ScreenshotGeometry::for_display(origin, logical_width, width, height),
        })
    }
    fn post(&self, event: &InputEvent) -> Result<(), String> {
        self.ensure_target(event)?;
        match event {
            InputEvent::Move(at) => self.move_pointer(*at),
            InputEvent::Click { at, button, count } => {
                self.move_pointer(*at)?;
                for _ in 0..*count {
                    if self.session == Session::Hyprland {
                        // The virtual pointer emits a frame for press and release. Hyprland's
                        // shortcut dispatcher can leave pointer events buffered until motion.
                        run(
                            "wlrctl",
                            &[
                                "pointer",
                                "click",
                                if *button == MouseButton::Right {
                                    "right"
                                } else {
                                    "left"
                                },
                            ],
                            None,
                        )?;
                    } else {
                        run(
                            "xdotool",
                            &[
                                "click",
                                if *button == MouseButton::Right {
                                    "3"
                                } else {
                                    "1"
                                },
                            ],
                            None,
                        )?;
                    }
                    std::thread::sleep(Duration::from_millis(40));
                }
                Ok(())
            }
            InputEvent::Drag { from, to } => {
                self.move_pointer(*from)?;
                let button = |pressed| {
                    if self.session == Session::Hyprland {
                        dispatch(
                            "sendkeystate",
                            if pressed {
                                ",mouse:272,down,"
                            } else {
                                ",mouse:272,up,"
                            },
                        )
                    } else {
                        run(
                            "xdotool",
                            &[if pressed { "mousedown" } else { "mouseup" }, "1"],
                            None,
                        )
                        .map(|_| ())
                    }
                };
                button(true)?;
                let result = (1..=12).try_for_each(|step| {
                    let ratio = f64::from(step) / 12.0;
                    self.move_pointer(Point {
                        x: from.x + (to.x - from.x) * ratio,
                        y: from.y + (to.y - from.y) * ratio,
                    })?;
                    std::thread::sleep(Duration::from_millis(12));
                    Ok::<(), String>(())
                });
                let release = button(false);
                result.and(release)?;
                // Flush the compositor's pointer frame after release, even when no further
                // action follows the drag; never leave a client waiting for physical motion.
                self.move_pointer(*to)
            }
            InputEvent::Scroll { at, dx, dy } => {
                self.move_pointer(*at)?;
                if self.session == Session::Hyprland {
                    run(
                        "wlrctl",
                        &["pointer", "scroll", &dy.to_string(), &dx.to_string()],
                        None,
                    )
                    .map(|_| ())
                } else {
                    for (distance, positive, negative) in [(*dy, "5", "4"), (*dx, "7", "6")] {
                        if distance != 0 {
                            let count = (distance.unsigned_abs().div_ceil(40)).min(250).to_string();
                            run(
                                "xdotool",
                                &[
                                    "click",
                                    "--repeat",
                                    &count,
                                    "--delay",
                                    "8",
                                    if distance > 0 { positive } else { negative },
                                ],
                                None,
                            )?;
                        }
                    }
                    Ok(())
                }
            }
            InputEvent::Key(combo) => {
                if combo.modifiers.fn_key {
                    return Err(
                        "Linux has no portable Fn key injection; use the named function key."
                            .into(),
                    );
                }
                let modifiers = modifiers(combo);
                if self.session == Session::Hyprland {
                    // Named shortcuts go through the compositor's existing keymap. Some
                    // compositors discard a newly created virtual keyboard's named keys.
                    let mods = modifiers
                        .iter()
                        .map(|m| m.to_ascii_uppercase())
                        .collect::<Vec<_>>()
                        .join(" ");
                    dispatch("sendshortcut", &format!("{mods},{},", key_name(combo)))
                } else {
                    let mut keys = modifiers
                        .into_iter()
                        .map(|m| if m == "super" { "Super_L" } else { m })
                        .collect::<Vec<_>>();
                    keys.push(key_name(combo));
                    run(
                        "xdotool",
                        &["key", "--clearmodifiers", &keys.join("+")],
                        None,
                    )
                    .map(|_| ())
                }
            }
            InputEvent::Text(text) => {
                if text.contains('\0') {
                    return Err("Text cannot contain NUL.".into());
                }
                if self.session == Session::Hyprland {
                    run("wtype", &["-"], Some(text)).map(|_| ())
                } else {
                    run(
                        "xdotool",
                        &["type", "--clearmodifiers", "--delay", "0", "--file", "-"],
                        Some(text),
                    )
                    .map(|_| ())
                }
            }
        }
    }
    fn list_apps(&self) -> Result<Vec<AppInfo>, String> {
        match self.session {
            Session::Hyprland => {
                let clients = self.clients()?;
                let monitors = self.monitors()?;
                let active = hypr("activewindow")
                    .ok()
                    .and_then(|w| address(&w).map(str::to_string));
                Ok(hypr_apps(&clients, &monitors, active.as_deref()))
            }
            Session::X11 => {
                let active = self.x11_window();
                let mut apps: Vec<AppInfo> = Vec::new();
                let mut app_ids: Vec<String> = Vec::new();
                for id in self.x11_ids()? {
                    let Some(app) = self.x11_identity(&id) else {
                        continue;
                    };
                    let properties = run(
                        "xprop",
                        &["-id", &id, "_NET_WM_DESKTOP", "_NET_WM_NAME"],
                        None,
                    )?;
                    let properties = String::from_utf8_lossy(&properties);
                    let workspace_id = properties
                        .lines()
                        .find(|l| l.starts_with("_NET_WM_DESKTOP("))
                        .and_then(|l| l.split('=').nth(1))
                        .and_then(|v| v.trim().parse::<i64>().ok());
                    let title = properties
                        .lines()
                        .find(|l| l.starts_with("_NET_WM_NAME("))
                        .and_then(|l| l.split_once('='))
                        .map(|(_, v)| v.trim().trim_matches('"').chars().take(1024).collect());
                    let is_active = active.as_ref().and_then(|id| id.parse::<u64>().ok())
                        == u64::from_str_radix(id.trim_start_matches("0x"), 16).ok();
                    let window = AppWindow {
                        id: id.clone(),
                        title,
                        workspace: workspace_id.map(|id| {
                            if id == i64::from(u32::MAX) {
                                "All workspaces".into()
                            } else {
                                format!("{}", id + 1)
                            }
                        }),
                        workspace_id,
                        active: is_active,
                        visible: self.x11_visible(&id),
                    };
                    if let Some(index) = app_ids.iter().position(|id| {
                        id.eq_ignore_ascii_case(app.bundle_id.as_deref().unwrap_or(&app.name))
                    }) {
                        apps[index].active |= is_active;
                        apps[index].windows.as_mut().unwrap().push(window);
                    } else {
                        app_ids.push(app.bundle_id.as_deref().unwrap_or(&app.name).to_string());
                        apps.push(AppInfo {
                            name: app.name,
                            bundle_id: app.bundle_id,
                            active: is_active,
                            windows: Some(vec![window]),
                        });
                    }
                }
                Ok(apps)
            }
            _ => Err(unsupported()),
        }
    }
    fn open_window(&self, id: &str) -> Result<(), String> {
        match self.session {
            Session::Hyprland => {
                let clients = self.clients()?;
                let window = clients
                    .iter()
                    .find(|w| address(w) == Some(id))
                    .ok_or("The selected window has closed. List applications again.")?;
                let app =
                    identity(window).ok_or("Cannot identify the selected window's application.")?;
                if let Some(reason) = blocked_reason(&app, self.own_pid) {
                    return Err(format!("Gentle Dot does not control {reason}."));
                }
                dispatch("focuswindow", &format!("address:{id}"))?;
                let (x, y, width, height) =
                    rect(window).ok_or("The selected window has no usable geometry.")?;
                // Screenshot coordinates refer to the display under the pointer. Explicitly
                // place it on the selected window even when Hyprland disables cursor warping.
                self.move_pointer(Point {
                    x: x + width / 2.0,
                    y: y + height / 2.0,
                })
            }
            Session::X11 => {
                if !self.x11_ids()?.iter().any(|known| known == id) {
                    return Err("The selected window has closed. List applications again.".into());
                }
                let app = self
                    .x11_identity(id)
                    .ok_or("Cannot identify the selected window's application.")?;
                if let Some(reason) = blocked_reason(&app, self.own_pid) {
                    return Err(format!("Gentle Dot does not control {reason}."));
                }
                run("xdotool", &["windowactivate", "--sync", id], None)?;
                let (x, y, width, height) = self
                    .x11_rect(id)
                    .ok_or("The selected window has no usable geometry.")?;
                self.move_pointer(Point {
                    x: x + width / 2.0,
                    y: y + height / 2.0,
                })
            }
            _ => Err(unsupported()),
        }
    }
    fn open_app(&self, name: &str) -> Result<(), String> {
        if self.session == Session::Unsupported {
            return Err(unsupported());
        }
        if let Some(reason) = super::blocklist::blocked_name(name) {
            return Err(format!("Gentle Dot does not open {reason}."));
        }
        if self.session == Session::Hyprland {
            if let Some(window) = self.clients()?.iter().find(|w| {
                identity(w).is_some_and(|a| {
                    a.name.eq_ignore_ascii_case(name)
                        || a.bundle_id
                            .as_deref()
                            .is_some_and(|id| id.eq_ignore_ascii_case(name))
                })
            }) {
                let app = identity(window).ok_or("unknown app identity")?;
                if blocked_reason(&app, self.own_pid).is_some() {
                    return Err("This application is protected.".into());
                }
                return self.open_window(address(window).ok_or("invalid window identity")?);
            }
        } else {
            for id in self.x11_ids()? {
                if self
                    .x11_identity(&id)
                    .is_some_and(|app| app.name.eq_ignore_ascii_case(name))
                {
                    return run("xdotool", &["windowactivate", "--sync", &id], None).map(|_| ());
                }
            }
        }
        let path = desktop_entry(name).ok_or_else(|| format!("No installed desktop application named `{name}`. Use its installed application name or desktop ID."))?;
        run(
            "gio",
            &["launch", path.to_str().ok_or("invalid desktop file path")?],
            None,
        )
        .map(|_| ())
    }
    fn element_at(&self, _at: Point) -> Vec<AxElement> {
        Vec::new()
    }
    fn focused_element(&self) -> Option<Focus> {
        let app = self.frontmost_app()?;
        if blocked_reason(&app, self.own_pid).is_some() {
            return None;
        }
        let result = run("python3", &["-c", ATSPI, &app.pid.to_string()], None).ok()?;
        let metadata: Value = serde_json::from_slice(&result).ok()?;
        let role = match metadata.get("role")?.as_str()? {
            "password text" => "AXSecureTextField",
            "text" | "entry" => "AXTextField",
            "paragraph" => "AXTextArea",
            "push button" | "button" => "AXButton",
            "link" => "AXLink",
            "menu item" => "AXMenuItem",
            _ => return None,
        };
        Some(Focus {
            element: AxElement {
                role: role.into(),
                title: metadata
                    .get("name")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                ..AxElement::default()
            },
            ..Focus::default()
        })
    }
    fn frontmost_app(&self) -> Option<AppIdentity> {
        match self.session {
            Session::Hyprland => identity(&hypr("activewindow").ok()?),
            Session::X11 => self.x11_identity(&self.x11_window()?),
            _ => None,
        }
    }
    fn focused_app(&self) -> Option<AppIdentity> {
        if self.session == Session::X11 {
            let bytes = run("xdotool", &["getwindowfocus"], None).ok()?;
            let id = String::from_utf8(bytes).ok()?.trim().to_string();
            if id.is_empty() || !id.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            return self.x11_identity(&id);
        }
        self.frontmost_app()
    }
    fn window_owner_at(&self, at: Point) -> Option<AppIdentity> {
        match self.session {
            Session::Hyprland => {
                let hidden_rose = self.hidden_rose();
                let mut clients = self.clients().ok()?;
                clients.retain(|window| {
                    !is_hidden_rose_client(window, hidden_rose.as_deref(), self.own_pid)
                });
                identity(owner_at(&clients, &self.monitors().ok()?, at)?)
            }
            Session::X11 => {
                // _NET_CLIENT_LIST_STACKING is bottom-to-top and only contains normal clients.
                let hidden_rose = self.hidden_rose();
                for id in self.x11_ids().ok()?.iter().rev() {
                    if self.x11_visible(id) && self.x11_rect(id).is_some_and(|r| contains(at, r)) {
                        let app = self.x11_identity(id);
                        if hidden_rose_matches(
                            hidden_rose.as_deref(),
                            "x11:",
                            id,
                            app.as_ref().map(|app| app.pid),
                            self.own_pid,
                        ) {
                            continue;
                        }
                        return app;
                    }
                }
                None
            }
            _ => None,
        }
    }
    fn activate(&self, pid: i32) {
        match self.session {
            Session::Hyprland => {
                if let Ok(clients) = self.clients() {
                    if let Some(window) = clients
                        .iter()
                        .find(|w| identity(w).is_some_and(|a| a.pid == pid))
                    {
                        if let Some(address) = address(window) {
                            let _ = dispatch("focuswindow", &format!("address:{address}"));
                        }
                    }
                }
            }
            Session::X11 => {
                if let Ok(ids) = self.x11_ids() {
                    if let Some(id) = ids
                        .iter()
                        .find(|id| self.x11_identity(id).is_some_and(|a| a.pid == pid))
                    {
                        let _ = run("xdotool", &["windowactivate", "--sync", id], None);
                    }
                }
            }
            _ => (),
        }
    }
}
impl LinuxDesktop {
    fn x11_ids(&self) -> Result<Vec<String>, String> {
        let output = run("xprop", &["-root", "_NET_CLIENT_LIST_STACKING"], None)?;
        Ok(String::from_utf8_lossy(&output)
            .split_whitespace()
            .map(|s| s.trim_end_matches(','))
            .filter(|s| {
                s.starts_with("0x") && s.len() > 2 && s[2..].bytes().all(|b| b.is_ascii_hexdigit())
            })
            .map(str::to_string)
            .take(512)
            .collect())
    }
    fn x11_visible(&self, id: &str) -> bool {
        let Ok(bytes) = run(
            "xprop",
            &["-id", id, "_NET_WM_STATE", "_NET_WM_DESKTOP"],
            None,
        ) else {
            return false;
        };
        let properties = String::from_utf8_lossy(&bytes);
        if properties.contains("_NET_WM_STATE_HIDDEN") {
            return false;
        }
        let desktop = properties
            .lines()
            .find(|line| line.starts_with("_NET_WM_DESKTOP("))
            .and_then(|line| line.split('=').nth(1))
            .and_then(|value| value.trim().parse::<u32>().ok());
        if let Some(desktop) = desktop.filter(|d| *d != u32::MAX) {
            let Ok(current) = run("xprop", &["-root", "_NET_CURRENT_DESKTOP"], None) else {
                return false;
            };
            let current = String::from_utf8_lossy(&current)
                .split('=')
                .nth(1)
                .and_then(|value| value.trim().parse::<u32>().ok());
            if current != Some(desktop) {
                return false;
            }
        }
        true
    }
    fn x11_rect(&self, id: &str) -> Option<(f64, f64, f64, f64)> {
        let output = run("xdotool", &["getwindowgeometry", "--shell", id], None).ok()?;
        let text = String::from_utf8_lossy(&output);
        let value = |key: &str| {
            text.lines()
                .find_map(|line| line.strip_prefix(key)?.parse::<f64>().ok())
        };
        Some((
            value("X=")?,
            value("Y=")?,
            value("WIDTH=")?,
            value("HEIGHT=")?,
        ))
    }
    fn x11_masks(&self) -> Result<Vec<(f64, f64, f64, f64)>, String> {
        let hidden_rose = self.hidden_rose();
        Ok(self
            .x11_ids()?
            .iter()
            .filter(|id| {
                self.x11_identity(id).is_some_and(|app| {
                    !hidden_rose_matches(
                        hidden_rose.as_deref(),
                        "x11:",
                        id,
                        Some(app.pid),
                        self.own_pid,
                    ) && blocked_reason(&app, self.own_pid).is_some()
                })
            })
            .filter_map(|id| self.x11_rect(id))
            .collect())
    }
}

/// Linux tools inherit compositor authorization; installation never silently grants a Dot
/// control session. The separate native/phone grant remains enforced by the MCP helper.
pub fn request_permission(kind: PermissionKind) -> Result<(), String> {
    let desktop = LinuxDesktop::new();
    if desktop.session == Session::Unsupported {
        return Err(unsupported());
    }
    let missing = desktop
        .dependencies(kind)
        .iter()
        .filter(|name| executable(name).is_none())
        .copied()
        .collect::<Vec<_>>();
    if missing.is_empty() {
        Ok(())
    } else {
        Err(format!("Linux desktop control needs: {}. Install these tools for your user, then retry. No administrator or uinput access is required.", missing.join(", ")))
    }
}

#[cfg(test)]
mod tests;
