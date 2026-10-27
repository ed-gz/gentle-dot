//! Personal, local-only GLBs. No arbitrary paths, network loader or distributed models.
use std::{io::Read, path::{Path, PathBuf}, sync::Mutex};
use tauri::{Manager, Emitter};

pub const ASSETS: [&str; 10] = [
    "roja.glb", "roja_baile.glb", "roja_brazos.glb", "roja_flotando.glb", "roja_guino.glb",
    "roja_inclinada.glb", "roja_recostada_abiertos.glb", "roja_recostada_cerrados.glb",
    "roja_sentada.glb", "roja_transformacion.glb",
];
const MAX_BYTES: u64 = 64 * 1024 * 1024;
#[cfg(test)]
mod art2d_tests {
    #[test]
    fn exact_png_allowlist() {
        for name in ["capri-full.png", "cutin-grin.png", "cutin-laugh.png", "cutin-eyes.png"] {
            assert!(super::allowed_2d_asset(name), "{name}");
        }
        for name in ["../cutin-grin.png", "cutin-many.png", "intro-grab.webp"] {
            assert!(!super::allowed_2d_asset(name), "{name}");
        }
        for name in ["../capri-full.png", "/tmp/capri-full.png", "other/capri-full.png", "capri-full.jpg", "roja.glb", "unknown.png", "CAPRI-FULL.PNG"] {
            assert!(!super::allowed_2d_asset(name), "{name}");
        }
    }
}
pub fn allowed_asset(name: &str) -> bool { ASSETS.contains(&name) }
fn asset_dir() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").ok_or("No se encontró la carpeta personal")?;
    Ok(PathBuf::from(home).join(".local/share/dev.gentleman.gentle-dot/capri-3d"))
}
pub fn installed() -> bool {
    asset_dir().is_ok_and(|dir| ASSETS.iter().all(|name| dir.join(name).is_file()))
}
fn read_asset(root: &Path, name: &str) -> Result<Vec<u8>, String> {
    if !allowed_asset(name) { return Err("Modelo de Capri no permitido".into()); }
    read_local_asset(root, name, MAX_BYTES)
}
fn read_local_asset(root: &Path, name: &str, max_bytes: u64) -> Result<Vec<u8>, String> {
    let path = root.join(name);
    let meta = std::fs::symlink_metadata(&path).map_err(|_| "Instala los modelos locales de Capri 3D")?;
    if !meta.is_file() || meta.len() > max_bytes { return Err("Modelo local inválido".into()); }
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let path = path.canonicalize().map_err(|e| e.to_string())?;
    if path.parent() != Some(root.as_path()) { return Err("Modelo fuera de la carpeta local".into()); }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path).map_err(|e| e.to_string())?;
    let stat = file.metadata().map_err(|e| e.to_string())?;
    if !stat.is_file() || stat.len() > max_bytes { return Err("Modelo local inválido".into()); }
    let mut bytes = Vec::new();
    file.take(max_bytes + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > max_bytes { return Err("Modelo demasiado grande".into()); }
    Ok(bytes)
}
#[tauri::command]
pub async fn capri3d_asset(window: tauri::WebviewWindow, name: String) -> Result<tauri::ipc::Response, String> {
    if window.label() != "dot" || !allowed_asset(&name) { return Err("Modelo no permitido".into()); }
    tauri::async_runtime::spawn_blocking(move || read_asset(&asset_dir()?, &name).map(tauri::ipc::Response::new))
        .await.map_err(|e| e.to_string())?
}
/// Ported choreography/engine from https://github.com/mochiiwuff/capri-desktop (MIT); artwork not included — personal-use assets loaded locally.
const ART_2D: [&str; 4] = ["capri-full.png", "cutin-grin.png", "cutin-laugh.png", "cutin-eyes.png"];
pub fn allowed_2d_asset(name: &str) -> bool { ART_2D.contains(&name) }
#[tauri::command]
pub async fn capri2d_asset(window: tauri::WebviewWindow, name: String) -> Result<tauri::ipc::Response, String> {
    if window.label() != "dot" || !allowed_2d_asset(&name) { return Err("Imagen de Capri no permitida".into()); }
    tauri::async_runtime::spawn_blocking(move || {
        let home = std::env::var_os("HOME").ok_or("No se encontró la carpeta personal")?;
        let root = PathBuf::from(home).join(".local/share/dev.gentleman.gentle-dot/capri-desktop-art");
        read_local_asset(&root, &name, 8 * 1024 * 1024).map(tauri::ipc::Response::new)
    }).await.map_err(|e| e.to_string())?
}
#[derive(Default)]
pub struct Surface {
    pub(crate) inner: Mutex<SurfaceState>,
    pub(crate) dragging: std::sync::atomic::AtomicBool,
}
#[derive(Default)]
pub(crate) struct SurfaceState { pub active: bool, pub mask: Vec<u8>, pub bubble: bool, pub input: bool, pub body_rects: Option<Vec<(i32,i32,i32,i32)>> }
/// Compact laptop-friendly body; the renderer draws 240x340 internally and the canvas scales down.
pub(crate) const BODY_WIDTH: i32 = 144;
pub(crate) const BODY_HEIGHT: i32 = 204;
const EXPANDED_WIDTH: i32 = 320;
const BUBBLE_HEIGHT: i32 = 152;
const INPUT_HEIGHT: i32 = 88;
/// The renderer projects the hip pivot to y=244 of its 340px frame (capri3d/perch.ts).
const RENDER_SEAT_Y: i32 = 244;
const RENDER_HEIGHT: i32 = 340;
pub(crate) fn surface_dimensions(bubble: bool, input: bool) -> (i32, i32) {
    (if bubble || input { EXPANDED_WIDTH } else { BODY_WIDTH }, BODY_HEIGHT + if bubble { BUBBLE_HEIGHT } else { 0 } + if input { INPUT_HEIGHT } else { 0 })
}
/// Window-space y of Capri's seat for a surface with or without the speech bubble above her.
pub(crate) fn seat_y(bubble: bool) -> i32 {
    (if bubble { BUBBLE_HEIGHT } else { 0 }) + (RENDER_SEAT_Y * BODY_HEIGHT + RENDER_HEIGHT / 2) / RENDER_HEIGHT
}
/// True when the window has one of the 3D surface sizes; returns whether the bubble is shown.
pub(crate) fn surface_bubble(width: i32, height: i32) -> Option<bool> {
    [(false, false), (true, false), (false, true), (true, true)].into_iter()
        .find(|&(b, i)| surface_dimensions(b, i) == (width, height)).map(|(b, _)| b)
}
pub fn init(app: &tauri::AppHandle) { app.manage(Surface::default()); }
pub(crate) fn active(app: &tauri::AppHandle) -> bool {
    app.try_state::<Surface>().is_some_and(|s| s.inner.lock().unwrap().active)
}
pub(crate) fn dimensions(app: &tauri::AppHandle) -> (i32, i32) {
    let surface = app.state::<Surface>();
    let state = surface.inner.lock().unwrap();
    if state.active { surface_dimensions(state.bubble, state.input) } else { (156, 156) }
}
pub fn mask_rectangles(mask: &[u8], width: i32, height: i32) -> Result<Vec<(i32, i32, i32, i32)>, String> {
    if mask.len() != 24 * 34 || mask.iter().any(|&cell| cell > 1) || width <= 0 || height <= 0 {
        return Err("Máscara de Capri inválida".into());
    }
    let mut rects = Vec::new();
    for y in 0..34 { for x in 0..24 {
        if mask[(y * 24 + x) as usize] == 0 { continue; }
        let (left, top) = (x * width / 24, y * height / 34);
        // Ceil the far edges to avoid fractional-scale cracks.
        rects.push((left, top, ((x + 1) * width + 23) / 24 - left, ((y + 1) * height + 33) / 34 - top));
    }}
    Ok(rects)
}
#[cfg(target_os = "linux")]
pub fn mask_region(mask: &[u8], width: i32, height: i32) -> Result<gtk::cairo::Region, String> {
    let region = gtk::cairo::Region::create();
    for (x, y, w, h) in mask_rectangles(mask, width, height)? {
        region.union_rectangle(&gtk::cairo::RectangleInt::new(x, y, w, h)).map_err(|e| e.to_string())?;
    }
    Ok(region)
}
/// None means legacy sprite input; Some(empty) means canvas not yet drawn and
/// must pass through, never fall back to a large circle/rectangle.
fn validate_body_rects(rects: &[(i32,i32,i32,i32)]) -> Result<(),String> {
    if rects.len() > (BODY_WIDTH * BODY_HEIGHT) as usize || rects.iter().any(|&(x,y,w,h)| {
        x < 0 || y < 0 || w <= 0 || h <= 0 || x.checked_add(w).is_none_or(|r| r > BODY_WIDTH) || y.checked_add(h).is_none_or(|b| b > BODY_HEIGHT)
    }) { return Err("Silueta de Capri inválida".into()); }
    Ok(())
}
fn surface_input_rectangles(state: &SurfaceState) -> Result<Option<Vec<(i32,i32,i32,i32)>>, String> {
    if !state.active { return Ok(None); }
    if let Some(body) = &state.body_rects {
        validate_body_rects(body)?;
        let (width,_) = surface_dimensions(state.bubble,state.input);
        let left=(width-BODY_WIDTH)/2;
        let top=if state.bubble { BUBBLE_HEIGHT } else { 0 };
        let mut rects:Vec<_>=body.iter().map(|&(x,y,w,h)|(x+left,y+top,w,h)).collect();
        if state.bubble { rects.push((0,0,width,BUBBLE_HEIGHT)); }
        if state.input { rects.push((0,top+BODY_HEIGHT,width,INPUT_HEIGHT)); }
        return Ok(Some(rects));
    }
    if state.mask.is_empty() { return Ok(Some(vec![])); }
    let (width,height)=surface_dimensions(state.bubble,state.input);
    mask_rectangles(&state.mask,width,height).map(Some)
}
#[cfg(target_os = "linux")]
pub(crate) fn input_shape(app: &tauri::AppHandle, native: &gtk::Window) -> Result<bool, String> {
    use gtk::prelude::*;
    let s = app.state::<Surface>();
    let state = s.inner.lock().unwrap();
    let Some(rects) = surface_input_rectangles(&state)? else { return Ok(false); };
    // Requested logical size, not GTK's previous allocation during asynchronous resize.
    let region = gtk::cairo::Region::create();
    for (x,y,w,h) in rects {
        region.union_rectangle(&gtk::cairo::RectangleInt::new(x,y,w,h)).map_err(|e| e.to_string())?;
    }
    native.input_shape_combine_region(Some(&region));
    // Apply to the realized Wayland surface too; GTK's widget shape can lag a resize.
    if let Some(window) = native.window() { window.input_shape_combine_region(&region,0,0); }
    Ok(true)
}
/// Query preferred form or publish a rendered silhouette. Only the companion can publish geometry.
#[tauri::command]
pub fn capri3d_surface(app: tauri::AppHandle, window: tauri::WebviewWindow, active: Option<bool>, mask: Option<Vec<u8>>, bubble: Option<bool>, input: Option<bool>, body_rects: Option<Vec<(i32,i32,i32,i32)>>) -> Result<bool, String> {
    if window.label() != "dot" { return Err("Esta superficie pertenece a Capri".into()); }
    let preferred = crate::desktop_companion::preferred_3d(&app);
    if let Some(mask) = &mask { mask_rectangles(mask, BODY_WIDTH, BODY_HEIGHT)?; }
    if let Some(rects) = &body_rects { validate_body_rects(rects)?; }
    if let Some(wanted) = active {
        let wanted = wanted && crate::desktop_companion::preferred_canvas(&app) && crate::desktop_companion::enabled(&app);
        let (changed, shift) = {
            let s = app.state::<Surface>();
            let mut state = s.inner.lock().unwrap();
            let was_active = state.active;
            let old_dimensions = surface_dimensions(state.bubble, state.input);
            let old_top = if state.bubble { BUBBLE_HEIGHT } else { 0 };
            let bubble = wanted && bubble.unwrap_or(false);
            let input = wanted && input.unwrap_or(false);
            let changed = state.active != wanted || state.bubble != bubble || state.input != input;
            state.active = wanted;
            // Every publication carries its mode's representation; no stale 2D
            // pixel shape may survive a switch back to the coarse 3D renderer.
            state.body_rects = if wanted { body_rects } else { None };
            state.bubble = bubble;
            state.input = input;
            if let Some(mask) = mask { state.mask = mask; }
            else if state.mask.len() != 24 * 34 { state.mask = vec![0; 24 * 34]; }
            let next_dimensions = surface_dimensions(bubble, input);
            let shift = if was_active && wanted {
                ((old_dimensions.0 - next_dimensions.0) / 2, old_top - if bubble { BUBBLE_HEIGHT } else { 0 })
            } else { (0, 0) };
            (changed, shift)
        };
        if changed && crate::desktop_companion::enabled(&app) {
            let (width, height) = dimensions(&app);
            window.set_min_size(None::<tauri::LogicalSize<i32>>).map_err(|e| e.to_string())?;
            window.set_max_size(None::<tauri::LogicalSize<i32>>).map_err(|e| e.to_string())?;
            window.set_size(tauri::LogicalSize::new(width, height)).map_err(|e| e.to_string())?;
            window.set_min_size(Some(tauri::LogicalSize::new(width, height))).map_err(|e| e.to_string())?;
            window.set_max_size(Some(tauri::LogicalSize::new(width, height))).map_err(|e| e.to_string())?;
            crate::desktop_companion::reconcile_3d_bounds(&app, shift);
        }
        crate::desktop_companion::refresh_3d_input(&app)?;
        if changed { crate::desktop_companion::refresh_3d_bubble(&app); }
    }
    Ok(preferred)
}
pub(crate) fn form_changed(app: &tauri::AppHandle, preferred: bool) {
    let _ = app.emit_to("dot", "dot://capri3d-form", preferred);
}

/// Unknown/missing logind properties never synthesize an unlock.
fn parse_absence(text: &str) -> Option<bool> {
    let property = |key: &str| text.lines().find_map(|line| {
        let (name, value) = line.split_once('=')?;
        if name != key { return None; }
        match value { "yes" => Some(true), "no" => Some(false), _ => None }
    });
    Some(property("LockedHint")? || property("IdleHint")?)
}
pub(crate) fn poll_absence(app: &tauri::AppHandle) {
    if !active(app) || !crate::desktop_companion::enabled(app) { return; }
    #[cfg(target_os = "linux")]
    {
        let session = std::env::var("XDG_SESSION_ID").unwrap_or_else(|_| "self".into());
        if let Ok(bytes) = crate::computer::linux::run("loginctl", &["show-session", &session, "-p", "LockedHint", "-p", "IdleHint"], None) {
            if let Some(absent) = parse_absence(&String::from_utf8_lossy(&bytes)) {
                let _ = app.emit_to("dot", "dot://capri3d-absence", absent);
            }
        }
    }
}
fn observe_release(held: &mut bool, down: bool) -> bool {
    let released = *held && !down;
    *held = down;
    released
}
/// GTK may not deliver button-release to WebKit after a compositor drag. Query
/// GDK's button state only for this explicit drag, never infer release from movement.
#[cfg(target_os = "linux")]
pub(crate) fn watch_drag(app: &tauri::AppHandle) {
    use gtk::prelude::*;
    use std::sync::atomic::Ordering;
    if app.state::<Surface>().dragging.swap(true, Ordering::SeqCst) { return; }
    let app = app.clone();
    let scheduler = app.clone();
    let _ = scheduler.run_on_main_thread(move || {
        let resources = (|| {
            let window = app.get_webview_window("dot")?;
            let native = window.gtk_window().ok()?;
            Some((native.display().default_seat()?.pointer()?, native.window()?))
        })();
        let Some((device, gdk_window)) = resources else {
            app.state::<Surface>().dragging.store(false, Ordering::SeqCst);
            let _ = app.emit_to("dot", "dot://capri3d-release", ());
            return;
        };
        let (_, _, _, state) = gdk_window.device_position(&device);
        // The UI's pointer-down is explicit evidence too: a fast release can occur
        // before this main-thread closure is scheduled.
        let mut held = true;
        let mut attempts = 0;
        let finish = |app: &tauri::AppHandle| {
            crate::desktop_companion::desktop_companion_interaction(app.clone(), false, Some(true), None);
            let _ = app.emit_to("dot", "dot://capri3d-release", ());
        };
        if observe_release(&mut held, state.contains(gtk::gdk::ModifierType::BUTTON1_MASK)) { finish(&app); return; }
        gtk::glib::timeout_add_local(std::time::Duration::from_millis(100), move || {
            attempts += 1;
            if !crate::desktop_companion::enabled(&app) || !active(&app) || attempts > 3000 {
                app.state::<Surface>().dragging.store(false, Ordering::SeqCst);
                let _ = app.emit_to("dot", "dot://capri3d-release", ());
                return gtk::glib::ControlFlow::Break;
            }
            if !app.state::<Surface>().dragging.load(Ordering::SeqCst) { return gtk::glib::ControlFlow::Break; }
            let (_, _, _, state) = gdk_window.device_position(&device);
            if observe_release(&mut held, state.contains(gtk::gdk::ModifierType::BUTTON1_MASK)) {
                finish(&app); gtk::glib::ControlFlow::Break
            } else { gtk::glib::ControlFlow::Continue }
        });
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn speech_and_input_expand_only_the_3d_surface() {
        assert_eq!(surface_dimensions(false, false), (144, 204));
        assert_eq!(surface_dimensions(true, false), (320, 356));
        assert_eq!(surface_dimensions(false, true), (320, 292));
        assert_eq!(surface_dimensions(true, true), (320, 444));
        assert_eq!(seat_y(false), 146);
        assert_eq!(seat_y(true), 298);
        let mut mask = vec![0; 816];
        mask[0] = 1;
        assert_eq!(mask_rectangles(&mask, 320, 444).unwrap(), vec![(0, 0, 14, 14)]);
    }
    #[test]
    fn parses_logind_without_guessing_on_failure() {
        assert_eq!(parse_absence("LockedHint=yes\nIdleHint=no\n"), Some(true));
        assert_eq!(parse_absence("LockedHint=no\nIdleHint=yes\n"), Some(true));
        assert_eq!(parse_absence("LockedHint=no\nIdleHint=no\n"), Some(false));
        assert_eq!(parse_absence("LockedHint=no\n"), None);
        assert_eq!(parse_absence("error"), None);
    }
    #[test]
    fn release_requires_a_previously_observed_held_button() {
        let mut held = false;
        assert!(!observe_release(&mut held, false));
        assert!(!observe_release(&mut held, true));
        assert!(observe_release(&mut held, false));
        assert!(!observe_release(&mut held, false));
    }
    #[test]
    fn asset_allowlist_rejects_paths_and_unknown_names() {
        assert!(allowed_asset("roja.glb"));
        for name in ["../roja.glb", "/roja.glb", "other.glb", "ROJA.glb", "roja.glb\0"] {
            assert!(!allowed_asset(name));
        }
        assert_eq!(ASSETS.len(), 10);
    }
    #[test]
    fn mask_rectangles_are_logical_and_top_to_bottom() {
        let mut mask = vec![0; 24 * 34];
        mask[0] = 1;
        mask[24 * 33 + 23] = 1;
        assert_eq!(mask_rectangles(&mask, 240, 340).unwrap(), vec![(0, 0, 10, 10), (230, 330, 10, 10)]);
        assert!(mask_rectangles(&[1], 240, 340).is_err());
        mask[1] = 2;
        assert!(mask_rectangles(&mask, 240, 340).is_err());
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn precise_body_region_keeps_transparent_pixels_outside_and_offsets_overlays() {
        let mut state=SurfaceState{active:true,body_rects:Some(vec![(1,2,1,1)]),..Default::default()};
        assert_eq!(surface_input_rectangles(&state).unwrap(),Some(vec![(1,2,1,1)]));
        state.bubble=true; state.input=true;
        let rects=surface_input_rectangles(&state).unwrap().unwrap();
        assert!(rects.contains(&(89,154,1,1)));
        assert!(rects.contains(&(0,0,320,152)));
        assert!(rects.contains(&(0,356,320,88)));
        assert!(validate_body_rects(&[(144,0,1,1)]).is_err());
        assert!(validate_body_rects(&[(0,0,-1,1)]).is_err());
    }
    #[test]
    fn inactive_input_region_is_not_a_full_window_and_missing_mask_fails_closed() {
        assert_eq!(surface_input_rectangles(&SurfaceState::default()).unwrap(), None);
        let state=SurfaceState{active:true,..Default::default()};
        assert_eq!(surface_input_rectangles(&state).unwrap(),Some(vec![]));
        let mut mask=vec![0;816]; mask[25]=1;
        let rects=surface_input_rectangles(&SurfaceState{active:true,mask,..Default::default()}).unwrap().unwrap();
        assert_eq!(rects,vec![(6,6,6,6)]);
    }
    #[test]
    fn input_region_contains_only_mask_cells() {
        let mut mask = vec![0; 24 * 34];
        mask[25] = 1;
        let region = mask_region(&mask, 240, 340).unwrap();
        assert!(region.contains_point(15, 15));
        assert!(!region.contains_point(5, 5));
        assert!(!region.contains_point(25, 15));
    }
}
