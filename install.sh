#!/usr/bin/env bash
# muzzpi installer
#   ./install.sh pi [--dry-run]   the pi harness  → ~/.pi/agent
#   ./install.sh ghostty          themes, fonts and switchers → Ghostty
#   ./install.sh herdr-ghostty    optional: herdr inside Ghostty, driven by ⌘ keys (herdr/README.md)
#   ./install.sh herdr-app        optional: the Herdr Mac app, set up on its own (herdr/README.md)
#   ./install.sh agy              optional: Antigravity CLI settings, status line, telemetry off (agy/README.md)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"

usage() {
    sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'
}

target="${1:-}"
[ $# -gt 0 ] && shift
case "$target" in
    pi) exec bash "$ROOT/pi-setup/install.sh" "$@" ;;
    ghostty) exec bash "$ROOT/ghostty/install.sh" "$@" ;;
    herdr-ghostty|herdr) exec bash "$ROOT/herdr/in-ghostty/install.sh" "$@" ;;
    herdr-app) exec bash "$ROOT/herdr/app/install.sh" "$@" ;;
    agy) exec bash "$ROOT/agy/install.sh" "$@" ;;
    -h|--help) usage ;;
    *) usage; exit 1 ;;
esac
