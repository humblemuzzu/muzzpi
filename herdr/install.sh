#!/usr/bin/env bash
# muzzpi · herdr (optional): Ghostty's ⌘ keys drive herdr, plus ⌘O project
# picker, ⌘I idea popup and ⌘W close. Read herdr/README.md first.
#   ./install.sh herdr                install, or update after a git pull
#   ./install.sh herdr --no-ghostty   herdr bindings and scripts, Ghostty untouched
#   ./install.sh herdr --uninstall    take it all back out
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
FRAGMENT="$REPO_DIR/herdr-keys.toml"
CONFIG="${HERDR_CONFIG_PATH:-$HOME/.config/herdr/config.toml}"
BIN_DIR="$HOME/.local/bin"
SCRIPTS="herdr-open herdr-idea herdr-close"
MARK="# muzzpi"
BEGIN="# >>> muzzpi herdr bindings (./install.sh herdr) >>>"
END="# <<< muzzpi herdr bindings <<<"
STAMP="$(date +%Y%m%d-%H%M%S)"

ok() { printf '  ✓ %s\n' "$*"; }
warn() { printf '  ! %s\n' "$*"; }

mode=install
with_ghostty=1
for arg in "$@"; do
    case "$arg" in
        --no-ghostty) with_ghostty=0 ;;
        --uninstall) mode=uninstall ;;
        -h | --help) sed -n '2,6p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) warn "unknown option: $arg"; exit 2 ;;
    esac
done

if ! command -v herdr >/dev/null 2>&1; then
    warn "herdr is not installed: https://herdr.dev"
    exit 1
fi

strip_ours() {
    [ -f "$1" ] || return 0
    awk -v b="$BEGIN" -v e="$END" '
        $0 == b { skip = 1; next }
        $0 == e { skip = 0; next }
        skip { next }
        / # muzzpi$/ { next }
        /^[ \t]*$/ { blank++; next }
        { while (blank > 0) { print ""; blank-- } print }' "$1"
}

table_value() {
    awk -v t="$1" -v k="$2" '
        /^[ \t]*\[\[/ { cur = ""; next }
        /^[ \t]*\[/ { h = $0; sub(/^[ \t]*\[/, "", h); sub(/\].*$/, "", h); gsub(/[ \t]/, "", h); cur = h; next }
        cur == t && match($0, "^[ \t]*" k "[ \t]*=") {
            v = substr($0, RLENGTH + 1); sub(/[ \t]*#.*$/, "", v); gsub(/^[ \t]+|[ \t]+$/, "", v); print v; exit
        }' "$3"
}

has_table() {
    awk -v t="[$1]" '{ l = $0; sub(/[ \t]*(#.*)?$/, "", l); gsub(/^[ \t]+/, "", l); if (l == t) found = 1 } END { exit found ? 0 : 1 }' "$2"
}

insert_after_table() {
    awk -v t="[$1]" -v line="$2" '{ print; l = $0; sub(/[ \t]*(#.*)?$/, "", l); gsub(/^[ \t]+/, "", l); if (!done && l == t) { print line; done = 1 } }' "$3"
}

herdr_check_and_swap() {
    local staged="$1" what="$2"
    if ! HERDR_CONFIG_PATH="$staged" herdr config check >/dev/null 2>&1; then
        HERDR_CONFIG_PATH="$staged" herdr config check || true
        warn "herdr rejected the merged config; yours is unchanged (the attempt is at $staged)"
        exit 1
    fi
    if [ -f "$CONFIG" ] && cmp -s "$staged" "$CONFIG"; then
        rm -f "$staged"
        ok "herdr config already $what ($CONFIG)"
        return
    fi
    if [ -f "$CONFIG" ]; then
        cp "$CONFIG" "$CONFIG.backup-$STAMP"
        ok "herdr config backed up → $CONFIG.backup-$STAMP"
    fi
    mv "$staged" "$CONFIG"
    ok "herdr config $what ($CONFIG)"
}

merge_herdr_config() {
    local staged="$CONFIG.new" conflicts="" new_tables="" last_table="" table key value current line
    mkdir -p "$(dirname "$CONFIG")"
    strip_ours "$CONFIG" >"$staged"

    current="$(table_value keys prefix "$staged")"
    if [ -n "$current" ] && [ "$current" != '"ctrl+b"' ]; then
        conflicts+="    your prefix is $current; the ⌘ keys send ctrl+b"$'\n'
    fi
    while IFS= read -r line; do
        conflicts+="    already bound: $line"$'\n'
    done < <(grep -n -E '"prefix\+(a|shift\+a|f|u|i)"|"prefix\+alt\+' "$staged" || true)

    while IFS=$'\t' read -r table key value; do
        current="$(table_value "$table" "$key" "$staged")"
        if [ -n "$current" ]; then
            [ "$current" = "$value" ] && continue
            [ "$key" = prompt_new_tab_name ] && continue
            conflicts+="    [$table] $key = $current (the ⌘ keys need $value)"$'\n'
        elif has_table "$table" "$staged"; then
            insert_after_table "$table" "$key = $value  $MARK" "$staged" >"$staged.tmp" && mv "$staged.tmp" "$staged"
        else
            [ "$table" = "$last_table" ] || new_tables+=$'\n'"[$table]"$'\n'
            new_tables+="$key = $value"$'\n'
            last_table="$table"
        fi
    done < <(awk '
        /^\[\[/ { exit }
        /^\[/ { t = $0; gsub(/[\[\] \t]/, "", t); next }
        /^[ \t]*[A-Za-z_]+[ \t]*=/ {
            k = $0; sub(/[ \t]*=.*/, "", k); gsub(/[ \t]/, "", k)
            v = substr($0, index($0, "=") + 1); gsub(/^[ \t]+|[ \t]+$/, "", v)
            print t "\t" k "\t" v
        }' "$FRAGMENT")

    if [ -n "$conflicts" ]; then
        printf '  ! your herdr config (%s) clashes with the bindings the ⌘ keys need:\n%s' "$CONFIG" "$conflicts"
        printf '    change those lines, or the matching ones in herdr/herdr-keys.toml and herdr/ghostty-keys.\n'
        printf '    nothing was changed.\n'
        rm -f "$staged"
        exit 1
    fi

    [ -s "$staged" ] && printf '\n' >>"$staged"
    {
        printf '%s%s\n' "$BEGIN" "$new_tables"
        awk '/^\[\[keys\.command\]\]/ { on = 1 } on { print }' "$FRAGMENT"
        printf '%s\n' "$END"
    } >>"$staged"
    herdr_check_and_swap "$staged" "has the muzzpi bindings"
}

ghostty_bin() {
    if [ -x /Applications/Ghostty.app/Contents/MacOS/ghostty ]; then
        echo /Applications/Ghostty.app/Contents/MacOS/ghostty
    else
        command -v ghostty || true
    fi
}

ghostty_config() {
    local mac="$HOME/Library/Application Support/com.mitchellh.ghostty/config"
    local xdg="${XDG_CONFIG_HOME:-$HOME/.config}/ghostty/config"
    if [ -f "$mac" ]; then echo "$mac"
    elif [ -f "$xdg" ]; then echo "$xdg"
    elif [ "$(uname -s)" = Darwin ]; then echo "$mac"
    else echo "$xdg"
    fi
}

install_ghostty_keys() {
    local bin cfg dir staged
    bin="$(ghostty_bin)"
    if [ -z "$bin" ]; then
        warn "Ghostty not found: herdr keeps its own keys (ctrl+b then a letter); the ⌘ shortcuts need Ghostty"
        return
    fi
    cfg="$(ghostty_config)"
    dir="$(dirname "$cfg")"
    mkdir -p "$dir"
    [ -f "$cfg" ] || : >"$cfg"
    install -m 644 "$REPO_DIR/ghostty-keys" "$dir/herdr-keys"
    ok "⌘ shortcuts → $dir/herdr-keys"
    if grep -qE '^[[:space:]]*config-file[[:space:]]*=[[:space:]]*"?\??herdr-keys"?[[:space:]]*$' "$cfg"; then
        "$bin" +validate-config --config-file="$cfg" >/dev/null || { warn "Ghostty rejects $cfg; run: $bin +validate-config"; exit 1; }
        ok "Ghostty config already loads them"
        return
    fi
    staged="$cfg.new"
    cp "$cfg" "$staged"
    printf '\n# herdr ⌘ shortcuts (./install.sh herdr)\nconfig-file = ?herdr-keys\n' >>"$staged"
    if ! "$bin" +validate-config --config-file="$staged"; then
        warn "Ghostty rejected the change; your config is unchanged (the attempt is at $staged)"
        exit 1
    fi
    cp "$cfg" "$cfg.backup-$STAMP"
    mv "$staged" "$cfg"
    ok "added \`config-file = ?herdr-keys\` to $cfg (backup: $cfg.backup-$STAMP)"
}

reload_herdr() {
    if herdr server reload-config >/dev/null 2>&1; then
        ok "running herdr server reloaded its config"
    else
        ok "herdr is not running; the config applies when it starts"
    fi
}

if [ "$mode" = uninstall ]; then
    if [ -f "$CONFIG" ]; then
        strip_ours "$CONFIG" >"$CONFIG.new"
        herdr_check_and_swap "$CONFIG.new" "free of the muzzpi bindings"
    fi
    cfg_dir="$(dirname "$(ghostty_config)")"
    if [ -f "$cfg_dir/herdr-keys" ]; then
        mv "$cfg_dir/herdr-keys" "$cfg_dir/herdr-keys.removed-$STAMP"
        ok "⌘ shortcuts off (moved to $cfg_dir/herdr-keys.removed-$STAMP); the optional include line stays harmless"
    fi
    for script in $SCRIPTS; do rm -f "$BIN_DIR/$script"; done
    ok "removed $SCRIPTS from $BIN_DIR"
    reload_herdr
    echo "  Reload Ghostty with ⌘⇧, to drop the ⌘ shortcuts."
    exit 0
fi

for dep in fzf jq; do
    command -v "$dep" >/dev/null 2>&1 || warn "$dep is missing, ⌘O needs it: brew install $dep"
done
merge_herdr_config
mkdir -p "$BIN_DIR"
for script in $SCRIPTS; do install -m 755 "$REPO_DIR/bin/$script" "$BIN_DIR/$script"; done
ok "$SCRIPTS → $BIN_DIR"
[ -f "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions/ideas/cli.js" ] \
    || warn "⌘I needs pi's ideas extension: ./install.sh pi"
if [ "$with_ghostty" = 1 ]; then install_ghostty_keys; else ok "Ghostty left alone (--no-ghostty)"; fi
reload_herdr

echo ""
echo "  Reload Ghostty with ⌘⇧, and the ⌘ keys are live. Every key: herdr/README.md"
echo "  ⌘O looks in: ${MUZZPI_PROJECT_ROOTS:-~/Documents/Code stuff, ~/StudioProjects, ~/Projects, ~/code}"
echo "     (set MUZZPI_PROJECT_ROOTS=dir1:dir2 in ~/.zshrc to change it)"
