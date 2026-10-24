//! Real WebKit/Tauri regression: bundled React survives an absent/restarted private fixture daemon.
//! Opt-in only, separate browser storage and briefly shown unfocused fixture windows.
//! No real sessions, installed service or other application windows are used.
use javascriptcore::ValueExt;
use std::{
    io::Write,
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use webkit2gtk::WebViewExt;

struct FixturePort {
    port: u16,
    connection_ready: Arc<AtomicBool>,
    companion: Mutex<serde_json::Value>,
}
#[tauri::command]
async fn connection_info(
    state: tauri::State<'_, FixturePort>,
) -> Result<crate::config::ConnectionInfo, String> {
    let port = state.port;
    let ready = state.connection_ready.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let deadline = Instant::now() + Duration::from_secs(30);
        while !ready.load(Ordering::Acquire) {
            assert!(Instant::now() < deadline, "fixture IPC was never released");
            std::thread::sleep(Duration::from_millis(10));
        }
        crate::config::connection_info(port, "isolated-native-fixture")
    })
    .await
    .map_err(|error| error.to_string())
}
fn fixture_companion() -> serde_json::Value {
    serde_json::json!({"enabled":true,"motion":true,"appearances":false,"pinned":false,"areas":[],"monitors":[],"visible":true,"paused":false,"travelling":true,"available":true})
}
#[tauri::command]
fn desktop_companion_get(state: tauri::State<'_, FixturePort>) -> serde_json::Value {
    state.companion.lock().unwrap().clone()
}
#[tauri::command]
fn desktop_companion_interaction(
    state: tauri::State<'_, FixturePort>,
    active: bool,
) -> serde_json::Value {
    let mut companion = state.companion.lock().unwrap();
    companion["paused"] = active.into();
    if active {
        companion["travelling"] = false.into();
    }
    companion.clone()
}
#[tauri::command]
fn desktop_companion_menu(state: tauri::State<'_, FixturePort>) -> serde_json::Value {
    state.companion.lock().unwrap().clone()
}
struct FixtureAck(AtomicBool, Mutex<std::collections::BTreeMap<String, usize>>);
#[tauri::command]
fn desktop_companion_context_ready(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, FixtureAck>,
    id: String,
) -> Result<crate::desktop_companion::State, String> {
    *state.1.lock().unwrap().entry(id.clone()).or_default() += 1;
    if state.0.load(Ordering::Acquire) {
        return Err("Isolated fixture dropped the paint receipt".into());
    }
    Ok(crate::desktop_companion::desktop_companion_context_ready(
        app, window, id,
    ))
}
fn emit_companion(app: &tauri::App, value: serde_json::Value) {
    *app.state::<FixturePort>().companion.lock().unwrap() = value.clone();
    app.emit_to("dot", "dot://desktop-companion", value)
        .unwrap();
}
struct Daemon(Child);
impl Daemon {
    fn command(&mut self, text: &str) {
        writeln!(self.0.stdin.as_mut().unwrap(), "{text}").unwrap();
        self.0.stdin.as_mut().unwrap().flush().unwrap();
    }
}
impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
#[allow(deprecated)]
fn pump(app: &mut tauri::App, duration: Duration) {
    let end = Instant::now() + duration;
    while Instant::now() < end {
        app.run_iteration(|_, _| {});
        std::thread::sleep(Duration::from_millis(5));
    }
}
fn evaluate(app: &mut tauri::App, label: &str, script: &str) -> String {
    let (tx, rx) = mpsc::sync_channel(1);
    let script = script.to_owned();
    app.get_webview_window(label)
        .unwrap()
        .with_webview(move |native| {
            native.inner().evaluate_javascript(
                &script,
                None,
                None,
                None::<&webkit2gtk::gio::Cancellable>,
                move |result| {
                    let _ = tx.send(
                        result
                            .map(|v| v.to_str().to_string())
                            .map_err(|e| e.to_string()),
                    );
                },
            );
        })
        .unwrap();
    let end = Instant::now() + Duration::from_secs(10);
    loop {
        pump(app, Duration::from_millis(10));
        if let Ok(value) = rx.try_recv() {
            return value.unwrap();
        }
        assert!(Instant::now() < end, "WebKit evaluation did not complete");
    }
}
fn wait_for(app: &mut tauri::App, label: &str, expression: &str) {
    let end = Instant::now() + Duration::from_secs(25);
    loop {
        if evaluate(app, label, expression) == "true" {
            return;
        }
        assert!(
            Instant::now() < end,
            "native DOM did not satisfy: {expression}"
        );
        pump(app, Duration::from_millis(100));
    }
}
struct Snapshot {
    width: i32,
    height: i32,
    pixels: Vec<u8>,
}
impl Snapshot {
    fn changed_pixels(&self, other: &Self) -> usize {
        assert_eq!((self.width, self.height), (other.width, other.height));
        assert_eq!(self.pixels.len(), other.pixels.len());
        self.pixels
            .chunks_exact(4)
            .zip(other.pixels.chunks_exact(4))
            .filter(|(a, b)| a != b)
            .count()
    }
}
fn snapshot(app: &mut tauri::App, label: &str, output: &str) -> Snapshot {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join(format!("../../../.cache/native-frontend-{output}.png"));
    let output_path = path.clone();
    let (tx, rx) = mpsc::sync_channel(1);
    app.get_webview_window(label)
        .unwrap()
        .with_webview(move |native| {
            native.inner().snapshot(
                webkit2gtk::SnapshotRegion::FullDocument,
                webkit2gtk::SnapshotOptions::TRANSPARENT_BACKGROUND,
                None::<&webkit2gtk::gio::Cancellable>,
                move |result| {
                    let saved = result.map_err(|e| e.to_string()).and_then(|surface| {
                        std::fs::create_dir_all(output_path.parent().unwrap())
                            .map_err(|e| e.to_string())?;
                        surface
                            .write_to_png(
                                &mut std::fs::File::create(output_path)
                                    .map_err(|e| e.to_string())?,
                            )
                            .map_err(|e| e.to_string())
                    });
                    let _ = tx.send(saved);
                },
            );
        })
        .unwrap();
    let end = Instant::now() + Duration::from_secs(10);
    loop {
        pump(app, Duration::from_millis(10));
        if let Ok(value) = rx.try_recv() {
            value.unwrap();
            break;
        }
        assert!(Instant::now() < end, "WebKit snapshot did not complete");
    }
    // Compare decoded pixels, not PNG file bytes: compression or metadata alone must
    // never count as a rendered animation frame.
    let mut image =
        cairo::ImageSurface::create_from_png(&mut std::fs::File::open(path).unwrap()).unwrap();
    let width = image.width();
    let height = image.height();
    let pixels = image.data().unwrap().to_vec();
    Snapshot {
        width,
        height,
        pixels,
    }
}
fn result_while_pumping<T>(app: &mut tauri::App, rx: &mpsc::Receiver<T>, timeout: Duration) -> T {
    let deadline = Instant::now() + timeout;
    loop {
        pump(app, Duration::from_millis(5));
        if let Ok(value) = rx.try_recv() {
            return value;
        }
        assert!(
            Instant::now() < deadline,
            "isolated native operation timed out"
        );
    }
}
fn offer_on_private_bus(id: &str) -> mpsc::Receiver<(bool, Duration)> {
    let (tx, rx) = mpsc::channel();
    let id = id.to_owned();
    std::thread::spawn(move || {
        let conn = dbus::blocking::Connection::new_session().unwrap();
        let start = Instant::now();
        let (accepted,): (bool,) = conn
            .with_proxy(
                crate::desktop_context::BUS_NAME,
                crate::desktop_context::BUS_PATH,
                Duration::from_secs(3),
            )
            .method_call(
                crate::desktop_context::BUS_INTERFACE,
                "OfferNotification",
                (
                    id.clone(),
                    format!("Aviso de prueba aislada {id}"),
                    "Este contenido pertenece únicamente a la prueba de Capri.",
                ),
            )
            .unwrap();
        tx.send((accepted, start.elapsed())).unwrap();
    });
    rx
}
fn offer_v2_on_private_bus(
    id: &str,
    summary: &str,
    metadata: serde_json::Value,
) -> mpsc::Receiver<(bool, Duration)> {
    let (tx, rx) = mpsc::channel();
    let id = id.to_owned();
    let summary = summary.to_owned();
    std::thread::spawn(move || {
        let conn = dbus::blocking::Connection::new_session().unwrap();
        let start = Instant::now();
        let (accepted,): (bool,) = conn
            .with_proxy(
                crate::desktop_context::BUS_NAME,
                crate::desktop_context::BUS_PATH,
                Duration::from_secs(3),
            )
            .method_call(
                crate::desktop_context::BUS_INTERFACE,
                "OfferNotificationV2",
                (
                    id,
                    summary,
                    "Contenido ficticio, sólo para comprobar Capri.",
                    metadata.to_string(),
                ),
            )
            .unwrap();
        tx.send((accepted, start.elapsed())).unwrap();
    });
    rx
}
fn cancel_while_pumping(app: &mut tauri::App, id: &str) {
    let id = id.to_owned();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        cancel_on_private_bus(&id);
        tx.send(()).unwrap();
    });
    result_while_pumping(app, &rx, Duration::from_secs(3));
    pump(app, Duration::from_millis(80));
}
fn cancel_on_private_bus(id: &str) {
    let conn = dbus::blocking::Connection::new_session().unwrap();
    let _: () = conn
        .with_proxy(
            crate::desktop_context::BUS_NAME,
            crate::desktop_context::BUS_PATH,
            Duration::from_secs(3),
        )
        .method_call(
            crate::desktop_context::BUS_INTERFACE,
            "CancelNotification",
            (id,),
        )
        .unwrap();
}
#[test]
#[ignore = "Run only through dbus-run-session with GENTLE_DOT_CONTEXT_FIXTURE=1; isolated own-PID windows, own browser storage and fake MPRIS player"]
fn native_context_bubble_ack_timeout_pin_and_mpris_are_real() {
    assert_eq!(
        std::env::var("GENTLE_DOT_CONTEXT_FIXTURE").as_deref(),
        Ok("1")
    );
    let data =
        std::env::temp_dir().join(format!("gentle-dot-native-context-{}", std::process::id()));
    std::fs::create_dir_all(&data).unwrap();
    std::fs::write(
        data.join("desktop-companion.json"),
        r#"{"enabled":true,"motion":true,"appearances":false,"pinned":true}"#,
    )
    .unwrap();
    let connection_ready = Arc::new(AtomicBool::new(false));
    let mut app = tauri::Builder::default()
        .any_thread()
        .manage(FixtureAck(
            AtomicBool::new(false),
            Mutex::new(Default::default()),
        ))
        .manage(FixturePort {
            port: 9,
            connection_ready: connection_ready.clone(),
            companion: Mutex::new(fixture_companion()),
        })
        .invoke_handler(tauri::generate_handler![
            connection_info,
            crate::desktop_companion::desktop_companion_get,
            crate::desktop_companion::desktop_companion_interaction,
            crate::desktop_companion::desktop_companion_context,
            desktop_companion_context_ready,
            crate::desktop_companion::desktop_companion_context_dismiss,
            crate::desktop_companion::desktop_companion_context_open
        ])
        .build(tauri::generate_context!())
        .unwrap();
    crate::desktop_companion::init(app.handle(), &data);
    for (label, title, w, h) in [
        ("dot", crate::platform::DOT_TITLE, 156., 156.),
        (
            "companion-launcher",
            crate::desktop_companion::LAUNCHER_TITLE,
            56.,
            56.,
        ),
        (
            "companion-bubble",
            crate::desktop_companion::BUBBLE_TITLE,
            crate::desktop_companion::BUBBLE_WIDTH as f64,
            crate::desktop_companion::BUBBLE_HEIGHT as f64,
        ),
    ] {
        WebviewWindowBuilder::new(
            &app,
            label,
            WebviewUrl::App(format!("index.html?surface={label}").into()),
        )
        .title(title)
        .inner_size(w, h)
        .min_inner_size(w, h)
        .max_inner_size(w, h)
        .resizable(true)
        .visible(false)
        .decorations(false)
        .transparent(true)
        .skip_taskbar(true)
        .data_directory(data.join(label))
        .build()
        .unwrap();
    }
    crate::desktop_companion::start(app.handle());
    wait_for(
        &mut app,
        "dot",
        "!!document.querySelector('.desktop-companion-surface[data-pinned=true]')",
    );
    wait_for(
        &mut app,
        "companion-bubble",
        "document.getElementById('root').childElementCount>0",
    );
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let h = app.handle().clone();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            tx.send(
                tauri::async_runtime::block_on(crate::desktop_companion::desktop_companion_get(h))
                    .unwrap(),
            )
            .unwrap()
        });
        if result_while_pumping(&mut app, &rx, Duration::from_secs(3))
            .context
            .notifications_available
        {
            break;
        }
        assert!(Instant::now() < deadline);
        pump(&mut app, Duration::from_millis(50));
    }
    let own_position = || {
        let clients = crate::computer::linux::hypr("clients").unwrap();
        clients
            .as_array()
            .unwrap()
            .iter()
            .find(|w| {
                w["pid"].as_u64() == Some(std::process::id() as u64)
                    && w["title"].as_str() == Some(crate::platform::DOT_TITLE)
            })
            .unwrap()["at"]
            .clone()
    };
    wait_for(
        &mut app,
        "dot",
        "!!document.querySelector('.desktop-companion-surface[data-visible=true]')",
    );
    wait_for(&mut app,"dot","(()=>{const src=document.querySelector('.desktop-companion-surface svg image')?.getAttribute('href');if(!src)return false;const assets=window.__fixtureLoadedAtlas??=Object.create(null);if(!(src in assets)){assets[src]=false;const img=new Image();img.onload=()=>{assets[src]=img.naturalWidth>0};img.src=src}return assets[src]===true})()");
    let before = own_position();
    let traveler_style = evaluate(&mut app,"dot","(()=>{const el=document.querySelector('.desktop-companion-surface');el.focus({preventScroll:true});const s=getComputedStyle(el);return JSON.stringify({outline:s.outlineStyle,shadow:s.boxShadow,border:s.borderTopWidth,background:s.backgroundColor})})()");
    let traveler_style: serde_json::Value = serde_json::from_str(&traveler_style).unwrap();
    assert_eq!(traveler_style["outline"], "none");
    assert_eq!(traveler_style["shadow"], "none");
    assert_eq!(traveler_style["border"], "0px");
    assert_eq!(traveler_style["background"], "rgba(0, 0, 0, 0)");
    let focused_traveler = snapshot(&mut app, "dot", "context-traveler-focused");
    assert!(focused_traveler.pixels.chunks_exact(4).any(|p| p[3] > 0));
    assert_eq!(focused_traveler.pixels[3], 0);
    let launcher_clients = crate::computer::linux::hypr("clients").unwrap();
    let launcher = launcher_clients
        .as_array()
        .unwrap()
        .iter()
        .find(|w| {
            w["pid"].as_u64() == Some(std::process::id() as u64)
                && w["title"].as_str() == Some(crate::desktop_companion::LAUNCHER_TITLE)
        })
        .unwrap();
    for (key, expected) in [
        ("border_size", serde_json::json!(0)),
        ("decorate", serde_json::json!(false)),
    ] {
        let out = crate::computer::linux::run(
            "hyprctl",
            &[
                "-j",
                "getprop",
                &format!("address:{}", launcher["address"].as_str().unwrap()),
                key,
            ],
            None,
        )
        .unwrap();
        let value: serde_json::Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(
            value[key], expected,
            "launcher inherited a workspace decoration"
        );
    }
    let offered = offer_on_private_bus("fixture-rendered");
    let (accepted, elapsed) = result_while_pumping(&mut app, &offered, Duration::from_secs(3));
    assert!(
        accepted,
        "real WebKit double-RAF did not acknowledge the visible bubble in time"
    );
    assert!(
        elapsed < Duration::from_millis(600),
        "ACK transport took {elapsed:?}"
    );
    assert_eq!(
        before,
        own_position(),
        "notification moved a pinned traveler"
    );
    wait_for(
        &mut app,
        "companion-bubble",
        "document.body.textContent.includes('Aviso de prueba aislada')",
    );
    let clients = crate::computer::linux::hypr("clients").unwrap();
    let own_bubble = clients
        .as_array()
        .unwrap()
        .iter()
        .find(|w| {
            w["pid"].as_u64() == Some(std::process::id() as u64)
                && w["title"].as_str() == Some(crate::desktop_companion::BUBBLE_TITLE)
        })
        .unwrap();
    let bubble_size = own_bubble["size"].clone();
    assert_eq!(bubble_size, serde_json::json!([220, 80]));
    let bubble = snapshot(&mut app, "companion-bubble", "context-bubble");
    assert!(bubble.pixels.chunks_exact(4).any(|pixel| pixel[3] > 0));
    let handle = app.handle().clone();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        tx.send(crate::desktop_companion::prepare_control(&handle, 701))
            .unwrap();
    });
    result_while_pumping(&mut app, &rx, Duration::from_secs(3)).unwrap();
    {
        use gtk::prelude::*;
        let native: gtk::Window = app
            .get_webview_window("companion-bubble")
            .unwrap()
            .gtk_window()
            .unwrap()
            .into();
        assert_eq!(native.child().unwrap().opacity(), 0.);
    }
    crate::desktop_companion::restore_control(app.handle(), 701);
    pump(&mut app, Duration::from_millis(100));
    // Exercise the original OS owner's closing signal through the cancellation method.
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        cancel_on_private_bus("fixture-rendered");
        tx.send(()).unwrap();
    });
    result_while_pumping(&mut app, &rx, Duration::from_secs(3));
    wait_for(
        &mut app,
        "companion-bubble",
        "!document.body.textContent.includes('Aviso de prueba aislada')",
    );
    pump(&mut app, Duration::from_millis(120));
    let message = offer_v2_on_private_bus(
        "fixture-origin-message",
        "Mensaje nuevo",
        serde_json::json!({"appName":"Slack","sender":"Alex Rivera"}),
    );
    let (message_accepted, message_elapsed) =
        result_while_pumping(&mut app, &message, Duration::from_secs(3));
    assert!(
        message_accepted,
        "Source notification must paint before ACK (elapsed={:?}, own size={:?})",
        message_elapsed,
        crate::computer::linux::hypr("clients")
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .filter(|w| w["pid"].as_u64() == Some(std::process::id() as u64)
                && w["title"].as_str() == Some(crate::desktop_companion::BUBBLE_TITLE))
            .map(|w| w["size"].clone())
            .collect::<Vec<_>>()
    );
    assert!(message_elapsed < Duration::from_millis(600));
    wait_for(
        &mut app,
        "companion-bubble",
        "document.body.textContent.includes('Alex Rivera')",
    );
    let clients = crate::computer::linux::hypr("clients").unwrap();
    let message_window = clients
        .as_array()
        .unwrap()
        .iter()
        .find(|w| {
            w["pid"].as_u64() == Some(std::process::id() as u64)
                && w["title"].as_str() == Some(crate::desktop_companion::BUBBLE_TITLE)
        })
        .unwrap();
    assert_eq!(message_window["size"], serde_json::json!([260, 96]));
    let message_image = snapshot(&mut app, "companion-bubble", "context-source-message");
    assert!(message_image.pixels.chunks_exact(4).any(|p| p[3] > 0));
    cancel_while_pumping(&mut app, "fixture-origin-message");
    evaluate(
        &mut app,
        "dot",
        r#"(()=>{window.__visualFixture=[];const save=()=>{const el=document.querySelector('.desktop-companion-surface');const sprite=el?.querySelector('.capri-sprite');window.__visualFixture.push({at:performance.now(),surface:el?{...el.dataset}:null,sprite:sprite?{...sprite.dataset}:null,hidden:document.hidden});};window.__visualObserver=new MutationObserver(save);window.__visualObserver.observe(document.body,{attributes:true,subtree:true,childList:true,attributeFilter:['data-context','data-animation','data-visible']});save();return true})()"#,
    );
    for (id, title, source) in [
        (
            "fixture-capture",
            "Screenshot Saved",
            serde_json::json!({"appName":"Screenshot"}),
        ),
        (
            "fixture-download",
            "Download complete",
            serde_json::json!({"appName":"aria2","category":"transfer.complete"}),
        ),
    ] {
        let offered = offer_v2_on_private_bus(id, title, source);
        let (accepted, elapsed) = result_while_pumping(&mut app, &offered, Duration::from_secs(3));
        assert!(accepted, "Visual receipt must come from the real traveler: id={id} elapsed={elapsed:?}, diagnostic={}", evaluate(&mut app, "dot", "JSON.stringify(window.__visualFixture)"));
        assert!(elapsed < Duration::from_millis(600));
        wait_for(
            &mut app,
            "dot",
            "!!document.querySelector('.capri-sprite[data-animation=file-away]')",
        );
        {
            use gtk::prelude::*;
            let native: gtk::Window = app
                .get_webview_window("companion-bubble")
                .unwrap()
                .gtk_window()
                .unwrap()
                .into();
            assert_eq!(native.child().unwrap().opacity(), 0.);
        }
        let visual = snapshot(&mut app, "dot", id);
        assert!(visual.pixels.chunks_exact(4).any(|p| p[3] > 0));
        pump(&mut app, Duration::from_millis(250));
        assert_eq!(
            app.state::<FixtureAck>().1.lock().unwrap().get(id).copied(),
            Some(1),
            "A state reply must not cause another visual ACK"
        );
        cancel_while_pumping(&mut app, id);
    }
    app.state::<FixtureAck>().0.store(true, Ordering::Release);
    let visual_without_ack = offer_v2_on_private_bus(
        "fixture-capture-noack",
        "Screenshot Saved",
        serde_json::json!({"appName":"Screenshot"}),
    );
    let (accepted, visual_timeout) =
        result_while_pumping(&mut app, &visual_without_ack, Duration::from_secs(3));
    assert!(!accepted);
    assert!(visual_timeout < Duration::from_millis(600));
    pump(&mut app, Duration::from_millis(80));
    app.state::<FixtureAck>().0.store(true, Ordering::Release);
    evaluate(&mut app,"companion-bubble","window.__burstSeen=false;window.__burstObserver=new MutationObserver(()=>{if(document.body.textContent.includes('fixture-burst-rejected'))window.__burstSeen=true});window.__burstObserver.observe(document.body,{subtree:true,childList:true,characterData:true});true");
    let missing_ack = offer_on_private_bus("fixture-no-ack");
    pump(&mut app, Duration::from_millis(40));
    let burst = offer_on_private_bus("fixture-burst-rejected");
    let (burst_accepted, burst_latency) =
        result_while_pumping(&mut app, &burst, Duration::from_secs(2));
    assert!(!burst_accepted);
    assert!(
        burst_latency < Duration::from_millis(250),
        "an offer queued behind another notification's ACK"
    );
    let (cancel_tx, cancel_rx) = mpsc::channel();
    std::thread::spawn(move || {
        cancel_on_private_bus("fixture-burst-rejected");
        cancel_tx.send(()).unwrap();
    });
    result_while_pumping(&mut app, &cancel_rx, Duration::from_millis(250));
    let (accepted, timeout) = result_while_pumping(&mut app, &missing_ack, Duration::from_secs(3));
    assert!(!accepted);
    assert!(timeout < Duration::from_millis(600));
    pump(&mut app, Duration::from_millis(700));
    assert_eq!(
        evaluate(&mut app, "companion-bubble", "window.__burstSeen"),
        "false"
    );
    {
        use gtk::prelude::*;
        let native: gtk::Window = app
            .get_webview_window("companion-bubble")
            .unwrap()
            .gtk_window()
            .unwrap()
            .into();
        assert_eq!(native.child().unwrap().opacity(), 0.);
    }
    app.state::<FixtureAck>().0.store(false, Ordering::Release);
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        cancel_on_private_bus("fixture-pre-cancelled");
        tx.send(()).unwrap();
    });
    result_while_pumping(&mut app, &rx, Duration::from_secs(3));
    let cancelled = offer_on_private_bus("fixture-pre-cancelled");
    assert!(!result_while_pumping(&mut app, &cancelled, Duration::from_secs(3)).0);
    // A fake MPRIS player sends only standard PlaybackStatus changes on this private bus.
    let player_stop = Arc::new(AtomicBool::new(false));
    let stopped = player_stop.clone();
    let (play_tx, play_rx) = mpsc::channel::<bool>();
    std::thread::spawn(move || {
        use dbus::channel::Sender;
        let conn = dbus::blocking::Connection::new_session().unwrap();
        conn.request_name("org.mpris.MediaPlayer2.gentle_fixture", false, false, true)
            .unwrap();
        let mut playing = false;
        while !stopped.load(Ordering::Acquire) {
            if let Ok(next) = play_rx.try_recv() {
                playing = next;
                let mut props = dbus::arg::PropMap::new();
                props.insert(
                    "PlaybackStatus".into(),
                    dbus::arg::Variant(Box::new(if playing {
                        "Playing".to_string()
                    } else {
                        "Paused".to_string()
                    })),
                );
                let signal = dbus::Message::new_signal(
                    "/org/mpris/MediaPlayer2",
                    "org.freedesktop.DBus.Properties",
                    "PropertiesChanged",
                )
                .unwrap()
                .append3(
                    "org.mpris.MediaPlayer2.Player",
                    props,
                    Vec::<String>::new(),
                );
                conn.send(signal).unwrap();
            }
            if let Some(m) = conn
                .channel()
                .blocking_pop_message(Duration::from_millis(20))
                .unwrap()
            {
                if m.member().is_some_and(|s| s == "Get") {
                    conn.send(m.method_return().append1(dbus::arg::Variant(if playing {
                        "Playing".to_string()
                    } else {
                        "Paused".to_string()
                    })))
                    .unwrap();
                }
            }
        }
    });
    pump(&mut app, Duration::from_millis(400));
    play_tx.send(true).unwrap();
    wait_for(&mut app,"dot","!!document.querySelector('.capri-sprite[data-animation=dancing],.capri-sprite[data-animation=headphones]')");
    play_tx.send(false).unwrap();
    wait_for(&mut app,"dot","!document.querySelector('.capri-sprite[data-animation=dancing],.capri-sprite[data-animation=headphones]')");
    assert_eq!(before, own_position());
    player_stop.store(true, Ordering::Release);
    let handle = app.handle().clone();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let state = tauri::async_runtime::block_on(
            crate::desktop_companion::desktop_companion_get(handle.clone()),
        )
        .unwrap();
        let areas = state
            .monitors
            .into_iter()
            .map(|m| crate::desktop_companion::AllowedArea {
                monitor: m.name,
                enabled: false,
                rect: crate::desktop_companion::NormalizedRect::default(),
            })
            .collect();
        tx.send(tauri::async_runtime::block_on(
            crate::desktop_companion::desktop_companion_set(
                handle,
                crate::desktop_companion::Patch {
                    areas: Some(areas),
                    ..Default::default()
                },
            ),
        ))
        .unwrap();
    });
    let excluded = result_while_pumping(&mut app, &rx, Duration::from_secs(3)).unwrap();
    assert!(!excluded.visible);
    let no_area = offer_on_private_bus("fixture-no-permitted-area");
    assert!(!result_while_pumping(&mut app, &no_area, Duration::from_secs(3)).0);
    let evidence = serde_json::json!({"verified":true,"privateBus":true,"realWebKitAck":true,"ackMs":elapsed.as_millis(),"timeoutMs":timeout.as_millis(),"missingAckFallsBack":true,"burstRejectedMs":burst_latency.as_millis(),"cancellationDidNotWaitForAck":true,"rejectedBurstNeverPainted":true,"cancelBeforeOfferRejected":true,"pinnedPositionPreserved":true,"mprisPlayingAndPauseObserved":true,"bubbleMaskedDuringControl":true,"launcherNativeBorderDisabled":true,"compactBubbleBoundsVerified":true,"sourceBubbleBoundsVerified":true,"sourceBubbleLogicalSize":[260,96],"visualOnlyReceiptFromTraveler":true,"visualOnlyReceiptOnce":true,"visualOnlyBubbleHidden":true,"visualOnlyMissingAckFallsBack":true,"visualOnlyMissingAckMs":visual_timeout.as_millis(),"bubbleLogicalSize":bubble_size,"focusedTravelerNoFrame":true,"excludedAreasRejectOffer":true,"bubblePixels":bubble.pixels.chunks_exact(4).filter(|p|p[3]>0).count()});
    std::fs::write(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../.cache/native-context-smoke.json"),
        serde_json::to_string_pretty(&evidence).unwrap(),
    )
    .unwrap();
    crate::desktop_companion::stop(app.handle());
    connection_ready.store(true, Ordering::Release);
    for window in app.webview_windows().values() {
        window.destroy().unwrap();
    }
    pump(&mut app, Duration::from_millis(50));
    app.cleanup_before_exit();
    let _ = std::fs::remove_dir_all(data);
}
#[test]
#[ignore = "Requires Hyprland, built UI and --features custom-protocol; briefly maps isolated unfocused fixture windows and a loopback server"]
fn bundled_frontend_cold_start_and_daemon_reconnect_keep_the_real_document() {
    let reserve = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = reserve.local_addr().unwrap().port();
    drop(reserve);
    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/frontend-daemon.mjs");
    let mut daemon = Daemon(
        Command::new("node")
            .arg(fixture)
            .arg(port.to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap(),
    );
    let data =
        std::env::temp_dir().join(format!("gentle-dot-native-frontend-{}", std::process::id()));
    std::fs::create_dir_all(&data).unwrap();
    let connection_ready = Arc::new(AtomicBool::new(false));
    let mut app = tauri::Builder::default()
        .any_thread()
        .manage(FixturePort {
            port,
            connection_ready: connection_ready.clone(),
            companion: Mutex::new(fixture_companion()),
        })
        .invoke_handler(tauri::generate_handler![
            connection_info,
            desktop_companion_get,
            desktop_companion_interaction,
            desktop_companion_menu
        ])
        .build(tauri::generate_context!())
        .unwrap();
    let mut mapping_rules = Vec::new();
    for (label, surface, w, h) in [
        ("panel", "panel", 420., 640.),
        ("dot", "dot", 156., 156.),
        ("companion-launcher", "companion-launcher", 56., 56.),
    ] {
        let rule = crate::desktop_companion::MappingRule::install(
            "fixture",
            &crate::desktop_companion::nonce().unwrap(),
        )
        .unwrap();
        eprintln!(
            "gentle-dot fixture surface label={label} title={}",
            rule.title
        );
        let window = WebviewWindowBuilder::new(
            &app,
            label,
            WebviewUrl::App(format!("index.html?surface={surface}").into()),
        )
        .title(&rule.title)
        .on_page_load(crate::frontend::page_loaded)
        .on_navigation(crate::navigation::handler(app.handle().clone()))
        .inner_size(w, h)
        .min_inner_size(w, h)
        .max_inner_size(w, h)
        .resizable(true)
        .visible(false)
        .decorations(false)
        .transparent(true)
        .skip_taskbar(true)
        .data_directory(data.join(label))
        .build()
        .unwrap();
        window.show().unwrap();
        // These are rendering fixtures, not controls. Keep the pointer from pausing a clip
        // or intercepting input when a fixture happens to map near the user's cursor.
        let native: gtk::Window = window.gtk_window().unwrap().into();
        gtk::prelude::WidgetExt::input_shape_combine_region(
            &native,
            Some(&gtk::cairo::Region::create()),
        );
        mapping_rules.push(rule);
    }
    wait_for(
        &mut app,
        "companion-launcher",
        "!!document.querySelector('.desktop-companion-launcher svg image')",
    );
    wait_for(
        &mut app,
        "dot",
        "!!document.querySelector('.desktop-companion-surface svg image')",
    );
    assert!(evaluate(&mut app, "panel", "location.href").starts_with("tauri://localhost/"));
    wait_for(
        &mut app,
        "panel",
        "!!document.querySelector('.chat textarea')",
    );
    assert_eq!(
        evaluate(
            &mut app,
            "panel",
            "document.querySelector('.chat textarea').disabled"
        ),
        "true"
    );
    evaluate(
        &mut app,
        "panel",
        "window.__nativeDocumentProbe='preserved'",
    );
    evaluate(
        &mut app,
        "companion-launcher",
        r#"(()=>{ const href=document.querySelector('svg image').getAttribute('href'); const img=new Image(); img.onload=()=>{window.__nativeAssetOK=img.naturalWidth>100}; img.onerror=()=>{window.__nativeAssetOK=false}; img.src=href; return true; })()"#,
    );
    wait_for(
        &mut app,
        "companion-launcher",
        "window.__nativeAssetOK===true",
    );
    // Exercise real frame cropping in WebKit while connection_info is still pending. DOM
    // metadata is limited to the app's sprite frame/crop; no conversation content is logged.
    wait_for(
        &mut app,
        "dot",
        "!!document.querySelector('.capri-sprite[data-animation=walk][data-playing=true] svg')",
    );
    let first_frame = evaluate(
        &mut app,
        "dot",
        r#"(()=>{window.__nativeReadFrame=()=>{const s=document.querySelector('.capri-sprite[data-animation=walk]');if(!s)return null;const c=s.querySelector('clipPath polygon,clipPath rect');return {action:s.dataset.animation,frame:s.dataset.frame,viewBox:s.querySelector('svg').getAttribute('viewBox'),transform:s.querySelector('svg > g').getAttribute('transform'),clip:JSON.stringify(c.tagName==='polygon'?{shape:'polygon',points:c.getAttribute('points')}:{shape:'rect',x:c.getAttribute('x'),y:c.getAttribute('y'),width:c.getAttribute('width'),height:c.getAttribute('height')})}};window.__nativeFrameProbe=window.__nativeReadFrame();return JSON.stringify(window.__nativeFrameProbe)})()"#,
    );
    let first_pixels = snapshot(&mut app, "dot", "walk-start");
    wait_for(
        &mut app,
        "dot",
        r#"(()=>{const n=window.__nativeReadFrame(),p=window.__nativeFrameProbe;const changed=!!n && n.frame!==p.frame && n.transform!==p.transform && n.clip!==p.clip && n.viewBox===p.viewBox;if(changed)window.__nativeNextFrameProbe=n;return changed})()"#,
    );
    let second_frame = evaluate(
        &mut app,
        "dot",
        "JSON.stringify(window.__nativeNextFrameProbe)",
    );
    let mut changed_pixels = first_pixels.changed_pixels(&snapshot(&mut app, "dot", "walk-next"));
    // A snapshot callback may land one complete animation cycle after the first one.
    // Retry actual rendering briefly, with a bounded deadline, instead of accepting
    // a metadata-only change or relying on the exact timing of WebKit's callback.
    let frame_deadline = Instant::now() + Duration::from_secs(3);
    while changed_pixels == 0 && Instant::now() < frame_deadline {
        pump(&mut app, Duration::from_millis(70));
        changed_pixels = first_pixels.changed_pixels(&snapshot(&mut app, "dot", "walk-next"));
    }
    assert!(
        changed_pixels > 0,
        "animation changed metadata but not WebKit pixels"
    );
    let mut stopped_travel = fixture_companion();
    stopped_travel["travelling"] = false.into();
    emit_companion(&app, stopped_travel.clone());
    wait_for(
        &mut app,
        "dot",
        "!!document.querySelector('.capri-sprite[data-animation]:not([data-animation=walk])')",
    );
    // Fixing the location and hovering pause travel only. Real WebKit must continue
    // advancing the relaxed gesture clip while the fixture IPC remains unresolved.
    stopped_travel["pinned"] = true.into();
    emit_companion(&app, stopped_travel);
    wait_for(&mut app, "dot", "!!document.querySelector('.desktop-companion-surface[data-pinned=true][data-motion=false][data-animated=true] .capri-sprite[data-animation=chill][data-playing=true]')");
    evaluate(
        &mut app,
        "dot",
        "window.__pinnedFrame=document.querySelector('.capri-sprite').dataset.frame",
    );
    let pinned_pixels = snapshot(&mut app, "dot", "pinned-start");
    evaluate(&mut app,"dot","document.querySelector('.desktop-companion-surface').dispatchEvent(new MouseEvent('mouseover',{bubbles:true}))");
    wait_for(&mut app,"dot","(()=>{const e=document.querySelector('.desktop-companion-surface'),s=e.querySelector('.capri-sprite');return e.dataset.pinned==='true'&&e.dataset.motion==='false'&&e.dataset.animated==='true'&&s.dataset.playing==='true'&&s.dataset.frame!==window.__pinnedFrame})()");
    let mut pinned_changed_pixels =
        pinned_pixels.changed_pixels(&snapshot(&mut app, "dot", "pinned-hover-next"));
    let pinned_deadline = Instant::now() + Duration::from_secs(3);
    while pinned_changed_pixels == 0 && Instant::now() < pinned_deadline {
        pump(&mut app, Duration::from_millis(70));
        pinned_changed_pixels =
            pinned_pixels.changed_pixels(&snapshot(&mut app, "dot", "pinned-hover-next"));
    }
    assert!(
        pinned_changed_pixels > 0,
        "pin/hover froze the actual gesture pixels"
    );
    assert!(
        app.state::<FixturePort>().companion.lock().unwrap()["paused"]
            .as_bool()
            .unwrap()
    );
    // Exercise the same native opacity/input restoration used by computer control,
    // with both owned windows mapped throughout. The launcher never overlaps Capri.
    for visible in [true, false, true] {
        eprintln!("gentle-dot fixture native-visibility begin traveler={visible}");
        crate::desktop_companion::paint_pair(app.handle(), visible).unwrap();
        for (label, expected) in [("dot", visible), ("companion-launcher", !visible)] {
            use gtk::prelude::*;
            let native: gtk::Window = app
                .get_webview_window(label)
                .unwrap()
                .gtk_window()
                .unwrap()
                .into();
            assert_eq!(
                native.child().unwrap().opacity(),
                if expected { 1. } else { 0. }
            );
            assert!(native.is_visible());
        }
        pump(&mut app, Duration::from_millis(40));
        eprintln!("gentle-dot fixture native-visibility verified traveler={visible}");
        if !visible {
            snapshot(&mut app, "companion-launcher", "launcher-only");
        }
    }
    let evidence = serde_json::json!({
        "first":serde_json::from_str::<serde_json::Value>(&first_frame).unwrap(),
        "next":serde_json::from_str::<serde_json::Value>(&second_frame).unwrap(),
        "changedPixels":changed_pixels,"fixedCanvas":true,
        "pinnedHoverChangedPixels":pinned_changed_pixels,"inverseNativeVisibility":true,
        "stoppedAfterNativeEvent":true,"connectionInfoStillPending":!connection_ready.load(Ordering::Acquire),
    });
    std::fs::write(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../.cache/native-frontend-animation.json"),
        serde_json::to_string_pretty(&evidence).unwrap(),
    )
    .unwrap();
    // The real IPC waits for the daemon/keychain. Native React/assets must be ready even
    // while that promise is unresolved; the readiness probe must never depend on it.
    wait_for(
        &mut app,
        "panel",
        "Object.hasOwn(window,'__gentleDotNativeAssets')",
    );
    assert!(!connection_ready.load(Ordering::Acquire));
    connection_ready.store(true, Ordering::Release);
    daemon.command("start");
    wait_for(&mut app,"panel","!document.querySelector('.chat textarea').disabled && document.body.textContent.includes('Native fixture round 1')");
    daemon.command("stop");
    wait_for(
        &mut app,
        "panel",
        "document.querySelector('.chat textarea').disabled",
    );
    assert_eq!(
        evaluate(&mut app, "panel", "window.__nativeDocumentProbe"),
        "preserved"
    );
    daemon.command("start");
    wait_for(&mut app,"panel","!document.querySelector('.chat textarea').disabled && document.body.textContent.includes('Native fixture round 2')");
    assert_eq!(
        evaluate(&mut app, "panel", "window.__nativeDocumentProbe"),
        "preserved"
    );
    assert_eq!(
        evaluate(&mut app, "companion-launcher", "window.__nativeAssetOK"),
        "true"
    );
    snapshot(&mut app, "panel", "panel");
    snapshot(&mut app, "dot", "dot");
    snapshot(&mut app, "companion-launcher", "companion-launcher");
    daemon.command("exit");
    for window in app.webview_windows().values() {
        window.destroy().unwrap();
    }
    pump(&mut app, Duration::from_millis(50));
    app.cleanup_before_exit();
    drop(mapping_rules);
    let _ = std::fs::remove_dir_all(data);
}
