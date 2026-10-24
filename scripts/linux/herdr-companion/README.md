# Exact Herdr geometry for Capri

This optional **client-only** patch targets Herdr **0.9.3**, commit
`7b116c05bfda646af39d2524c54e70c751f57ee8`. It exports the actual pane interior
and visible agent rows from the TUI's last successfully presented layout.
It never exports terminal cells, draft text, titles, messages, keys or images.
The server, frozen codecs and public API are unchanged.

The installed Herdr binary and existing sessions remain in place. A separate
binary named `herdr` is used only by an explicitly opened new window.

## Build and verify

Prerequisites: Node.js, Git, tar, Rust/Cargo and Zig **0.16.0**. Keep downloaded
tools in a private build directory; no global installation is required.
Use absolute paths in these commands:

```sh
node scripts/linux/herdr-companion/build.mjs --prepare --source /path/to/upstream-clone --directory /path/to/new-build
node scripts/linux/herdr-companion/build.mjs --test --directory /path/to/new-build --zig /path/to/zig
node scripts/linux/herdr-companion/build.mjs --build --directory /path/to/new-build --zig /path/to/zig
```

The clone must contain the pinned commit. Preparation uses `git archive` of that
commit, verifies the patch digest, applies it to a new directory and checks the
resulting file digests. Tests use isolated fixtures and clear inherited Herdr
socket overrides. `companion-build.json` records the binary hash; a build alone
does **not** count as a successful runtime smoke.

## Activate after the isolated smoke

Run the isolated Linux smoke with a live Wayland/Kitty environment. It starts a
new private Herdr server and a hidden client, checks the actual report through
Dot's reader, then closes only those test processes. It never attaches to an
existing server or changes focus:

```sh
node scripts/linux/herdr-companion/smoke.mjs --build /path/to/new-build --output /path/to/new-smoke.json
```

Stage only a binary whose isolated smoke has passed. The smoke evidence must
contain `verified: true`, `scope: "isolated"`, and matching `binarySha256` and
`patchSha256`. Staging creates a new directory and never changes PATH:

```sh
node scripts/linux/herdr-companion/stage.mjs --build /path/to/new-build --smoke /path/to/smoke.json --destination /path/to/private-sidecar
node scripts/linux/herdr-companion/open.mjs --sidecar /path/to/private-sidecar --socket /path/to/existing/herdr.sock
```

The second command prints the exact launch plan. Add `--launch` to open one new
Kitty window with a private control socket. Invoke this manual launcher from a
terminal, not from the Dot service's process group. It runs `herdr client`, which connects
to the existing server without starting, updating or restarting it. Closing this
new window ends only that client. Returning to ordinary Herdr needs no rollback;
remove the unused sidecar directory when it is no longer needed.

Existing Gentle Shell/Pi sessions without the editor geometry adapter continue
working. They cannot gain exact editor coordinates merely by opening the new
Herdr client. A newly started compatible Pi session supplies those coordinates;
until then Capri uses a verified cursor fallback when available. Do not reload
busy sessions to activate this feature.

## Local report contract

`GENTLE_DOT_COMPANION_LAYOUT_DIR` opts the client in. With the variable absent,
there is no geometry traversal, publisher thread or filesystem output. The
wrapper sets it to `$XDG_RUNTIME_DIR/gentle-dot/herdr-layout`.
The directory must be owned by the user with mode `0700`; each `<clientPid>.json`
is replaced atomically with mode `0600`. Publication is capped at 1 Hz and uses
a bounded nonblocking worker. A blocked client does not manufacture heartbeats.
Startup removes only recognized private reports for PIDs that no longer exist;
live processes, unknown files, symlinks and changed inodes are left untouched.

Reports contain version, client PID/start identity/TTY/Kitty window ID, canonical
Herdr API socket identity, dimensions, timestamp, endpoint boot/revision, focus,
overlay/availability state, pane interiors and visible sidebar rows. Rectangles
are in terminal cells relative to the whole Herdr client, including its actual
sidebar and tab offsets. `scrollOffset: null` means unknown and must be rejected
for editor placement. Only the local endpoint is exported; at most 128 pane/row
entries are included. Incoherent, unpresented, resized, frozen, overlaid or
disconnected views publish unavailable geometry.

Consumers still verify the process identity, file owner/mode, socket binding,
Kitty ancestry/window identity, current terminal dimensions, focused pane,
zero scroll and freshness (2.5 seconds). Missing or rejected reports disable only
precise placement. No geometry is guessed and no session is focused automatically.
