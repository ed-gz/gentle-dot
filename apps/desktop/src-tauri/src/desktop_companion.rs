//! Local desktop companion. No daemon, shell session, global compositor rule or active-window
//! dispatcher is involved. Every compositor mutation resolves one mapped window owned by this PID.
use crate::desktop_context::{
    Context, Kind, NotificationSource, Placement, Request as ContextRequest, Target,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc, Condvar, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager};

pub const BUBBLE: &str = "companion-bubble";
pub const BUBBLE_TITLE: &str = "Gentle Dot Context";
pub const BUBBLE_WIDTH: i32 = 220;
pub const BUBBLE_HEIGHT: i32 = 80;
const BUBBLE_RADIUS: i32 = 20;
const NOTIFICATION_BUBBLE: (i32, i32) = (260, 96);
fn bubble_size(context: &Context) -> (i32, i32) {
    if context
        .bubble()
        .is_some_and(|cue| cue.kind == Kind::Notification && cue.source.is_some())
    {
        NOTIFICATION_BUBBLE
    } else {
        (BUBBLE_WIDTH, BUBBLE_HEIGHT)
    }
}
pub const LAUNCHER: &str = "companion-launcher";
pub const LAUNCHER_TITLE: &str = "Gentle Dot Launcher";
const EVENT: &str = "dot://desktop-companion";
const SIZE: i32 = 156;
const LAUNCHER_SIZE: i32 = 56;
const VISIBLE_FOR: Duration = Duration::from_secs(45);
const HIDDEN_FOR: Duration = Duration::from_secs(10);
// A short signal around the compositor's existing move animation, not frame-rate IPC.
const TRAVEL_FOR: Duration = Duration::from_millis(600);

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub struct Preferences {
    pub enabled: bool,
    pub motion: bool,
    pub appearances: bool,
    pub pinned: bool,
    pub areas: Vec<AllowedArea>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pin_position: Option<PinPosition>,
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            enabled: false,
            motion: true,
            appearances: true,
            pinned: false,
            areas: Vec::new(),
            pin_position: None,
        }
    }
}
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Patch {
    pub enabled: Option<bool>,
    pub motion: Option<bool>,
    pub appearances: Option<bool>,
    pub pinned: Option<bool>,
    pub areas: Option<Vec<AllowedArea>>,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct NormalizedRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
impl Default for NormalizedRect {
    fn default() -> Self {
        Self {
            x: 0.,
            y: 0.,
            width: 1.,
            height: 1.,
        }
    }
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AllowedArea {
    pub monitor: String,
    pub enabled: bool,
    pub rect: NormalizedRect,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct PinPosition {
    monitor: String,
    x: f64,
    y: f64,
}
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Monitor {
    #[serde(skip)]
    id: i64,
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}
impl Monitor {
    fn work_area(&self) -> Area {
        Area {
            x: self.x,
            y: self.y,
            width: self.width,
            height: self.height,
        }
    }
}
fn valid_name(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= 128 && !value.contains('\0')
}
impl Preferences {
    fn patched(&self, patch: Patch) -> Result<Self, String> {
        let mut next = Self {
            enabled: patch.enabled.unwrap_or(self.enabled),
            motion: patch.motion.unwrap_or(self.motion),
            appearances: patch.appearances.unwrap_or(self.appearances),
            pinned: patch.pinned.unwrap_or(self.pinned),
            areas: patch.areas.unwrap_or_else(|| self.areas.clone()),
            pin_position: self.pin_position.clone(),
        };
        next.validate()?;
        Ok(next)
    }
    fn validate(&mut self) -> Result<(), String> {
        if self.areas.len() > 64 {
            return Err("Capri admite hasta 64 zonas de pantalla".into());
        }
        let mut names = std::collections::HashSet::new();
        for a in &mut self.areas {
            if !valid_name(&a.monitor) || !names.insert(a.monitor.clone()) {
                return Err("Cada pantalla debe tener un nombre válido y una sola zona".into());
            }
            let r = &mut a.rect;
            if ![r.x, r.y, r.width, r.height].iter().all(|n| n.is_finite())
                || r.width <= 0.
                || r.height <= 0.
                || r.x >= 1.
                || r.y >= 1.
            {
                return Err(
                    "La zona de Capri debe tener un tamaño válido dentro de la pantalla".into(),
                );
            }
            r.x = r.x.clamp(0., 1.);
            r.y = r.y.clamp(0., 1.);
            r.width = r.width.min(1. - r.x);
            r.height = r.height.min(1. - r.y);
        }
        if self.pin_position.as_ref().is_some_and(|p| {
            !valid_name(&p.monitor)
                || !p.x.is_finite()
                || !p.y.is_finite()
                || !(0. ..=1.).contains(&p.x)
                || !(0. ..=1.).contains(&p.y)
        }) {
            return Err("La posición guardada de Capri no es válida".into());
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize)]
pub struct State {
    pub context: Context,
    pub enabled: bool,
    pub motion: bool,
    pub appearances: bool,
    pub pinned: bool,
    pub areas: Vec<AllowedArea>,
    pub monitors: Vec<Monitor>,
    pub visible: bool,
    pub paused: bool,
    pub travelling: bool,
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}
#[derive(Clone, Debug, PartialEq)]
struct Client {
    address: String,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    monitor: i64,
    pinned: bool,
}
#[derive(Clone, Copy, Debug, PartialEq)]
struct Area {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}
impl Area {
    fn clamp(self, x: i32, y: i32, size: i32) -> (i32, i32) {
        let margin = 12
            .min((self.width - size).max(0) / 2)
            .min((self.height - size).max(0) / 2);
        (
            x.clamp(
                self.x + margin,
                self.x + (self.width - size - margin).max(margin),
            ),
            y.clamp(
                self.y + margin,
                self.y + (self.height - size - margin).max(margin),
            ),
        )
    }
}
fn own_client(clients: &Value, pid: u32, title: &str) -> Result<Client, String> {
    let mut found = clients
        .as_array()
        .ok_or("Hyprland no devolvió ventanas válidas")?
        .iter()
        .filter(|c| {
            c["pid"].as_u64() == Some(pid.into())
                && c["title"].as_str() == Some(title)
                && c["mapped"].as_bool() == Some(true)
        });
    let c = found
        .next()
        .ok_or("No se encuentra la ventana propia de Capri")?;
    if found.next().is_some() {
        return Err("Hay más de una ventana propia con ese nombre; movimiento detenido".into());
    }
    let address = c["address"]
        .as_str()
        .filter(|s| {
            s.starts_with("0x") && s.len() > 2 && s[2..].bytes().all(|b| b.is_ascii_hexdigit())
        })
        .ok_or("Identidad de ventana inválida")?;
    let num = |field: &str, index: usize| {
        c[field][index]
            .as_i64()
            .and_then(|n| i32::try_from(n).ok())
            .ok_or("Geometría de ventana inválida")
    };
    Ok(Client {
        address: address.into(),
        x: num("at", 0)?,
        y: num("at", 1)?,
        width: num("size", 0)?,
        height: num("size", 1)?,
        monitor: c["monitor"].as_i64().ok_or("Monitor desconocido")?,
        pinned: c["pinned"].as_bool().unwrap_or(false),
    })
}
fn area(monitors: &Value, monitor: i64) -> Result<Area, String> {
    let m = monitors
        .as_array()
        .and_then(|ms| ms.iter().find(|m| m["id"].as_i64() == Some(monitor)))
        .ok_or("El monitor de Capri ya no está disponible")?;
    let scale = m["scale"]
        .as_f64()
        .filter(|s| s.is_finite() && *s > 0.)
        .ok_or("Escala de monitor inválida")?;
    let n = |key: &str| {
        m[key]
            .as_i64()
            .and_then(|n| i32::try_from(n).ok())
            .ok_or("Geometría de monitor inválida")
    };
    let (mut w, mut h) = (n("width")?, n("height")?);
    if matches!(m["transform"].as_i64().unwrap_or(0), 1 | 3 | 5 | 7) {
        std::mem::swap(&mut w, &mut h);
    }
    let reserved = |i: usize| {
        m["reserved"][i]
            .as_i64()
            .and_then(|n| i32::try_from(n).ok())
            .unwrap_or(0)
            .max(0)
    };
    let a = Area {
        x: n("x")? + reserved(0),
        y: n("y")? + reserved(1),
        width: (w as f64 / scale).round() as i32 - reserved(0) - reserved(2),
        height: (h as f64 / scale).round() as i32 - reserved(1) - reserved(3),
    };
    if a.width < SIZE || a.height < SIZE {
        return Err("El monitor no tiene espacio para Capri".into());
    }
    Ok(a)
}
fn monitors(value: &Value) -> Vec<Monitor> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|m| {
            let id = m["id"].as_i64()?;
            let name = m["name"].as_str().filter(|s| valid_name(s))?;
            let a = area(value, id).ok()?;
            Some(Monitor {
                id,
                name: name.into(),
                x: a.x,
                y: a.y,
                width: a.width,
                height: a.height,
            })
        })
        .take(32)
        .collect()
}
fn allowed_areas(prefs: &Preferences, monitors: &[Monitor]) -> Vec<(String, Area)> {
    monitors
        .iter()
        .filter_map(|m| {
            let rect = if prefs.areas.is_empty() {
                NormalizedRect::default()
            } else {
                prefs
                    .areas
                    .iter()
                    .find(|a| a.monitor == m.name && a.enabled)?
                    .rect
            };
            let x = (rect.x * m.width as f64).round() as i32;
            let y = (rect.y * m.height as f64).round() as i32;
            let width = ((rect.width * m.width as f64).round() as i32).min(m.width - x);
            let height = ((rect.height * m.height as f64).round() as i32).min(m.height - y);
            (width >= SIZE && height >= SIZE).then(|| {
                (
                    m.name.clone(),
                    Area {
                        x: m.x + x,
                        y: m.y + y,
                        width,
                        height,
                    },
                )
            })
        })
        .collect()
}
fn destination(
    prefs: &Preferences,
    monitors: &[Monitor],
    current: &Client,
    restore_pin: bool,
) -> Option<(String, Area, i32, i32)> {
    let allowed = allowed_areas(prefs, monitors);
    let current_name = monitors
        .iter()
        .find(|m| m.id == current.monitor)
        .map(|m| m.name.as_str());
    let pin = prefs
        .pin_position
        .as_ref()
        .filter(|_| prefs.pinned && restore_pin);
    let chosen = pin
        .and_then(|p| allowed.iter().find(|(name, _)| name == &p.monitor))
        .or_else(|| {
            allowed
                .iter()
                .find(|(name, _)| Some(name.as_str()) == current_name)
        })
        .or_else(|| allowed.first())?;
    let (mut x, mut y) = (current.x, current.y);
    if let Some(p) = pin.filter(|p| p.monitor == chosen.0) {
        let m = monitors.iter().find(|m| m.name == p.monitor)?;
        x = m.x + (p.x * m.width as f64).round() as i32;
        y = m.y + (p.y * m.height as f64).round() as i32;
    }
    let (x, y) = chosen.1.clamp(x, y, SIZE);
    Some((chosen.0.clone(), chosen.1, x, y))
}
fn pin_position(monitors: &[Monitor], monitor: &str, x: i32, y: i32) -> Option<PinPosition> {
    let m = monitors.iter().find(|m| m.name == monitor)?;
    Some(PinPosition {
        monitor: monitor.into(),
        x: ((x - m.x) as f64 / m.width as f64).clamp(0., 1.),
        y: ((y - m.y) as f64 / m.height as f64).clamp(0., 1.),
    })
}
#[cfg(target_os = "linux")]
fn query(name: &str) -> Result<Value, String> {
    crate::computer::linux::hypr(name)
}
#[cfg(not(target_os = "linux"))]
fn query(_: &str) -> Result<Value, String> {
    Err("Capri en el escritorio requiere Linux con Hyprland".into())
}
fn resolve(title: &str) -> Result<Client, String> {
    own_client(&query("clients")?, std::process::id(), title)
}
/// GTK3 Wayland ignores focus_on_map. Match a private random initial title only, before mapping.
/// Hyprland 0.56 has no remove-rule API; disabled named entries are inert until compositor reload.
pub(crate) struct MappingRule {
    name: String,
    pub(crate) title: String,
}
impl MappingRule {
    pub(crate) fn install(role: &str, nonce: &str) -> Result<Self, String> {
        if !matches!(role, "dot" | "launcher" | "bubble" | "fixture")
            || nonce.is_empty()
            || !nonce.bytes().all(|c| c.is_ascii_hexdigit())
        {
            return Err("Identidad de arranque inválida".into());
        }
        let name = format!("gentle-dot-map-{}-{nonce}-{role}", std::process::id());
        let title = format!("Gentle Dot Bootstrap {} {nonce} {role}", std::process::id());
        eval(&mapping_rule(&name, &title, role))?;
        Ok(Self { name, title })
    }
}
fn mapping_rule(name: &str, title: &str, role: &str) -> String {
    let style = if role == "fixture" {
        String::new()
    } else {
        format!(",{SILHOUETTE_EFFECTS}")
    };
    format!("hl.window_rule({{name='{name}',enabled=true,match={{initial_title='^{title}$'}},float=true,no_initial_focus=true{style}}})")
}
impl Drop for MappingRule {
    fn drop(&mut self) {
        if let Err(error) = eval(&format!(
            "hl.window_rule({{name='{}',enabled=false}})",
            self.name
        )) {
            eprintln!("gentle-dot: cannot disable exact bootstrap rule: {error}");
        }
    }
}
// A transparent WebKit buffer can still acquire Hyprland's rectangular blur and shadow.
// A private tag gives each companion window a removable rule, without overwriting SET_PROP
// overrides. The UI draws its own circles. Removing it reveals the user's original rules.
const SILHOUETTE_EFFECTS: &str =
    "no_blur=true,no_shadow=true,no_dim=true,border_size=0,rounding=0,opaque=true,decorate=false";
const SILHOUETTE_PROPERTIES: &[(&str, bool)] = &[
    ("no_blur", true),
    ("no_shadow", true),
    ("no_dim", true),
    ("border_size", false),
    ("rounding", false),
    ("opaque", true),
];
fn style_identity(nonce: &str) -> Result<String, String> {
    if nonce.is_empty() || !nonce.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err("Identidad de estilo inválida".into());
    }
    Ok(format!("gentle-dot-style-{}-{nonce}", std::process::id()))
}
fn style_rule(name: &str) -> String {
    format!("hl.window_rule({{name='{name}',enabled=true,match={{tag='{name}'}},{SILHOUETTE_EFFECTS}}})")
}
struct SilhouetteRule {
    name: String,
    title: String,
    address: String,
    active: bool,
}
impl SilhouetteRule {
    fn install(title: &str, address: &str, nonce: &str) -> Result<Self, String> {
        let name = style_identity(nonce)?;
        let clients = query("clients")?;
        let own = own_client(&clients, std::process::id(), title)?;
        if own.address != address
            || clients.as_array().is_some_and(|clients| {
                clients.iter().any(|client| {
                    client["tags"]
                        .as_array()
                        .is_some_and(|tags| tags.iter().any(|tag| tag.as_str() == Some(&name)))
                })
            })
        {
            return Err("La identidad privada de estilo ya está en uso".into());
        }
        let mut rule = Self {
            name,
            title: title.into(),
            address: address.into(),
            active: true,
        };
        eval(&style_rule(&rule.name))?;
        // Every mutation resolves PID/title/address again, never the active window.
        if let Err(error) = dispatch(title, address, "tag", &format!("tag='+{}'", rule.name))
            .and_then(|_| verify_silhouette(title, address))
        {
            let _ = rule.remove();
            return Err(error);
        }
        eprintln!("gentle-dot desktop companion silhouette verified: {title}");
        Ok(rule)
    }
    fn remove(&mut self) -> Result<(), String> {
        if !self.active {
            return Ok(());
        }
        // A disappeared/replaced window needs no tag cleanup; its private rule can still retire.
        let remove_tag = if resolve(&self.title).is_ok_and(|client| client.address == self.address)
        {
            dispatch(
                &self.title,
                &self.address,
                "tag",
                &format!("tag='-{}'", self.name),
            )
        } else {
            Ok(())
        };
        let remove_rule = eval(&format!(
            "hl.window_rule({{name='{}',enabled=false}})",
            self.name
        ));
        remove_tag?;
        remove_rule?;
        self.active = false;
        Ok(())
    }
}
impl Drop for SilhouetteRule {
    fn drop(&mut self) {
        if let Err(error) = self.remove() {
            eprintln!("gentle-dot: cannot retire private silhouette style: {error}");
        }
    }
}
fn window_property(title: &str, address: &str, property: &str) -> Result<Value, String> {
    if resolve(title)?.address != address
        || !SILHOUETTE_PROPERTIES
            .iter()
            .any(|(key, _)| *key == property)
    {
        return Err("La ventana o propiedad de Capri cambió".into());
    }
    #[cfg(target_os = "linux")]
    {
        let output = crate::computer::linux::run(
            "hyprctl",
            &["-j", "getprop", &format!("address:{address}"), property],
            None,
        )?;
        let result: Value = serde_json::from_slice(&output)
            .map_err(|_| "Hyprland no devolvió el estilo de ventana")?;
        Ok(result[property].clone())
    }
    #[cfg(not(target_os = "linux"))]
    {
        Err("Escritorio no compatible".into())
    }
}
fn verify_silhouette(title: &str, address: &str) -> Result<(), String> {
    for (key, boolean) in SILHOUETTE_PROPERTIES {
        let value = window_property(title, address, key)?;
        if if *boolean {
            value.as_bool() != Some(true)
        } else {
            value.as_i64() != Some(0)
        } {
            return Err(format!(
                "Hyprland no confirmó la transparencia de Capri ({key})"
            ));
        }
    }
    Ok(())
}
fn eval(expression: &str) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let out = crate::computer::linux::run("hyprctl", &["eval", expression], None)?;
        if String::from_utf8_lossy(&out).trim() != "ok" {
            return Err("Hyprland no confirmó la regla temporal de foco".into());
        }
        Ok(())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = expression;
        Err("Escritorio no compatible".into())
    }
}
pub(crate) fn nonce() -> Result<String, String> {
    let mut bytes = [0u8; 12];
    getrandom::fill(&mut bytes).map_err(|_| "No se pudo crear la identidad privada de ventana")?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}
fn command(address: &str, action: &str, args: &str) -> Result<String, String> {
    if !address.starts_with("0x")
        || address.len() <= 2
        || !address[2..].bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err("Identidad de ventana inválida".into());
    }
    if !matches!(action, "float" | "pin" | "move" | "resize" | "tag") {
        return Err("Acción de escritorio no permitida".into());
    }
    Ok(format!(
        "hl.dsp.window.{action}({{window='address:{address}',{args}}})"
    ))
}
fn dispatch(title: &str, expected: &str, action: &str, args: &str) -> Result<(), String> {
    // Resolve again immediately before each mutation. A stale/missing target never falls back
    // to the active window. Only fixed actions and internally generated numeric args reach Lua.
    let current = resolve(title)?;
    if current.address != expected {
        return Err("La ventana de Capri cambió; vuelve a activarla".into());
    }
    #[cfg(target_os = "linux")]
    {
        let out = crate::computer::linux::run(
            "hyprctl",
            &["dispatch", &command(expected, action, args)?],
            None,
        )?;
        if String::from_utf8_lossy(&out).trim() != "ok" {
            return Err("Hyprland no confirmó el cambio de ventana".into());
        }
        Ok(())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (action, args);
        Err("Escritorio no compatible".into())
    }
}
fn place(title: &str, id: &str, x: i32, y: i32, size: i32, pin: bool) -> Result<(), String> {
    dispatch(title, id, "float", "action='on'")?;
    dispatch(
        title,
        id,
        "pin",
        if pin { "action='on'" } else { "action='off'" },
    )?;
    dispatch(
        title,
        id,
        "resize",
        &format!("x={size},y={size},relative=false"),
    )?;
    dispatch(title, id, "move", &format!("x={x},y={y},relative=false"))?;
    verify(title, id, x, y, size, Some(pin))
}
fn verify(
    title: &str,
    id: &str,
    x: i32,
    y: i32,
    size: i32,
    pin: Option<bool>,
) -> Result<(), String> {
    let c = resolve(title)?;
    if c.address != id
        || (c.x - x).abs() > 2
        || (c.y - y).abs() > 2
        || (c.width - size).abs() > 2
        || (c.height - size).abs() > 2
        || pin.is_some_and(|p| p != c.pinned)
    {
        return Err("Hyprland no confirmó la posición o tamaño de Capri".into());
    }
    Ok(())
}
fn automatic_actions(
    prefs: &Preferences,
    visible: bool,
    manually_hidden: bool,
    appearance_elapsed: Duration,
) -> (bool, bool) {
    if prefs.pinned {
        return (false, false);
    }
    (
        prefs.appearances
            && !manually_hidden
            && appearance_elapsed >= if visible { VISIBLE_FOR } else { HIDDEN_FOR },
        // Timers may change visibility, never position. Moves only follow accepted cues.
        false,
    )
}
#[derive(Default)]
struct TravelPulse {
    until: Option<Instant>,
}
impl TravelPulse {
    fn start(&mut self, now: Instant) {
        self.until = Some(now + TRAVEL_FOR);
    }
    fn cancel(&mut self) -> bool {
        self.until.take().is_some()
    }
    fn finish(&mut self, now: Instant) -> bool {
        if self.until.is_some_and(|until| now >= until) {
            self.cancel()
        } else {
            false
        }
    }
    fn visible(&self, now: Instant, prefs: &Preferences, visible: bool, paused: bool) -> bool {
        prefs.enabled
            && prefs.motion
            && !prefs.pinned
            && visible
            && !paused
            && self.until.is_some_and(|until| now < until)
    }
    fn next_wake(&self, now: Instant) -> Duration {
        self.until
            .map(|until| {
                until
                    .saturating_duration_since(now)
                    .max(Duration::from_millis(1))
            })
            .unwrap_or(Duration::from_secs(1))
            .min(Duration::from_secs(1))
    }
}
struct PositionSettle {
    position: Option<(i32, i32)>,
    touched: Instant,
    programmatic_until: Instant,
}
impl PositionSettle {
    fn new(now: Instant) -> Self {
        Self {
            position: None,
            touched: now,
            programmatic_until: now,
        }
    }
    fn programmatic(&mut self, x: i32, y: i32, now: Instant) {
        self.position = Some((x, y));
        self.programmatic_until = now + Duration::from_secs(1);
    }
    fn movement(&mut self, now: Instant) -> bool {
        if now < self.programmatic_until {
            return false;
        }
        self.touched = now;
        true
    }
    fn observe(&mut self, x: i32, y: i32, now: Instant) -> bool {
        let previous = self.position.replace((x, y));
        previous.is_some_and(|p| p != (x, y)) && self.movement(now)
    }
    fn ready(&self, now: Instant) -> bool {
        now.duration_since(self.touched) >= Duration::from_millis(350)
    }
}
struct PendingOffer {
    id: String,
    deadline: Instant,
    ready: bool,
}
fn bubble_position(
    prefs: &Preferences,
    monitors: &[Monitor],
    dot: &Client,
    size: (i32, i32),
) -> Option<(i32, i32)> {
    let (width, height) = size;
    let (_, zone, _, _) = destination(prefs, monitors, dot, false)?;
    [
        (dot.x + SIZE + 8, dot.y),
        (dot.x - width - 8, dot.y),
        (dot.x, dot.y - height - 8),
        (dot.x, dot.y + SIZE + 8),
    ]
    .into_iter()
    .find(|(x, y)| {
        *x >= zone.x
            && *y >= zone.y
            && *x + width <= zone.x + zone.width
            && *y + height <= zone.y + zone.height
    })
}
// Small, intentional allow-list; only window metadata is inspected, never terminal cells.
const TERMINAL_CLASSES: &[&str] = &["kitty", "herdr"];
const TERMINAL_TITLES: &[&str] = &["gentle shell"];

fn terminal_target(active: &Value, clients: &Value) -> Option<Target> {
    let address = active["address"].as_str().filter(|address| !address.is_empty())?;
    let client = clients.as_array()?.iter().find(|c| {
        c["address"].as_str() == Some(address)
            && c["mapped"].as_bool() == Some(true)
            && c["title"] == active["title"]
            && c["class"] == active["class"]
            && c["at"] == active["at"]
            && c["size"] == active["size"]
    })?;
    let class = client["class"].as_str()?.to_lowercase();
    let title = client["title"].as_str()?.to_lowercase();
    if !TERMINAL_CLASSES.contains(&class.as_str())
        && !TERMINAL_TITLES.iter().any(|allowed| title.contains(allowed))
    {
        return None;
    }
    let target = Target {
        x: client["at"][0].as_f64()?,
        y: client["at"][1].as_f64()?,
        width: client["size"][0].as_f64()?,
        height: client["size"][1].as_f64()?,
    };
    ([target.x, target.y, target.width, target.height]
        .iter()
        .all(|v| v.is_finite())
        && target.x.abs() <= 100_000.
        && target.y.abs() <= 100_000.
        && (1. ..=32_768.).contains(&target.width)
        && (1. ..=32_768.).contains(&target.height))
    .then_some(target)
}
fn focused_terminal_target() -> Option<Target> {
    let active = query("activewindow").ok()?;
    let target = terminal_target(&active, &query("clients").ok()?)?;
    // Revalidate identity after reading the client list; never move toward a stale focus.
    let fresh = query("activewindow").ok()?;
    (fresh["address"] == active["address"]
        && fresh["title"] == active["title"]
        && fresh["class"] == active["class"]
        && fresh["at"] == active["at"]
        && fresh["size"] == active["size"])
    .then_some(target)
}
fn target_zone(prefs: &Preferences, monitors: &[Monitor], target: &Target) -> Option<Area> {
    let cx = target.x + target.width / 2.;
    let cy = target.y + target.height / 2.;
    allowed_areas(prefs, monitors).into_iter().find_map(|(_, a)| {
        (cx >= a.x as f64
            && cx < (a.x + a.width) as f64
            && cy >= a.y as f64
            && cy < (a.y + a.height) as f64)
            .then_some(a)
    })
}
/// Bottom-aligned aside, or below the bottom border. Never clamp into input rows.
/// If the terminal fills the permitted area, staying put is safer than covering it.
fn terminal_destination(target: &Target, zone: Area, size: i32) -> Option<(i32, i32)> {
    let right = (target.x + target.width).ceil() as i32;
    let left = target.x.floor() as i32;
    let bottom = (target.y + target.height).ceil() as i32;
    let y = (bottom - size).clamp(zone.y, zone.y + (zone.height - size).max(0));
    let x = (right - size).clamp(zone.x, zone.x + (zone.width - size).max(0));
    [(right, y), (left - size, y), (x, bottom)]
        .into_iter()
        .find(|(x, y)| {
            *x >= zone.x
                && *y >= zone.y
                && *x + size <= zone.x + zone.width
                && *y + size <= zone.y + zone.height
        })
}
fn context_destination(
    prefs: &Preferences,
    monitors: &[Monitor],
    dot: &Client,
    target: &Target,
    placement: Option<Placement>,
) -> Option<(i32, i32)> {
    if prefs.pinned || !prefs.motion {
        return None;
    }
    let cy = target.y + target.height / 2.;
    // No fallback to a different monitor/zone when the indicated target is excluded.
    let zone = target_zone(prefs, monitors, target)?;
    let fits = |x: i32, y: i32| {
        x >= zone.x
            && y >= zone.y
            && x + SIZE <= zone.x + zone.width
            && y + SIZE <= zone.y + zone.height
    };
    if placement == Some(Placement::Perch) {
        // The SVG uses xMidYMid meet inside 140x140 with 8px padding.
        // Atlas canvas 272x321; authored seat at (140,238), independent of animation frames.
        let scale = (SIZE - 16) as f64 / 321.;
        let anchor_x = 8. + ((SIZE - 16) as f64 - 272. * scale) / 2. + 140. * scale;
        let anchor_y = 8. + 238. * scale;
        let x = (target.x + target.width - 40. - anchor_x).round() as i32;
        let y = (target.y - anchor_y).round() as i32;
        return fits(x, y).then_some((x, y));
    }
    // Prefer the right edge; a full-width editor can use the clear area above.
    let y = (cy - SIZE as f64 / 2.).round() as i32;
    let (_, y) = zone.clamp(dot.x, y, SIZE);
    [
        (target.x + target.width + 8.).ceil() as i32,
        (target.x - SIZE as f64 - 8.).floor() as i32,
    ]
    .into_iter()
    .find(|x| fits(*x, y))
    .map(|x| (x, y))
    .or_else(|| {
        let y = (target.y - SIZE as f64 - 8.).floor() as i32;
        let (x, _) = zone.clamp(
            (target.x + target.width - SIZE as f64 - 8.).floor() as i32,
            y,
            SIZE,
        );
        fits(x, y).then_some((x, y))
    })
}
struct Runtime {
    context: Context,
    pending_offer: Option<PendingOffer>,
    dismissed_cues: std::collections::VecDeque<String>,
    cancelled_notifications: std::collections::VecDeque<(String, Instant)>,
    bubble_position: Option<(i32, i32)>,
    prefs: Preferences,
    visible: bool,
    reason: Option<String>,
    baseline: Option<Client>,
    last_appearance: Instant,
    travel: TravelPulse,
    monitors: Vec<Monitor>,
    last_topology: Instant,
    manual_hidden: bool,
    zone_unavailable: bool,
    position_settle: PositionSettle,
}
#[derive(Default)]
pub(crate) struct ControlPause(AtomicU64);
impl ControlPause {
    pub(crate) fn begin(&self, operation: u64) {
        self.0.store(operation, Ordering::SeqCst);
    }
    pub(crate) fn end(&self, operation: u64) -> bool {
        self.0
            .compare_exchange(operation, 0, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }
    pub(crate) fn active(&self) -> bool {
        self.0.load(Ordering::SeqCst) != 0
    }
}
pub struct Controller {
    app: AppHandle,
    path: PathBuf,
    inner: Mutex<Runtime>,
    operations: Mutex<()>,
    interaction: AtomicBool,
    control: ControlPause,
    stop: AtomicBool,
    settle_position: AtomicBool,
    topology_dirty: AtomicBool,
    context_menu: Mutex<Option<tauri::menu::Menu<tauri::Wry>>>,
    available: bool,
    map_nonce: String,
    silhouette: Mutex<Option<SilhouetteRule>>,
    bubble_style: Mutex<Option<SilhouetteRule>>,
    launcher_style: Mutex<Option<SilhouetteRule>>,
    context_ready: Condvar,
}
impl Controller {
    fn ensure_bubble(&self) -> Result<(), String> {
        if resolve(BUBBLE_TITLE).is_ok() {
            return Ok(());
        }
        let mapping = MappingRule::install("bubble", &self.map_nonce)?;
        let title = mapping.title.clone();
        self.main(move |app| {
            let w = app
                .get_webview_window(BUBBLE)
                .ok_or("Falta el globo de Capri")?;
            w.set_title(&title).map_err(|e| e.to_string())?;
            #[cfg(target_os = "linux")]
            {
                use gtk::prelude::*;
                let native: gtk::Window = w.gtk_window().map_err(|e| e.to_string())?.into();
                native.set_focus_on_map(false);
                native.set_accept_focus(true);
                paint_bubble(&app, false)?;
            }
            #[cfg(any(target_os = "linux", target_os = "macos"))]
            crate::computer::app::show_without_focus(&w)?;
            Ok(())
        })?;
        let mut mapped = None;
        for _ in 0..20 {
            if let Ok(w) = resolve(&mapping.title) {
                mapped = Some(w);
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        let mapped = mapped.ok_or("No se pudo identificar el globo propio de Capri")?;
        self.main(|app| {
            app.get_webview_window(BUBBLE)
                .ok_or("Falta el globo")?
                .set_title(BUBBLE_TITLE)
                .map_err(|e| e.to_string())
        })?;
        for _ in 0..20 {
            if resolve(BUBBLE_TITLE).is_ok_and(|w| w.address == mapped.address) {
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        let bubble = resolve(BUBBLE_TITLE)?;
        dispatch(BUBBLE_TITLE, &bubble.address, "float", "action='on'")?;
        dispatch(BUBBLE_TITLE, &bubble.address, "pin", "action='on'")?;
        dispatch(
            BUBBLE_TITLE,
            &bubble.address,
            "resize",
            &format!("x={BUBBLE_WIDTH},y={BUBBLE_HEIGHT},relative=false"),
        )?;
        *self.bubble_style.lock().unwrap() = Some(SilhouetteRule::install(
            BUBBLE_TITLE,
            &bubble.address,
            &format!("{}b", self.map_nonce),
        )?);
        drop(mapping);
        Ok(())
    }
    fn sync_bubble(&self) -> Result<(), String> {
        let (show, prefs, monitors, bubble_id, offer_guard, size) = {
            let i = self.inner.lock().unwrap();
            (
                i.prefs.enabled
                    && i.visible
                    && !i.manual_hidden
                    && i.context.bubble().is_some()
                    && !self.control.active(),
                i.prefs.clone(),
                i.monitors.clone(),
                i.context.bubble().map(|cue| cue.id.clone()),
                i.pending_offer.as_ref().map(|p| (p.id.clone(), p.deadline)),
                bubble_size(&i.context),
            )
        };
        let position = if show {
            resolve(crate::platform::DOT_TITLE)
                .ok()
                .and_then(|dot| bubble_position(&prefs, &monitors, &dot, size))
        } else {
            None
        };
        if let Some((x, y)) = position {
            let bubble = resolve(BUBBLE_TITLE)?;
            let resized = (bubble.width, bubble.height) != size;
            if resized {
                self.main(move |app| {
                    // Resize the existing mapped surface; never present it or take focus.
                    paint_bubble(&app, false)?;
                    let window = app.get_webview_window(BUBBLE).ok_or("Falta el globo")?;
                    window
                        .set_min_size(None::<tauri::LogicalSize<i32>>)
                        .map_err(|e| e.to_string())?;
                    window
                        .set_max_size(None::<tauri::LogicalSize<i32>>)
                        .map_err(|e| e.to_string())?;
                    window
                        .set_size(tauri::LogicalSize::new(size.0, size.1))
                        .map_err(|e| e.to_string())?;
                    window
                        .set_min_size(Some(tauri::LogicalSize::new(size.0, size.1)))
                        .map_err(|e| e.to_string())?;
                    window
                        .set_max_size(Some(tauri::LogicalSize::new(size.0, size.1)))
                        .map_err(|e| e.to_string())?;
                    Ok(())
                })?;
                dispatch(
                    BUBBLE_TITLE,
                    &bubble.address,
                    "resize",
                    &format!("x={},y={},relative=false", size.0, size.1),
                )?;
            }
            if resized || (bubble.x, bubble.y) != (x, y) {
                dispatch(
                    BUBBLE_TITLE,
                    &bubble.address,
                    "move",
                    &format!("x={x},y={y},relative=false"),
                )?;
            }
            let deadline = Instant::now() + Duration::from_millis(120);
            loop {
                let verified = resolve(BUBBLE_TITLE)?;
                if verified.address != bubble.address {
                    return Err("La identidad del globo cambió".into());
                }
                if (verified.x - x).abs() <= 2
                    && (verified.y - y).abs() <= 2
                    && (verified.width - size.0).abs() <= 2
                    && (verified.height - size.1).abs() <= 2
                {
                    break;
                }
                if Instant::now() >= deadline
                    || offer_guard
                        .as_ref()
                        .is_some_and(|(_, until)| Instant::now() >= *until)
                {
                    return Err("El escritorio no confirmó el globo de Capri".into());
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        }
        self.inner.lock().unwrap().bubble_position = position;
        self.main(move |app| {
            // GTK work can be queued while a cancel arrives. Validate the exact
            // context captured before geometry work, including a removed offer.
            let controller = app.state::<Arc<Controller>>();
            let i = controller.inner.lock().unwrap();
            let mut show = position.is_some()
                && !controlled(&app)
                && i.prefs.enabled
                && i.visible
                && !i.manual_hidden
                && i.context.bubble().map(|cue| &cue.id) == bubble_id.as_ref();
            if let Some((id, deadline)) = offer_guard {
                show &= Instant::now() < deadline
                    && i.pending_offer.as_ref().is_some_and(|p| p.id == id);
            }
            drop(i);
            #[cfg(target_os = "linux")]
            paint_bubble(&app, show)?;
            Ok(())
        })
    }
    fn contextual_move(
        &self,
        target: &Target,
        placement: Option<Placement>,
        terminal_fallback: bool,
    ) -> Result<bool, String> {
        let s = self.state();
        if !s.enabled || !s.visible || s.pinned || s.paused || !s.motion {
            return Ok(false);
        }
        let dot = resolve(crate::platform::DOT_TITLE)?;
        let (prefs, monitors) = {
            let i = self.inner.lock().unwrap();
            (i.prefs.clone(), i.monitors.clone())
        };
        let destination = if terminal_fallback {
            target_zone(&prefs, &monitors, target)
                .and_then(|zone| terminal_destination(target, zone, SIZE))
        } else {
            context_destination(&prefs, &monitors, &dot, target, placement)
        };
        let Some((x, y)) = destination else {
            return Ok(false);
        };
        if (dot.x, dot.y) == (x, y) {
            return Ok(true);
        }
        if self.state().paused {
            return Ok(false);
        }
        self.inner.lock().unwrap().travel.start(Instant::now());
        self.emit();
        self.programmatic_position(x, y);
        let moved = dispatch(
            crate::platform::DOT_TITLE,
            &dot.address,
            "move",
            &format!("x={x},y={y},relative=false"),
        )
        .and_then(|_| verify(crate::platform::DOT_TITLE, &dot.address, x, y, SIZE, None));
        if moved.is_err() {
            self.cancel_travel();
        }
        moved?;
        Ok(true)
    }
    fn context(&self, request: ContextRequest) -> Result<State, String> {
        request.validate()?;
        let _serial = self.operations.lock().unwrap();
        {
            let mut i = self.inner.lock().unwrap();
            if request.kind == Kind::Rest {
                if i.context
                    .cue
                    .as_ref()
                    .is_some_and(|c| request.id.as_ref().map_or(
                        c.expires_at <= crate::desktop_context::now_ms(),
                        |id| *id == c.id,
                    ))
                {
                    i.context.cue = None;
                }
                drop(i);
                self.sync_bubble()?;
                self.emit();
                return Ok(self.state());
            }
            if !i.prefs.enabled {
                drop(i);
                return Ok(self.state());
            }
            if request
                .id
                .as_ref()
                .is_some_and(|id| i.dismissed_cues.contains(id))
            {
                drop(i);
                return Ok(self.state());
            }
            if !i.context.accepts(request.kind, crate::desktop_context::now_ms()) {
                drop(i);
                return Ok(self.state());
            }
            let mut cue = request.cue();
            // Placement is recomputed even for repeated cue IDs: focus/geometry can change.
            cue.placement = None;
            i.context.cue = Some(cue);
        }
        if matches!(
            request.kind,
            Kind::Question
                | Kind::Attention
                | Kind::Error
                | Kind::Done
                | Kind::Capture
                | Kind::Notification
        ) {
            let show = {
                let i = self.inner.lock().unwrap();
                !i.manual_hidden && !i.zone_unavailable && !i.visible && !self.control.active()
            };
            if show {
                self.paint(true)?;
            }
        }
        // Supplied verified editor geometry always wins. Failure to fit is not permission
        // to move somewhere else. Only target-less typing cues use window metadata.
        let fallback = request.target.is_none()
            && matches!(request.kind, Kind::Typing | Kind::InputReady);
        let target = request
            .target
            .clone()
            .or_else(|| fallback.then(focused_terminal_target).flatten());
        if let Some(target) = target.as_ref() {
            let placed = self.contextual_move(target, request.placement, fallback)?;
            if placed {
                if let Some(cue) = self.inner.lock().unwrap().context.cue.as_mut() {
                    cue.placement = if fallback {
                        Some(Placement::Aside)
                    } else {
                        request.placement
                    };
                }
            }
        }
        self.sync_bubble()?;
        self.emit();
        Ok(self.state())
    }
    fn dismiss_context(&self, id: Option<&str>) -> Result<(), String> {
        let mut i = self.inner.lock().unwrap();
        if let Some(cue) = i
            .context
            .cue
            .as_ref()
            .filter(|c| id.is_none_or(|id| c.id == id))
        {
            let id = cue.id.clone();
            i.dismissed_cues.push_back(id);
            while i.dismissed_cues.len() > 32 {
                i.dismissed_cues.pop_front();
            }
        }
        i.context.dismiss(id);
        if i.pending_offer
            .as_ref()
            .is_some_and(|p| id.is_none_or(|id| p.id == id))
        {
            i.pending_offer = None;
            self.context_ready.notify_all();
        }
        drop(i);
        self.sync_bubble()?;
        self.emit();
        Ok(())
    }
    fn state(&self) -> State {
        let i = self.inner.lock().unwrap();
        let paused = self.interaction.load(Ordering::SeqCst)
            || self.control.active()
            || i.reason.is_some()
            || i.zone_unavailable
            || self.settle_position.load(Ordering::SeqCst);
        State {
            context:i.context.clone(),
            enabled: i.prefs.enabled,
            motion: i.prefs.motion,
            appearances: i.prefs.appearances,
            pinned: i.prefs.pinned,
            areas: i.prefs.areas.clone(),
            monitors: i.monitors.clone(),
            visible: i.prefs.enabled && i.visible,
            paused,
            travelling: i.travel.visible(Instant::now(), &i.prefs, i.visible, paused),
            available: self.available,
            reason: i.reason.clone().or_else(|| i.zone_unavailable.then(|| "No hay una zona permitida disponible. Habilita una pantalla o amplía la zona de Capri.".into())).or_else(|| {
                (!self.available).then(|| {
                    "Capri en el escritorio requiere Linux con Hyprland y configuración Lua".into()
                })
            }),
        }
    }
    fn emit(&self) {
        let state = self.state();
        crate::shell::update_companion_menu(&self.app, state.enabled, state.available);
        let _ = self.app.emit(EVENT, state);
    }
    fn cancel_travel(&self) {
        let changed = self.inner.lock().unwrap().travel.cancel();
        if changed {
            self.emit();
        }
    }
    fn main<T: Send + 'static>(
        &self,
        f: impl FnOnce(AppHandle) -> Result<T, String> + Send + 'static,
    ) -> Result<T, String> {
        let (tx, rx) = mpsc::sync_channel(1);
        let app = self.app.clone();
        self.app
            .run_on_main_thread(move || {
                let _ = tx.send(f(app));
            })
            .map_err(|e| e.to_string())?;
        rx.recv_timeout(Duration::from_secs(5))
            .map_err(|_| "El escritorio no respondió a tiempo".to_string())?
    }
    fn paint(&self, visible: bool) -> Result<(), String> {
        if !visible {
            self.cancel_travel();
        }
        self.main(move |app| {
            if controlled(&app) {
                return Err("Capri está pausada durante el control del equipo".into());
            }
            #[cfg(target_os = "linux")]
            {
                paint_pair(&app, visible)?;
            }
            Ok(())
        })?;
        let mut i = self.inner.lock().unwrap();
        i.visible = visible;
        i.last_appearance = Instant::now();
        drop(i);
        self.sync_bubble()?;
        Ok(())
    }
    fn refresh_monitors(&self) -> Result<bool, String> {
        let next = monitors(&query("monitors")?);
        let mut i = self.inner.lock().unwrap();
        let changed = i.monitors != next;
        if changed {
            self.topology_dirty.store(true, Ordering::SeqCst);
        }
        i.monitors = next;
        i.last_topology = Instant::now();
        Ok(changed)
    }
    fn programmatic_position(&self, x: i32, y: i32) {
        self.inner
            .lock()
            .unwrap()
            .position_settle
            .programmatic(x, y, Instant::now());
        self.settle_position.store(false, Ordering::SeqCst);
    }
    fn apply_bounds(&self, prefs: &Preferences, restore_pin: bool) -> Result<bool, String> {
        let dot = resolve(crate::platform::DOT_TITLE)?;
        let monitors = self.inner.lock().unwrap().monitors.clone();
        let target = destination(prefs, &monitors, &dot, restore_pin);
        self.inner.lock().unwrap().zone_unavailable = target.is_none();
        let Some((_, _, x, y)) = target else {
            self.paint(false)?;
            return Ok(false);
        };
        if (dot.x, dot.y) != (x, y) {
            self.cancel_travel();
            self.programmatic_position(x, y);
            dispatch(
                crate::platform::DOT_TITLE,
                &dot.address,
                "move",
                &format!("x={x},y={y},relative=false"),
            )?;
            verify(crate::platform::DOT_TITLE, &dot.address, x, y, SIZE, None)?;
        }
        Ok(true)
    }
    fn save_pinned_position(&self) -> Result<(), String> {
        let mut prefs = self.inner.lock().unwrap().prefs.clone();
        if !prefs.enabled || !prefs.pinned {
            return Ok(());
        }
        let dot = resolve(crate::platform::DOT_TITLE)?;
        let monitors = self.inner.lock().unwrap().monitors.clone();
        if let Some((name, _, x, y)) = destination(&prefs, &monitors, &dot, false) {
            let pin = pin_position(&monitors, &name, x, y);
            if pin != prefs.pin_position {
                prefs.pin_position = pin;
                crate::config::write_private(
                    &self.path,
                    &serde_json::to_string_pretty(&prefs).unwrap(),
                )
                .map_err(|e| e.to_string())?;
                self.inner.lock().unwrap().prefs = prefs;
            }
        }
        Ok(())
    }
    fn enable(&self, prefs: &Preferences) -> Result<(), String> {
        if !self.available || query("status")?["configProvider"].as_str() != Some("lua") {
            return Err("Capri en el escritorio requiere Hyprland con configuración Lua".into());
        }
        let original = resolve(crate::platform::DOT_TITLE).ok();
        let dot_rule = if original.is_none() {
            Some(MappingRule::install("dot", &self.map_nonce)?)
        } else {
            None
        };
        let launcher_rule = if resolve(LAUNCHER_TITLE).is_err() {
            Some(MappingRule::install("launcher", &self.map_nonce)?)
        } else {
            None
        };
        let dot_title = dot_rule
            .as_ref()
            .map(|r| r.title.clone())
            .unwrap_or_else(|| crate::platform::DOT_TITLE.into());
        let launcher_title = launcher_rule
            .as_ref()
            .map(|r| r.title.clone())
            .unwrap_or_else(|| LAUNCHER_TITLE.into());
        let (dt, lt) = (dot_title.clone(), launcher_title.clone());
        self.main(move |app| {
            if controlled(&app) {
                return Err("El control del equipo está activo".into());
            }
            app.get_webview_window("dot")
                .ok_or("Falta Dot")?
                .set_title(&dt)
                .map_err(|e| e.to_string())?;
            app.get_webview_window(LAUNCHER)
                .ok_or("Falta el acceso a Capri")?
                .set_title(&lt)
                .map_err(|e| e.to_string())?;
            configure_window(&app, "dot", SIZE, true)?;
            configure_window(&app, LAUNCHER, LAUNCHER_SIZE, true)?;
            #[cfg(target_os = "linux")]
            {
                paint_window(&app, "dot", false, SIZE)?;
                paint_window(&app, LAUNCHER, false, LAUNCHER_SIZE)?;
            }
            Ok(())
        })?;
        // Window mapping is asynchronous. This worker never waits on GTK's thread.
        let mut pair = None;
        for _ in 0..20 {
            if let (Ok(dot), Ok(launcher)) = (resolve(&dot_title), resolve(&launcher_title)) {
                pair = Some((dot, launcher));
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let (dot, launcher) =
            pair.ok_or("No se pudieron identificar las ventanas propias de Capri")?;
        self.main(|app| {
            app.get_webview_window("dot")
                .ok_or("Falta Dot")?
                .set_title(crate::platform::DOT_TITLE)
                .map_err(|e| e.to_string())?;
            app.get_webview_window(LAUNCHER)
                .ok_or("Falta el acceso a Capri")?
                .set_title(LAUNCHER_TITLE)
                .map_err(|e| e.to_string())?;
            Ok(())
        })?;
        let mut renamed = false;
        for _ in 0..20 {
            if resolve(crate::platform::DOT_TITLE).is_ok_and(|c| c.address == dot.address)
                && resolve(LAUNCHER_TITLE).is_ok_and(|c| c.address == launcher.address)
            {
                renamed = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        if !renamed {
            return Err("No se confirmaron los nombres de las ventanas propias".into());
        }
        // Install before retiring the bootstrap rule; keep only the traveler silhouette styled.
        {
            let mut silhouette = self.silhouette.lock().unwrap();
            if silhouette
                .as_ref()
                .is_some_and(|style| style.address != dot.address)
            {
                silhouette.take();
            }
            if silhouette.is_none() {
                *silhouette = Some(SilhouetteRule::install(
                    crate::platform::DOT_TITLE,
                    &dot.address,
                    &self.map_nonce,
                )?);
            }
        }
        {
            let mut style = self.launcher_style.lock().unwrap();
            if style
                .as_ref()
                .is_some_and(|s| s.address != launcher.address)
            {
                style.take();
            }
            if style.is_none() {
                *style = Some(SilhouetteRule::install(
                    LAUNCHER_TITLE,
                    &launcher.address,
                    &format!("{}c", self.map_nonce),
                )?);
            }
        }
        drop(dot_rule);
        drop(launcher_rule);
        // Baseline is captured before any compositor move. GTK may already report the new size;
        // the saved flower position and pin preference remain its original native values.
        self.inner
            .lock()
            .unwrap()
            .baseline
            .get_or_insert_with(|| original.unwrap_or_else(|| dot.clone()));
        let a = area(&query("monitors")?, dot.monitor)?;
        let (x, y) = a.clamp(dot.x, dot.y, SIZE);
        self.programmatic_position(x, y);
        place(crate::platform::DOT_TITLE, &dot.address, x, y, SIZE, true)?;
        let (lx, ly) = a.clamp(
            a.x + a.width - LAUNCHER_SIZE - 16,
            a.y + a.height - LAUNCHER_SIZE - 16,
            LAUNCHER_SIZE,
        );
        place(
            LAUNCHER_TITLE,
            &launcher.address,
            lx,
            ly,
            LAUNCHER_SIZE,
            true,
        )?;
        self.ensure_bubble()?;
        self.refresh_monitors()?;
        let allowed = self.apply_bounds(prefs, true)?;
        self.inner.lock().unwrap().manual_hidden = false;
        self.paint(allowed)
    }
    fn disable(&self) -> Result<(), String> {
        if let Some(mut style) = self.launcher_style.lock().unwrap().take() {
            style.remove()?;
        }
        self.dismiss_context(None)?;
        if let Some(mut style) = self.bubble_style.lock().unwrap().take() {
            style.remove()?;
        }
        self.main(|app| {
            if let Some(w) = app.get_webview_window(BUBBLE) {
                w.hide().map_err(|e| e.to_string())?;
            }
            Ok(())
        })?;
        if let Some(mut silhouette) = self.silhouette.lock().unwrap().take() {
            silhouette.remove()?;
        }
        let baseline = self.inner.lock().unwrap().baseline.clone();
        let mapped = self.main(|app| {
            if let Some(w) = app.get_webview_window(LAUNCHER) {
                w.hide().map_err(|e| e.to_string())?;
                w.set_title(LAUNCHER_TITLE).map_err(|e| e.to_string())?;
            }
            let dot = app.get_webview_window("dot").ok_or("Falta Dot")?;
            dot.set_title(crate::platform::DOT_TITLE)
                .map_err(|e| e.to_string())?;
            let mapped = dot.is_visible().map_err(|e| e.to_string())?;
            configure_window(&app, "dot", 72, mapped)?;
            Ok(mapped)
        })?;
        if let Some(b) = baseline.filter(|_| mapped) {
            for _ in 0..20 {
                if resolve(crate::platform::DOT_TITLE).is_ok() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            let current = resolve(crate::platform::DOT_TITLE)?;
            let topology = query("monitors")?;
            let a = area(&topology, b.monitor).or_else(|_| area(&topology, current.monitor))?;
            let (x, y) = a.clamp(b.x, b.y, 72);
            self.programmatic_position(x, y);
            place(
                crate::platform::DOT_TITLE,
                &current.address,
                x,
                y,
                72,
                b.pinned,
            )?;
        }
        self.main(|app| {
            if crate::shell::rose_hidden_state(&app) {
                app.get_webview_window("dot")
                    .ok_or("Falta la ventana Dot")?
                    .hide()
                    .map_err(|e| e.to_string())?;
            }
            Ok(())
        })
    }
    fn set(&self, patch: Patch) -> Result<State, String> {
        let _serial = self.operations.lock().unwrap();
        if self.control.active() {
            return Err("Espera a que termine el control del equipo para cambiar Capri".into());
        }
        let previous = self.inner.lock().unwrap().prefs.clone();
        let mut next = previous.patched(patch)?;
        self.cancel_travel();
        if self.available {
            self.refresh_monitors()?;
        }
        if (next.enabled && next.pinned && (!previous.pinned || previous.areas != next.areas))
            || (previous.enabled && previous.pinned && !next.enabled)
        {
            if let Ok(dot) = resolve(crate::platform::DOT_TITLE) {
                let monitors = self.inner.lock().unwrap().monitors.clone();
                if let Some((name, _, x, y)) = destination(&next, &monitors, &dot, false) {
                    next.pin_position = pin_position(&monitors, &name, x, y);
                }
            }
        }
        if next.enabled != previous.enabled {
            let change = if next.enabled {
                self.enable(&next)
            } else {
                self.disable()
            };
            if let Err(e) = change {
                let rollback = if previous.enabled {
                    self.enable(&previous)
                } else {
                    self.disable()
                };
                if let Err(rollback_error) = rollback {
                    eprintln!("gentle-dot: companion rollback: {rollback_error}");
                }
                self.inner.lock().unwrap().reason = Some(e.clone());
                self.emit();
                return Err(e);
            }
        } else if next.enabled {
            let was_unavailable = self.inner.lock().unwrap().zone_unavailable;
            let allowed = self.apply_bounds(&next, next.pinned)?;
            let manual_hidden = self.inner.lock().unwrap().manual_hidden;
            if next.pinned || !next.appearances || allowed && was_unavailable {
                self.paint(allowed && !manual_hidden)?;
            }
        }
        if let Err(e) =
            crate::config::write_private(&self.path, &serde_json::to_string_pretty(&next).unwrap())
        {
            if next.enabled != previous.enabled {
                let _ = if previous.enabled {
                    self.enable(&previous)
                } else {
                    self.disable()
                };
            }
            return Err(format!(
                "No se pudo guardar la preferencia de escritorio: {e}"
            ));
        }
        {
            let mut i = self.inner.lock().unwrap();
            i.prefs = next.clone();
            if next.enabled != previous.enabled {
                if !next.enabled {
                    i.visible = false;
                    i.manual_hidden = false;
                    i.zone_unavailable = false;
                }
            }
            if !next.enabled {
                i.baseline = None;
            }
            i.reason = None;
            i.last_appearance = Instant::now();
        }
        if next.enabled && next.pinned && next.pin_position.is_none() {
            self.save_pinned_position()?;
        }
        if !next.enabled {
            self.interaction.store(false, Ordering::SeqCst);
        }
        self.sync_bubble()?;
        self.emit();
        Ok(self.state())
    }
    fn move_by(&self, dx: i32, dy: i32) -> Result<(), String> {
        self.cancel_travel();
        if !self.state().enabled || self.control.active() {
            return Err("Capri no está disponible para moverse ahora".into());
        }
        let dot = resolve(crate::platform::DOT_TITLE)?;
        self.refresh_monitors()?;
        let (prefs, monitors) = {
            let i = self.inner.lock().unwrap();
            (i.prefs.clone(), i.monitors.clone())
        };
        let Some((_, a, base_x, base_y)) = destination(&prefs, &monitors, &dot, false) else {
            self.inner.lock().unwrap().zone_unavailable = true;
            self.paint(false)?;
            return Err("No hay una zona permitida disponible para Capri".into());
        };
        let (x, y) = a.clamp(base_x.saturating_add(dx), base_y.saturating_add(dy), SIZE);
        if (x, y) == (dot.x, dot.y) {
            return Ok(());
        }
        if self.control.active() {
            return Ok(());
        }
        self.programmatic_position(x, y);
        let moved = dispatch(
            crate::platform::DOT_TITLE,
            &dot.address,
            "move",
            &format!("x={x},y={y},relative=false"),
        )
        .and_then(|_| verify(crate::platform::DOT_TITLE, &dot.address, x, y, SIZE, None));
        if moved.is_err() {
            self.cancel_travel();
        }
        moved?;
        self.sync_bubble()?;
        self.save_pinned_position()?;
        self.emit();
        Ok(())
    }
    fn recall(&self) -> Result<State, String> {
        let _serial = self.operations.lock().unwrap();
        self.cancel_travel();
        if !self.state().enabled {
            return Err("Activa Capri en el escritorio primero".into());
        }
        if self.control.active() {
            return Err("Espera a que termine el control del equipo".into());
        }
        self.refresh_monitors()?;
        let prefs = self.inner.lock().unwrap().prefs.clone();
        if !self.apply_bounds(&prefs, prefs.pinned)? {
            self.emit();
            return Err("Habilita una zona de pantalla para traer a Capri".into());
        }
        self.inner.lock().unwrap().manual_hidden = false;
        self.paint(true)?;
        self.inner.lock().unwrap().reason = None;
        self.emit();
        Ok(self.state())
    }
    fn hide(&self) -> Result<State, String> {
        let _serial = self.operations.lock().unwrap();
        if !self.state().enabled || self.control.active() {
            return Err("Capri no está disponible ahora".into());
        }
        self.inner.lock().unwrap().manual_hidden = true;
        self.paint(false)?;
        self.emit();
        Ok(self.state())
    }
    fn tick(&self) -> Result<bool, String> {
        let _serial = self.operations.lock().unwrap();
        let expired = self.inner.lock().unwrap().context.expire();
        if expired {
            self.sync_bubble()?;
        }
        let finished = self.inner.lock().unwrap().travel.finish(Instant::now()) || expired;
        let topology_due =
            self.inner.lock().unwrap().last_topology.elapsed() >= Duration::from_secs(5);
        let mut changed = false;
        if topology_due && self.available && self.state().enabled && !self.control.active() {
            self.refresh_monitors()?;
        }
        if !self.control.active() {
            changed = self.topology_dirty.swap(false, Ordering::SeqCst);
        }
        let topology_changed = changed;
        if self.state().enabled
            && !self.control.active()
            && (topology_due || self.settle_position.load(Ordering::SeqCst))
        {
            let dot = resolve(crate::platform::DOT_TITLE)?;
            if self
                .inner
                .lock()
                .unwrap()
                .position_settle
                .observe(dot.x, dot.y, Instant::now())
            {
                self.settle_position.store(true, Ordering::SeqCst);
                changed = true;
            }
        }
        let settle = self.settle_position.load(Ordering::SeqCst)
            && self
                .inner
                .lock()
                .unwrap()
                .position_settle
                .ready(Instant::now());
        if self.state().enabled && !self.control.active() && (topology_changed || settle) {
            self.settle_position.store(false, Ordering::SeqCst);
            let (prefs, was_unavailable, hidden) = {
                let i = self.inner.lock().unwrap();
                (i.prefs.clone(), i.zone_unavailable, i.manual_hidden)
            };
            let allowed = self.apply_bounds(&prefs, topology_changed && prefs.pinned)?;
            if was_unavailable && allowed {
                self.paint(!hidden)?;
            }
            if settle && !topology_changed {
                self.save_pinned_position()?;
            }
            self.sync_bubble()?;
            changed = true;
        }
        let s = self.state();
        if !s.enabled || s.paused {
            let cancelled = self.inner.lock().unwrap().travel.cancel();
            return Ok(finished || cancelled || changed);
        }
        let (appearance, _) = {
            let i = self.inner.lock().unwrap();
            automatic_actions(
                &i.prefs,
                s.visible,
                i.manual_hidden,
                i.last_appearance.elapsed(),
            )
        };
        let contextual = {
            let i = self.inner.lock().unwrap();
            i.context.bubble().is_some()
                || i.context
                    .cue
                    .as_ref()
                    .is_some_and(|cue| cue.placement.is_some())
        };
        if appearance && !contextual {
            self.paint(!s.visible)?;
            return Ok(true);
        }
        Ok(finished || changed)
    }
}

pub fn init(app: &AppHandle, data: &std::path::Path) {
    let path = data.join("desktop-companion.json");
    let mut prefs = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str::<Preferences>(&s).ok())
        .unwrap_or_default();
    if prefs.validate().is_err() {
        prefs = Preferences::default();
    }
    let map_nonce = nonce().unwrap_or_default();
    let available = !map_nonce.is_empty()
        && cfg!(target_os = "linux")
        && std::env::var_os("HYPRLAND_INSTANCE_SIGNATURE").is_some()
        && std::env::var_os("WAYLAND_DISPLAY").is_some();
    app.manage(Arc::new(Controller {
        app: app.clone(),
        path,
        inner: Mutex::new(Runtime {
            context: Context::default(),
            pending_offer: None,
            dismissed_cues: Default::default(),
            cancelled_notifications: Default::default(),
            bubble_position: None,
            prefs: Preferences {
                enabled: false,
                ..prefs.clone()
            },
            visible: false,
            reason: None,
            baseline: None,
            last_appearance: Instant::now(),
            travel: TravelPulse::default(),
            monitors: Vec::new(),
            last_topology: Instant::now() - Duration::from_secs(5),
            manual_hidden: false,
            zone_unavailable: false,
            position_settle: PositionSettle::new(Instant::now()),
        }),
        operations: Mutex::new(()),
        interaction: AtomicBool::new(false),
        control: ControlPause::default(),
        stop: AtomicBool::new(false),
        settle_position: AtomicBool::new(false),
        topology_dirty: AtomicBool::new(false),
        context_menu: Mutex::new(None),
        available,
        map_nonce,
        silhouette: Mutex::new(None),
        bubble_style: Mutex::new(None),
        launcher_style: Mutex::new(None),
        context_ready: Condvar::new(),
    }));
    app.manage(StartEnabled(prefs.enabled));
}
struct StartEnabled(bool);
pub fn starts_enabled(app: &AppHandle) -> bool {
    app.try_state::<StartEnabled>().is_some_and(|s| s.0)
}
pub fn start(app: &AppHandle) {
    crate::desktop_context::start(app);
    for label in ["dot", LAUNCHER] {
        if let Some(window) = app.get_webview_window(label) {
            window.on_menu_event(|window, event| {
                handle_context_action(window.app_handle(), event.id().as_ref())
            });
        }
    }
    let c = app.state::<Arc<Controller>>().inner().clone();
    let enabled = app.state::<StartEnabled>().0;
    std::thread::spawn(move || {
        c.emit();
        if enabled {
            if let Err(e) = c.set(Patch {
                enabled: Some(true),
                ..Patch::default()
            }) {
                eprintln!("gentle-dot desktop companion: {e}");
            }
        }
        while !c.stop.load(Ordering::SeqCst) {
            let delay = c.inner.lock().unwrap().travel.next_wake(Instant::now());
            std::thread::sleep(delay);
            if c.stop.load(Ordering::SeqCst) {
                break;
            }
            match c.tick() {
                Ok(true) => c.emit(),
                Ok(false) => {}
                Err(e) => {
                    let mut i = c.inner.lock().unwrap();
                    i.travel.cancel();
                    i.reason = Some(e);
                    drop(i);
                    c.emit();
                }
            }
        }
    });
}
pub fn stop(app: &AppHandle) {
    if let Some(c) = app.try_state::<Arc<Controller>>() {
        c.stop.store(true, Ordering::SeqCst);
        c.context_ready.notify_all();
        if let Some(mut style) = c.launcher_style.lock().unwrap().take() {
            let _ = style.remove();
        }
        if let Some(mut style) = c.bubble_style.lock().unwrap().take() {
            let _ = style.remove();
        }
        if let Err(e) = c.save_pinned_position() {
            eprintln!("gentle-dot: cannot preserve pinned position: {e}");
        }
        c.inner.lock().unwrap().travel.cancel();
        if let Some(mut silhouette) = c.silhouette.lock().unwrap().take() {
            if let Err(error) = silhouette.remove() {
                eprintln!("gentle-dot: silhouette shutdown cleanup: {error}");
            }
        }
    }
}
pub fn enabled(app: &AppHandle) -> bool {
    app.try_state::<Arc<Controller>>()
        .is_some_and(|c| c.inner.lock().unwrap().prefs.enabled)
}
pub(crate) fn context_stopped(app: &AppHandle) -> bool {
    app.try_state::<Arc<Controller>>()
        .is_none_or(|c| c.stop.load(Ordering::SeqCst))
}
pub(crate) fn context_music(app: &AppHandle, playing: bool, available: bool) {
    if let Some(c) = app.try_state::<Arc<Controller>>() {
        let mut i = c.inner.lock().unwrap();
        let changed = i.context.music_playing != playing || i.context.music_available != available;
        i.context.music_playing = playing;
        i.context.music_available = available;
        drop(i);
        if changed {
            c.emit();
        }
    }
}
pub(crate) fn context_notifications(app: &AppHandle, available: bool, service: Option<String>) {
    if let Some(c) = app.try_state::<Arc<Controller>>() {
        let mut i = c.inner.lock().unwrap();
        i.context.notifications_available = available;
        i.context.notification_service = service;
        drop(i);
        c.emit();
    }
}
pub(crate) fn cancel_notification(app: &AppHandle, id: &str) {
    if id.is_empty() || id.len() > 160 || id.chars().any(char::is_control) {
        return;
    }
    if let Some(c) = app.try_state::<Arc<Controller>>() {
        let mut i = c.inner.lock().unwrap();
        i.cancelled_notifications
            .push_back((id.into(), Instant::now()));
        while i.cancelled_notifications.len() > 64 {
            i.cancelled_notifications.pop_front();
        }
        let changed = i.context.notification.as_ref().is_some_and(|n| n.id == id);
        if changed {
            i.context.notification = None;
        }
        if i.pending_offer.as_ref().is_some_and(|p| p.id == id) {
            i.pending_offer = None;
            c.context_ready.notify_all();
        }
        drop(i);
        if changed {
            c.emit();
            let worker = c.inner().clone();
            std::thread::spawn(move || {
                let _serial = worker.operations.lock().unwrap();
                let _ = worker.sync_bubble();
            });
        }
    }
}
pub(crate) fn offer_notification(
    app: &AppHandle,
    id: String,
    summary: String,
    body: String,
    deadline: Instant,
) -> bool {
    offer_notification_with_source(app, id, summary, body, None, deadline)
}
pub(crate) fn offer_notification_with_source(
    app: &AppHandle,
    id: String,
    summary: String,
    body: String,
    source: Option<NotificationSource>,
    deadline: Instant,
) -> bool {
    if Instant::now() >= deadline {
        return false;
    }
    let kind = source.as_ref().map_or(Kind::Notification, |source| {
        source.notification_kind(&summary, &body)
    });
    let visual = kind.visual_only();
    let request = ContextRequest {
        kind,
        id: Some(id.clone()),
        summary: Some(summary),
        body: Some(body),
        session_id: None,
        pane_id: None,
        target: None,
        source,
        placement: None,
    };
    if request.validate().is_err() {
        return false;
    }
    let Some(c) = app.try_state::<Arc<Controller>>() else {
        return false;
    };
    {
        // Do not block an offer behind movement/control; Quickshell can show its normal popup.
        let Ok(_serial) = c.operations.try_lock() else {
            return false;
        };
        let mut i = c.inner.lock().unwrap();
        i.context.expire();
        i.cancelled_notifications
            .retain(|(_, at)| at.elapsed() < Duration::from_secs(2));
        if i.cancelled_notifications
            .iter()
            .any(|(cancelled, _)| *cancelled == id)
        {
            return false;
        }
        if !i.prefs.enabled
            || !c.available
            || c.control.active()
            || i.manual_hidden
            || i.zone_unavailable
            || i.context.notification.is_some()
            || !i.context.accepts(kind, crate::desktop_context::now_ms())
            || i.pending_offer.is_some()
        {
            return false;
        }
        i.pending_offer = Some(PendingOffer {
            id: id.clone(),
            deadline,
            ready: false,
        });
        i.context.notification = Some(request.cue());
        drop(i);
        let prepared = if Instant::now() < deadline {
            c.paint(true)
        } else {
            Err("Oferta vencida".into())
        };
        if prepared.is_err()
            || Instant::now() >= deadline
            || (!visual && c.inner.lock().unwrap().bubble_position.is_none())
        {
            let _ = c.dismiss_context(Some(&id));
            return false;
        }
        c.emit();
    }
    let mut i = c.inner.lock().unwrap();
    while Instant::now() < deadline
        && !c.stop.load(Ordering::SeqCst)
        && i.pending_offer
            .as_ref()
            .is_some_and(|p| p.id == id && !p.ready)
    {
        let remaining = deadline.saturating_duration_since(Instant::now());
        i = c.context_ready.wait_timeout(i, remaining).unwrap().0;
    }
    let accepted = Instant::now() < deadline
        && !c.control.active()
        && i.pending_offer
            .as_ref()
            .is_some_and(|p| p.id == id && p.ready)
        && i.context.notification.as_ref().is_some_and(|n| n.id == id)
        && i.prefs.enabled
        && i.visible
        && !i.manual_hidden
        && !i.zone_unavailable
        && (visual || i.bubble_position.is_some());
    i.pending_offer = None;
    drop(i);
    if !accepted {
        let _serial = c.operations.lock().unwrap();
        let _ = c.dismiss_context(Some(&id));
    }
    accepted
}
/// Native move events only postpone the next automatic action. No IPC or event emission per frame.
pub fn movement_observed(app: &AppHandle) {
    if let Some(c) = app.try_state::<Arc<Controller>>() {
        let mut i = c.inner.lock().unwrap();
        if i.prefs.enabled {
            if i.position_settle.movement(Instant::now()) {
                c.settle_position.store(true, Ordering::SeqCst);
            }
        }
    }
}
fn controlled(app: &AppHandle) -> bool {
    app.try_state::<Arc<Controller>>()
        .is_some_and(|c| c.control.active())
}
/// Worker preparation; serializes against any in-flight native movement before capture starts.
pub fn prepare_control(app: &AppHandle, operation: u64) -> Result<(), String> {
    if let Some(c) = app.try_state::<Arc<Controller>>() {
        let _serial = c.operations.lock().unwrap();
        c.control.begin(operation);
        {
            let mut i = c.inner.lock().unwrap();
            i.travel.cancel();
            if i.pending_offer.take().is_some() {
                i.context.notification = None;
                c.context_ready.notify_all();
            }
        }
        #[cfg(target_os = "linux")]
        {
            if c.inner.lock().unwrap().prefs.enabled {
                let identity = resolve(BUBBLE_TITLE)
                    .ok()
                    .map(|b| format!("hyprland:{}", b.address));
                if let Err(error) = c.main(|app| paint_bubble(&app, false)) {
                    c.control.end(operation);
                    return Err(error);
                }
                crate::computer::LinuxDesktop::set_hidden_companion_bubble(identity);
            }
        }
        c.emit();
    }
    Ok(())
}
/// Main-thread restoration. Never acquire operations (a worker could be waiting for GTK).
pub fn restore_control(app: &AppHandle, operation: u64) {
    if let Some(c) = app.try_state::<Arc<Controller>>() {
        if !c.control.end(operation) {
            return;
        }
        #[cfg(target_os = "linux")]
        crate::computer::LinuxDesktop::set_hidden_companion_bubble(None);
        let worker = c.inner().clone();
        std::thread::spawn(move || {
            let _serial = worker.operations.lock().unwrap();
            let _ = worker.sync_bubble();
        });
        c.inner.lock().unwrap().last_appearance = Instant::now();
        c.emit();
    }
}
#[cfg(target_os = "linux")]
pub(crate) fn circle(native: &gtk::Window, size: i32) {
    use gtk::prelude::*;
    native.input_shape_combine_region(Some(&circle_region(size)));
}
#[cfg(target_os = "linux")]
fn circle_region(size: i32) -> gtk::cairo::Region {
    let region = gtk::cairo::Region::create();
    let r = size as f64 / 2.;
    for y in 0..size {
        let dy = y as f64 + 0.5 - r;
        let half = (r * r - dy * dy).max(0.).sqrt();
        let x = (r - half).ceil() as i32;
        let width = size - x * 2;
        if width > 0 {
            let _ = region.union_rectangle(&gtk::cairo::RectangleInt::new(x, y, width, 1));
        }
    }
    region
}
#[cfg(target_os = "linux")]
fn paint_window(app: &AppHandle, label: &str, visible: bool, size: i32) -> Result<(), String> {
    use gtk::prelude::*;
    let native: gtk::Window = app
        .get_webview_window(label)
        .ok_or("Falta la ventana de Capri")?
        .gtk_window()
        .map_err(|e| e.to_string())?
        .into();
    let content = native.child().ok_or("Falta el contenido de Capri")?;
    if visible {
        circle(&native, size);
    } else {
        native.input_shape_combine_region(Some(&gtk::cairo::Region::create()));
    }
    content.set_opacity(if visible { 1. } else { 0. });
    native.queue_draw();
    native.display().flush();
    Ok(())
}
#[cfg(target_os = "linux")]
fn bubble_region(visible: bool, size: (i32, i32)) -> gtk::cairo::Region {
    let (width, height) = size;
    let region = gtk::cairo::Region::create();
    if visible {
        // Rounded content only; transparent corner pixels and hidden windows never eat clicks.
        for y in 0..height {
            let edge = BUBBLE_RADIUS.min(y).min(height - 1 - y);
            let radius = BUBBLE_RADIUS as f64;
            let inset = if edge < BUBBLE_RADIUS {
                (radius
                    - (radius.powi(2) - ((BUBBLE_RADIUS - edge) as f64).powi(2))
                        .max(0.)
                        .sqrt())
                .ceil() as i32
            } else {
                0
            };
            let _ = region.union_rectangle(&gtk::cairo::RectangleInt::new(
                inset,
                y,
                width - inset * 2,
                1,
            ));
        }
    }
    region
}
#[cfg(target_os = "linux")]
fn paint_bubble(app: &AppHandle, visible: bool) -> Result<(), String> {
    use gtk::prelude::*;
    let native: gtk::Window = app
        .get_webview_window(BUBBLE)
        .ok_or("Falta el globo de Capri")?
        .gtk_window()
        .map_err(|e| e.to_string())?
        .into();
    let region = bubble_region(
        visible,
        (native.allocated_width(), native.allocated_height()),
    );
    native.input_shape_combine_region(Some(&region));
    native
        .child()
        .ok_or("Falta el contenido del globo")?
        .set_opacity(if visible { 1. } else { 0. });
    native.queue_draw();
    native.display().flush();
    Ok(())
}
#[cfg(target_os = "linux")]
pub(crate) fn paint_pair(app: &AppHandle, visible: bool) -> Result<(), String> {
    paint_window(app, "dot", visible, SIZE)?;
    paint_window(app, LAUNCHER, !visible, LAUNCHER_SIZE)
}
pub(crate) fn restore_shape(app: &AppHandle) {
    #[cfg(target_os = "linux")]
    if enabled(app) {
        let visible = app.state::<Arc<Controller>>().inner.lock().unwrap().visible;
        let _ = paint_pair(app, visible);
    }
}
fn configure_window(app: &AppHandle, label: &str, size: i32, show: bool) -> Result<(), String> {
    let w = app
        .get_webview_window(label)
        .ok_or("Falta la ventana de Capri")?;
    w.set_min_size(Some(tauri::LogicalSize::new(size, size)))
        .map_err(|e| e.to_string())?;
    w.set_max_size(Some(tauri::LogicalSize::new(size, size)))
        .map_err(|e| e.to_string())?;
    w.set_size(tauri::LogicalSize::new(size, size))
        .map_err(|e| e.to_string())?;
    #[cfg(target_os = "linux")]
    {
        use gtk::prelude::*;
        let native: gtk::Window = w.gtk_window().map_err(|e| e.to_string())?.into();
        native.set_focus_on_map(false);
        // A click can focus the companion for keyboard controls. Passive appearance never does.
        native.set_accept_focus(true);
        if let Some(child) = native.child() {
            child.set_opacity(1.);
        }
        if size != 72 {
            circle(&native, size);
        } else {
            native.input_shape_combine_region(None);
        }
    }
    if show {
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        crate::computer::app::show_without_focus(&w)?;
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        w.show().map_err(|e| e.to_string())?;
    }
    Ok(())
}
#[tauri::command]
pub async fn desktop_companion_get(app: AppHandle) -> Result<State, String> {
    let c = app.state::<Arc<Controller>>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        if c.available {
            c.refresh_monitors()?;
        }
        Ok(c.state())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn desktop_companion_context(
    app: AppHandle,
    request: ContextRequest,
) -> Result<State, String> {
    let c = app.state::<Arc<Controller>>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || c.context(request))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn desktop_companion_context_dismiss(
    app: AppHandle,
    id: Option<String>,
) -> Result<State, String> {
    let c = app.state::<Arc<Controller>>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _serial = c.operations.lock().unwrap();
        c.dismiss_context(id.as_deref())?;
        Ok(c.state())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn desktop_companion_context_ready(
    app: AppHandle,
    window: tauri::WebviewWindow,
    id: String,
) -> State {
    let c = app.state::<Arc<Controller>>();
    let mut i = c.inner.lock().unwrap();
    let expected = i
        .context
        .notification
        .as_ref()
        .filter(|n| n.id == id)
        .map(|cue| cue.kind.ack_surface());
    if expected != Some(window.label())
        || !i.prefs.enabled
        || !i.visible
        || i.manual_hidden
        || i.zone_unavailable
        || c.control.active()
    {
        drop(i);
        return c.state();
    }
    if let Some(p) = i
        .pending_offer
        .as_mut()
        .filter(|p| p.id == id && Instant::now() < p.deadline)
    {
        p.ready = true;
        c.context_ready.notify_all();
    }
    drop(i);
    c.state()
}
#[tauri::command]
pub fn desktop_companion_context_open(app: AppHandle) -> Result<State, String> {
    let c = app.state::<Arc<Controller>>();
    let cue = c.inner.lock().unwrap().context.bubble().cloned();
    if let Some(cue) = cue {
        if c.control.active() {
            return Err("Espera a que termine el control del equipo".into());
        }
        let destination =
            if cue.kind == Kind::Question && cue.pane_id.is_some() && cue.session_id.is_some() {
                "dot"
            } else {
                crate::shell::show_panel(&app)?;
                "panel"
            };
        let _ = app.emit_to(
            destination,
            "dot://capri-open-context",
            serde_json::json!({"kind":cue.kind,"sessionId":cue.session_id,"paneId":cue.pane_id}),
        );
    }
    Ok(c.state())
}
#[tauri::command]
pub async fn desktop_companion_set(app: AppHandle, patch: Patch) -> Result<State, String> {
    let c = app.state::<Arc<Controller>>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || c.set(patch))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn desktop_companion_interaction(app: AppHandle, active: bool) -> State {
    let c = app.state::<Arc<Controller>>();
    c.interaction.store(active, Ordering::SeqCst);
    if !active {
        c.settle_position.store(true, Ordering::SeqCst);
    }
    {
        let mut i = c.inner.lock().unwrap();
        i.travel.cancel();
        i.last_appearance = Instant::now();
    }
    c.emit();
    c.state()
}
#[tauri::command]
pub async fn desktop_companion_recall(app: AppHandle) -> Result<State, String> {
    let c = app.state::<Arc<Controller>>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || c.recall())
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn desktop_companion_hide(app: AppHandle) -> Result<State, String> {
    let c = app.state::<Arc<Controller>>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || c.hide())
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn desktop_companion_menu(
    app: AppHandle,
    window: tauri::WebviewWindow,
) -> Result<State, String> {
    if !matches!(window.label(), "dot" | "companion-launcher") {
        return Err("Este menú pertenece a Capri".into());
    }
    let c = app.state::<Arc<Controller>>();
    let state = c.state();
    if !state.enabled || c.control.active() {
        return Err("Capri no está disponible ahora".into());
    }
    c.cancel_travel();
    c.inner.lock().unwrap().last_appearance = Instant::now();
    use tauri::menu::{Menu, MenuItem};
    let menu = Menu::new(&app).map_err(|e| e.to_string())?;
    for (id, text) in [
        (
            "capri-context-pin",
            if state.pinned {
                "Dejar pasear"
            } else {
                "Fijar aquí"
            },
        ),
        (
            "capri-context-visibility",
            if state.visible {
                "Ocultar Capri"
            } else {
                "Traer Capri"
            },
        ),
        ("capri-context-settings", "Configurar Capri"),
    ] {
        menu.append(
            &MenuItem::with_id(&app, id, text, true, None::<&str>).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
    }
    window.popup_menu(&menu).map_err(|e| e.to_string())?;
    *c.context_menu.lock().unwrap() = Some(menu);
    Ok(c.state())
}
fn handle_context_action(app: &AppHandle, id: &str) {
    if id == "capri-context-settings" {
        if crate::shell::show_panel(app).is_ok() {
            let _ = app.emit_to("panel", "dot://capri-settings", ());
        }
        return;
    }
    if !matches!(id, "capri-context-pin" | "capri-context-visibility") {
        return;
    }
    let c = app.state::<Arc<Controller>>().inner().clone();
    let pin = id == "capri-context-pin";
    std::thread::spawn(move || {
        let state = c.state();
        let result = if pin {
            c.set(Patch {
                pinned: Some(!state.pinned),
                motion: state.pinned.then_some(true),
                ..Patch::default()
            })
        } else if state.visible {
            c.hide()
        } else {
            c.recall()
        };
        if let Err(e) = result {
            crate::shell::companion_error(&c.app, &e);
        }
    });
}
#[tauri::command]
pub async fn desktop_companion_move(app: AppHandle, dx: i32, dy: i32) -> Result<State, String> {
    if dx.abs_diff(0) > 512 || dy.abs_diff(0) > 512 {
        return Err("El desplazamiento debe ser de hasta 512 puntos".into());
    }
    let c = app.state::<Arc<Controller>>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _serial = c.operations.lock().unwrap();
        c.move_by(dx, dy)?;
        Ok(c.state())
    })
    .await
    .map_err(|e| e.to_string())?
}
pub fn tray_toggle(app: &AppHandle) {
    let c = app.state::<Arc<Controller>>().inner().clone();
    std::thread::spawn(move || {
        if let Err(e) = c.set(Patch {
            enabled: Some(!c.state().enabled),
            ..Patch::default()
        }) {
            crate::shell::companion_error(&c.app, &e);
            c.emit();
        }
    });
}
pub fn tray_recall(app: &AppHandle) {
    let c = app.state::<Arc<Controller>>().inner().clone();
    std::thread::spawn(move || {
        if let Err(e) = c.recall() {
            crate::shell::companion_error(&c.app, &e);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(pid: u32, title: &str, address: &str) -> Value {
        serde_json::json!({"pid":pid,"title":title,"address":address,"mapped":true,"at":[2652,415],"size":[156,156],"monitor":1,"pinned":true})
    }
    #[test]
    fn own_identity_rejects_foreign_ambiguous_unmapped_and_injection() {
        let good = fixture(8, "own", "0xabc");
        assert!(own_client(&serde_json::json!([good]), 8, "own").is_ok());
        for bad in [
            serde_json::json!([fixture(9, "own", "0xabc")]),
            serde_json::json!([fixture(8, "other", "0xabc")]),
            serde_json::json!([fixture(8, "own", "0xabc'),activewindow(")]),
            serde_json::json!([fixture(8, "own", "0xabc"), fixture(8, "own", "0xdef")]),
        ] {
            assert!(own_client(&bad, 8, "own").is_err());
        }
        let mut hidden = fixture(8, "own", "0xabc");
        hidden["mapped"] = false.into();
        assert!(own_client(&serde_json::json!([hidden]), 8, "own").is_err());
    }
    #[test]
    fn monitor_scale_reserved_and_negative_origins_bound_every_move() {
        let a = area(&serde_json::json!([{"id":1,"x":1920,"y":0,"width":1920,"height":1080,"scale":1.25,"reserved":[0,37,0,0]}]),1).unwrap();
        assert_eq!(
            a,
            Area {
                x: 1920,
                y: 37,
                width: 1536,
                height: 827
            }
        );
        assert_eq!(a.clamp(9999, -400, 156), (3288, 49));
        assert_eq!(
            Area {
                x: -1920,
                y: -100,
                width: 1920,
                height: 1080
            }
            .clamp(-9999, 9999, 156),
            (-1908, 812)
        );
        assert!(area(&serde_json::json!([]), 1).is_err());
    }
    #[test]
    fn strict_patch_and_default_are_independent_of_app_persona() {
        let p = Preferences::default();
        assert!(!p.enabled && p.motion && p.appearances);
        assert_eq!(
            p.patched(Patch {
                enabled: Some(true),
                ..Patch::default()
            })
            .unwrap(),
            Preferences { enabled: true, ..p }
        );
        assert!(serde_json::from_str::<Patch>(r#"{"mode":"capri"}"#).is_err());
        assert!(serde_json::from_str::<Patch>(r#"{"travelling":true}"#).is_err());
    }
    #[test]
    fn automatic_travel_expires_once_and_uses_a_bounded_wake() {
        let now = Instant::now();
        let prefs = Preferences {
            enabled: true,
            ..Preferences::default()
        };
        let mut travel = TravelPulse::default();
        assert!(!travel.visible(now, &prefs, true, false));
        assert_eq!(travel.next_wake(now), Duration::from_secs(1));
        travel.start(now);
        assert!(travel.visible(now, &prefs, true, false));
        assert_eq!(travel.next_wake(now), TRAVEL_FOR);
        assert!(!travel.finish(now + TRAVEL_FOR - Duration::from_millis(1)));
        assert!(travel.finish(now + TRAVEL_FOR));
        assert!(!travel.visible(now + TRAVEL_FOR, &prefs, true, false));
        assert!(!travel.finish(now + TRAVEL_FOR));
        assert_eq!(travel.next_wake(now + TRAVEL_FOR), Duration::from_secs(1));
    }
    #[test]
    fn paused_hidden_disabled_or_motion_off_never_reports_walking() {
        let now = Instant::now();
        let prefs = Preferences {
            enabled: true,
            ..Preferences::default()
        };
        let mut travel = TravelPulse::default();
        travel.start(now);
        assert!(!travel.visible(now, &prefs, true, true));
        assert!(!travel.visible(now, &prefs, false, false));
        assert!(!travel.visible(
            now,
            &Preferences {
                enabled: false,
                ..prefs.clone()
            },
            true,
            false
        ));
        assert!(!travel.visible(
            now,
            &Preferences {
                motion: false,
                ..prefs.clone()
            },
            true,
            false
        ));
        assert!(travel.cancel());
        assert!(!travel.visible(now, &prefs, true, false));
        assert!(!travel.finish(now + TRAVEL_FOR));
        assert!(!travel.cancel());
    }
    #[test]
    fn travel_signal_is_transient_and_cannot_enter_saved_preferences() {
        let value = serde_json::to_value(Preferences::default()).unwrap();
        assert_eq!(value.as_object().unwrap().len(), 5);
        assert!(value.get("travelling").is_none());
        let now = Instant::now();
        let mut travel = TravelPulse::default();
        travel.start(now);
        travel.cancel(); // interaction, manual move, error, shutdown and control share cancellation
        travel.start(now + Duration::from_secs(20));
        assert_eq!(travel.next_wake(now + Duration::from_secs(20)), TRAVEL_FOR);
    }
    fn two_monitors() -> Vec<Monitor> {
        monitors(&serde_json::json!([
            {"id":1,"name":"eDP-1","x":-1920,"y":0,"width":1920,"height":1080,"scale":1.,"reserved":[0,32,0,0]},
            {"id":2,"name":"DP-1","x":0,"y":0,"width":2560,"height":1440,"scale":1.25,"reserved":[0,28,0,0]}
        ]))
    }
    fn zone(name: &str, enabled: bool) -> AllowedArea {
        AllowedArea {
            monitor: name.into(),
            enabled,
            rect: NormalizedRect::default(),
        }
    }
    #[test]
    fn old_preferences_migrate_and_region_patches_are_bounded_and_strict() {
        let old: Preferences =
            serde_json::from_str(r#"{"enabled":true,"motion":true,"appearances":false}"#).unwrap();
        assert!(!old.pinned && old.areas.is_empty() && old.pin_position.is_none());
        let clamped = old
            .patched(Patch {
                areas: Some(vec![AllowedArea {
                    monitor: "DP-1".into(),
                    enabled: true,
                    rect: NormalizedRect {
                        x: -0.2,
                        y: 0.75,
                        width: 2.,
                        height: 0.5,
                    },
                }]),
                ..Patch::default()
            })
            .unwrap();
        assert_eq!(
            clamped.areas[0].rect,
            NormalizedRect {
                x: 0.,
                y: 0.75,
                width: 1.,
                height: 0.25
            }
        );
        for areas in [
            vec![zone("DP-1", true), zone("DP-1", false)],
            vec![zone("", true)],
            vec![AllowedArea {
                rect: NormalizedRect {
                    width: 0.,
                    ..NormalizedRect::default()
                },
                ..zone("DP-1", true)
            }],
            vec![AllowedArea {
                rect: NormalizedRect {
                    x: f64::NAN,
                    ..NormalizedRect::default()
                },
                ..zone("DP-1", true)
            }],
        ] {
            assert!(old
                .patched(Patch {
                    areas: Some(areas),
                    ..Patch::default()
                })
                .is_err());
        }
        assert!(
            serde_json::from_str::<Patch>(r#"{"pinPosition":{"monitor":"DP-1","x":0,"y":0}}"#)
                .is_err()
        );
    }
    #[test]
    fn position_settles_after_motion_not_after_hover_and_ignores_our_moves() {
        let now = Instant::now();
        let mut tracking = PositionSettle::new(now);
        assert!(!tracking.observe(100, 200, now));
        assert!(tracking.movement(now));
        assert!(!tracking.ready(now + Duration::from_millis(349)));
        assert!(tracking.ready(now + Duration::from_millis(350)));
        assert!(tracking.observe(120, 240, now + Duration::from_millis(400)));
        assert!(!tracking.ready(now + Duration::from_millis(700)));
        assert!(tracking.ready(now + Duration::from_millis(750)));
        tracking.programmatic(500, 500, now + Duration::from_secs(1));
        assert!(!tracking.movement(now + Duration::from_millis(1500)));
        assert!(!tracking.observe(500, 500, now + Duration::from_secs(3)));
        assert!(tracking.observe(510, 500, now + Duration::from_secs(3)));
        assert!(tracking.ready(now + Duration::from_millis(3350)));
    }
    #[test]
    fn configured_zones_never_choose_an_excluded_or_new_monitor() {
        let monitors = two_monitors();
        let prefs = Preferences {
            areas: vec![
                AllowedArea {
                    rect: NormalizedRect {
                        x: 0.25,
                        y: 0.5,
                        width: 0.5,
                        height: 0.5,
                    },
                    ..zone("eDP-1", true)
                },
                zone("DP-1", false),
            ],
            ..Preferences::default()
        };
        let current = Client {
            monitor: 2,
            x: 500,
            y: 100,
            ..own_client(&serde_json::json!([fixture(8, "own", "0xabc")]), 8, "own").unwrap()
        };
        let (name, a, x, y) = destination(&prefs, &monitors, &current, false).unwrap();
        assert_eq!(name, "eDP-1");
        assert_eq!(
            a,
            Area {
                x: -1440,
                y: 556,
                width: 960,
                height: 524
            }
        );
        assert!(x >= a.x && x + SIZE <= a.x + a.width && y >= a.y && y + SIZE <= a.y + a.height);
        let only_excluded = vec![monitors[1].clone()];
        assert!(destination(&prefs, &only_excluded, &current, false).is_none());
        let new_monitor = vec![Monitor {
            name: "HDMI-A-1".into(),
            ..monitors[1].clone()
        }];
        assert!(destination(&prefs, &new_monitor, &current, false).is_none());
    }
    #[test]
    fn context_targets_never_override_pin_or_escape_permitted_monitors() {
        let monitors = two_monitors();
        let dot = Client {
            monitor: 1,
            x: -1500,
            y: 400,
            ..own_client(&serde_json::json!([fixture(8, "own", "0xabc")]), 8, "own").unwrap()
        };
        let mut prefs = Preferences {
            motion: true,
            areas: vec![zone("eDP-1", true), zone("DP-1", false)],
            ..Preferences::default()
        };
        let inside = Target {
            x: -1800.,
            y: 300.,
            width: 200.,
            height: 100.,
        };
        let outside = Target {
            x: 100.,
            ..inside.clone()
        };
        assert!(context_destination(&prefs, &monitors, &dot, &outside, None).is_none());
        let (x, y) = context_destination(&prefs, &monitors, &dot, &inside, None).unwrap();
        assert!(x >= -1920 && x + SIZE <= 0 && y >= 32 && y + SIZE <= 1080);
        prefs.pinned = true;
        assert!(context_destination(&prefs, &monitors, &dot, &inside, None).is_none());
        // The independent bubble does not move a pinned sprite.
        assert!(bubble_position(&prefs, &monitors, &dot, (BUBBLE_WIDTH, BUBBLE_HEIGHT)).is_some());
        assert_eq!((dot.x, dot.y), (-1500, 400));
        prefs.areas[0].rect = NormalizedRect {
            x: 0.2,
            y: 0.3,
            width: 0.1,
            height: 0.2,
        };
        assert!(bubble_position(&prefs, &monitors, &dot, (BUBBLE_WIDTH, BUBBLE_HEIGHT)).is_none());
    }
    #[test]
    fn perch_uses_authored_seat_and_aside_never_covers_the_composer() {
        let monitors = two_monitors();
        let dot = Client {
            monitor: 1,
            x: -1500,
            y: 400,
            ..own_client(&serde_json::json!([fixture(8, "own", "0xabc")]), 8, "own").unwrap()
        };
        let mut prefs = Preferences {
            motion: true,
            areas: vec![zone("eDP-1", true), zone("DP-1", false)],
            ..Preferences::default()
        };
        let target = Target {
            x: -1800.,
            y: 300.,
            width: 200.,
            height: 100.,
        };
        let perch =
            context_destination(&prefs, &monitors, &dot, &target, Some(Placement::Perch)).unwrap();
        assert_eq!(perch, (-1720, 188));
        let aside =
            context_destination(&prefs, &monitors, &dot, &target, Some(Placement::Aside)).unwrap();
        assert!(aside.0 as f64 >= target.x + target.width);
        let full = Target {
            x: -1920.,
            y: 300.,
            width: 1920.,
            height: 100.,
        };
        let above =
            context_destination(&prefs, &monitors, &dot, &full, Some(Placement::Aside)).unwrap();
        assert!((above.1 + SIZE) as f64 <= full.y);
        let blocked = Target { y: 40., ..full };
        assert!(
            context_destination(&prefs, &monitors, &dot, &blocked, Some(Placement::Aside))
                .is_none()
        );
        let too_high = Target {
            y: 40.,
            ..target.clone()
        };
        assert!(
            context_destination(&prefs, &monitors, &dot, &too_high, Some(Placement::Perch))
                .is_none()
        );
        prefs.pinned = true;
        assert!(
            context_destination(&prefs, &monitors, &dot, &target, Some(Placement::Perch)).is_none()
        );
    }
    #[test]
    fn only_spoken_source_notifications_expand_the_bubble() {
        let mut context = Context::default();
        let request: ContextRequest=serde_json::from_value(serde_json::json!({"kind":"notification","id":"source","summary":"Mensaje","source":{"appName":"Slack"}})).unwrap();
        context.notification = Some(request.cue());
        assert_eq!(bubble_size(&context), (260, 96));
        context.notification.as_mut().unwrap().kind = Kind::Capture;
        assert_eq!(bubble_size(&context), (220, 80));
        context.notification.as_mut().unwrap().kind = Kind::Question;
        assert_eq!(bubble_size(&context), (220, 80));
    }
    #[test]
    fn offline_or_too_small_zones_hide_without_escaping_and_reconnect_recovers() {
        let monitors = two_monitors();
        let mut prefs = Preferences {
            areas: vec![zone("eDP-1", false), zone("DP-1", true)],
            ..Preferences::default()
        };
        assert_eq!(allowed_areas(&prefs, &monitors).len(), 1);
        assert!(allowed_areas(&prefs, &monitors[..1]).is_empty());
        prefs.areas[1].rect.width = 0.01;
        assert!(allowed_areas(&prefs, &monitors).is_empty());
        prefs.areas[1].rect.width = 1.;
        let returned = vec![Monitor {
            id: 99,
            ..monitors[1].clone()
        }];
        assert_eq!(allowed_areas(&prefs, &returned)[0].0, "DP-1");
        prefs.areas[1].enabled = false;
        assert!(allowed_areas(&prefs, &monitors).is_empty());
    }
    #[test]
    fn pinned_coordinates_survive_restart_scale_changes_and_monitor_id_changes() {
        let monitors = two_monitors();
        let prefs = Preferences {
            enabled: true,
            pinned: true,
            areas: vec![zone("eDP-1", false), zone("DP-1", true)],
            pin_position: pin_position(&monitors, "DP-1", 512, 300),
            ..Preferences::default()
        };
        let saved = serde_json::to_string(&prefs).unwrap();
        let mut restored: Preferences = serde_json::from_str(&saved).unwrap();
        restored.validate().unwrap();
        let mut resized = monitors.clone();
        resized[1].id = 77;
        resized[1].width *= 2;
        let current =
            own_client(&serde_json::json!([fixture(8, "own", "0xabc")]), 8, "own").unwrap();
        let (name, _, x, y) = destination(&restored, &resized, &current, true).unwrap();
        assert_eq!((name.as_str(), x, y), ("DP-1", 1024, 300));
        assert!(destination(&restored, &resized[..1], &current, true).is_none());
    }
    #[test]
    fn idle_never_schedules_a_move() {
        let prefs = Preferences {
            enabled: true,
            ..Preferences::default()
        };
        assert!(!automatic_actions(&prefs, true, false, Duration::from_secs(3600)).1);
    }
    #[test]
    fn cue_priority_is_ordered_and_equal_priority_can_refresh() {
        let tiers: &[&[Kind]] = &[
            &[Kind::Question, Kind::Attention, Kind::Notification],
            &[Kind::Done, Kind::Error, Kind::Capture, Kind::Download],
            &[Kind::Typing, Kind::InputReady],
            &[Kind::Working],
            &[Kind::Reading, Kind::Submitted],
            &[Kind::Rest, Kind::Music],
        ];
        for (index, tier) in tiers.iter().enumerate() {
            for kind in *tier {
                assert_eq!(kind.priority(), (tiers.len() - index - 1) as u8);
                let request: ContextRequest = serde_json::from_value(serde_json::json!({
                    "kind": kind, "id": "same-id"
                })).unwrap();
                let mut cue = request.cue();
                cue.expires_at = 100;
                for incoming in tiers.iter().flat_map(|tier| tier.iter()) {
                    let expected = incoming.priority() >= kind.priority();
                    let context = Context { cue: Some(cue.clone()), ..Context::default() };
                    assert_eq!(context.accepts(*incoming, 99), expected);
                    assert!(context.accepts(*incoming, 100));
                    let notification = Context { notification: Some(cue.clone()), ..Context::default() };
                    assert_eq!(notification.accepts(*incoming, 99), expected);
                }
            }
        }
    }
    #[test]
    fn fallback_only_accepts_mapped_terminal_metadata_with_matching_identity() {
        let active = serde_json::json!({
            "address": "0x123", "class": "herdr", "title": "Herdr",
            "at": [-800, 0], "size": [600, 700], "mapped": true
        });
        let clients = serde_json::json!([active.clone()]);
        assert_eq!(terminal_target(&active, &clients).unwrap().x, -800.);
        let mut other = active.clone();
        other["class"] = serde_json::json!("browser");
        assert!(terminal_target(&other, &serde_json::json!([other.clone()])).is_none());
        other["title"] = serde_json::json!("Gentle Shell — session");
        assert!(terminal_target(&other, &serde_json::json!([other.clone()])).is_some());
        other["mapped"] = serde_json::json!(false);
        assert!(terminal_target(&other, &serde_json::json!([other.clone()])).is_none());
        other = active.clone();
        other["title"] = serde_json::json!("changed");
        assert!(terminal_target(&other, &clients).is_none());
        other = active.clone();
        other["address"] = serde_json::json!("0x456");
        assert!(terminal_target(&other, &clients).is_none());
        other = active.clone();
        other["at"] = serde_json::json!([-700, 0]);
        assert!(terminal_target(&other, &clients).is_none());
        other = active.clone();
        other["size"] = serde_json::json!([0, 700]);
        assert!(terminal_target(&other, &serde_json::json!([other.clone()])).is_none());
    }
    #[test]
    fn terminal_fallback_stays_outside_bottom_input_rows() {
        let zone = Area { x: 0, y: 0, width: 1200, height: 900 };
        let rect = Target { x: 200., y: 100., width: 600., height: 600. };
        assert_eq!(terminal_destination(&rect, zone, 156), Some((800, 544)));
        let right = Target { x: 600., ..rect.clone() };
        assert_eq!(terminal_destination(&right, zone, 156), Some((444, 544)));
        let full = Target { x: 0., y: 0., width: 1200., height: 900. };
        assert_eq!(terminal_destination(&full, zone, 156), None);
        let below = Target { x: 0., y: 0., width: 1200., height: 600. };
        assert_eq!(terminal_destination(&below, zone, 156), Some((1044, 600)));
        let excluded = Area { x: 0, y: 0, width: 100, height: 100 };
        assert_eq!(terminal_destination(&rect, excluded, 156), None);
        let negative_zone = Area { x: -1200, ..zone };
        let negative_rect = Target { x: -1000., ..rect };
        assert_eq!(terminal_destination(&negative_rect, negative_zone, 156), Some((-400, 544)));
    }
    #[test]
    fn pin_prevents_automatic_walk_and_hide_without_changing_gesture_preferences() {
        let prefs = Preferences {
            enabled: true,
            pinned: true,
            ..Preferences::default()
        };
        assert_eq!(
            automatic_actions(
                &prefs,
                true,
                false,
                Duration::from_secs(100)
            ),
            (false, false)
        );
        assert!(prefs.motion && prefs.appearances);
        let mut travel = TravelPulse::default();
        let now = Instant::now();
        travel.start(now);
        assert!(!travel.visible(now, &prefs, true, false));
        let free = Preferences {
            pinned: false,
            ..prefs
        };
        assert_eq!(
            automatic_actions(
                &free,
                true,
                false,
                Duration::from_secs(100)
            ),
            (true, false)
        );
        assert_eq!(
            automatic_actions(
                &free,
                false,
                true,
                Duration::from_secs(100)
            ),
            (false, false)
        );
    }
    #[test]
    fn rotated_work_area_uses_logical_reserved_space() {
        let items = monitors(
            &serde_json::json!([{"id":4,"name":"DP-portrait","x":-900,"y":-100,"width":1920,"height":1080,"scale":1.5,"transform":1,"reserved":[10,30,10,20]}]),
        );
        assert_eq!(
            items[0].work_area(),
            Area {
                x: -890,
                y: -70,
                width: 700,
                height: 1230
            }
        );
    }
    #[test]
    fn dispatcher_has_exact_target_and_never_activewindow_or_focus() {
        assert_eq!(
            command("0xabc", "move", "x=-100,y=37,relative=false").unwrap(),
            "hl.dsp.window.move({window='address:0xabc',x=-100,y=37,relative=false})"
        );
        assert!(command("0xabc", "focus", "action='on'").is_err());
        assert!(command("activewindow", "move", "").is_err());
        assert!(command("0xabc'", "move", "").is_err());
    }
    #[test]
    fn silhouette_rule_is_private_removable_and_preserves_pixel_alpha() {
        let name = style_identity("a9f3").unwrap();
        let rule = style_rule(&name);
        assert!(rule.contains(&format!("match={{tag='{name}'}}")));
        assert!(rule.contains("no_blur=true,no_shadow=true,no_dim=true"));
        assert!(rule.contains("border_size=0,rounding=0,opaque=true"));
        assert!(!rule.contains("force_rgbx"));
        assert!(!rule.contains("Launcher"));
        assert!(style_identity("").is_err());
        assert!(style_identity("a';clear_tags()").is_err());
        assert_eq!(
            command("0xabc", "tag", &format!("tag='-{name}'")).unwrap(),
            format!("hl.dsp.window.tag({{window='address:0xabc',tag='-{name}'}})")
        );
    }
    #[test]
    fn every_companion_window_maps_without_compositor_effects() {
        // A transparent launcher with profile blur/shadow paints a ghost square while hidden.
        for role in ["dot", "launcher", "bubble"] {
            assert!(mapping_rule("n", "t", role).ends_with(&format!(",{SILHOUETTE_EFFECTS}}})")));
        }
        assert!(!mapping_rule("n", "t", "fixture").contains("no_blur"));
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn compact_bubble_input_has_no_reserved_strip_or_hidden_hit_area() {
        assert_eq!((BUBBLE_WIDTH, BUBBLE_HEIGHT), (220, 80));
        let visible = bubble_region(true, (BUBBLE_WIDTH, BUBBLE_HEIGHT));
        assert!(!visible.contains_point(0, 0));
        assert!(!visible.contains_point(5, 5));
        assert!(visible.contains_point(110, 40));
        assert!(!visible.contains_point(110, 80));
        assert!(!visible.contains_point(220, 40));
        assert!(bubble_region(false, NOTIFICATION_BUBBLE).is_empty());
        let expanded = bubble_region(true, NOTIFICATION_BUBBLE);
        assert!(expanded.contains_point(250, 48));
        assert!(expanded.contains_point(130, 94));
        assert!(!expanded.contains_point(0, 0));
        assert!(!expanded.contains_point(260, 48));
        assert!(!expanded.contains_point(130, 96));
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn shaped_input_excludes_transparent_corners_and_retains_center_controls() {
        for size in [56, 156] {
            let region = circle_region(size);
            assert!(!region.contains_point(0, 0));
            assert!(!region.contains_point(size - 1, size - 1));
            assert!(region.contains_point(size / 2, size / 2));
            assert!(region.contains_point(size / 2, size - 2));
        }
    }
    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "Opt-in Hyprland fixture: creates only one fresh transparent own-PID window, never targets existing windows"]
    fn isolated_hyprland_window_moves_without_focus_and_restores() {
        use gtk::prelude::*;
        gtk::init().expect("GTK display");
        let rule = MappingRule::install("fixture", &nonce().unwrap()).unwrap();
        let title = rule.title.clone();
        let focused = query("activewindow").unwrap()["address"].clone();
        let native = gtk::Window::new(gtk::WindowType::Toplevel);
        native.set_title(&title);
        native.set_decorated(false);
        native.set_focus_on_map(false);
        native.set_accept_focus(true);
        native.set_app_paintable(true);
        native.set_skip_taskbar_hint(true);
        if let Some(visual) = gtk::prelude::WidgetExt::screen(&native).and_then(|s| s.rgba_visual())
        {
            native.set_visual(Some(&visual));
        }
        let content = gtk::DrawingArea::new();
        content.set_size_request(SIZE, SIZE);
        content.set_opacity(0.);
        native.add(&content);
        native.set_default_size(SIZE, SIZE);
        native.input_shape_combine_region(Some(&gtk::cairo::Region::create()));
        native.show_all();
        let (done, result) = mpsc::sync_channel(1);
        let worker = std::thread::spawn(move || {
            let run = || -> Result<(), String> {
                let mut baseline = None;
                for _ in 0..40 {
                    if let Ok(c) = resolve(&title) {
                        baseline = Some(c);
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(25));
                }
                let b = baseline.ok_or("fixture did not map")?;
                let previous_style: Vec<_> = SILHOUETTE_PROPERTIES
                    .iter()
                    .map(|(key, _)| {
                        window_property(&title, &b.address, key).map(|value| (*key, value))
                    })
                    .collect::<Result<_, _>>()?;
                let mut silhouette = SilhouetteRule::install(&title, &b.address, &nonce()?)?;
                let mapped_focus = query("activewindow")?["address"].clone();
                if mapped_focus != focused {
                    return Err(format!(
                        "mapping changed focus; fixture_focused={}",
                        mapped_focus.as_str() == Some(&b.address)
                    ));
                }
                let a = area(&query("monitors")?, b.monitor)?;
                let (x, y) = a.clamp(b.x + 180, b.y - 90, SIZE);
                place(&title, &b.address, x, y, SIZE, true)?;
                if query("activewindow")?["address"] != focused {
                    return Err(format!(
                        "movement changed focus; fixture_focused={}",
                        query("activewindow")?["address"].as_str() == Some(&b.address)
                    ));
                }
                place(&title, &b.address, b.x, b.y, SIZE, b.pinned)?;
                silhouette.remove()?;
                for (property, previous) in previous_style {
                    if window_property(&title, &b.address, property)? != previous {
                        return Err(format!("private style did not restore {property}"));
                    }
                }
                Ok(())
            };
            let _ = done.send(run());
        });
        let deadline = Instant::now() + Duration::from_secs(20);
        let outcome = loop {
            while gtk::events_pending() {
                gtk::main_iteration_do(false);
            }
            if let Ok(result) = result.try_recv() {
                break result;
            }
            if Instant::now() >= deadline {
                break Err("fixture timeout".into());
            }
            std::thread::sleep(Duration::from_millis(5));
        };
        assert_eq!(content.opacity(), 0.);
        circle(&native, SIZE);
        native.input_shape_combine_region(Some(&gtk::cairo::Region::create()));
        circle(&native, SIZE);
        native.hide();
        native.close();
        worker.join().unwrap();
        drop(rule);
        assert!(outcome.is_ok(), "{outcome:?}");
    }
}
