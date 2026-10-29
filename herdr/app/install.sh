#!/usr/bin/env bash
# muzzpi · Herdr Mac app (optional): ⌘O ⌘W ⌘I ⌘J keys, a look, and pi's status in its
# agents list. Separate from herdr in Ghostty. Read herdr/app/README.md first.
#   ./install.sh herdr-app              install, or update after a git pull
#   ./install.sh herdr-app --uninstall  take it back out
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APP_HOME="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
PI_EXT="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions/herdr-app-status.ts"
OLD_SOUND="$HOME/.config/herdr/sounds/needs-you.mp3"
MODS="muzz-open muzz-close muzz-idea muzz-attention"
STAMP="$(date +%Y%m%d-%H%M%S)"

ok() { printf '  ✓ %s\n' "$*"; }
warn() { printf '  ! %s\n' "$*"; }

mode=install
for arg in "$@"; do
    case "$arg" in
        --uninstall) mode=uninstall ;;
        -h | --help) sed -n '2,5p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) warn "unknown option: $arg"; exit 2 ;;
    esac
done

if [ ! -f "$APP_HOME/keys.json" ]; then
    warn "no Herdr app home at $APP_HOME: install Herdr (https://herdr.dev) and open it once"
    exit 1
fi

# json_edit <file> <python body>: edits `d` (the parsed file) and writes it back atomically
json_edit() {
    python3 - "$1" "$2" "$HERE" <<'EOF'
import json, os, sys
path, body, here = sys.argv[1], sys.argv[2], sys.argv[3]
d = json.load(open(path)) if os.path.exists(path) else {}
exec(body)
with open(path + ".tmp", "w") as f:
    f.write(json.dumps(d, indent=2, ensure_ascii=False) + "\n")
os.replace(path + ".tmp", path)
EOF
}

if [ "$mode" = uninstall ]; then
    cp "$APP_HOME/keys.json" "$APP_HOME/keys.json.backup-$STAMP"
    json_edit "$APP_HOME/keys.json" '
ours = json.load(open(os.path.join(here, "keys.json")))
defaults = {"cmd-w": "tab.close", "cmd-shift-w": "pane.close"}
for section, binds in ours.items():
    for key, action in binds.items():
        if d.get(section, {}).get(key) == action:
            del d[section][key]
            if key in defaults: d[section][key] = defaults[key]'
    ok "muzzpi keys removed (backup: $APP_HOME/keys.json.backup-$STAMP)"
    for mod in $MODS; do
        [ -d "$APP_HOME/mods/$mod" ] && mv "$APP_HOME/mods/$mod" "$APP_HOME/mods/.$mod.removed-$STAMP"
    done
    ok "mods moved aside as $APP_HOME/mods/.<name>.removed-$STAMP"
    if [ -f "$APP_HOME/layouts/muzz-focus.json" ]; then
        herdr-app do layout.switch --name main >/dev/null 2>&1 || true
        mv "$APP_HOME/layouts/muzz-focus.json" "$APP_HOME/layouts/.muzz-focus.json.removed-$STAMP"
        ok "focus layout moved aside"
    fi
    [ -f "$PI_EXT" ] && mv "$PI_EXT" "$PI_EXT.removed-$STAMP" && ok "pi status reporter off (restart pi)"
    echo "  The cursor-soft theme and your settings.json stay; pick another theme in Herdr's settings."
    exit 0
fi

mkdir -p "$APP_HOME/mods" "$APP_HOME/themes"
for mod in $MODS; do
    mkdir -p "$APP_HOME/mods/$mod"
    cp -p "$HERE/mods/$mod/"* "$APP_HOME/mods/$mod/"
    if command -v herdr-app >/dev/null 2>&1 && ! herdr-app check "$APP_HOME/mods/$mod" >/dev/null 2>&1; then
        herdr-app check "$APP_HOME/mods/$mod" || true
        warn "$mod failed herdr-app check; this Herdr may be older or newer than these mods"
    fi
done
ok "⌘O ⌘W ⌘I ⌘J mods → $APP_HOME/mods ($MODS)"

cp "$HERE/themes/cursor-soft.json" "$APP_HOME/themes/"
mkdir -p "$APP_HOME/layouts"
cp "$HERE/layouts/muzz-focus.json" "$APP_HOME/layouts/"
ok "focus layout → $APP_HOME/layouts/muzz-focus.json (⌘⇧F)"
if [ -f "$OLD_SOUND" ]; then
    mkdir -p "$APP_HOME/sounds"
    cp "$OLD_SOUND" "$APP_HOME/sounds/needs-you.mp3"
fi
json_edit "$APP_HOME/settings.json" '
for k, v in {"theme": "cursor-soft", "appearance": "dark", "font": "Fira Code", "font_size": 14}.items():
    d.setdefault(k, v)
sounds = d.setdefault("sounds", {"enabled": True})
if os.path.exists(os.path.join(os.path.dirname(path), "sounds/needs-you.mp3")):
    sounds.setdefault("blocked", "sounds/needs-you.mp3")'
ok "theme cursor-soft, Fira Code 14, needs-you sound (settings you already set are kept)"

cp "$APP_HOME/keys.json" "$APP_HOME/keys.json.backup-$STAMP"
json_edit "$APP_HOME/keys.json" '
for section, binds in json.load(open(os.path.join(here, "keys.json"))).items():
    d.setdefault(section, {}).update(binds)'
ok "keys merged into $APP_HOME/keys.json (backup: keys.json.backup-$STAMP)"
sleep 1
[ -f "$APP_HOME/keys.error" ] && { cat "$APP_HOME/keys.error"; warn "Herdr rejected keys.json; restore the backup"; exit 1; }

grey_focus_border() {
    python3 - "$APP_HOME" <<'EOF'
import json, os, subprocess, sys
home = sys.argv[1]
tree = json.load(open(os.path.join(home, "layouts/main.json")))
state_path = os.path.join(home, "layouts/.state/main.json")
clicks = json.load(open(state_path)).get("nodes", {}) if os.path.exists(state_path) else {}
if clicks.get("main", {}).get("pane", {}).get("focus", {}).get("color") == "input":
    sys.exit(0)

def merge(into, over):
    for k, v in over.items():
        if isinstance(v, dict) and isinstance(into.get(k), dict):
            merge(into[k], v)
        else:
            into[k] = v

def walk(n):
    if isinstance(n, dict):
        if n.get("id") in clicks:
            merge(n, clicks[n["id"]])
        if n.get("id") == "main":
            n["content"]["pane"]["focus"] = {"width": 1, "color": "input"}
        for v in n.values():
            walk(v)
    elif isinstance(n, list):
        for v in n:
            walk(v)

walk(tree)
r = subprocess.run(["herdr-app", "do", "layout.set", json.dumps({"layout": tree})], capture_output=True, text=True)
sys.exit(0 if '"ok"' in r.stdout else 1)
EOF
}
if herdr-app status >/dev/null 2>&1; then
    if grey_focus_border; then ok "the focused pane's border is grey (theme colour \`input\`)"; else warn "could not set the grey focus border; Herdr keeps its own"; fi
else
    warn "Herdr is not open: run this again with it open for the grey focus border"
fi

mkdir -p "$(dirname "$PI_EXT")"
cp "$HERE/pi-status.ts" "$PI_EXT"
ok "pi reports its status to Herdr → $PI_EXT (pi sessions already running need a restart)"

echo ""
echo "  Live in the open Herdr window. Every key: herdr/app/README.md"
