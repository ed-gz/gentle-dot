#!/usr/bin/env bash
# Explicit, reviewed installation for source checkouts. Building and APK creation never run this.
# Usage: sudo /usr/bin/bash scripts/linux/install-system-helper.sh /absolute/path/to/build/system-helper
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
umask 022
if [ "$#" != 1 ] || [[ "$1" != /* ]]; then
    echo "Usage: sudo /usr/bin/bash install-system-helper.sh /absolute/path/to/build/system-helper" >&2
    exit 64
fi
if [ "$(id -u)" != 0 ]; then
    echo "Installation requires administrator authentication on the computer. No password is accepted by this script." >&2
    exit 77
fi
stage=$1
for item in privileged-helper dev.gentledot.install-browser.policy SHA256SUMS; do
    [ -f "$stage/$item" ] && [ ! -L "$stage/$item" ] || { echo "Missing or unsafe build artifact: $item" >&2; exit 78; }
done
helper_hash=''
policy_hash=''
while read -r checksum filename extra; do
    [[ "$checksum" =~ ^[0-9a-f]{64}$ ]] && [ -z "$extra" ] || { echo "Invalid checksum manifest." >&2; exit 78; }
    case "$filename" in
    privileged-helper) [ -z "$helper_hash" ] || exit 78; helper_hash=$checksum ;;
    dev.gentledot.install-browser.policy) [ -z "$policy_hash" ] || exit 78; policy_hash=$checksum ;;
    *) echo "Unexpected artifact in checksum manifest." >&2; exit 78 ;;
    esac
done < "$stage/SHA256SUMS"
[ -n "$helper_hash" ] && [ -n "$policy_hash" ] || { echo "Incomplete checksum manifest." >&2; exit 78; }
# Refuse symlinks or writable ancestors before creating installation directories.
for directory in / /usr /usr/libexec /usr/libexec/gentle-dot /usr/share /usr/share/polkit-1 /usr/share/polkit-1/actions; do
    if [ ! -e "$directory" ] && [ ! -L "$directory" ]; then install -d -o root -g root -m 0755 "$directory"; fi
    [ -d "$directory" ] && [ ! -L "$directory" ] && [ "$(stat -c %u "$directory")" = 0 ] || { echo "Unsafe installation directory." >&2; exit 78; }
    directory_mode=$(stat -c %a "$directory")
    (( (8#$directory_mode & 8#022) == 0 )) || { echo "Writable installation directory." >&2; exit 78; }
done
helper_tmp=$(mktemp /usr/libexec/gentle-dot/.helper.XXXXXX)
policy_tmp=$(mktemp /usr/share/polkit-1/actions/.gentle-dot.XXXXXX)
trap 'rm -f -- "$helper_tmp" "$policy_tmp"' EXIT
install -o root -g root -m 0755 -- "$stage/privileged-helper" "$helper_tmp"
install -o root -g root -m 0644 -- "$stage/dev.gentledot.install-browser.policy" "$policy_tmp"
# Hash the protected copies, so changing the source during installation cannot change what is installed.
[ "$(sha256sum "$helper_tmp" | cut -d ' ' -f1)" = "$helper_hash" ] && \
[ "$(sha256sum "$policy_tmp" | cut -d ' ' -f1)" = "$policy_hash" ] || { echo "Build artifacts changed; nothing was installed." >&2; exit 78; }
mv -fT -- "$helper_tmp" /usr/libexec/gentle-dot/privileged-helper
mv -fT -- "$policy_tmp" /usr/share/polkit-1/actions/dev.gentledot.install-browser.policy
echo "Gentle Dot's system helper is installed. Chromium was not installed."
echo "A later Chromium request opens the computer's system authentication dialog."
