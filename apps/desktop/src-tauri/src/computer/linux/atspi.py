"""Read only bounded AT-SPI metadata. Never read field values or clipboard contents."""
import json
import sys
import time

try:
    import gi
    gi.require_version("Atspi", "2.0")
    from gi.repository import Atspi

    Atspi.set_timeout(70, 70)
    deadline = time.monotonic() + 0.55
    pid = int(sys.argv[1])
    desktop = Atspi.get_desktop(0)
    app = None
    for i in range(min(desktop.get_child_count(), 128)):
        candidate = desktop.get_child_at_index(i)
        if candidate.get_process_id() == pid:
            app = candidate
            break
    queue = [app] if app else []
    visited = 0
    while queue and visited < 512 and time.monotonic() < deadline:
        item = queue.pop(0)
        visited += 1
        try:
            states = item.get_state_set()
            if states.contains(Atspi.StateType.FOCUSED):
                role = item.get_role_name()
                # A password's accessible name may contain a secret in a broken app too.
                name = "" if role == "password text" else item.get_name()[:512]
                print(json.dumps({"role": role, "name": name}))
                sys.exit(0)
            if states.contains(Atspi.StateType.DEFUNCT):
                continue
            # No text values, text interfaces, document contents or attributes are read.
            queue.extend(item.get_child_at_index(i) for i in range(min(item.get_child_count(), 128)))
        except Exception:
            continue
except Exception:
    pass
print("null")
