#!/usr/bin/env bash
#
# muzzpi installer: deploys this pi setup into ~/.pi/agent and patches pi.
#
# Usage:
#   ./install.sh pi                      # from the repo root
#   bash pi-setup/install.sh --dry-run   # print every change, make none
#
# Never installs a global npm package: pi loads packages only from
# ~/.pi/agent/npm/node_modules, and a global copy ships an unpatched pi-tui.
# Backs up every file it overwrites, including pi's own stock files (*.stock).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKUP_SUFFIX=".backup-$(date +%Y%m%d-%H%M%S)"

PI_AGENT="$HOME/.pi/agent"
CONFIG_SKILLS="$HOME/.config/agents/skills"

info()  { printf "\033[1;34m→\033[0m %s\n" "$1"; }
ok()    { printf "\033[1;32m✓\033[0m %s\n" "$1"; }
warn()  { printf "\033[1;33m!\033[0m %s\n" "$1"; }

DRY_RUN=0
for arg in "$@"; do
    case "$arg" in
        -n|--dry-run) DRY_RUN=1 ;;
        -h|--help) sed -n '3,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) warn "unknown option: $arg (try --help)"; exit 1 ;;
    esac
done

run() {
    if [ "$DRY_RUN" -eq 1 ]; then
        printf '  \033[2mwould run:\033[0m'
        printf ' %q' "$@"
        printf '\n'
    else
        "$@"
    fi
}

backup_if_exists() {
    local target="$1"
    if [ -e "$target" ]; then
        local backup="${target}${BACKUP_SUFFIX}"
        run cp -R "$target" "$backup"
        warn "Backed up existing $(basename "$target") → $(basename "$backup")"
    fi
}

# Files the repo does not own are kept and reported, never deleted.
sync_dir() {
    local src="$1" target="$2"
    if [ ! -d "$src" ]; then
        warn "Source missing, skipped: $src"
        return 0
    fi
    backup_if_exists "$target"
    run mkdir -p "$target"
    run cp -R "$src/." "$target/" 2>/dev/null || warn "Copy reported errors: $src"
    local orphans
    orphans=$(cd "$target" 2>/dev/null && find . \( -type f -o -type l \) -print | sed 's|^\./||' | sort | while IFS= read -r f; do
        [ -e "$src/$f" ] || printf '%s\n' "$f"
    done) || true
    if [ -n "$orphans" ]; then
        warn "Kept $(printf '%s\n' "$orphans" | wc -l | tr -d ' ') file(s) the repo does not own:"
        printf '%s\n' "$orphans" | sed 's/^/    /'
    fi
}

install_file() {
    local src="$1" target="$2"
    backup_if_exists "$target"
    run cp "$src" "$target"
}

# pi-core-patches replace whole files, so keep the stock file once, beside it.
patch_core_file() {
    local src="$1" target="$2"
    [ -f "$src" ] || { warn "missing patch source: $src"; return 0; }
    if [ -f "$target" ] && ! cmp -s "$src" "$target" && [ ! -e "$target.stock" ]; then
        run cp "$target" "$target.stock"
    fi
    run cp "$src" "$target"
}

# The repo's tools/package.json links its devDependencies to the Homebrew pi.
relink_tool_devdeps() {
    node -e '
const fs = require("fs");
const [file, from, to] = process.argv.slice(1);
const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
for (const [name, spec] of Object.entries(pkg.devDependencies ?? {})) {
    if (typeof spec === "string" && spec.startsWith("file:" + from)) pkg.devDependencies[name] = "file:" + to + spec.slice(5 + from.length);
}
fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
' "$1" "$2" "$3"
}

install_tool_deps() {
    (cd "$1" && npm install --no-package-lock --silent 2>/dev/null)
}

echo ""
echo "╭─────────────────────────────────────────╮"
echo "│   muzzpi                                │"
echo "│   a pi harness, installed               │"
echo "╰─────────────────────────────────────────╯"
echo ""
[ "$DRY_RUN" -eq 1 ] && warn "dry run: nothing below is written"

# ── Prerequisites ──
info "Checking prerequisites..."
if ! command -v pi &>/dev/null; then
    warn "pi not found. Install it first:"
    echo "  npm install -g @earendil-works/pi-coding-agent"
    echo "  Then re-run this script."
    exit 1
fi
ok "pi found: $(pi --version 2>/dev/null || echo 'version unknown')"
if ! command -v node &>/dev/null; then
    warn "node not found. pi needs node >= 22.19; install it, then re-run."
    exit 1
fi

# shellcheck source=pi-location.sh
source "$SCRIPT_DIR/pi-location.sh"
if pi_locate; then
    ok "pi package: $PI_PKG"
else
    warn "could not find pi's package directory from $(command -v pi). Set PI_PKG_DIR=/path/to/$PI_PACKAGE and re-run."
    exit 1
fi

# None of these block the install; each one turns off one feature.
[ -n "${DEEPSEEK_API_KEY:-}" ] || warn "DEEPSEEK_API_KEY not set: chad, finder, librarian, read_session and read_web_page fall back to your main model (edit agent-models.json to change)"
[ -n "${PARALLEL_API_KEY:-}" ] || warn "PARALLEL_API_KEY not set: web_search will refuse until it is"
if ! command -v gh &>/dev/null; then
    warn "gh not found: the 7 GitHub tools need the GitHub CLI (brew install gh && gh auth login)"
elif ! gh auth status &>/dev/null; then
    warn "gh is not logged in: run gh auth login for the GitHub tools"
fi
command -v rg &>/dev/null || warn "rg (ripgrep) not found: grep and find need it (brew install ripgrep)"
command -v trash &>/dev/null || warn "trash not found: permissions.json blocks rm and points the agent at trash (brew install trash)"
command -v bun &>/dev/null || warn "bun not found: verify-patches.sh uses it to audit agent-models.json, and the tests run on it"

# ── Create directories ──
info "Creating directories..."
run mkdir -p "$PI_AGENT"
run mkdir -p "$CONFIG_SKILLS"

# ── Extensions ──
info "Installing extensions..."
sync_dir "$SCRIPT_DIR/extensions" "$PI_AGENT/extensions"

if command -v npm &>/dev/null; then
    TOOLS_DIR="$PI_AGENT/extensions/tools"
    HOMEBREW_PKG="/opt/homebrew/lib/node_modules/$PI_PACKAGE"
    if [ "$PI_PKG" != "$HOMEBREW_PKG" ]; then
        info "Pointing tool devDependencies at $PI_PKG..."
        run relink_tool_devdeps "$TOOLS_DIR/package.json" "$HOMEBREW_PKG" "$PI_PKG"
    fi
    info "Installing tool extension dependencies (npm install)..."
    # the copied lockfile stores the file: links relative to the repo checkout, which sits at a different depth
    run install_tool_deps "$TOOLS_DIR" || warn "npm install failed — run it in $TOOLS_DIR by hand"
else
    warn "npm not found: tool dependencies not installed; web, screenshot and diff tools will fail"
fi
ok "Extensions installed"

# ── Themes ──
info "Installing themes..."
sync_dir "$SCRIPT_DIR/themes" "$PI_AGENT/themes"
ok "Themes installed"

# ── Agents (prompt files) ──
info "Installing agent prompts..."
sync_dir "$SCRIPT_DIR/agents" "$PI_AGENT/agents"
ok "Agent prompts installed"

# ── Pi-level skills ──
if [ -d "$SCRIPT_DIR/pi-skills" ]; then
    info "Installing pi skills..."
    sync_dir "$SCRIPT_DIR/pi-skills" "$PI_AGENT/skills"
    ok "Pi skills installed"
fi

# ── Config-level skills ──
info "Installing config skills..."
sync_dir "$SCRIPT_DIR/config-skills" "$CONFIG_SKILLS"
if [ -f "$CONFIG_SKILLS/chrome-cdp/scripts/cdp.mjs" ] || [ "$DRY_RUN" -eq 1 ]; then
    run chmod +x "$CONFIG_SKILLS/chrome-cdp/scripts/cdp.mjs"
fi
ok "Config skills installed"

# ── Config files ──
info "Installing settings, models, sub-agent models, keybindings, permissions..."
for cfg in settings.json models.json agent-models.json keybindings.json permissions.json; do
    if [ -f "$SCRIPT_DIR/$cfg" ]; then install_file "$SCRIPT_DIR/$cfg" "$PI_AGENT/$cfg"; fi
done
ok "Config files installed"

# ── MCP servers (pi-mcp-adapter global config) ──
if [ -f "$SCRIPT_DIR/mcp.json" ]; then
    info "Installing global MCP config..."
    run mkdir -p "$HOME/.config/mcp"
    install_file "$SCRIPT_DIR/mcp.json" "$HOME/.config/mcp/mcp.json"
    ok "Global MCP config installed (~/.config/mcp/mcp.json)"
fi
if [ -f "$PI_AGENT/mcp.json" ]; then
    run mv "$PI_AGENT/mcp.json" "$PI_AGENT/mcp.json${BACKUP_SUFFIX}"
    ok "Moved leftover $PI_AGENT/mcp.json aside (adapter reads ~/.config/mcp/mcp.json)"
fi

# ── Pi package configs (sub-bar, sub-core) ──
# live copies are TUI-saved; only seed when missing
info "Installing pi package configs..."
for cfg in pi-sub-bar-settings.json pi-sub-core-settings.json; do
    if [ -f "$SCRIPT_DIR/$cfg" ]; then
        if [ -f "$PI_AGENT/$cfg" ]; then
            warn "Keeping live $cfg — not overwriting"
        else
            run cp "$SCRIPT_DIR/$cfg" "$PI_AGENT/$cfg"
            ok "Seeded $cfg (no live copy)"
        fi
    fi
done

# ── Pi packages (npm, discovered by pi at runtime) ──
info "Installing pi packages..."
# Mirror of settings.json "packages"; never re-add one AGENTS.md lists as removed.
packages=(
    "npm:pi-token-burden"
    "npm:@benvargas/pi-claude-code-use@2.2.1"
    "npm:@marckrenn/pi-sub-bar"
    "npm:pi-tool-display"
    "npm:pi-codex-goal@0.6.0"
    "npm:pi-mcp-adapter@5.1.0"
)
for pkg in "${packages[@]}"; do
    info "  Installing $pkg..."
    run pi install "$pkg" 2>/dev/null || warn "Failed to install $pkg (install manually with: pi install $pkg)"
done
ok "Pi packages installed (${#packages[@]} packages)"

# ── pi entrypoint ──
# pi ships `pi` → dist/bundle/cli.js, which never loads the patched dist/ files.
if pi_bin_is_bundle; then
    info "Re-linking pi to the modular CLI so the core patches load..."
    run ln -sfn "$PI_PKG/dist/cli.js" "$PI_BIN" || \
        warn "could not re-link $PI_BIN — run: ln -sfn '$PI_PKG/dist/cli.js' '$PI_BIN'"
fi

# ── pi core patches (dist/) ──
# resource-loader.js is CRITICAL — without it pi refuses to start (our tools
# override built-in tool names). The pi-tui width patch is CRITICAL too —
# without it Indic conjuncts or text-presentation emoji smear the whole TUI.
if [ -d "$SCRIPT_DIR/pi-core-patches" ]; then
    info "Applying pi core patches to $PI_DIST (stock files kept as *.stock)..."
    patch_core_file "$SCRIPT_DIR/pi-core-patches/resource-loader.js" "$PI_DIST/core/resource-loader.js"
    patch_core_file "$SCRIPT_DIR/pi-core-patches/session-selector.js" "$PI_DIST/modes/interactive/components/session-selector.js"
    patch_core_file "$SCRIPT_DIR/pi-core-patches/keybindings.js" "$PI_DIST/core/keybindings.js"
    # every npm package bundles its own pi-tui, and one unpatched copy still smears
    run node "$SCRIPT_DIR/pi-core-patches/apply-pi-tui-width-patch.mjs" || \
        warn "pi-tui width patch failed on some copies — TUI may smear on exotic unicode (see AGENTS.md)"
    # some pi versions import pi-server without declaring the dependency
    run bash "$SCRIPT_DIR/pi-core-patches/install-pi-server.sh" || \
        warn "pi-server install failed — pi may not start (see AGENTS.md)"
    ok "pi core patches applied (resource-loader + session pinning + pi-tui widths + pi-server)"
else
    warn "pi-core-patches/ missing — apply them by hand"
fi

# ── pi-sub grok provider patch ──
# Upstream has no provider plugin hook — PROVIDER_FACTORIES is a hardcoded map —
# so the installed copies are patched after every `pi install`.
SUB_NM="$PI_AGENT/npm/node_modules/@marckrenn"
SUB_PATCH="$SCRIPT_DIR/pi-sub-patches"
if [ -f "$SUB_PATCH/manifest.txt" ] && { [ -d "$SUB_NM/pi-sub-core" ] || [ "$DRY_RUN" -eq 1 ]; }; then
    info "Applying pi-sub grok provider patch..."
    sub_failed=0
    while read -r src dest || [ -n "$src" ]; do
        [ -z "$src" ] && continue
        run cp "$SUB_PATCH/$src" "$SUB_NM/$dest" || { warn "pi-sub patch: could not copy $src → $dest"; sub_failed=1; }
    done < "$SUB_PATCH/manifest.txt"
    if [ "$sub_failed" -eq 0 ]; then ok "pi-sub grok provider patch applied"; else warn "pi-sub grok provider patch INCOMPLETE — see above"; fi
    info "Applying pi-sub-core stale-ctx guard..."
    run node "$SUB_PATCH/apply-sub-core-stale-guard.mjs" || \
        warn "pi-sub-core stale-ctx guard FAILED — a usage fetch outliving /resume will exit pi"
else
    warn "pi-sub packages or pi-sub-patches missing — grok usage provider not installed"
fi

# ── pi-tool-display config ──
if [ -f "$SCRIPT_DIR/extensions/pi-tool-display/config.json" ]; then
    info "Installing pi-tool-display config (all tool overrides disabled)..."
    run mkdir -p "$PI_AGENT/extensions/pi-tool-display"
    run cp "$SCRIPT_DIR/extensions/pi-tool-display/config.json" "$PI_AGENT/extensions/pi-tool-display/config.json"
    ok "pi-tool-display config installed"
fi

if [ "$DRY_RUN" -eq 1 ]; then
    echo ""
    ok "dry run finished — nothing was written. Run without --dry-run to install."
    exit 0
fi

echo ""
echo "╭──────────────────────────────────────────╮"
echo "│   done. restart pi, then:                │"
echo "│                                          │"
echo "│   /login anthropic          Claude Max   │"
echo "│   export DEEPSEEK_API_KEY   optional,    │"
echo "│                             cheap agents │"
echo "│                                          │"
echo "│   debug: PI_DEBUG=1 pi                   │"
echo "│   audit: bash pi-setup/verify-patches.sh │"
echo "╰──────────────────────────────────────────╯"
echo ""

# ── final audit: verify every patch actually landed ──
if [ -f "$SCRIPT_DIR/verify-patches.sh" ]; then
    info "Verifying all patches are in place..."
    bash "$SCRIPT_DIR/verify-patches.sh" || warn "Some patches missing — see FAIL lines above"
fi
