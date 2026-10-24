use super::*;
use serde_json::json;

#[test]
fn never_uses_xwayland_as_a_wayland_fallback() {
    assert_eq!(session_for(true, false, true), Session::Unsupported);
    assert_eq!(session_for(true, true, true), Session::Hyprland);
    assert_eq!(session_for(false, false, true), Session::X11);
    assert_eq!(session_for(false, false, false), Session::Unsupported);
}
#[test]
fn logical_geometry_respects_fractional_scaling_rotation_and_negative_origin() {
    assert_eq!(
        logical_monitor(
            &json!({"x":-1536,"y":0,"width":1920,"height":1080,"scale":1.25,"transform":0})
        ),
        Some((-1536., 0., 1536., 864.))
    );
    assert_eq!(
        logical_monitor(
            &json!({"x":0,"y":-100,"width":1920,"height":1080,"scale":2,"transform":1})
        ),
        Some((0., -100., 540., 960.))
    );
}
#[test]
fn target_geometry_excludes_hidden_workspaces_and_prefers_floating_front_window() {
    let monitors = vec![json!({"activeWorkspace":{"id":2},"specialWorkspace":{"id":0}})];
    let clients = vec![
        json!({"mapped":true,"hidden":false,"workspace":{"id":2},"at":[0,0],"size":[500,500],"pid":1,"class":"base","focusHistoryID":0}),
        json!({"mapped":true,"hidden":false,"workspace":{"id":2},"at":[100,100],"size":[200,200],"pid":2,"class":"front","floating":true,"focusHistoryID":1}),
        json!({"mapped":true,"hidden":false,"workspace":{"id":3},"at":[0,0],"size":[500,500],"pid":3,"class":"other","floating":true,"focusHistoryID":0}),
    ];
    assert_eq!(
        identity(owner_at(&clients, &monitors, Point { x: 150., y: 150. }).unwrap())
            .unwrap()
            .pid,
        2
    );
    assert_eq!(
        identity(owner_at(&clients, &monitors, Point { x: 10., y: 10. }).unwrap())
            .unwrap()
            .pid,
        1
    );
    assert!(owner_at(&clients, &monitors, Point { x: 500., y: 500. }).is_none());
}
#[test]
fn input_key_names_preserve_linux_semantics() {
    let combo = super::super::keys::parse_combo("ctrl+shift+backspace").unwrap();
    assert_eq!(key_name(&combo), "BackSpace");
    assert_eq!(modifiers(&combo), vec!["ctrl", "shift"]);
    assert_eq!(
        key_name(&super::super::keys::parse_combo("cmd+f12").unwrap()),
        "F12"
    );
}
#[test]
fn window_identity_requires_known_positive_pid_and_app_id() {
    assert!(identity(&json!({"pid":0,"class":"zen"})).is_none());
    assert!(identity(&json!({"pid":12,"class":""})).is_none());
    assert!(address(&json!({"address":"0x123,exec,anything"})).is_none());
    assert_eq!(address(&json!({"address":"0xabc001"})), Some("0xabc001"));
}
#[test]
fn rose_resolution_requires_one_mapped_native_window_of_this_process() {
    let rose = json!({"pid":90,"class":"dev.gentledot","title":"Gentle Dot","mapped":true,"address":"0x111"});
    let foreign =
        json!({"pid":91,"class":"other","title":"Gentle Dot","mapped":true,"address":"0x222"});
    let mut panel = rose.clone();
    panel["title"] = json!("Gentle Dot Chat");
    panel["address"] = json!("0x333");
    assert_eq!(
        unique_rose_address(&[rose.clone(), foreign.clone(), panel], 90, "Gentle Dot").unwrap(),
        "0x111"
    );
    assert!(unique_rose_address(&[foreign], 90, "Gentle Dot").is_err());
    let mut duplicate = rose.clone();
    duplicate["address"] = json!("0x444");
    assert!(unique_rose_address(&[rose.clone(), duplicate], 90, "Gentle Dot").is_err());
    for (field, invalid) in [
        ("mapped", json!(false)),
        ("class", json!("")),
        ("address", json!("invalid")),
    ] {
        let mut invalid_rose = rose.clone();
        invalid_rose[field] = invalid;
        assert!(
            unique_rose_address(&[invalid_rose], 90, "Gentle Dot").is_err(),
            "{field}"
        );
    }
}
#[test]
fn a_hidden_rose_is_excluded_by_exact_id_and_pid_only_until_restored() {
    let own_pid = 90;
    let monitors = vec![json!({"activeWorkspace":{"id":1}})];
    let rose = json!({"pid":own_pid,"class":"dev.gentledot","title":"Gentle Dot","address":"0x111","mapped":true,"floating":true,"focusHistoryID":0,"workspace":{"id":1},"at":[0,0],"size":[72,72]});
    let browser = json!({"pid":91,"class":"zen","title":"Gentle Dot","address":"0x222","mapped":true,"floating":false,"focusHistoryID":1,"workspace":{"id":1},"at":[0,0],"size":[500,500]});
    let at = Point { x: 10., y: 10. };
    for hidden in [Some("hyprland:0x111"), None] {
        let clients: Vec<_> = [rose.clone(), browser.clone()]
            .into_iter()
            .filter(|window| !is_hidden_rose_client(window, hidden, own_pid))
            .collect();
        let receiving = identity(owner_at(&clients, &monitors, at).unwrap()).unwrap();
        assert_eq!(receiving.pid, if hidden.is_some() { 91 } else { own_pid });
        let masked = !is_hidden_rose_client(&rose, hidden, own_pid)
            && blocked_reason(&identity(&rose).unwrap(), own_pid).is_some();
        assert_eq!(masked, hidden.is_none());
    }
    let mut another_own_window = rose.clone();
    another_own_window["address"] = json!("0x333");
    assert!(!is_hidden_rose_client(
        &another_own_window,
        Some("hyprland:0x111"),
        own_pid
    ));
    assert!(blocked_reason(&identity(&another_own_window).unwrap(), own_pid).is_some());
    let mut reused_id = rose.clone();
    reused_id["pid"] = json!(91);
    assert!(!is_hidden_rose_client(
        &reused_id,
        Some("hyprland:0x111"),
        own_pid
    ));
    assert!(!is_hidden_rose_client(&rose, Some("x11:0x111"), own_pid));
}
#[test]
fn x11_rose_exclusion_never_applies_to_other_windows_or_unknown_owners() {
    let active = Some("x11:0x123");
    assert!(hidden_rose_matches(active, "x11:", "0x123", Some(90), 90));
    assert!(!hidden_rose_matches(None, "x11:", "0x123", Some(90), 90));
    assert!(!hidden_rose_matches(active, "x11:", "0x124", Some(90), 90));
    assert!(!hidden_rose_matches(active, "x11:", "0x123", Some(91), 90));
    assert!(!hidden_rose_matches(active, "x11:", "0x123", None, 90));
    assert!(!hidden_rose_matches(
        Some("hyprland:0x123"),
        "x11:",
        "0x123",
        Some(90),
        90
    ));
}
#[test]
fn masked_context_bubble_exclusion_requires_exact_owned_identity_and_is_reversible() {
    let bubble=json!({"pid":90,"class":"dev.gentledot","title":crate::desktop_companion::BUBBLE_TITLE,"address":"0xcafe","mapped":true});
    LinuxDesktop::set_hidden_companion_bubble(Some("hyprland:0xcafe".into()));
    assert!(is_hidden_rose_client(&bubble,None,90));
    for (key,value) in [("pid",json!(91)),("address",json!("0xcaff")),("title",json!("Another own window"))] {
        let mut other=bubble.clone();other[key]=value;assert!(!is_hidden_rose_client(&other,None,90));
    }
    LinuxDesktop::set_hidden_companion_bubble(None);
    assert!(!is_hidden_rose_client(&bubble,None,90));
}
#[test]
fn x11_metadata_does_not_use_window_title_as_app_identity() {
    let value =
        x11_identity("_NET_WM_PID(CARDINAL) = 123\nWM_CLASS(STRING) = \"navigator\", \"Firefox\"")
            .unwrap();
    assert_eq!(value.pid, 123);
    assert_eq!(value.bundle_id.as_deref(), Some("Firefox"));
    assert!(x11_identity("_NET_WM_PID: not found\nWM_CLASS(STRING) = \"Firefox\"").is_none());
}
#[test]
fn application_name_cannot_be_a_command_or_filesystem_path() {
    for name in [
        "/tmp/model.desktop",
        "../editor",
        "foo\nExec=anything",
        "foo\0bar",
    ] {
        assert!(desktop_entry(name).is_none());
    }
}
#[test]
fn command_runner_enforces_timeout_and_output_bound() {
    let started = Instant::now();
    let error = run_path(
        Path::new("/usr/bin/sleep"),
        &["2"],
        None,
        Duration::from_millis(40),
        128,
    )
    .unwrap_err();
    assert!(error.contains("timed out"));
    assert!(started.elapsed() < Duration::from_secs(1));
    let error = run_path(
        Path::new("/usr/bin/printf"),
        &["123456789"],
        None,
        Duration::from_secs(1),
        4,
    )
    .unwrap_err();
    assert!(error.contains("too much output"));
}
#[test]
fn command_runner_does_not_interpret_shell_text_or_echo_secret_errors() {
    let text = "$(not-a-command); `also-not-a-command`";
    assert_eq!(
        run_path(
            Path::new("/usr/bin/printf"),
            &["%s", text],
            None,
            Duration::from_secs(1),
            512
        )
        .unwrap(),
        text.as_bytes()
    );
    let error = run_path(
        Path::new("/usr/bin/ls"),
        &["/not-present-private-secret"],
        None,
        Duration::from_secs(1),
        512,
    )
    .unwrap_err();
    assert!(!error.contains("private-secret"));
}
#[test]
#[ignore = "opt-in real desktop read-only capture; never executed in ordinary tests"]
fn live_linux_capture_and_application_metadata() {
    let desktop = LinuxDesktop::new();
    assert!(desktop.permissions().screen_recording);
    let apps = desktop.list_apps().unwrap();
    assert!(!apps.is_empty());
    let capture = desktop.capture().unwrap();
    assert!(
        capture.geometry.image_width <= MAX_LONG_EDGE
            && capture.geometry.image_height <= MAX_LONG_EDGE
    );
    assert!(capture.geometry.scale > 0.0);
    assert!(!capture.data.is_empty());
    eprintln!(
        "desktop capture {}x{}, {} bytes, {} running apps",
        capture.geometry.image_width,
        capture.geometry.image_height,
        capture.data.len(),
        apps.len()
    );
}

#[test]
#[ignore = "requires an explicitly provided inert GTK fixture PID; never target user applications"]
fn live_linux_input_only_into_named_fixture() {
    let pid: i32 = std::env::var("GENTLE_DOT_TEST_FIXTURE_PID")
        .expect("explicit fixture PID required")
        .parse()
        .unwrap();
    let desktop = LinuxDesktop::new();
    assert_eq!(desktop.session, Session::Hyprland);
    let fixture = || {
        desktop
            .clients()
            .unwrap()
            .into_iter()
            .find(|w| {
                w["pid"].as_i64() == Some(i64::from(pid))
                    && w["title"].as_str() == Some("Gentle Dot desktop verification")
            })
            .expect("the named test fixture must still exist")
    };
    let window = fixture();
    assert_eq!(
        window["xwayland"], false,
        "this fixture proves native Wayland input"
    );
    let original = desktop.frontmost_app();
    let pointer = desktop.pointer().unwrap();
    struct Restore<'a>(&'a LinuxDesktop, Option<AppIdentity>, Point);
    impl Drop for Restore<'_> {
        fn drop(&mut self) {
            let _ = self.0.move_pointer(self.2);
            if let Some(app) = &self.1 {
                self.0.activate(app.pid);
            }
        }
    }
    let _restore = Restore(&desktop, original, pointer);
    desktop.activate(pid);
    std::thread::sleep(Duration::from_millis(150));
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../.cache/computer-tools");
    let log_path = root.join("fixture-events.jsonl");
    let baseline = std::fs::metadata(&log_path).unwrap().len() as usize;
    let widget = |name: &str| {
        let geometry: Value =
            serde_json::from_slice(&std::fs::read(root.join("fixture-geometry.json")).unwrap())
                .unwrap();
        let window = fixture();
        let (x, y) = pair(&window, "at").unwrap();
        let item = &geometry[name];
        Point {
            x: x + item["x"].as_f64().unwrap() + item["width"].as_f64().unwrap() / 2.0,
            y: y + item["y"].as_f64().unwrap() + item["height"].as_f64().unwrap() / 2.0,
        }
    };
    let post = |event| {
        fixture();
        assert_eq!(
            desktop.frontmost_app().map(|app| app.pid),
            Some(pid),
            "focus changed: refusing to type in another application"
        );
        desktop.post(&event).unwrap();
        std::thread::sleep(Duration::from_millis(70));
    };
    let started = Instant::now();
    post(InputEvent::Click {
        at: widget("entry"),
        button: MouseButton::Left,
        count: 1,
    });
    post(InputEvent::Key(
        super::super::keys::parse_combo("ctrl+a").unwrap(),
    ));
    post(InputEvent::Text("Gentle Dot: café 🌹".into()));
    post(InputEvent::Key(
        super::super::keys::parse_combo("return").unwrap(),
    ));
    post(InputEvent::Click {
        at: widget("button"),
        button: MouseButton::Left,
        count: 1,
    });
    let at = widget("area");
    post(InputEvent::Scroll { at, dx: 0, dy: 120 });
    post(InputEvent::Drag {
        from: at,
        to: Point {
            x: at.x + 50.0,
            y: at.y + 30.0,
        },
    });
    let capture = desktop.capture().unwrap();
    let bytes = std::fs::read(&log_path).unwrap();
    let events = String::from_utf8_lossy(&bytes[baseline..])
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert!(
        events
            .iter()
            .any(|e| e["kind"] == "enter" && e["text"] == "Gentle Dot: café 🌹"),
        "Unicode text and Return must reach the fixture"
    );
    for kind in [
        "click",
        "scroll-event",
        "button-press-event",
        "button-release-event",
        "motion-notify-event",
    ] {
        assert!(
            events.iter().any(|e| e["kind"] == kind),
            "missing fixture event: {kind}"
        );
    }
    eprintln!("Native Wayland verified: click, Unicode text, Ctrl+A, Return, scroll, drag and {}x{} screenshot; {} events in {} ms", capture.geometry.image_width, capture.geometry.image_height, events.len(), started.elapsed().as_millis());
}

#[test]
fn timeout_kills_descendants_so_stdin_writer_cannot_outlive_action() {
    let started = Instant::now();
    let text = "x".repeat(1024 * 1024);
    let error = run_path(
        Path::new("/usr/bin/python3"),
        &["-c", "import os,time; os.fork(); time.sleep(10)"],
        Some(&text),
        Duration::from_millis(70),
        128,
    )
    .unwrap_err();
    assert!(error.contains("timed out"));
    assert!(started.elapsed() < Duration::from_secs(1));
}

#[test]
fn lua_dispatcher_is_fixed_and_rejects_interpolated_code() {
    assert_eq!(
        lua_dispatch("focuswindow", "address:0x123abc").unwrap(),
        "hl.dsp.focus({window='address:0x123abc'})"
    );
    assert_eq!(
        lua_dispatch("movecursor", "-150 40").unwrap(),
        "hl.dsp.cursor.move({x=-150,y=40})"
    );
    assert!(lua_dispatch("focuswindow", "address:0x123');os.execute('x')").is_err());
    assert!(lua_dispatch("movecursor", "1;os.execute('x') 4").is_err());
    assert!(lua_dispatch("sendshortcut", ",x,anything").is_err());
    assert!(lua_dispatch("sendshortcut", "CTRL',os.execute('x'),Return,").is_err());
    assert_eq!(
        lua_dispatch("sendshortcut", "CTRL SHIFT,a,").unwrap(),
        "hl.dsp.send_shortcut({mods='CTRL SHIFT',key='a'})"
    );
    assert_eq!(
        lua_dispatch("sendshortcut", ",Return,").unwrap(),
        "hl.dsp.send_shortcut({mods='',key='Return'})"
    );
    assert!(lua_dispatch("exec", "anything").is_err());
}

#[test]
fn applications_include_every_workspace_and_group_same_program_across_processes() {
    let clients = vec![
        json!({"mapped":true,"hidden":false,"visible":true,"workspace":{"id":1,"name":"Work"},"at":[0,0],"size":[500,500],"pid":55,"class":"zen","address":"0x101","title":"Browser one"}),
        json!({"mapped":true,"hidden":false,"visible":false,"workspace":{"id":3,"name":"Personal"},"at":[0,0],"size":[500,500],"pid":56,"class":"zen","address":"0x103","title":"Browser two"}),
        json!({"mapped":true,"hidden":false,"visible":false,"workspace":{"id":-5,"name":"special:test"},"at":[0,0],"size":[500,500],"pid":99,"class":"editor","address":"0x104","title":"Notes"}),
    ];
    let apps = hypr_apps(&clients, &[], Some("0x101"));
    assert_eq!(apps.len(), 2);
    let windows = apps[0].windows.as_ref().unwrap();
    assert_eq!(windows.len(), 2);
    assert_eq!(windows[0].workspace.as_deref(), Some("Work"));
    assert_eq!(windows[1].workspace_id, Some(3));
    assert!(!windows[1].visible);
    assert!(apps[0].active);
    assert!(!apps[1].active);
    assert_eq!(
        apps[1].windows.as_ref().unwrap()[0].workspace.as_deref(),
        Some("special:test")
    );
}

#[test]
#[ignore = "moves only the explicitly named inert fixture to a temporary empty workspace and restores it"]
fn live_linux_finds_and_activates_fixture_on_another_workspace() {
    let pid: i32 = std::env::var("GENTLE_DOT_TEST_FIXTURE_PID")
        .expect("explicit fixture PID required")
        .parse()
        .unwrap();
    let desktop = LinuxDesktop::new();
    assert_eq!(desktop.session, Session::Hyprland);
    let fixture = desktop
        .clients()
        .unwrap()
        .into_iter()
        .find(|w| {
            w["pid"].as_i64() == Some(i64::from(pid))
                && w["title"].as_str() == Some("Gentle Dot desktop verification")
        })
        .expect("named fixture must exist");
    let id = address(&fixture).unwrap().to_string();
    let original_workspace = fixture
        .pointer("/workspace/id")
        .and_then(Value::as_i64)
        .filter(|n| *n > 0)
        .unwrap();
    let original_focus = desktop.frontmost_app();
    let original_pointer = desktop.pointer().unwrap();
    let workspaces = hypr("workspaces").unwrap();
    let temporary = (99001..99100)
        .find(|candidate| {
            !workspaces
                .as_array()
                .unwrap()
                .iter()
                .any(|w| w["id"].as_i64() == Some(*candidate))
        })
        .unwrap();
    let move_fixture = |workspace: i64| {
        if uses_lua_dispatch() {
            run("hyprctl", &["dispatch", &format!("hl.dsp.window.move({{window='address:{id}',workspace={workspace},follow=false}})")], None)
        } else {
            run("hyprctl", &["dispatch", "movetoworkspacesilent", &format!("{workspace},address:{id}")], None)
        }.unwrap();
    };
    struct Restore<'a, F: Fn(i64)>(&'a LinuxDesktop, F, i64, Option<AppIdentity>, Point);
    impl<F: Fn(i64)> Drop for Restore<'_, F> {
        fn drop(&mut self) {
            (self.1)(self.2);
            let _ = self.0.move_pointer(self.4);
            if let Some(app) = &self.3 {
                self.0.activate(app.pid);
            }
        }
    }
    let _restore = Restore(
        &desktop,
        &move_fixture,
        original_workspace,
        original_focus,
        original_pointer,
    );
    move_fixture(temporary);
    let apps = desktop.list_apps().unwrap();
    let window = apps
        .iter()
        .flat_map(|app| app.windows.as_ref().into_iter().flatten())
        .find(|w| w.id == id)
        .expect("hidden fixture must remain discoverable");
    assert_eq!(window.workspace_id, Some(temporary));
    assert!(!window.visible);
    desktop.open_window(&id).unwrap();
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(desktop.frontmost_app().map(|app| app.pid), Some(pid));
    assert_eq!(hypr("activeworkspace").unwrap()["id"], temporary);
    eprintln!("Discovered fixture on another workspace and activated exactly its window; workspace restored afterward.");
}

#[test]
fn text_slices_fit_wtype_latency_and_leave_room_for_stop_checks() {
    let desktop = LinuxDesktop {
        session: Session::Hyprland,
        own_pid: 123,
    };
    assert!(desktop.text_chunk_units() > 20);
    assert!(desktop.text_chunk_units() * 4 < COMMAND_TIMEOUT.as_millis() as usize / 2);
}

#[test]
fn compositor_animation_visibility_never_exposes_an_inactive_workspace_as_current() {
    let monitors = vec![json!({"activeWorkspace":{"id":1},"specialWorkspace":{"id":0}})];
    let window = json!({"mapped":true,"hidden":false,"visible":true,"workspace":{"id":99001}});
    assert!(!visible(&window, &monitors));
}
