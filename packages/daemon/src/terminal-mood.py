"""Fixed no-UI Kitty bridge. Only this window's foreground/background and ANSI 0..15.

Do not use set-colors here: it also changes global/tab colors and clears dynamic
transparent-background colors. Direct ColorProfile setters preserve those fields.
"""

import json
import os

from kittens.tui.handler import result_handler


PRESETS = {
    "hacker": ("07120d", "b7ffcd", "07120d ff657a 58e896 e4ed92 75bfff b9a0ff 63e6d5 d9eee1 526a5c ff91a0 8affb5 f5ffc2 a3d7ff d2baff 9affec f1fff6"),
    "afterlife": ("101020", "e5e6ff", "101020 ff6688 72edbd f4d58d 829dff d291ff 6ee7f7 e5e6ff 606683 ff9bb0 a3ffda ffe6ad b1bdff e8b9ff a8f6ff f8f5ff"),
    "sunset": ("20131c", "ffe8d4", "20131c ff7c89 a8dca3 f7c779 baadff f2a0d0 86dada ffe8d4 826878 ffa2a9 cbefbc ffdfac d5caff ffc5e5 b7f0eb fff7ed"),
}


def process_info(pid):
    with open(f"/proc/{pid}/stat", encoding="utf8") as stream:
        stat = stream.read().rsplit(")", 1)[1].split()
    with open("/proc/sys/kernel/random/boot_id", encoding="utf8") as stream:
        identity = f"{stream.read().strip()}:{stat[19]}"
    return int(stat[1]), identity


def assert_target(window, params):
    if window.id != params["windowId"] or window.child.pid != params["childPid"]:
        raise ValueError("La ventana cambió; vuelve a seleccionarla.")
    if os.getpid() != params["kittyPid"] or process_info(os.getpid())[1] != params["kittyIdentity"]:
        raise ValueError("La instancia de terminal cambió.")
    pid = params["pid"]
    if process_info(pid)[1] != params["processIdentity"]:
        raise ValueError("El proceso de la sesión cambió.")
    for _ in range(96):
        if pid == window.child.pid:
            return
        parent, _identity = process_info(pid)
        if parent <= 1 or parent == pid:
            break
        pid = parent
    raise ValueError("La sesión ya no pertenece a esta ventana.")


def capture(profile):
    colors = profile.as_dict()
    return {key: colors[key] for key in ("foreground", "background", *(f"color{i}" for i in range(16))) if key in colors}


def apply(profile, colors):
    for key, attr in (("foreground", "default_fg"), ("background", "default_bg")):
        if key in colors:
            setattr(profile, attr, colors[key])
        else:
            # Mark dirty before removing an override: deletion itself does not.
            setattr(profile, attr, int(getattr(profile, attr)))
            delattr(profile, attr)
    for index in range(16):
        profile.set_color(index, colors[f"color{index}"])


def preset(name):
    background, foreground, palette = PRESETS[name]
    colors = {f"color{i}": int(value, 16) for i, value in enumerate(palette.split())}
    return {**colors, "background": int(background, 16), "foreground": int(foreground, 16)}


def geometry(window):
    # Kitty owns these metrics. Never inspect screen lines, text, environment, or stdin.
    from kitty.fast_data_types import get_options, viewport_for_window
    _central, _bar, vw, vh, cw, ch = viewport_for_window(window.os_window_id)
    g = window.geometry
    title = window.show_title_bar and g.ynum > 1
    top = g.top + (ch if title and get_options().window_title_bar == "top" else 0)
    return {"viewportWidth": vw, "viewportHeight": vh, "left": g.left, "top": top,
            "cellWidth": cw, "cellHeight": ch, "columns": window.screen.columns,
            "rows": window.screen.lines, "cursorX": window.screen.cursor.x,
            "cursorY": window.screen.cursor.y, "cursorVisible": window.screen.cursor_visible,
            "active": window.is_active, "focused": window.is_focused}


def main(args):
    raise RuntimeError("This bridge must be run as a no-UI Kitty kitten.")


@result_handler(no_ui=True)
def handle_result(args, answer, target_window_id, boss):
    try:
        if len(args) != 2:
            raise ValueError("Invalid terminal mood arguments")
        params = json.loads(args[1])
        if params.get("mood") not in (*PRESETS, "restore", "inspect", "geometry"):
            raise ValueError("Invalid terminal mood")
        window = boss.window_id_map.get(target_window_id)
        if window is None:
            raise ValueError("La ventana ya se cerró.")
        assert_target(window, params)
        if params["mood"] == "geometry":
            return json.dumps({"ok": True, "verified": True, "windowId": window.id, "geometry": geometry(window)})
        # Stored on the original window: daemon restarts keep restore available;
        # closing/replacing a Kitty window discards it instead of reusing its ID.
        saved = getattr(window, "_gentle_dot_mood", None)
        profile = window.screen.color_profile
        before = capture(profile)
        mood = params["mood"]
        if mood != "inspect":
            if mood == "restore" and saved is None:
                raise ValueError("Esta ventana no tiene colores anteriores guardados.")
            desired = saved["original"] if mood == "restore" else preset(mood)
            try:
                apply(profile, desired)
                if capture(profile) != desired:
                    raise ValueError("La terminal no confirmó los colores.")
                window.refresh()
            except Exception:
                apply(profile, before)
                window.refresh()
                raise
            if mood == "restore":
                window._gentle_dot_mood = saved = None
            else:
                window._gentle_dot_mood = saved = {"original": saved["original"] if saved else before, "mood": mood, "applied": desired}
        current_mood = saved["mood"] if saved and capture(profile) == saved["applied"] else None
        return json.dumps({"ok": True, "windowId": window.id, "mood": current_mood, "canRestore": saved is not None, "verified": True})
    except Exception as error:
        return json.dumps({"ok": False, "error": str(error)[:400]})
