//! Tauri wiring: windows, commands, tray menu, global shortcut, Dot snapping,
//! hiding the rose, the full-screen panel, voice input, the shortcut chosen in Settings,
//! the daemon lifecycle (design §9), and the app's private channel to the daemon (S25.1–S25.3).

use crate::app_channel::{self, AppChannel, NO_CHANNEL, REGISTER_TIMEOUT};
use crate::approvals::{native::NativePrompt, ApprovalRequest, Approvals, Decision, APPROVAL_TIMEOUT};
use crate::computer::app as computer;
use crate::computer::server::Endpoint;
use crate::computer::session::Reason;
use crate::computer::working::{self, Part};
use crate::config::{self, ConnectionInfo, DesktopConfig, DEFAULT_SHORTCUT};
use crate::daemon::{self, Daemon, RestartOutcome};
use crate::desktop_companion;
use crate::geometry::{self, Rect};
use crate::platform::{self, LaunchRequest, Os, DOT_TITLE, PANEL_TITLE};
use crate::position::{self, DotPosition};
use crate::secure_store::{self, SecretStore};
use crate::shortcut;
use crate::status::{is_template, tray_status, TrayGlyph};
use crate::voice::app as voice;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder};
#[cfg(target_os = "macos")]
use tauri::window::{Effect, EffectState, EffectsBuilder};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, RunEvent, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as _};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutEvent, ShortcutState};
use tauri_plugin_opener::OpenerExt;

const DOT: &str = "dot";
pub(crate) const PANEL: &str = "panel";
const TRAY: &str = "main";
/// The Dot window, in points: a 66 pt black disc with the rose, plus a 3 pt
/// ring for its shadow. About the screen area of the earlier 64 × 84 rose.
const DOT_SIZE: (f64, f64) = (72.0, 72.0);
const PANEL_SIZE: (f64, f64) = (420.0, 640.0);
/// All placement runs in points (see `geometry`), so margins never depend on a scale factor.
const EDGE_MARGIN: i32 = 12;
const PANEL_GAP: i32 = 8;
const DRAG_SETTLE: Duration = Duration::from_millis(300);
const DAEMON_START_TIMEOUT: Duration = Duration::from_secs(20);
/// Sent to the Dot and the panel each time the assistant this app may use starts answering (at
/// launch or after Restart assistant): a window that was refused, or whose `connection_info` gave up
/// first, asks again and connects without a reopen (S35.2).
const ASSISTANT_READY: &str = "dot://assistant-ready";

struct Shell {
    config: DesktopConfig,
    daemon: Arc<Daemon>,
    snap: mpsc::Sender<()>,
    /// False on native Wayland, where the compositor places windows (Hyprland window rules).
    places_windows: bool,
    /// The user hid the Dot window (S26.1); saved in `desktop.json`.
    rose_hidden: AtomicBool,
    /// Where the panel was when it was last hidden, for placing it without the Dot.
    panel_spot: Mutex<Option<(i32, i32)>>,
    /// While the panel fills the screen (S26.2): its frame before, to restore.
    full_screen: Mutex<Option<Rect>>,
    /// The shortcut that toggles the panel now; `None` while none is bound (native Wayland).
    shortcut: Mutex<Option<String>>,
}

/// The Dot and the panel as computer control hides them during a call (S1, S5): never through
/// `hide_panel` or `show_panel`, so the remembered spot, the full-screen frame, the rose choice,
/// and the keyboard focus stay as they were. Main thread only.
struct ShellWindows {
    app: AppHandle,
    /// Linux compositors may reposition a window every time it is mapped. Keep
    /// the rose mapped during a computer step; hide only its painted contents
    /// and input region. The saved opacity is released even if the user hides it.
    #[cfg(target_os = "linux")]
    dot_opacity: Mutex<Option<f64>>,
    #[cfg(target_os = "linux")]
    prepared_dot_id: Mutex<Option<String>>,
    #[cfg(target_os = "linux")]
    launcher_opacity: Mutex<Option<f64>>,
    #[cfg(target_os = "linux")]
    prepared_launcher_id: Mutex<Option<String>>,
}

impl ShellWindows {
    fn get(&self, part: Part) -> Option<WebviewWindow> {
        self.app.get_webview_window(match part {
            Part::Dot => DOT,
            Part::Panel => PANEL,
        })
    }

    #[cfg(target_os = "linux")]
    fn hide_dot_content(&self) -> Result<(), String> {
        let dot = self.get(Part::Dot).ok_or("the rose window is missing")?;
        let native: gtk::Window = dot.gtk_window().map_err(err)?.into();
        let id = self.prepared_dot_id.lock().unwrap().take().ok_or("the rose window identity is unavailable")?;
        if let Some(id) = self.prepared_launcher_id.lock().unwrap().take() {
            let launcher = self.app.get_webview_window(desktop_companion::LAUNCHER).ok_or("the launcher is missing")?;
            let native: gtk::Window = launcher.gtk_window().map_err(err)?.into();
            let opacity = mask_dot_content(&native)?;
            self.launcher_opacity.lock().unwrap().get_or_insert(opacity);
            crate::computer::LinuxDesktop::set_hidden_companion_launcher(Some(id));
        }
        let mut saved = self.dot_opacity.lock().unwrap();
        let original = mask_dot_content(&native)?;
        saved.get_or_insert(original);
        crate::computer::LinuxDesktop::set_hidden_rose(Some(id));
        Ok(())
    }

    #[cfg(target_os = "linux")]
    fn restore_dot_content(&self) -> Result<(), String> {
        crate::computer::LinuxDesktop::set_hidden_rose(None);
        let mut saved = self.dot_opacity.lock().unwrap();
        let Some(opacity) = *saved else { return Ok(()) };
        let dot = self.get(Part::Dot).ok_or("the rose window is missing")?;
        let native: gtk::Window = dot.gtk_window().map_err(err)?.into();
        unmask_dot_content(&native, opacity)?;
        *saved = None;
        Ok(())
    }

    #[cfg(target_os = "linux")]
    fn restore_launcher_content(&self) -> Result<(), String> {
        crate::computer::LinuxDesktop::set_hidden_companion_launcher(None);
        let mut saved = self.launcher_opacity.lock().unwrap();
        if let Some(opacity) = *saved {
            let launcher = self.app.get_webview_window(desktop_companion::LAUNCHER).ok_or("the launcher is missing")?;
            unmask_dot_content(&launcher.gtk_window().map_err(err)?.into(), opacity)?;
            *saved = None;
        }
        desktop_companion::restore_shape(&self.app);
        Ok(())
    }
}

impl working::Windows for ShellWindows {
    fn prepare_hide(&self, operation: u64) -> Result<(), String> {
        desktop_companion::prepare_control(&self.app, operation)?;
        #[cfg(target_os = "linux")]
        {
            *self.prepared_dot_id.lock().unwrap() = None;
            *self.prepared_launcher_id.lock().unwrap() = None;
            // A previous finish may have queued restoration on GTK. Its rose
            // is still mapped even while logical visibility is temporarily false.
            let mapped = self.get(Part::Dot).and_then(|dot| dot.is_visible().ok()).unwrap_or(false);
            if !self.rose_hidden() && mapped {
                let id = crate::computer::LinuxDesktop::resolve_rose_window(DOT_TITLE)?;
                *self.prepared_dot_id.lock().unwrap() = Some(id);
                if desktop_companion::enabled(&self.app) {
                    let id = crate::computer::LinuxDesktop::resolve_rose_window(desktop_companion::LAUNCHER_TITLE)?;
                    *self.prepared_launcher_id.lock().unwrap() = Some(id);
                }
            }
        }
        Ok(())
    }

    fn is_visible(&self, part: Part) -> bool {
        #[cfg(target_os = "linux")]
        if part == Part::Dot && self.dot_opacity.lock().unwrap().is_some() {
            return false;
        }
        self.get(part).and_then(|window| window.is_visible().ok()).unwrap_or(false)
    }

    fn hide(&self, part: Part) -> Result<(), String> {
        #[cfg(target_os = "linux")]
        if part == Part::Dot {
            return self.hide_dot_content();
        }
        self.get(part).ok_or_else(|| format!("window {part:?} is missing"))?.hide().map_err(err)
    }

    fn show(&self, part: Part) {
        let Some(window) = self.get(part) else { return };
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        let shown = computer::show_without_focus(&window);
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        let shown = window.show().map_err(err);
        if let Err(error) = shown {
            eprintln!("gentle-dot: cannot show the {part:?} again: {error}");
        }
    }

    fn rose_hidden(&self) -> bool {
        !desktop_companion::enabled(&self.app) && self.app.try_state::<Shell>().is_some_and(|shell| shell.rose_hidden.load(Ordering::SeqCst))
    }

    fn restore(&self, part: Part, show: bool) {
        #[cfg(target_os = "linux")]
        if part == Part::Dot {
            // Its map state was never changed by working. If the user explicitly
            // hid it, restoring content leaves that window unmapped and hidden.
            if let Err(error) = self.restore_dot_content() {
                eprintln!("gentle-dot: cannot restore the rose content: {error}");
            }
            return;
        }
        if show {
            self.show(part);
        }
    }

    fn after_hidden(&self, ready: working::Task) -> Result<(), String> {
        #[cfg(target_os = "linux")]
        if self.dot_opacity.lock().unwrap().is_some() {
            let dot = self.get(Part::Dot).ok_or("the rose window is missing")?;
            if self.launcher_opacity.lock().unwrap().is_some() {
                let launcher = self.app.get_webview_window(desktop_companion::LAUNCHER).ok_or("the launcher is missing")?;
                let native: gtk::Window = launcher.gtk_window().map_err(err)?.into();
                return after_dot_paint(&native, Box::new(move || {
                    let result = dot.gtk_window().map_err(err).and_then(|native| after_dot_paint(&native.into(), ready));
                    if let Err(error) = result { eprintln!("gentle-dot: companion capture frame: {error}"); }
                }));
            }
            return after_dot_paint(&dot.gtk_window().map_err(err)?.into(), ready);
        }
        ready();
        Ok(())
    }

    fn cancel_prepare(&self, operation: u64) { desktop_companion::restore_control(&self.app, operation); }

    fn after_restore(&self, operation: u64) {
        #[cfg(target_os = "linux")]
        if let Err(error) = self.restore_launcher_content() { eprintln!("gentle-dot: cannot restore launcher: {error}"); }
        desktop_companion::restore_control(&self.app, operation);
    }
}

/// Change the child, not the toplevel's opacity: compositor rules can force the
/// latter to 1. No hide/show, move, resize, or focus request, on either path.
#[cfg(target_os = "linux")]
fn mask_dot_content(native: &gtk::Window) -> Result<f64, String> {
    use gtk::prelude::*;
    let content = native.child().ok_or("the rose content is missing")?;
    let opacity = content.opacity();
    native.input_shape_combine_region(Some(&gtk::cairo::Region::create()));
    content.set_opacity(0.0);
    native.queue_draw();
    native.display().flush();
    Ok(opacity)
}

#[cfg(target_os = "linux")]
fn unmask_dot_content(native: &gtk::Window, opacity: f64) -> Result<(), String> {
    use gtk::prelude::*;
    let content = native.child().ok_or("the rose content is missing")?;
    native.input_shape_combine_region(None);
    content.set_opacity(opacity);
    native.queue_draw();
    native.display().flush();
    Ok(())
}

/// The screenshot worker is released only after GTK has painted the transparent
/// content. No sleeps or nested GTK loop on the main thread; timeout removes the
/// listener, and Working's existing deadline refuses the capture if no frame ran.
#[cfg(target_os = "linux")]
fn after_dot_paint(native: &gtk::Window, ready: working::Task) -> Result<(), String> {
    use gtk::prelude::*;
    use std::{cell::RefCell, rc::Rc};
    if !native.is_visible() {
        ready();
        return Ok(());
    }
    let clock = native.frame_clock().ok_or("the rose frame clock is unavailable")?;
    let callback = Rc::new(RefCell::new(Some(ready)));
    let handler = Rc::new(RefCell::new(None));
    let timeout = Rc::new(RefCell::new(None::<gtk::glib::SourceId>));
    let (paint_callback, paint_handler, paint_timeout) = (callback.clone(), handler.clone(), timeout.clone());
    *handler.borrow_mut() = Some(clock.connect_after_paint(move |clock| {
        if let Some(id) = paint_handler.borrow_mut().take() {
            clock.disconnect(id);
        }
        if let Some(id) = paint_timeout.borrow_mut().take() {
            id.remove();
        }
        if let Some(ready) = paint_callback.borrow_mut().take() {
            ready();
        }
    }));
    let weak_clock = clock.downgrade();
    *timeout.borrow_mut() = Some(gtk::glib::timeout_add_local_once(working::READY_TIMEOUT, move || {
        if let (Some(clock), Some(id)) = (weak_clock.upgrade(), handler.borrow_mut().take()) {
            clock.disconnect(id);
        }
        callback.borrow_mut().take();
    }));
    native.queue_draw();
    clock.request_phase(gtk::gdk::FrameClockPhase::AFTER_PAINT);
    Ok(())
}

/// The tray's rose item, relabeled when the rose is hidden or shown.
struct RoseMenuItem(MenuItem<tauri::Wry>);

/// The tray's "Open" item, whose accelerator label follows the shortcut (S33.3).
struct OpenMenuItem(MenuItem<tauri::Wry>);

/// On native Wayland the desktop binds `gentle-dot --toggle` itself.
const DESKTOP_OWNS_SHORTCUTS: &str =
    "On this desktop, global shortcuts are set in the system keyboard settings: bind `gentle-dot --toggle` there.";

/// Where `show_panel` puts the panel.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Placement {
    /// Leave it where it is: full screen, or a compositor that places windows itself.
    Keep,
    BesideDot,
    /// The rose is hidden: the remembered spot or the default one on the current display.
    Alone,
}

/// Opening the panel never depends on the Dot window being visible.
fn panel_placement(places_windows: bool, full_screen: bool, rose_hidden: bool) -> Placement {
    if !places_windows || full_screen {
        Placement::Keep
    } else if rose_hidden {
        Placement::Alone
    } else {
        Placement::BesideDot
    }
}

fn rose_menu_label(hidden: bool) -> &'static str {
    if hidden {
        "Show the rose"
    } else {
        "Hide the rose"
    }
}

fn desktop_file(config: &DesktopConfig) -> PathBuf {
    config.data_dir.join("desktop.json")
}

type CommandResult<T = ()> = Result<T, String>;

fn err(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn window(app: &AppHandle, label: &str) -> CommandResult<WebviewWindow> {
    app.get_webview_window(label).ok_or_else(|| format!("window `{label}` is missing"))
}

fn read_connection_info(config: &DesktopConfig) -> CommandResult<ConnectionInfo> {
    let token = std::fs::read_to_string(config.data_dir.join("token")).map_err(|e| format!("cannot read token: {e}"))?;
    Ok(config::connection_info(config.port, token.trim()))
}

/// Serves the daemon's requests on the app channel: native approvals (S25.3), connector secrets
/// from the secure store (S25.5), and registering the computer helper with a daemon this app just
/// spawned (S24.7, L61).
struct ChannelService {
    app: AppHandle,
    approvals: Approvals,
    computer: Option<Endpoint>,
    secrets: Box<dyn SecretStore>,
    privileged: crate::privileged::Privileged,
}

impl app_channel::Handler for ChannelService {
    fn voice_request(&self, method: &str, params: &serde_json::Value) -> Result<serde_json::Value,String> {
        self.app.try_state::<voice::VoiceModel>().ok_or("PC voice is starting.")?.remote_request(method, params)
    }
    fn privileged_operation(&self, request: crate::privileged::Request) -> crate::privileged::Reply {
        self.privileged.perform(request)
    }

    fn privileged_cancel(&self, request: crate::privileged::Cancel) -> crate::privileged::Reply {
        self.privileged.cancel(request)
    }

    fn approve(&self, request: &ApprovalRequest) -> bool {
        self.approvals.confirm(request) == Decision::Approved
    }

    fn approve_cancellable(&self, request: &ApprovalRequest, cancelled: crate::approvals::cancellation::Token) -> bool {
        self.approvals.confirm_cancellable(request, cancelled) == Decision::Approved
    }

    fn secrets(&self) -> Option<&dyn SecretStore> {
        Some(self.secrets.as_ref())
    }

    fn closed(&self) {
        if let Some(model) = self.app.try_state::<voice::VoiceModel>() { model.remote_disconnected(); }
        self.privileged.disconnected();
        computer::stop(&self.app, Reason::Panic);
    }

    fn computer_status(&self) -> Result<serde_json::Value, String> {
        computer::public_status(&self.app)
    }

    fn computer_stop(&self) -> Result<serde_json::Value, String> {
        computer::stop(&self.app, Reason::Panic);
        computer::public_status(&self.app)
    }

    fn opened(&self, channel: &Arc<AppChannel>) {
        self.privileged.connected();
        let Some(endpoint) = self.computer.clone() else {
            return;
        };
        let channel = channel.clone();
        thread::spawn(move || {
            let params = serde_json::json!({ "url": endpoint.url, "token": endpoint.token });
            if let Err(error) = channel.request("computer_register", params, REGISTER_TIMEOUT) {
                eprintln!("gentle-dot: computer control was not registered with the assistant: {error}");
            }
        });
    }
}

/// A computer helper asks for a human decision through the daemon's existing native/mobile
/// broker. The private channel is available only to this app; a failed or stale request refuses.
/// Called by a helper worker, never by a webview command or model tool directly.
pub(crate) fn computer_approval(app: &AppHandle, params: serde_json::Value) -> bool {
    let Some(shell) = app.try_state::<Shell>() else { return false };
    let Some(channel) = shell.daemon.channel() else { return false };
    channel.request("computer_approval", params, app_channel::COMMAND_TIMEOUT)
        .is_ok_and(|answer| channel.is_open() && approved_computer_answer(&answer))
}

pub(crate) fn cancel_computer_approval(app: &AppHandle, request_id: String) {
    let Some(shell) = app.try_state::<Shell>() else { return };
    let Some(channel) = shell.daemon.channel() else { return };
    let _ = channel.request("computer_approval_cancel", serde_json::json!({ "requestId": request_id }), Duration::from_secs(5));
}

fn approved_computer_answer(answer: &serde_json::Value) -> bool {
    answer.as_object().is_some_and(|fields| fields.len() == 1 && fields.get("approved") == Some(&serde_json::Value::Bool(true)))
}

/// A connector change from the panel (S25.2), sent over the app's channel on behalf of the panel's
/// window (`client_id`, from its `ready`), so its sign-in steps reach that window. Waits for the
/// daemon, which may first confirm a widening change in a native dialog.
#[tauri::command]
async fn connector_command(app: AppHandle, client_id: String, message: serde_json::Value) -> CommandResult {
    let daemon = app.state::<Shell>().daemon.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let channel = daemon.channel().ok_or_else(|| NO_CHANNEL.to_string())?;
        channel.command(&client_id, message)
    })
    .await
    .map_err(err)?
}

/// Waits until the daemon this app launched answers `/health`, then returns its URLs and token.
/// A daemon it did not launch is never used (S35.2): the answer is then the reason and its exit.
/// Replacing an earlier app's daemon can take longer than this waits (up to 17 s before the spawn);
/// the windows then connect on [`ASSISTANT_READY`].
#[tauri::command]
async fn connection_info(app: AppHandle) -> CommandResult<ConnectionInfo> {
    let shell = app.state::<Shell>();
    let (config, daemon) = (shell.config.clone(), shell.daemon.clone());
    tauri::async_runtime::spawn_blocking(move || {
        daemon.wait_ready(DAEMON_START_TIMEOUT)?;
        read_connection_info(&config)
    })
    .await
    .map_err(err)?
}

#[tauri::command]
fn toggle_panel(app: AppHandle) -> CommandResult {
    if window(&app, PANEL)?.is_visible().map_err(err)? {
        hide_panel(app)
    } else {
        show_panel(&app)
    }
}

#[tauri::command]
fn hide_panel(app: AppHandle) -> CommandResult {
    let panel = window(&app, PANEL)?;
    let shell = app.state::<Shell>();
    if shell.full_screen.lock().unwrap().is_none() {
        if let Ok(rect) = rect_of(&panel) {
            *shell.panel_spot.lock().unwrap() = Some((rect.x, rect.y));
        }
    }
    panel.hide().map_err(err)
}

#[tauri::command]
fn rose_hidden(app: AppHandle) -> bool {
    rose_hidden_state(&app)
}

/// Hides or shows the Dot window and remembers the choice. Returns whether it is hidden.
#[tauri::command]
fn set_rose_hidden(app: AppHandle, hidden: bool) -> CommandResult<bool> {
    if desktop_companion::enabled(&app) { return Err("Desactiva Capri en el escritorio para cambiar la flor".into()); }
    let shell = app.state::<Shell>();
    position::save_rose_hidden(&desktop_file(&shell.config), hidden).map_err(err)?;
    shell.rose_hidden.store(hidden, Ordering::SeqCst);
    let dot = window(&app, DOT)?;
    if hidden {
        dot.hide().map_err(err)?;
    } else {
        #[cfg(target_os = "linux")]
        if let Some(windows) = app.try_state::<Arc<ShellWindows>>() {
            windows.restore_dot_content()?;
        }
        dot.show().map_err(err)?;
    }
    if let Some(item) = app.try_state::<RoseMenuItem>() {
        item.0.set_text(rose_menu_label(hidden)).map_err(err)?;
    }
    app.emit("dot://rose", serde_json::json!({ "hidden": hidden })).map_err(err)?;
    Ok(hidden)
}

/// Fills the work area of the panel's display, or returns to the frame before (S26.2).
/// It stays an accessory window, never a separate macOS fullscreen Space. Returns the new state.
#[tauri::command]
fn set_panel_fullscreen(app: AppHandle, on: bool) -> CommandResult<bool> {
    let panel = window(&app, PANEL)?;
    let shell = app.state::<Shell>();
    let mut full_screen = shell.full_screen.lock().unwrap();
    let monitors = monitor_rects(&panel)?;
    match (on, *full_screen) {
        (true, None) => {
            let before = rect_of(&panel)?;
            let Some(area) = geometry::full_screen_rect(before, &monitors) else {
                return Ok(false);
            };
            // GTK keeps a non-resizable window at its content size.
            #[cfg(target_os = "linux")]
            panel.set_resizable(true).map_err(err)?;
            set_frame(&panel, area)?;
            *full_screen = Some(before);
        }
        (false, Some(before)) => {
            set_frame(&panel, geometry::restore_rect(before, &monitors, EDGE_MARGIN))?;
            *full_screen = None;
        }
        _ => {}
    }
    Ok(full_screen.is_some())
}

/// Result of `shortcut_get`: the shortcut that opens the panel and the default one.
#[derive(serde::Serialize)]
struct ShortcutInfo {
    shortcut: String,
    default: String,
}

/// Result of `shortcut_set`: the shortcut as saved.
#[derive(serde::Serialize)]
struct ShortcutChoice {
    shortcut: String,
}

#[tauri::command]
fn shortcut_get(app: AppHandle) -> ShortcutInfo {
    let shell = app.state::<Shell>();
    let current = shell.shortcut.lock().unwrap().clone().unwrap_or_else(|| shell.config.shortcut.clone());
    ShortcutInfo {
        shortcut: shortcut::normalize(&current).unwrap_or(current),
        default: DEFAULT_SHORTCUT.to_string(),
    }
}

/// Binds, saves, and shows a new panel shortcut at once (S33.3), or says why it cannot.
#[tauri::command]
async fn shortcut_set(app: AppHandle, shortcut: String) -> CommandResult<ShortcutChoice> {
    tauri::async_runtime::spawn_blocking(move || {
        let shell = app.state::<Shell>();
        if !shell.places_windows {
            return Err(DESKTOP_OWNS_SHORTCUTS.to_string());
        }
        let mut current = shell.shortcut.lock().unwrap();
        let host = ShortcutHost { app: &app, config_file: shell.config.data_dir.join("config.json") };
        let saved = shortcut::apply(&host, current.as_deref(), &shortcut)?;
        *current = Some(saved.clone());
        Ok(ShortcutChoice { shortcut: saved })
    })
    .await
    .map_err(err)?
}

struct ShortcutHost<'a> {
    app: &'a AppHandle,
    config_file: PathBuf,
}

impl shortcut::Host for ShortcutHost<'_> {
    fn bind_toggle(&self, shortcut: &str) -> Result<(), String> {
        self.app.global_shortcut().on_shortcut(shortcut, toggle_on_press).map_err(err)
    }

    fn unbind(&self, shortcut: &str) {
        if let Err(error) = self.app.global_shortcut().unregister(shortcut) {
            eprintln!("gentle-dot: cannot release shortcut `{shortcut}`: {error}");
        }
    }

    fn save(&self, shortcut: &str) -> Result<(), String> {
        config::save_shortcut(&self.config_file, shortcut)
    }

    fn label_tray(&self, shortcut: &str) {
        label_tray_open(self.app, shortcut);
    }
}

/// The accelerator is only a label; one the menu cannot show is left off.
fn label_tray_open(app: &AppHandle, shortcut: &str) {
    if let Some(item) = app.try_state::<OpenMenuItem>() {
        if item.0.set_accelerator(Some(shortcut)).is_err() {
            let _ = item.0.set_accelerator(None::<&str>);
        }
    }
}

#[tauri::command]
fn set_dot_state(app: AppHandle, state: String) -> CommandResult {
    let status = tray_status(&state).ok_or_else(|| format!("unknown state `{state}`"))?;
    let tray = app.tray_by_id(TRAY).ok_or("tray icon is missing")?;
    tray.set_tooltip(Some(&status.tooltip)).map_err(err)?;
    tray.set_icon(Some(Image::from_bytes(status.glyph.image(Os::CURRENT)).map_err(err)?)).map_err(err)?;
    tray.set_icon_as_template(is_template(Os::CURRENT)).map_err(err)
}

/// The window frame in points. Tao reports it in pixels of the window's current scale factor.
fn rect_of(window: &WebviewWindow) -> CommandResult<Rect> {
    let position = window.outer_position().map_err(err)?;
    let size = window.outer_size().map_err(err)?;
    let scale = window.scale_factor().map_err(err)?;
    Ok(geometry::to_points((position.x, position.y), (size.width, size.height), scale))
}

/// Work area (without menu bar and Dock) of a monitor in points, using that monitor's own scale factor.
fn work_area(monitor: &tauri::Monitor) -> Rect {
    let area = monitor.work_area();
    geometry::to_points(
        (area.position.x, area.position.y),
        (area.size.width, area.size.height),
        monitor.scale_factor(),
    )
}

fn monitor_rects(window: &WebviewWindow) -> CommandResult<Vec<Rect>> {
    Ok(window.available_monitors().map_err(err)?.iter().map(work_area).collect())
}

fn move_to(window: &WebviewWindow, (x, y): (i32, i32)) -> CommandResult {
    window.set_position(LogicalPosition::new(f64::from(x), f64::from(y))).map_err(err)
}

fn set_frame(window: &WebviewWindow, rect: Rect) -> CommandResult {
    window.set_size(LogicalSize::new(f64::from(rect.width), f64::from(rect.height))).map_err(err)?;
    move_to(window, (rect.x, rect.y))
}

/// The work area under the pointer, or the primary one. Tao reports the pointer in pixels of the
/// primary monitor's scale factor.
fn current_monitor(app: &AppHandle, monitors: &[Rect]) -> CommandResult<Option<Rect>> {
    let primary = app.primary_monitor().map_err(err)?;
    let scale = primary.as_ref().map_or(1.0, |m| m.scale_factor());
    let points = |value: f64| (value / scale).round() as i32;
    let pointer = app.cursor_position().ok().map(|p| Rect::new(points(p.x), points(p.y), 0, 0));
    Ok(pointer.and_then(|p| geometry::monitor_for(p, monitors)).or_else(|| primary.as_ref().map(work_area)))
}

/// Keeps the Dot at exactly `DOT_SIZE` points, in case macOS or a monitor change resized it.
fn keep_dot_size(dot: &WebviewWindow, current: Rect) -> CommandResult {
    if (current.width, current.height) == (DOT_SIZE.0 as i32, DOT_SIZE.1 as i32) {
        return Ok(());
    }
    dot.set_size(LogicalSize::new(DOT_SIZE.0, DOT_SIZE.1)).map_err(err)
}

fn place_panel(app: &AppHandle) -> CommandResult {
    let shell = app.state::<Shell>();
    let full_screen = shell.full_screen.lock().unwrap().is_some();
    match panel_placement(shell.places_windows, full_screen, shell.rose_hidden.load(Ordering::SeqCst)) {
        Placement::Keep => Ok(()),
        Placement::BesideDot => place_panel_next_to_dot(app),
        Placement::Alone => place_panel_alone(app),
    }
}

fn place_panel_alone(app: &AppHandle) -> CommandResult {
    let panel = window(app, PANEL)?;
    let Some(current) = current_monitor(app, &monitor_rects(&panel)?)? else {
        return Ok(());
    };
    let remembered = *app.state::<Shell>().panel_spot.lock().unwrap();
    let size = (PANEL_SIZE.0 as i32, PANEL_SIZE.1 as i32);
    move_to(&panel, geometry::place_panel_alone(remembered, size, current, EDGE_MARGIN))
}

fn place_panel_next_to_dot(app: &AppHandle) -> CommandResult {
    let (dot, panel) = (window(app, DOT)?, window(app, PANEL)?);
    let mut dot_rect = rect_of(&dot)?;
    (dot_rect.width, dot_rect.height) = (DOT_SIZE.0 as i32, DOT_SIZE.1 as i32);
    let Some(monitor) = geometry::monitor_for(dot_rect, &monitor_rects(&dot)?) else {
        return Ok(());
    };
    // Both windows have fixed sizes. On Linux a panel that was never shown reports 0 × 0.
    let size = (PANEL_SIZE.0 as i32, PANEL_SIZE.1 as i32);
    let position = geometry::place_panel(dot_rect, size, monitor, PANEL_GAP, EDGE_MARGIN);
    move_to(&panel, position)
}

pub(crate) fn show_panel(app: &AppHandle) -> CommandResult {
    place_panel(app)?;
    let panel = window(app, PANEL)?;
    panel.show().map_err(err)?;
    panel.set_focus().map_err(err)?;
    app.emit("dot://panel-shown", ()).map_err(err)
}

/// Snaps the Dot to the nearest edge and persists the position.
fn snap_dot(app: &AppHandle) -> CommandResult {
    if desktop_companion::enabled(app) { return Ok(()); }
    let dot = window(app, DOT)?;
    let mut current = rect_of(&dot)?;
    keep_dot_size(&dot, current)?;
    (current.width, current.height) = (DOT_SIZE.0 as i32, DOT_SIZE.1 as i32);
    let (x, y) = geometry::snap_to_edge(current, &monitor_rects(&dot)?, EDGE_MARGIN);
    if (x, y) != (current.x, current.y) {
        move_to(&dot, (x, y))?;
    }
    let shell = app.state::<Shell>();
    position::save(&desktop_file(&shell.config), DotPosition { x, y }).map_err(err)?;
    if window(app, PANEL)?.is_visible().unwrap_or(false) {
        place_panel(app)?;
    }
    Ok(())
}

/// Runs `snap_dot` once the Dot has stopped moving for `DRAG_SETTLE`.
fn spawn_snapper(app: AppHandle) -> mpsc::Sender<()> {
    let (tx, rx) = mpsc::channel::<()>();
    thread::spawn(move || {
        while rx.recv().is_ok() {
            loop {
                match rx.recv_timeout(DRAG_SETTLE) {
                    Ok(()) => continue,
                    Err(mpsc::RecvTimeoutError::Timeout) => break,
                    Err(mpsc::RecvTimeoutError::Disconnected) => return,
                }
            }
            if let Err(error) = snap_dot(&app) {
                eprintln!("gentle-dot: cannot snap the Dot: {error}");
            }
        }
    });
    tx
}

fn build_windows(
    app: &AppHandle,
    config: &DesktopConfig,
    places_windows: bool,
    rose_hidden: bool,
) -> tauri::Result<()> {
    let dot = WebviewWindowBuilder::new(app, DOT, WebviewUrl::App("index.html?surface=dot".into()))
        .on_navigation(crate::navigation::handler(app.clone()))
        .on_page_load(crate::frontend::page_loaded)
        .title(DOT_TITLE)
        .inner_size(DOT_SIZE.0, DOT_SIZE.1)
        .transparent(true)
        .decorations(false)
        .always_on_top(true)
        .resizable(false)
        .skip_taskbar(true)
        .visible_on_all_workspaces(true)
        .shadow(false)
        .visible(false);
    #[cfg(target_os = "macos")]
    let dot = dot.accept_first_mouse(true);
    // GTK sizes a non-resizable window to its content (200 × 200 in an X11 test), so on Linux
    // the Dot stays resizable and equal minimum and maximum sizes pin it at DOT_SIZE.
    #[cfg(target_os = "linux")]
    let dot = dot.resizable(true).min_inner_size(DOT_SIZE.0, DOT_SIZE.1).max_inner_size(DOT_SIZE.0, DOT_SIZE.1);
    let dot = dot.build()?;
    WebviewWindowBuilder::new(app, desktop_companion::LAUNCHER, WebviewUrl::App("index.html?surface=companion-launcher".into()))
        .on_navigation(crate::navigation::handler(app.clone()))
        .on_page_load(crate::frontend::page_loaded)
        .title(desktop_companion::LAUNCHER_TITLE)
        .inner_size(56., 56.).min_inner_size(56., 56.).max_inner_size(56., 56.)
        .transparent(true).decorations(false).always_on_top(true).resizable(true)
        .skip_taskbar(true).visible_on_all_workspaces(true).shadow(false).visible(false)
        .build()?;
    WebviewWindowBuilder::new(app, desktop_companion::BUBBLE, WebviewUrl::App("index.html?surface=companion-bubble".into()))
        .on_navigation(crate::navigation::handler(app.clone()))
        .on_page_load(crate::frontend::page_loaded)
        .title(desktop_companion::BUBBLE_TITLE)
        .inner_size(desktop_companion::BUBBLE_WIDTH as f64, desktop_companion::BUBBLE_HEIGHT as f64)
        .min_inner_size(desktop_companion::BUBBLE_WIDTH as f64, desktop_companion::BUBBLE_HEIGHT as f64)
        .max_inner_size(desktop_companion::BUBBLE_WIDTH as f64, desktop_companion::BUBBLE_HEIGHT as f64)
        .transparent(true).decorations(false).always_on_top(true).resizable(true)
        .skip_taskbar(true).visible_on_all_workspaces(true).shadow(false).visible(false)
        .build()?;
    // Linux has no window effects; the panel URL tells the UI to paint an opaque background.
    let panel = WebviewWindowBuilder::new(app, PANEL, WebviewUrl::App(platform::panel_url(Os::CURRENT).into()))
        .on_navigation(crate::navigation::handler(app.clone()))
        .on_page_load(crate::frontend::page_loaded)
        .title(PANEL_TITLE)
        .inner_size(PANEL_SIZE.0, PANEL_SIZE.1)
        .transparent(true)
        .decorations(false)
        .always_on_top(true)
        .resizable(false)
        .skip_taskbar(true)
        // Lets the chat receive HTML5 drops of attachments (S31); Tauri's own handler would take them.
        .disable_drag_drop_handler()
        .visible(false);
    #[cfg(target_os = "macos")]
    let panel = panel
        .effects(EffectsBuilder::new().effect(Effect::HudWindow).state(EffectState::Active).radius(20.0).build());
    panel.build()?;

    if !places_windows {
        // Native Wayland ignores positions; Hyprland window rules place and pin the Dot.
        if !rose_hidden && !desktop_companion::starts_enabled(app) {
            dot.show()?;
        }
        return Ok(());
    }

    // Restore the saved position (re-snapped in case the monitors changed), or
    // default to the right edge of the primary monitor, vertically centered.
    // Everything is in points: before it is shown, the window may sit on a
    // monitor with another scale factor than the one it is moved to.
    let monitors = monitor_rects(&dot).unwrap_or_default();
    let size = (DOT_SIZE.0 as i32, DOT_SIZE.1 as i32);
    let primary = app.primary_monitor()?.as_ref().map(work_area);
    let saved = position::load(&desktop_file(config)).map(|p| (p.x, p.y));
    if let Some((x, y)) = geometry::initial_dot_position(saved, size, &monitors, primary, EDGE_MARGIN) {
        dot.set_position(LogicalPosition::new(f64::from(x), f64::from(y)))?;
    }
    // Set the size again once the window is in place, so it is exactly DOT_SIZE points there.
    dot.set_size(LogicalSize::new(DOT_SIZE.0, DOT_SIZE.1))?;
    // A hidden rose stays placed, ready for "Show the rose".
    if !rose_hidden && !desktop_companion::starts_enabled(app) {
        dot.show()?;
    }
    Ok(())
}

/// Whether the conversations list is on, read like the daemon reads it (`GENTLE_DOT_CONVERSATIONS=1`).
fn conversations_on(value: Option<&str>) -> bool {
    value == Some("1")
}

/// The tray menu, top to bottom (`-` is a separator). "New conversation" only exists with the
/// conversations list on; in the single continuous chat there is nothing new to start.
/// "Stop computer control" and "Yolo mode" exist where computer control does (macOS, S24.3, S24.9).
/// "rose" hides or shows the floating Dot (S26.1).
fn tray_menu_ids(conversations: bool, computer_control: bool) -> Vec<&'static str> {
    let mut ids = vec!["open"];
    if conversations {
        ids.push("new");
    }
    ids.extend(["browser", "rose"]);
    if computer_control {
        ids.extend(["computer-stop", "computer-yolo"]);
    }
    ids.extend(["-", "restart", "autostart", "-", "quit"]);
    ids
}

fn build_tray(app: &AppHandle, config: &DesktopConfig, rose_hidden: bool) -> tauri::Result<TrayIcon> {
    let autostart = app.autolaunch().is_enabled().unwrap_or(false);
    // The accelerator is only a label here; an unparsable one must not break the menu.
    let open = MenuItem::with_id(app, "open", "Open", true, Some(config.shortcut.as_str()))
        .or_else(|_| MenuItem::with_id(app, "open", "Open", true, None::<&str>))?;
    app.manage(OpenMenuItem(open.clone()));
    let menu = Menu::new(app)?;
    let conversations = conversations_on(std::env::var("GENTLE_DOT_CONVERSATIONS").ok().as_deref());
    for id in tray_menu_ids(conversations, cfg!(target_os = "macos")) {
        match id {
            "open" => menu.append(&open)?,
            "new" => menu.append(&MenuItem::with_id(app, "new", "New conversation", true, None::<&str>)?)?,
            "browser" => menu.append(&MenuItem::with_id(app, "browser", "Open in browser", true, None::<&str>)?)?,
            "rose" => {
                let item = MenuItem::with_id(app, "rose", rose_menu_label(rose_hidden), true, None::<&str>)?;
                menu.append(&item)?;
                app.manage(RoseMenuItem(item));
                let capri = CheckMenuItem::with_id(app, "desktop-companion", "Capri en el escritorio", true, false, None::<&str>)?;
                let recall = MenuItem::with_id(app, "desktop-companion-recall", "Traer Capri aquí", false, None::<&str>)?;
                menu.append(&capri)?;
                menu.append(&recall)?;
                app.manage(CompanionMenuItems { toggle: capri, recall });
            }
            "computer-stop" => menu.append(&MenuItem::with_id(
                app,
                "computer-stop",
                "Stop computer control",
                true,
                None::<&str>,
            )?)?,
            "computer-yolo" => {
                // Off at launch: yolo mode never outlives the app (S24.9).
                let item = CheckMenuItem::with_id(app, "computer-yolo", "Yolo mode", true, false, None::<&str>)?;
                menu.append(&item)?;
                app.manage(computer::YoloMenuItem(item));
            }
            "restart" => {
                menu.append(&MenuItem::with_id(app, "restart", "Restart assistant", true, None::<&str>)?)?;
            }
            "autostart" => menu.append(&CheckMenuItem::with_id(
                app,
                "autostart",
                "Launch at login",
                true,
                autostart,
                None::<&str>,
            )?)?,
            "quit" => menu.append(&MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?)?,
            _ => menu.append(&PredefinedMenuItem::separator(app)?)?,
        }
    }
    TrayIconBuilder::with_id(TRAY)
        .icon(Image::from_bytes(TrayGlyph::Unavailable.image(Os::CURRENT))?)
        .icon_as_template(is_template(Os::CURRENT))
        .tooltip("Gentle Dot")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(move |app, event| {
            let result = match event.id().as_ref() {
                "open" => show_panel(app),
                "new" => show_panel(app).and_then(|()| app.emit("dot://new-conversation", ()).map_err(err)),
                "browser" => open_in_browser(app),
                "rose" => set_rose_hidden(app.clone(), !rose_hidden_state(app)).map(|_| ()),
                "desktop-companion" => { desktop_companion::tray_toggle(app); Ok(()) },
                "desktop-companion-recall" => { desktop_companion::tray_recall(app); Ok(()) },
                "computer-stop" => {
                    computer::stop(app, Reason::Stopped);
                    Ok(())
                }
                "computer-yolo" => {
                    computer::toggle_yolo(app);
                    Ok(())
                }
                "restart" => {
                    restart_daemon(app.clone());
                    Ok(())
                }
                "autostart" => toggle_autostart(app, &menu),
                "quit" => {
                    app.exit(0);
                    Ok(())
                }
                _ => Ok(()),
            };
            if let Err(error) = result {
                show_message(app, MessageDialogKind::Error, &error);
            }
        })
        .build(app)
}

pub(crate) fn rose_hidden_state(app: &AppHandle) -> bool {
    app.state::<Shell>().rose_hidden.load(Ordering::SeqCst)
}

struct CompanionMenuItems { toggle: CheckMenuItem<tauri::Wry>, recall: MenuItem<tauri::Wry> }
pub(crate) fn update_companion_menu(app: &AppHandle, enabled: bool, available: bool) {
    if let Some(items) = app.try_state::<CompanionMenuItems>() {
        let _ = items.toggle.set_checked(enabled);
        let _ = items.toggle.set_enabled(available || enabled);
        let _ = items.recall.set_enabled(enabled);
    }
    if let Some(rose) = app.try_state::<RoseMenuItem>() { let _ = rose.0.set_enabled(!enabled); }
}
pub(crate) fn companion_error(app: &AppHandle, text: &str) { show_message(app, MessageDialogKind::Error, text); }

fn show_message(app: &AppHandle, kind: MessageDialogKind, text: &str) {
    app.dialog().message(text).title("Gentle Dot").kind(kind).show(|_| {});
}

fn open_in_browser(app: &AppHandle) -> CommandResult {
    let info = read_connection_info(&app.state::<Shell>().config)?;
    app.opener().open_url(info.web_url, None::<&str>).map_err(err)
}

fn toggle_autostart(app: &AppHandle, menu: &Menu<tauri::Wry>) -> CommandResult {
    let autolaunch = app.autolaunch();
    if autolaunch.is_enabled().map_err(err)? {
        autolaunch.disable().map_err(err)?;
    } else {
        autolaunch.enable().map_err(err)?;
    }
    if let Some(item) = menu.get("autostart").and_then(|item| item.as_check_menuitem().cloned()) {
        item.set_checked(autolaunch.is_enabled().unwrap_or(false)).map_err(err)?;
    }
    Ok(())
}

fn restart_daemon(app: AppHandle) {
    let (daemon, port) = (app.state::<Shell>().daemon.clone(), app.state::<Shell>().config.port);
    thread::spawn(move || match daemon.restart(DAEMON_START_TIMEOUT) {
        RestartOutcome::Restarted => {}
        RestartOutcome::External => {
            show_message(&app, MessageDialogKind::Warning, &daemon::foreign_daemon_message(port))
        }
        RestartOutcome::Failed(error) => {
            show_message(&app, MessageDialogKind::Error, &format!("The assistant could not restart: {error}"))
        }
    });
}

/// Alt/Option+Shift+Escape ends control on desktops that permit native global shortcuts.
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn register_panic_shortcut(app: &AppHandle) {
    let handler = |app: &AppHandle, _: &_, event: tauri_plugin_global_shortcut::ShortcutEvent| {
        if event.state() == ShortcutState::Pressed {
            computer::stop(app, Reason::Panic);
        }
    };
    if let Err(error) = app.global_shortcut().on_shortcut(computer::PANIC_SHORTCUT, handler) {
        eprintln!("gentle-dot: the computer-control panic shortcut is unavailable: {error}");
    }
}

/// What the panel shortcut does, at launch and after a change in Settings.
fn toggle_on_press(app: &AppHandle, _: &Shortcut, event: ShortcutEvent) {
    if event.state() == ShortcutState::Pressed {
        if let Err(error) = toggle_panel(app.clone()) {
            eprintln!("gentle-dot: cannot toggle the panel: {error}");
        }
    }
}

/// Binds the configured shortcut, or the default one when it is unavailable. Returns the bound one.
fn register_shortcut(app: &AppHandle, shortcut: &str) -> Option<String> {
    match app.global_shortcut().on_shortcut(shortcut, toggle_on_press) {
        Ok(()) => return Some(shortcut.to_string()),
        Err(error) => eprintln!("gentle-dot: shortcut `{shortcut}` is unavailable ({error}); using {DEFAULT_SHORTCUT}"),
    }
    if shortcut != DEFAULT_SHORTCUT && app.global_shortcut().on_shortcut(DEFAULT_SHORTCUT, toggle_on_press).is_ok() {
        return Some(DEFAULT_SHORTCUT.to_string());
    }
    None
}

/// A launch of `gentle-dot` (usually `--toggle` from a desktop shortcut) reaches the running app.
fn handle_launch(app: &AppHandle, args: &[String]) {
    let result = match platform::launch_request(args) {
        LaunchRequest::Toggle => toggle_panel(app.clone()),
        LaunchRequest::Show => show_panel(app),
        LaunchRequest::StopComputer => {
            computer::stop(app, Reason::Panic);
            Ok(())
        },
    };
    if let Err(error) = result {
        eprintln!("gentle-dot: cannot show the panel: {error}");
    }
}

pub fn run() {
    // GNOME on Wayland: run under XWayland so the Dot can place itself, stay on top, and snap.
    // This must happen before GTK starts.
    #[cfg(target_os = "linux")]
    if let Some(backend) = platform::forced_gdk_backend(|key| std::env::var(key).ok()) {
        std::env::set_var("GDK_BACKEND", backend);
    }
    // Apply only to this app, before GTK starts; keep other desktop applications unchanged.
    #[cfg(target_os = "linux")]
    // SAFETY: plain getters of the linked WebKitGTK version; no initialization required.
    let webkit = unsafe {
        (
            webkit2gtk::ffi::webkit_get_major_version(),
            webkit2gtk::ffi::webkit_get_minor_version(),
        )
    };
    #[cfg(target_os = "linux")]
    if let Some(value) = platform::webkit_renderer_env(webkit, |key| std::env::var(key).ok()) {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", value);
    }
    let places_windows = !platform::compositor_places_windows(|key| std::env::var(key).ok());
    let config = config::load_config();
    tauri::Builder::default()
        // First, so a second launch forwards its arguments and exits before anything else starts.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| handle_launch(app, &args)))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            connection_info,
            toggle_panel,
            hide_panel,
            set_dot_state,
            rose_hidden,
            set_rose_hidden,
            set_panel_fullscreen,
            shortcut_get,
            shortcut_set,
            connector_command,
            crate::capri3d::capri3d_asset,
            crate::capri3d::capri3d_surface,
            desktop_companion::desktop_companion_get,
            desktop_companion::desktop_companion_set,
            desktop_companion::desktop_companion_interaction,
            desktop_companion::desktop_companion_recall,
            desktop_companion::desktop_companion_move,
            desktop_companion::desktop_companion_hide,
            desktop_companion::desktop_companion_menu,
            desktop_companion::desktop_companion_context,
            desktop_companion::desktop_companion_context_dismiss,
            desktop_companion::desktop_companion_context_ready,
            desktop_companion::desktop_companion_context_open,
            computer::computer_endpoint,
            computer::computer_permissions,
            computer::computer_capabilities,
            computer::computer_request_permission,
            computer::computer_stop,
            computer::computer_status,
            computer::computer_set_yolo,
            computer::computer_working_ready,
            voice::voice_status,
            voice::voice_start,
            voice::voice_stop,
            voice::voice_cancel,
            voice::voice_model_status,
            voice::voice_model_download,
            voice::voice_model_cancel,
            voice::voice_model_remove
        ])
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            let handle = app.handle().clone();

            // Computer control first: a daemon this app spawns gets the helper over its channel.
            let control_windows = Arc::new(ShellWindows {
                app: handle.clone(),
                #[cfg(target_os = "linux")]
                dot_opacity: Mutex::new(None),
                #[cfg(target_os = "linux")]
                prepared_dot_id: Mutex::new(None),
                #[cfg(target_os = "linux")]
                launcher_opacity: Mutex::new(None),
                #[cfg(target_os = "linux")]
                prepared_launcher_id: Mutex::new(None),
            });
            app.manage(control_windows.clone());
            let computer = computer::start(&handle, control_windows);
            let service = ChannelService {
                app: handle.clone(),
                approvals: Approvals::new(Arc::new(NativePrompt::new(handle.clone())), APPROVAL_TIMEOUT),
                computer: computer.endpoint(),
                secrets: secure_store::connector_store(),
                privileged: crate::privileged::Privileged::default(),
            };
            app.manage(computer);
            let runtime_dir = daemon::runtime_dir(|key| std::env::var(key).ok(), app.path().resource_dir().ok());
            let announcer = handle.clone();
            let daemon = Arc::new(
                Daemon::new(config.port, config.data_dir.clone(), runtime_dir)
                    .with_channel(Arc::new(service))
                    .on_ready(Arc::new(move || {
                        if let Err(error) = announcer.emit(ASSISTANT_READY, ()) {
                            eprintln!("gentle-dot: cannot tell the windows the assistant is ready: {error}");
                        }
                    })),
            );
            let (starter, notifier) = (daemon.clone(), handle.clone());
            thread::spawn(move || {
                if let Err(error) = starter.ensure_running(DAEMON_START_TIMEOUT) {
                    eprintln!("gentle-dot: {error}");
                    // Another daemon holds the port (S35.2): say so, with the way out, instead of using it.
                    if starter.refusal().is_some() {
                        show_message(&notifier, MessageDialogKind::Warning, &error);
                    }
                }
            });
            let rose_hidden = position::load_rose_hidden(&desktop_file(&config));
            app.manage(Shell {
                config: config.clone(),
                daemon,
                snap: spawn_snapper(handle.clone()),
                places_windows,
                rose_hidden: AtomicBool::new(rose_hidden),
                panel_spot: Mutex::new(None),
                full_screen: Mutex::new(None),
                shortcut: Mutex::new(None),
            });
            let (voice_input, voice_model) = voice::start(&handle);
            app.manage(voice_input);
            app.manage(voice_model);
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            if places_windows { register_panic_shortcut(&handle); }

            crate::capri3d::init(&handle);
            desktop_companion::init(&handle, &config.data_dir);
            build_windows(&handle, &config, places_windows, rose_hidden)?;
            build_tray(&handle, &config, rose_hidden)?;
            desktop_companion::start(&handle);
            let moved = handle.clone();
            window(&handle, DOT)?.on_window_event(move |event| {
                if matches!(event, WindowEvent::Moved(_)) { desktop_companion::movement_observed(&moved); }
            });
            if places_windows {
                let bound = register_shortcut(&handle, &config.shortcut);
                if let Some(bound) = &bound {
                    label_tray_open(&handle, bound);
                }
                *app.state::<Shell>().shortcut.lock().unwrap() = bound;
                let snap = app.state::<Shell>().snap.clone();
                window(&handle, DOT)?.on_window_event(move |event| {
                    // A move, or a new monitor scale, re-snaps the Dot and restores its size.
                    if let WindowEvent::Moved(_) | WindowEvent::ScaleFactorChanged { .. } = event {
                        let _ = snap.send(());
                    }
                });
            } else {
                eprintln!(
                    "gentle-dot: native Wayland: the desktop places the windows and owns shortcuts; bind `gentle-dot --toggle` (docs/linux-testing.md)"
                );
            }
            // Started by the shortcut while not running: open the panel right away.
            let args: Vec<String> = std::env::args().collect();
            if matches!(platform::launch_request(&args), LaunchRequest::Toggle | LaunchRequest::StopComputer) {
                handle_launch(&handle, &args);
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Gentle Dot")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                desktop_companion::stop(app);
                app.state::<Shell>().daemon.stop();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Uses the production GTK helpers on a fixture never presented to the desktop.
    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "Requires GTK display; only creates an offscreen fixture"]
    fn rose_control_mask_keeps_mapping_geometry_and_restores_hidden_content() {
        use gtk::prelude::*;
        use std::time::Instant;
        gtk::init().expect("GTK display for offscreen fixture");
        let offscreen = gtk::OffscreenWindow::new();
        let native = offscreen.upcast_ref::<gtk::Window>();
        native.set_default_size(72, 72);
        native.set_app_paintable(true);
        if let Some(visual) = gtk::prelude::GtkWindowExt::screen(native).and_then(|screen| screen.rgba_visual()) {
            native.set_visual(Some(&visual));
        }
        // Same transparent-background draw used by Tao for .transparent(true).
        native.connect_draw(|window, cr| {
            let rect = window.allocation();
            cr.rectangle(0.0, 0.0, rect.width() as f64, rect.height() as f64);
            cr.set_source_rgba(0.0, 0.0, 0.0, 0.0);
            cr.set_operator(gtk::cairo::Operator::Source);
            cr.fill().unwrap();
            cr.set_operator(gtk::cairo::Operator::Over);
            gtk::glib::Propagation::Proceed
        });
        let rose = gtk::DrawingArea::new();
        rose.set_size_request(72, 72);
        rose.connect_draw(|_, cr| {
            cr.set_source_rgba(1.0, 0.0, 0.2, 1.0);
            cr.paint().unwrap();
            gtk::glib::Propagation::Proceed
        });
        native.add(&rose);
        let mappings = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let unmappings = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let maps = mappings.clone();
        let unmaps = unmappings.clone();
        native.connect_map(move |_| { maps.fetch_add(1, Ordering::SeqCst); });
        native.connect_unmap(move |_| { unmaps.fetch_add(1, Ordering::SeqCst); });
        let painted = |native: &gtk::Window| {
            let ready = Arc::new(AtomicBool::new(false));
            let done = ready.clone();
            after_dot_paint(native, Box::new(move || { done.store(true, Ordering::SeqCst); })).unwrap();
            let deadline = Instant::now() + Duration::from_secs(3);
            while !ready.load(Ordering::SeqCst) && Instant::now() < deadline {
                while gtk::events_pending() { gtk::main_iteration_do(false); }
                std::thread::sleep(Duration::from_millis(1));
            }
            assert!(ready.load(Ordering::SeqCst), "GTK must paint before releasing capture");
        };
        let pixel = || {
            let pixbuf = offscreen.pixbuf().expect("offscreen rendered pixels");
            let bytes = pixbuf.read_pixel_bytes();
            let at = (36 * pixbuf.rowstride() + 36 * pixbuf.n_channels()) as usize;
            let channels = pixbuf.n_channels() as usize;
            bytes.as_ref()[at..at + channels].to_vec()
        };
        native.show_all();
        painted(native);
        let original = pixel();
        assert!(original[0] > 240 && original[1] < 10, "fixture paints rose pixels: {original:?}");
        let geometry = (native.position(), native.size());
        let focused = native.is_active();
        let map_count = mappings.load(Ordering::SeqCst);
        let unmap_count = unmappings.load(Ordering::SeqCst);
        for _ in 0..5 {
            let opacity = mask_dot_content(native).unwrap();
            painted(native);
            let masked = pixel();
            assert!(masked.len() == 4 && masked[3] == 0, "rose pixels must be transparent before capture: {masked:?}");
            assert_eq!((native.position(), native.size()), geometry);
            assert_eq!(native.is_active(), focused);
            assert!(native.is_visible());
            unmask_dot_content(native, opacity).unwrap();
            painted(native);
            assert_eq!(pixel(), original);
        }
        assert_eq!(mappings.load(Ordering::SeqCst), map_count, "control never remaps the rose");
        assert_eq!(unmappings.load(Ordering::SeqCst), unmap_count, "control never unmaps the rose");
        let opacity = mask_dot_content(native).unwrap();
        native.hide(); // the user's explicit choice during a computer step
        unmask_dot_content(native, opacity).unwrap();
        assert!(!native.is_visible(), "automatic restoration must preserve the user's hide");
        native.show_all(); // the user's later explicit choice
        painted(native);
        assert_eq!(pixel(), original, "explicit show restores the original rose contents");
        native.hide();
    }

    #[test]
    fn computer_approval_requires_an_exact_positive_human_answer() {
        use serde_json::json;
        assert!(approved_computer_answer(&json!({"approved": true})));
        for reply in [json!(true), json!({"approved":false}), json!({"approved":"true"}),
            json!({}), json!({"approved":true,"expired":true}), serde_json::Value::Null] {
            assert!(!approved_computer_answer(&reply), "{reply}");
        }
    }

    #[test]
    fn tray_hides_new_conversation_in_the_single_chat() {
        assert_eq!(
            tray_menu_ids(false, false),
            vec!["open", "browser", "rose", "-", "restart", "autostart", "-", "quit"]
        );
    }

    #[test]
    fn tray_shows_new_conversation_with_the_conversations_list() {
        assert_eq!(
            tray_menu_ids(true, false),
            vec!["open", "new", "browser", "rose", "-", "restart", "autostart", "-", "quit"]
        );
    }

    #[test]
    fn tray_offers_stop_computer_control_where_it_exists() {
        assert_eq!(
            tray_menu_ids(false, true),
            vec!["open", "browser", "rose", "computer-stop", "computer-yolo", "-", "restart", "autostart", "-", "quit"]
        );
    }

    #[test]
    fn the_rose_item_offers_the_opposite_of_its_state() {
        assert_eq!(rose_menu_label(false), "Hide the rose");
        assert_eq!(rose_menu_label(true), "Show the rose");
    }

    #[test]
    fn shortcut_and_tray_open_place_the_panel_without_the_rose_when_it_is_hidden() {
        // `toggle_panel` (the shortcut) and the tray's Open both go through `show_panel`.
        assert_eq!(panel_placement(true, false, false), Placement::BesideDot);
        assert_eq!(panel_placement(true, false, true), Placement::Alone);
        // Full screen keeps its frame; native Wayland leaves placement to the compositor.
        assert_eq!(panel_placement(true, true, true), Placement::Keep);
        assert_eq!(panel_placement(true, true, false), Placement::Keep);
        assert_eq!(panel_placement(false, false, true), Placement::Keep);
    }

    #[test]
    fn the_shortcut_and_connector_commands_are_registered_and_granted_to_the_panel_only() {
        let build = include_str!("../build.rs");
        let capabilities: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        for command in ["shortcut_get", "shortcut_set", "connector_command"] {
            assert!(build.contains(&format!("\"{command}\",")), "{command} is missing from build.rs");
            let permission = format!("allow-{}", command.replace('_', "-"));
            let windows: Vec<&serde_json::Value> = capabilities["capabilities"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|c| c["permissions"].as_array().unwrap().iter().any(|p| p == permission.as_str()))
                .flat_map(|c| c["windows"].as_array().unwrap())
                .collect();
            assert_eq!(windows, ["panel"], "{permission}");
        }
    }

    #[test]
    fn only_the_glow_overlay_may_acknowledge_the_working_rings() {
        let build = include_str!("../build.rs");
        assert!(build.contains("\"computer_working_ready\","), "computer_working_ready is missing from build.rs");
        let capabilities: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        let windows: Vec<&serde_json::Value> = capabilities["capabilities"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|c| c["permissions"].as_array().unwrap().iter().any(|p| p == "allow-computer-working-ready"))
            .flat_map(|c| c["windows"].as_array().unwrap())
            .collect();
        assert_eq!(windows, [computer::GLOW_WINDOW]);
    }

    #[test]
    fn the_windows_listen_for_the_assistant_ready_event() {
        let desktop = include_str!("../../../../packages/ui/src/desktop.ts");
        let app = include_str!("../../../../packages/ui/src/App.tsx");
        let quoted = format!("\"{ASSISTANT_READY}\"");
        assert!(desktop.contains(&quoted), "desktop.ts does not accept {quoted}");
        assert!(app.contains(&format!("onDesktopEvent({quoted}")), "App.tsx does not listen for {quoted}");
    }

    #[test]
    fn conversations_flag_reads_like_the_daemon() {
        assert!(conversations_on(Some("1")));
        assert!(!conversations_on(None));
        assert!(!conversations_on(Some("0")));
        assert!(!conversations_on(Some("true")));
    }
}
