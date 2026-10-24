//! Local, transient desktop context. Never reads a screen, keystroke, track title or history.
//! MPRIS is observed through its standard change signals. Notification offers use our own
//! D-Bus name; the existing notification server remains the owner of notifications/actions.
use serde::{Deserialize, Serialize};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::AppHandle;

pub const BUS_NAME: &str = "io.gentledot.Companion";
pub const BUS_PATH: &str = "/io/gentledot/Companion";
pub const BUS_INTERFACE: &str = "io.gentledot.Companion1";

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    #[serde(rename = "input-ready")]
    InputReady,
    Typing,
    Submitted,
    Working,
    Question,
    Capture,
    Download,
    Notification,
    Music,
    Rest,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Placement {
    Perch,
    Aside,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Target {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Request {
    pub kind: Kind,
    pub id: Option<String>,
    pub summary: Option<String>,
    pub body: Option<String>,
    pub session_id: Option<String>,
    pub pane_id: Option<String>,
    pub target: Option<Target>,
    pub source: Option<NotificationSource>,
    pub placement: Option<Placement>,
}
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct NotificationSource {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub desktop_entry: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sender: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conversation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub urgency: Option<u8>,
}
impl NotificationSource {
    pub fn valid(&self) -> bool {
        self.urgency.is_none_or(|value| value <= 2)
            && [
                &self.app_name,
                &self.desktop_entry,
                &self.category,
                &self.sender,
                &self.conversation,
            ]
            .iter()
            .all(|value| value.as_ref().is_none_or(|value| value.len() <= 1024))
    }
    pub fn clean(&self) -> Self {
        let clean = |value: &Option<String>, limit| {
            value
                .as_ref()
                .map(|s| plain(s, limit))
                .filter(|s| !s.is_empty())
        };
        Self {
            app_name: clean(&self.app_name, 160),
            desktop_entry: clean(&self.desktop_entry, 160),
            category: clean(&self.category, 128),
            sender: clean(&self.sender, 160),
            conversation: clean(&self.conversation, 240),
            urgency: self.urgency,
        }
    }
    pub fn notification_kind(&self, summary: &str, body: &str) -> Kind {
        let app = self.app_name.as_deref().unwrap_or("").trim().to_lowercase();
        let desktop = self
            .desktop_entry
            .as_deref()
            .unwrap_or("")
            .trim()
            .trim_end_matches(".desktop")
            .to_lowercase();
        let category = self.category.as_deref().unwrap_or("").trim().to_lowercase();
        let title = summary.trim().to_lowercase();
        // These vetoes can only preserve a spoken notice, never silence one.
        let alert = format!("{summary} {body}")
            .to_lowercase()
            .split(|c: char| !c.is_alphanumeric())
            .any(|word| {
                matches!(
                    word,
                    "error"
                        | "errors"
                        | "failed"
                        | "failure"
                        | "denied"
                        | "warning"
                        | "authentication"
                        | "password"
                        | "login"
                        | "contraseña"
                        | "autenticación"
                        | "advertencia"
                        | "falló"
                        | "fallida"
                        | "cancelled"
                        | "canceled"
                        | "cancelado"
                )
            });
        let messaging = [
            "slack",
            "herdr",
            "chatgpt",
            "codex",
            "discord",
            "telegram",
            "signal",
            "teams",
            "microsoft teams",
            "whatsapp",
        ]
        .contains(&app.as_str())
            || [
                "com.slack.slack",
                "slack",
                "herdr",
                "chatgpt",
                "com.openai.chatgpt",
                "codex",
                "discord",
                "org.telegram.desktop",
                "org.signal.signal",
            ]
            .contains(&desktop.as_str());
        if self.urgency == Some(2)
            || alert
            || messaging
            || category.starts_with("im.")
            || category.starts_with("email.")
            || category.contains("error")
            || category.contains("auth")
            || category.starts_with("security")
        {
            return Kind::Notification;
        }
        // Exact local screenshot.sh producer contract; arbitrary mentions are never actions.
        if app == "screenshot" && title == "screenshot saved" {
            return Kind::Capture;
        }
        // transfer.complete is the explicit desktop notification category, not inferred prose.
        if category == "transfer.complete" {
            return Kind::Download;
        }
        let downloader = [
            "aria2",
            "motrix",
            "transmission",
            "qbittorrent",
            "jdownloader",
        ]
        .contains(&app.as_str())
            || [
                "aria2",
                "motrix",
                "transmission-gtk",
                "org.qbittorrent.qbittorrent",
                "org.jdownloader.jdownloader",
            ]
            .contains(&desktop.as_str());
        if downloader
            && [
                "download complete",
                "download completed",
                "download finished",
                "descarga completa",
                "descarga completada",
            ]
            .contains(&title.as_str())
        {
            return Kind::Download;
        }
        Kind::Notification
    }
}
impl Kind {
    pub fn visual_only(self) -> bool {
        matches!(self, Self::Capture | Self::Download)
    }
    pub fn ack_surface(self) -> &'static str {
        if self.visual_only() {
            "dot"
        } else {
            "companion-bubble"
        }
    }
}
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Cue {
    pub id: String,
    pub kind: Kind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pane_id: Option<String>,
    pub expires_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<NotificationSource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub placement: Option<Placement>,
}
#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Context {
    pub music_playing: bool,
    pub music_available: bool,
    pub notifications_available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notification_service: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notification: Option<Cue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cue: Option<Cue>,
}
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}
pub fn plain(value: &str, limit: usize) -> String {
    let mut tag = false;
    value
        .chars()
        .filter(|c| {
            if *c == '<' {
                tag = true;
                return false;
            }
            if *c == '>' {
                tag = false;
                return false;
            }
            !tag && (!c.is_control() || *c == '\n')
        })
        .take(limit)
        .collect::<String>()
        .trim()
        .into()
}
fn identifier(value: &Option<String>) -> bool {
    value
        .as_ref()
        .is_none_or(|s| !s.is_empty() && s.len() <= 160 && !s.chars().any(char::is_control))
}
impl Request {
    pub fn validate(&self) -> Result<(), String> {
        if !identifier(&self.id) || !identifier(&self.session_id) || !identifier(&self.pane_id) {
            return Err("El contexto de Capri tiene un identificador inválido".into());
        }
        if self.target.as_ref().is_some_and(|t| {
            ![t.x, t.y, t.width, t.height].iter().all(|x| x.is_finite())
                || t.x.abs() > 100_000.
                || t.y.abs() > 100_000.
                || !(1. ..=32_768.).contains(&t.width)
                || !(1. ..=32_768.).contains(&t.height)
        }) {
            return Err("La posición del contexto no es válida".into());
        }
        if self.summary.as_ref().is_some_and(|s| s.len() > 16_384)
            || self.body.as_ref().is_some_and(|s| s.len() > 65_536)
        {
            return Err("El contexto es demasiado largo".into());
        }
        if self.source.as_ref().is_some_and(|source| !source.valid()) {
            return Err("La fuente de la notificación es inválida".into());
        }
        Ok(())
    }
    pub fn cue(&self) -> Cue {
        Cue {
            id: self
                .id
                .clone()
                .unwrap_or_else(|| format!("context-{}", now_ms())),
            kind: self.kind,
            summary: self.summary.as_ref().map(|s| plain(s, 240)),
            body: self.body.as_ref().map(|s| plain(s, 480)),
            session_id: self.session_id.clone(),
            pane_id: self.pane_id.clone(),
            source: self.source.as_ref().map(NotificationSource::clean),
            placement: self.placement,
            expires_at: now_ms()
                + match self.kind {
                    Kind::Question => 30_000,
                    Kind::InputReady => 2_500,
                    _ => 8_000,
                },
        }
    }
}
impl Context {
    pub fn bubble(&self) -> Option<&Cue> {
        self.notification.iter().chain(self.cue.iter()).find(|c| {
            !c.kind.visual_only()
                && c.kind != Kind::InputReady
                && c.expires_at > now_ms()
                && (c.summary.as_ref().is_some_and(|s| !s.is_empty())
                    || c.body.as_ref().is_some_and(|s| !s.is_empty()))
        })
    }
    pub fn expire(&mut self) -> bool {
        let now = now_ms();
        let mut changed = false;
        if self
            .notification
            .as_ref()
            .is_some_and(|c| c.expires_at <= now)
        {
            self.notification = None;
            changed = true;
        }
        if self.cue.as_ref().is_some_and(|c| c.expires_at <= now) {
            self.cue = None;
            changed = true;
        }
        changed
    }
    pub fn dismiss(&mut self, id: Option<&str>) -> bool {
        let mut changed = false;
        if self
            .notification
            .as_ref()
            .is_some_and(|c| id.is_none_or(|id| c.id == id))
        {
            self.notification = None;
            changed = true;
        }
        if self
            .cue
            .as_ref()
            .is_some_and(|c| id.is_none_or(|id| c.id == id))
        {
            self.cue = None;
            changed = true;
        }
        changed
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use super::*;
    use dbus::{
        arg::{PropMap, Variant},
        blocking::Connection,
        channel::Sender,
        MessageType,
    };
    use std::collections::HashMap;
    const PLAYER: &str = "org.mpris.MediaPlayer2.Player";
    const PLAYER_PATH: &str = "/org/mpris/MediaPlayer2";
    fn proxy<'a>(
        c: &'a Connection,
        name: &'a str,
        path: &'a str,
    ) -> dbus::blocking::Proxy<'a, &'a Connection> {
        c.with_proxy(name, path, Duration::from_millis(350))
    }
    fn playback(c: &Connection, name: &str) -> bool {
        let status: Result<(Variant<String>,), _> = proxy(c, name, PLAYER_PATH).method_call(
            "org.freedesktop.DBus.Properties",
            "Get",
            (PLAYER, "PlaybackStatus"),
        );
        status.is_ok_and(|s| s.0 .0 == "Playing")
    }
    fn players(c: &Connection) -> Result<HashMap<String, (String, bool)>, dbus::Error> {
        let p = proxy(c, "org.freedesktop.DBus", "/org/freedesktop/DBus");
        let (names,): (Vec<String>,) = p.method_call("org.freedesktop.DBus", "ListNames", ())?;
        Ok(names
            .into_iter()
            .filter(|n| {
                n.starts_with("org.mpris.MediaPlayer2.") && n != "org.mpris.MediaPlayer2.playerctld"
            })
            .take(32)
            .filter_map(|n| {
                let owner: Result<(String,), _> =
                    p.method_call("org.freedesktop.DBus", "GetNameOwner", (&n,));
                owner.ok().map(|o| {
                    let playing = playback(c, &n);
                    (n, (o.0, playing))
                })
            })
            .collect())
    }
    fn watch_music(app: &AppHandle) -> Result<(), dbus::Error> {
        let c = Connection::new_session()?;
        c.add_match_no_cb("type='signal',interface='org.freedesktop.DBus.Properties',member='PropertiesChanged',path='/org/mpris/MediaPlayer2',arg0='org.mpris.MediaPlayer2.Player'")?;
        c.add_match_no_cb("type='signal',sender='org.freedesktop.DBus',interface='org.freedesktop.DBus',member='NameOwnerChanged',arg0namespace='org.mpris.MediaPlayer2'")?;
        let mut current = players(&c)?;
        let mut refreshed = std::time::Instant::now();
        let mut last = None;
        while !crate::desktop_companion::context_stopped(app)
            && crate::desktop_companion::enabled(app)
        {
            let status = current.values().any(|(_, p)| *p);
            if last != Some(status) {
                crate::desktop_companion::context_music(app, status, true);
                last = Some(status);
            }
            if let Some(m) = c.channel().blocking_pop_message(Duration::from_secs(1))? {
                if m.member().is_some_and(|v| v == "NameOwnerChanged") {
                    if let Ok((name, _, owner)) = m.read3::<String, String, String>() {
                        current.remove(&name);
                        if !owner.is_empty()
                            && name.starts_with("org.mpris.MediaPlayer2.")
                            && name != "org.mpris.MediaPlayer2.playerctld"
                            && current.len() < 32
                        {
                            let p = playback(&c, &name);
                            current.insert(name, (owner, p));
                        }
                    }
                } else if m.member().is_some_and(|v| v == "PropertiesChanged") {
                    if let Ok((interface, changes, invalidated)) =
                        m.read3::<String, PropMap, Vec<String>>()
                    {
                        if interface == PLAYER {
                            let sender = m.sender().map(|s| s.to_string()).unwrap_or_default();
                            for (name, (owner, playing)) in
                                current.iter_mut().filter(|(_, v)| v.0 == sender)
                            {
                                let _ = owner;
                                if let Some(status) =
                                    changes.get("PlaybackStatus").and_then(|v| v.0.as_str())
                                {
                                    *playing = status == "Playing";
                                } else if invalidated.iter().any(|p| p == "PlaybackStatus") {
                                    *playing = playback(&c, name);
                                }
                            }
                        }
                    }
                }
            }
            // Reconcile infrequently for nonconforming players; never poll track position/metadata.
            if refreshed.elapsed() >= Duration::from_secs(60) {
                current = players(&c)?;
                refreshed = std::time::Instant::now();
            }
        }
        Ok(())
    }
    fn serve_notifications(app: &AppHandle) -> Result<(), dbus::Error> {
        let c = Connection::new_session()?;
        // libdbus can hold its connection lock during blocking receive. Keep all
        // transport on this thread so an ACK worker never waits behind that lock.
        let (completed_tx, completed_rx) = std::sync::mpsc::sync_channel(1);
        let mut active_offer = false;
        use dbus::blocking::stdintf::org_freedesktop_dbus::RequestNameReply;
        if c.request_name(BUS_NAME, false, false, true)? != RequestNameReply::PrimaryOwner {
            return Err(dbus::Error::new_failed(
                "Companion notification receiver already owned",
            ));
        }
        // Inspect only an existing owner; do not activate or replace a notification daemon.
        let owner = c
            .with_proxy(
                "org.freedesktop.DBus",
                "/org/freedesktop/DBus",
                Duration::from_millis(350),
            )
            .method_call::<(String,), _, _, _>(
                "org.freedesktop.DBus",
                "GetNameOwner",
                ("org.freedesktop.Notifications",),
            )
            .ok();
        let service = owner
            .and_then(|(owner,)| {
                c.with_proxy(
                    &owner,
                    "/org/freedesktop/Notifications",
                    Duration::from_millis(350),
                )
                .method_call::<(String, String, String, String), _, _, _>(
                    "org.freedesktop.Notifications",
                    "GetServerInformation",
                    (),
                )
                .ok()
            })
            .map(|s| plain(&s.0, 128));
        crate::desktop_companion::context_notifications(app, true, service);
        while !crate::desktop_companion::context_stopped(app) {
            if let Ok((reply, accepted)) = completed_rx.try_recv() {
                let reply: dbus::Message = reply;
                let _ = c.send(reply.append1(accepted));
                active_offer = false;
            }
            // Idle uses a blocking bus wait. Only an outstanding (450ms maximum)
            // offer needs a short wait so its worker reply is flushed promptly.
            let wait = if active_offer {
                Duration::from_millis(20)
            } else {
                Duration::from_secs(1)
            };
            if let Some(m) = c.channel().blocking_pop_message(wait)? {
                if m.msg_type() != MessageType::MethodCall {
                    continue;
                }
                if m.path().is_some_and(|p| p == BUS_PATH)
                    && m.interface().is_some_and(|i| i == BUS_INTERFACE)
                    && m.member()
                        .is_some_and(|v| v == "OfferNotification" || v == "OfferNotificationV2")
                {
                    // Never queue an old offer behind GTK/ACK. Cancellation keeps flowing on
                    // this receiver; a concurrent notification immediately uses the OS fallback.
                    let deadline = std::time::Instant::now() + Duration::from_millis(450);
                    let args = if m.member().is_some_and(|v| v == "OfferNotificationV2") {
                        m.read4::<String, String, String, String>().ok().and_then(
                            |(id, summary, body, metadata)| {
                                if metadata.len() > 8192 {
                                    return None;
                                }
                                let source: NotificationSource =
                                    serde_json::from_str(&metadata).ok()?;
                                source.valid().then_some((id, summary, body, Some(source)))
                            },
                        )
                    } else {
                        m.read3::<String, String, String>()
                            .ok()
                            .map(|(id, summary, body)| (id, summary, body, None))
                    };
                    if args.is_none() || active_offer {
                        let _ = c.send(m.method_return().append1(false));
                        continue;
                    }
                    active_offer = true;
                    let (id, summary, body, source) = args.unwrap();
                    let reply = m.method_return();
                    let app = app.clone();
                    let completed = completed_tx.clone();
                    std::thread::spawn(move || {
                        let accepted = if source.is_some() {
                            crate::desktop_companion::offer_notification_with_source(
                                &app, id, summary, body, source, deadline,
                            )
                        } else {
                            crate::desktop_companion::offer_notification(
                                &app, id, summary, body, deadline,
                            )
                        };
                        let _ = completed.send((reply, accepted));
                    });
                } else if m.path().is_some_and(|p| p == BUS_PATH)
                    && m.interface().is_some_and(|i| i == BUS_INTERFACE)
                    && m.member().is_some_and(|v| v == "CancelNotification")
                {
                    if let Ok(id) = m.read1::<String>() {
                        crate::desktop_companion::cancel_notification(app, &id);
                    }
                    let _ = c.send(m.method_return());
                } else if m
                    .interface()
                    .is_some_and(|i| i == "org.freedesktop.DBus.Introspectable")
                {
                    let _=c.send(m.method_return().append1("<node><interface name='io.gentledot.Companion1'><method name='OfferNotification'><arg type='s' direction='in' name='id'/><arg type='s' direction='in' name='summary'/><arg type='s' direction='in' name='body'/><arg type='b' direction='out' name='accepted'/></method><method name='OfferNotificationV2'><arg type='s' direction='in' name='id'/><arg type='s' direction='in' name='summary'/><arg type='s' direction='in' name='body'/><arg type='s' direction='in' name='metadata'/><arg type='b' direction='out' name='accepted'/></method><method name='CancelNotification'><arg type='s' direction='in' name='id'/></method></interface></node>"));
                } else if let Some(reply) = dbus::channel::default_reply(&m) {
                    let _ = c.send(reply);
                }
            }
        }
        Ok(())
    }
    pub fn start(app: &AppHandle) {
        let a = app.clone();
        std::thread::spawn(move || {
            while !crate::desktop_companion::context_stopped(&a) {
                if crate::desktop_companion::enabled(&a) {
                    let _ = watch_music(&a);
                    crate::desktop_companion::context_music(&a, false, false);
                }
                for _ in 0..10 {
                    if crate::desktop_companion::context_stopped(&a) {
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(500));
                }
            }
        });
        let a = app.clone();
        std::thread::spawn(move || {
            while !crate::desktop_companion::context_stopped(&a) {
                let _ = serve_notifications(&a);
                crate::desktop_companion::context_notifications(&a, false, None);
                for _ in 0..60 {
                    if crate::desktop_companion::context_stopped(&a) {
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(500));
                }
            }
        });
    }
}
pub fn start(app: &AppHandle) {
    #[cfg(target_os = "linux")]
    linux::start(app);
    #[cfg(not(target_os = "linux"))]
    let _ = app;
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn context_is_plain_bounded_and_geometry_is_checked() {
        let r:Request=serde_json::from_value(serde_json::json!({"kind":"question","summary":"<b>Pregunta</b>\u{0}","body":"x".repeat(1000),"target":{"x":-1920,"y":0,"width":100,"height":80}})).unwrap();
        assert!(r.validate().is_ok());
        let c = r.cue();
        assert_eq!(c.summary.as_deref(), Some("Pregunta"));
        assert_eq!(c.body.unwrap().len(), 480);
        let mut r = r;
        r.target.as_mut().unwrap().x = f64::INFINITY;
        assert!(r.validate().is_err());
    }
    #[test]
    fn notification_classifier_uses_exact_producer_metadata_and_preserves_messages_and_alerts() {
        let fixtures: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../scripts/linux/quickshell/test/fixtures/notification-kinds.json"
        ))
        .unwrap();
        for fixture in fixtures.as_array().unwrap() {
            let source: NotificationSource =
                serde_json::from_value(fixture["source"].clone()).unwrap();
            let kind = source.notification_kind(
                fixture["summary"].as_str().unwrap(),
                fixture["body"].as_str().unwrap(),
            );
            assert_eq!(
                serde_json::to_value(kind).unwrap(),
                fixture["kind"],
                "{fixture}"
            );
        }
    }
    #[test]
    fn source_is_bounded_and_never_derives_a_sender_from_text() {
        let request: Request = serde_json::from_value(serde_json::json!({"kind":"notification","source":{"appName":"Slack"},"summary":"Nuevo mensaje en General","body":"Alex Rivera: La revisión está lista"})).unwrap();
        let cue = request.cue();
        assert_eq!(cue.source.unwrap().sender, None);
        assert_eq!(cue.body.as_deref(), Some("Alex Rivera: La revisión está lista"));
        let mut invalid = NotificationSource::default();
        invalid.urgency = Some(3);
        assert!(!invalid.valid());
        invalid.urgency = Some(1);
        invalid.sender = Some("x".repeat(1025));
        assert!(!invalid.valid());
    }
    #[test]
    fn visual_files_have_no_spoken_bubble_and_require_the_traveler_receipt() {
        for kind in [Kind::Capture, Kind::Download] {
            let request: Request = serde_json::from_value(serde_json::json!({"kind":kind,"id":"file","summary":"Stored","body":"File details"})).unwrap();
            let mut context = Context {
                notification: Some(request.cue()),
                ..Context::default()
            };
            assert!(context.bubble().is_none());
            assert_eq!(kind.ack_surface(), "dot");
            let question: Request = serde_json::from_value(
                serde_json::json!({"kind":"question","id":"approval","summary":"Approve this?"}),
            )
            .unwrap();
            context.cue = Some(question.cue());
            assert_eq!(context.bubble().unwrap().id, "approval");
            assert!(!context.dismiss(Some("other")));
            assert!(context.dismiss(Some("file")));
            assert!(context.cue.is_some());
        }
        assert_eq!(Kind::Notification.ack_surface(), "companion-bubble");
    }
    #[test]
    fn focused_idle_editor_has_a_short_lived_silent_identity_distinct_from_typing() {
        let request: Request = serde_json::from_value(
            serde_json::json!({"kind":"input-ready","placement":"perch","summary":"Not spoken"}),
        )
        .unwrap();
        assert_eq!(request.kind, Kind::InputReady);
        assert_eq!(request.placement, Some(Placement::Perch));
        let before = now_ms();
        let cue = request.cue();
        assert!(cue.expires_at >= before + 2500 && cue.expires_at <= now_ms() + 2500);
        assert_eq!(cue.placement, Some(Placement::Perch));
        assert!(Context {
            cue: Some(cue),
            ..Context::default()
        }
        .bubble()
        .is_none());
    }
    #[test]
    fn dismiss_is_scoped_and_expiration_does_not_clear_music() {
        let cue = |id: &str| Cue {
            id: id.into(),
            kind: Kind::Notification,
            summary: Some("Hello".into()),
            body: None,
            session_id: None,
            pane_id: None,
            expires_at: now_ms() + 1000,
            source: None,
            placement: None,
        };
        let mut c = Context {
            music_playing: true,
            notification: Some(cue("n")),
            cue: Some(cue("q")),
            ..Context::default()
        };
        assert!(!c.dismiss(Some("old")));
        assert!(c.dismiss(Some("q")));
        assert!(c.notification.is_some());
        c.notification.as_mut().unwrap().expires_at = 0;
        assert!(c.expire());
        assert!(c.music_playing);
    }
}
