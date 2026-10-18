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

# install alone keeps a dependency package.json dropped; prune removes it
install_tool_deps() {
    (cd "$1" && npm install --no-package-lock --silent 2>/dev/null && npm prune --no-package-lock --silent 2>/dev/null)
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
# shellcheck source=pi-core-patches/patches.sh
source "$SCRIPT_DIR/pi-core-patches/patches.sh"
if pi_locate; then
    ok "pi package: $PI_PKG"
else
    warn "could not find pi's package directory from $(command -v pi). Set PI_PKG_DIR=/path/to/$PI_PACKAGE and re-run."
    exit 1
fi

# The patches replace whole files of pi $PI_BASE. Another pi gets them only when
# it left those files alone; copied over changed ones they undo upstream fixes.
PI_BASE="$(tr -d '[:space:]' < "$SCRIPT_DIR/pi-core-patches/base-version")"
PI_VERSION="$(node -p "require(process.argv[1]).version" "$PI_PKG/package.json")"
if [ "$PI_VERSION" != "$PI_BASE" ]; then
    info "pi $PI_VERSION is installed; this setup's patches are for pi $PI_BASE. Checking they still fit..."
    if ! drift="$(pi_patch_drift "$PI_DIST" "$PI_BASE")"; then
        warn "could not download pi $PI_BASE to compare (offline?); nothing was changed. Re-run when online."
        exit 1
    fi
    if [ -n "$drift" ]; then
        warn "pi $PI_VERSION changed files the patches replace: ${drift//$'\n'/, }. Nothing was changed."
        echo "  Install the pi this setup is built on, then re-run ./install.sh pi:"
        if [ -n "$PI_PREFIX" ]; then
            echo "    npm install -g --prefix '$PI_PREFIX' $PI_PACKAGE@$PI_BASE"
        else
            echo "    pi $PI_BASE, into $PI_PKG, with the tool that installed it there (pnpm, bun, ...)"
        fi
        exit 1
    fi
    ok "the patches fit pi $PI_VERSION"
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
command -v trash &>/dev/null || warn "trash not found: permissions.json makes rm ask first and points the agent at trash (brew install trash)"
if ! command -v bun &>/dev/null; then
    warn "bun not found. The installer bundles the extensions with it: brew install oven-sh/bun/bun"
    exit 1
fi

# ── Create directories ──
info "Creating directories..."
run mkdir -p "$PI_AGENT"
run mkdir -p "$CONFIG_SKILLS"

# ── Extensions ──
# pi loads one prebuilt file per extension; the TypeScript stays in the repo.
# The old dir is moved aside as the backup, then what the repo does not own
# (herdr's extension) and the installed tool deps are carried over.
info "Building and installing extensions..."
EXT_LIVE="$PI_AGENT/extensions"
EXT_OLD="$EXT_LIVE$BACKUP_SUFFIX"
if [ -d "$EXT_LIVE" ]; then
    run mv "$EXT_LIVE" "$EXT_OLD"
    warn "Backed up extensions to $(basename "$EXT_OLD")"
fi
if ! run bun "$SCRIPT_DIR/build-extensions.ts" "$EXT_LIVE"; then
    if [ -d "$EXT_OLD" ]; then
        if [ -e "$EXT_LIVE" ]; then mv "$EXT_LIVE" "$EXT_LIVE.failed$BACKUP_SUFFIX"; fi
        mv "$EXT_OLD" "$EXT_LIVE"
    fi
    warn "extension build failed (see above); the previous extensions are back in place"
    exit 1
fi
if [ -d "$EXT_OLD" ]; then
    for old in "$EXT_OLD"/*; do
        [ -e "$old" ] || continue
        name="$(basename "$old")"
        if [ ! -e "$SCRIPT_DIR/extensions/$name" ] && [ ! -e "$EXT_LIVE/$name" ]; then
            run cp -R "$old" "$EXT_LIVE/"
            warn "Kept $name (not from this repo)"
        fi
    done
    if [ -d "$EXT_OLD/tools/node_modules" ]; then
        run mv "$EXT_OLD/tools/node_modules" "$EXT_LIVE/tools/"
    fi
fi

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

# ── searchd: the index behind find and grep ──
# Optional: without a Rust toolchain the tools keep running rg. A build serves
# only after its selftest has matched this machine's rg (it records a stamp).
SEARCHD_SRC="$SCRIPT_DIR/searchd"
SEARCHD_BIN="$PI_AGENT/bin/searchd"
SEARCHD_TARGET="${XDG_CACHE_HOME:-$HOME/.cache}/muzzpi/searchd-target"

# searchd needs Rust 1.88 (let-chains, edition 2024).
rustc_new_enough() {
    local version major minor
    version="$(rustc --version 2>/dev/null | sed -n '1s/^rustc \([0-9]*\)\.\([0-9]*\).*/\1 \2/p')"
    [ -n "$version" ] || return 1
    read -r major minor <<< "$version"
    [ "$major" -gt 1 ] || { [ "$major" -eq 1 ] && [ "$minor" -ge 88 ]; }
}

if [ "$(uname -s)" != "Darwin" ]; then
    info "searchd is macOS-only; find and grep use rg"
elif [ ! -d "$SEARCHD_SRC" ] || ! command -v cargo &>/dev/null; then
    warn "cargo not found: searchd not built, find and grep use rg (https://rustup.rs enables it)"
elif ! rustc_new_enough; then
    warn "rustc $(rustc --version 2>/dev/null | cut -d' ' -f2) is older than the 1.88 searchd needs: not built, find and grep use rg (rustup update, then re-run)"
else
    info "Building searchd (the index behind find and grep)..."
    if run env CARGO_TARGET_DIR="$SEARCHD_TARGET" cargo build --release --locked --manifest-path "$SEARCHD_SRC/Cargo.toml"; then
        run mkdir -p "$PI_AGENT/bin"
        # the running daemon is the old build; the next find or grep starts the new one
        if [ -x "$SEARCHD_BIN" ]; then run "$SEARCHD_BIN" query '{"op":"shutdown"}' >/dev/null 2>&1 || true; fi
        run cp "$SEARCHD_TARGET/release/searchd" "$SEARCHD_BIN.new.$$"
        run mv -f "$SEARCHD_BIN.new.$$" "$SEARCHD_BIN"
        if [ "$DRY_RUN" -eq 0 ]; then
            declared="$(sed -n 's/^version = "\(.*\)"/\1/p' "$SEARCHD_SRC/Cargo.toml" | head -1)"
            built="$("$SEARCHD_BIN" version 2>/dev/null || true)"
            [ "$built" = "$declared" ] || warn "searchd reports version '$built', Cargo.toml says '$declared'"
        fi
        if run "$SEARCHD_BIN" selftest --stamp; then
            ok "searchd installed: find and grep start it on first use (remove it with: $SEARCHD_BIN uninstall)"
        else
            warn "searchd selftest failed: it will not serve, and find/grep keep using rg"
        fi
    else
        warn "searchd build failed: find and grep keep using rg"
    fi
fi

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

# ── MCP servers (pi's built-in client) ──
if [ -f "$SCRIPT_DIR/mcp.json" ]; then
    info "Installing MCP config..."
    install_file "$SCRIPT_DIR/mcp.json" "$PI_AGENT/mcp.json"
    ok "MCP config installed ($PI_AGENT/mcp.json)"
fi

# ── Pi packages ──
# None: everything runs from extensions/ or pi itself. Remove what older
# installs had: <npm source>|<dir under npm/node_modules>|<what replaced it>.
replaced=(
    "npm:@benvargas/pi-claude-code-use@2.2.1|@benvargas/pi-claude-code-use|extensions/anthropic-sub.ts"
    "npm:pi-mcp-adapter@5.3.1|pi-mcp-adapter|pi's built-in MCP client"
    "npm:pi-codex-goal@0.6.1|pi-codex-goal|extensions/goal"
)
for entry in "${replaced[@]}"; do
    IFS='|' read -r source dir by <<< "$entry"
    [ -d "$PI_AGENT/npm/node_modules/$dir" ] || continue
    run pi remove "$source" || true
    if [ -d "$PI_AGENT/npm/node_modules/$dir" ]; then
        run mv "$PI_AGENT/npm/node_modules/$dir" "$PI_AGENT/$(basename "$dir")$BACKUP_SUFFIX"
    fi
    ok "Removed $(basename "$dir") (replaced by $by)"
done

# ── pi core patches (dist/) ──
# resource-loader.js is CRITICAL — without it pi refuses to start (our tools
# override built-in tool names). The pi-tui width patch is CRITICAL too —
# without it Indic conjuncts or text-presentation emoji smear the whole TUI.
if [ -d "$SCRIPT_DIR/pi-core-patches" ]; then
    info "Applying pi core patches to $PI_DIST (stock files kept as *.stock)..."
    for entry in "${PI_CORE_PATCHES[@]}"; do
        patch_core_file "$SCRIPT_DIR/pi-core-patches/$(patch_source "$entry")" "$PI_DIST/$(patch_dist_path "$entry")"
    done
    # every npm package bundles its own pi-tui, and one unpatched copy still smears
    run node "$SCRIPT_DIR/pi-core-patches/apply-pi-tui-width-patch.mjs" || \
        warn "pi-tui width patch failed on some copies — TUI may smear on exotic unicode (see AGENTS.md)"
    ok "pi core patches applied (resource-loader + session pinning + lazy MCP + pi-tui widths)"
else
    warn "pi-core-patches/ missing — apply them by hand"
fi

# ── pi entrypoint: our bundle of the patched files ──
# pi ships `pi` → dist/bundle/cli.js, built before any patch. Ours is pi's own
# recipe run on the files patched above; without it `pi` runs those files directly.
info "Building pi from the patched files..."
BUILD=(node "$SCRIPT_DIR/pi-bundle/build-pi-bundle.mjs" --pkg "$PI_PKG")
# PI_PKG_DIR can name another install than the `pi` on PATH; never repoint that one.
if [ "$(node -e 'const fs = require("fs"); console.log(fs.realpathSync(process.argv[1]).startsWith(fs.realpathSync(process.argv[2]) + "/"))' "$PI_BIN" "$PI_PKG" 2>/dev/null)" != true ]; then
    warn "$PI_BIN is not from $PI_PKG: building without re-pointing it"
    run "${BUILD[@]}" || warn "could not build our bundle (see above)"
elif run "${BUILD[@]}" --link "$PI_BIN"; then
    ok "pi runs our bundle of the patched files"
else
    warn "could not build or link our bundle (see above): pi runs the patched files directly, ~170 ms slower per start"
    if pi_bin_is_bundle || pi_bin_is_our_bundle; then
        run ln -sfn "$PI_PKG/dist/cli.js" "$PI_BIN" || \
            warn "could not re-link $PI_BIN — run: ln -sfn '$PI_PKG/dist/cli.js' '$PI_BIN'"
    fi
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
