#!/bin/sh
# Use scanner defaults even if a local config or inline suppression exists.
set -eu
cd "$(git rev-parse --show-toplevel)"
if command -v gitleaks >/dev/null 2>&1; then
	scanner=gitleaks
elif [ -x .cache/tools/gitleaks ]; then
	scanner=.cache/tools/gitleaks
else
	printf '%s\n' 'Check stopped: install Gitleaks; see docs/repository-hygiene.md.' >&2
	exit 1
fi
umask 077
scan_config="$(mktemp "${TMPDIR:-/tmp}/gentle-dot-gitleaks.XXXXXX")"
trap 'rm -f "$scan_config"' EXIT
trap 'exit 1' HUP INT TERM
printf '[extend]\nuseDefault = true\n' > "$scan_config"
"$scanner" git . --config "$scan_config" --ignore-gitleaks-allow \
	--log-opts='--all --diff-merges=first-parent' --redact --no-banner
