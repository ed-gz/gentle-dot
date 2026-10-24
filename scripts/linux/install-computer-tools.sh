#!/usr/bin/env bash
# Build optional Hyprland input helpers from pinned upstream sources, without sudo.
set -euo pipefail
for tool in git meson ninja pkg-config cc; do
  command -v "$tool" >/dev/null || { echo "Install the build dependency: $tool" >&2; exit 1; }
done
pkg-config --exists wayland-client wayland-cursor xkbcommon
# Keep executables outside data/config files. This matches LinuxDesktop's helper discovery.
prefix="$HOME/.local/lib/gentle-dot"
build_dir="$(mktemp -d)"
trap 'rm -rf -- "$build_dir"' EXIT
build_helper() {
  local name="$1" url="$2" commit="$3"
  shift 3
  git init -q "$build_dir/$name"
  git -C "$build_dir/$name" remote add origin "$url"
  git -C "$build_dir/$name" fetch -q --depth 1 origin "$commit"
  test "$(git -C "$build_dir/$name" rev-parse FETCH_HEAD)" = "$commit"
  git -C "$build_dir/$name" checkout -q --detach FETCH_HEAD
  meson setup "$build_dir/$name/build" "$build_dir/$name" --prefix="$prefix" "$@"
  ninja -C "$build_dir/$name/build"
  meson install -C "$build_dir/$name/build"
}
build_helper wtype https://github.com/atx/wtype.git d71be3a7b3f93b534a2823fd68cabd7ac2a02359
build_helper wlrctl https://git.sr.ht/~brocellous/wlrctl afe60da062ea315b92f2a9857e50b77e0b3a4b7e -Dman-pages=disabled
printf 'Installed input helpers in %s/bin. Restart Gentle Dot to detect them.\n' "$prefix"
