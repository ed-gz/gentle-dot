#!/usr/bin/env bash
# Optional public interoperability probe: no credentials, real endpoints or user data.
set -euo pipefail
root=$(mktemp -d "${TMPDIR:-/tmp}/capri-mcp-sdk.XXXXXXXX")
trap 'rm -rf "$root"' EXIT
fixture="$(dirname "$0")/../test/fixtures/mcp-official-sdk"
cp "$fixture/package.json" "$fixture/package-lock.json" "$root/"
npm ci --prefix "$root" --ignore-scripts --no-audit --no-fund
CAPRI_MCP_OFFICIAL_ROOT="$root" node --test "$(dirname "$0")/../test/mcp-official-sdk.test.mjs"
