#!/bin/bash
# verify-patches.sh — read-only audit: is every patch/config still in place?
#
# Run after ANY pi update, package update, or `pi install`:
#   bash pi-setup/verify-patches.sh
#
# Exit 0 = everything in place. Exit 1 = something needs re-applying
# (run install.sh, or the specific fix printed next to each FAIL).
# Fix commands assume the repo root as cwd.
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PI_AGENT="$HOME/.pi/agent"
FAIL=0

pass() { printf '\033[32mPASS\033[0m  %s\n' "$1"; }
fail() { printf '\033[31mFAIL\033[0m  %s\n    fix: %s\n' "$1" "$2"; FAIL=1; }
note() { printf '\033[33mWARN\033[0m  %s\n    fix: %s\n' "$1" "$2"; }

PI_BIN="" PI_PKG="" PI_DIST="" PI_PREFIX=""
# shellcheck source=pi-location.sh
if source "$SCRIPT_DIR/pi-location.sh" 2>/dev/null && pi_locate; then
    pass "pi located: $PI_PKG"
else
    fail "cannot locate pi's package directory from \`pi\` on PATH" \
         "install pi (npm install -g @earendil-works/pi-coding-agent), or rerun with PI_PKG_DIR=/path/to/@earendil-works/pi-coding-agent"
fi

# ── pi entrypoint: our bundle of the patched files ──
# pi's own dist/bundle/cli.js was built before any patch, so under it every core
# patch below is inert while its check still passes. Ours is built from the
# patched files and goes stale when one of them changes.
BUILD_FIX="node pi-setup/pi-bundle/build-pi-bundle.mjs --pkg '$PI_PKG' --link '$PI_BIN'"
if declare -F pi_bin_is_bundle >/dev/null && pi_bin_is_bundle; then
    # npm (re)installed pi, which also undid every patch
    fail "pi entrypoint: pi's own bundle — every core patch is inert" "bash pi-setup/install.sh"
elif declare -F pi_bin_is_our_bundle >/dev/null && pi_bin_is_our_bundle; then
    if STALE=$(node "$SCRIPT_DIR/pi-bundle/build-pi-bundle.mjs" --pkg "$PI_PKG" --check 2>&1); then
        pass "pi entrypoint: our bundle, current with the patched files"
    else
        fail "pi entrypoint: our bundle is out of date (${STALE//$'\n'/; })" "$BUILD_FIX"
    fi
else
    note "pi entrypoint: modular CLI (patches load, every start ~170 ms slower)" "$BUILD_FIX"
fi

# ── pi core: tool-conflict suppression (pi won't START without it) ──
if [ -f "$PI_DIST/core/resource-loader.js" ] && \
   ! grep -q "for (const conflict of conflicts)" "$PI_DIST/core/resource-loader.js"; then
    pass "pi core: resource-loader conflict suppression"
else
    fail "pi core: resource-loader conflict suppression" \
         "cp pi-setup/pi-core-patches/resource-loader.js $PI_DIST/core/resource-loader.js"
fi

# ── pi core: session pinning ──
if grep -q "LOCAL PATCH" "$PI_DIST/modes/interactive/components/session-selector.js" 2>/dev/null && \
   grep -q "app.session.pin" "$PI_DIST/core/keybindings.js" 2>/dev/null; then
    pass "pi core: session pinning (Ctrl+B in /resume)"
else
    fail "pi core: session pinning" \
         "cp pi-setup/pi-core-patches/session-selector.js $PI_DIST/modes/interactive/components/session-selector.js && cp pi-setup/pi-core-patches/keybindings.js $PI_DIST/core/keybindings.js"
fi

# ── pi core: lazy MCP connect (stock connects every server at every session start) ──
if grep -q "LOCAL PATCH: lazy MCP connect" "$PI_DIST/extensions/mcp/index.js" 2>/dev/null; then
    pass "pi core: lazy MCP connect"
else
    fail "pi core: lazy MCP connect missing" \
         "cp pi-setup/pi-core-patches/mcp-index.js $PI_DIST/extensions/mcp/index.js"
fi

# ── MCP: pi's built-in client reads ~/.pi/agent/mcp.json ──
# A server without a description changes the mcp_servers prompt section when it
# connects; the adapter's `auth: "oauth"` / `false` fail the built-in's
# validation, which takes only `auth: { provider }`.
MCP_REPORT=$(python3 - "$PI_AGENT/mcp.json" "$PI_AGENT/settings.json" <<'PY'
import json, sys
mcp, settings = sys.argv[1:3]
problems = []
try:
    servers = json.load(open(mcp)).get("mcpServers", {})
    problems += [f"{name} has no description" for name, s in servers.items() if not s.get("description")]
    problems += [f"{name} has the adapter's auth key" for name, s in servers.items() if "auth" in s and not isinstance(s["auth"], dict)]
except (OSError, ValueError) as error:
    problems.append(f"cannot read {mcp}: {error}")
try:
    if "-builtin:mcp" in json.load(open(settings)).get("extensions", []):
        problems.append("settings.json disables builtin:mcp")
except (OSError, ValueError) as error:
    problems.append(f"cannot read {settings}: {error}")
print("; ".join(problems))
PY
) || MCP_REPORT="the audit script failed"
if [ -z "$MCP_REPORT" ]; then
    pass "MCP: built-in client enabled, every server in mcp.json described"
else
    fail "MCP: $MCP_REPORT" \
         "cp pi-setup/mcp.json $PI_AGENT/mcp.json, and drop -builtin:mcp from settings.json extensions"
fi

# ── pi core: compaction must be STOCK ──
# pi-core-patches/compaction.js is retired; copying it would undo upstream's
# toolChoice fix and break /compact on xAI/OpenAI.
if [ -f "$PI_DIST/core/compaction/compaction.js" ] && \
   ! grep -q "toolChoice" "$PI_DIST/core/compaction/compaction.js" && \
   grep -q "getSummarizationFailure" "$PI_DIST/core/compaction/compaction.js"; then
    pass "pi core: compaction is stock (/compact OK)"
else
    fail "pi core: compaction drifted — stock has no toolChoice and defines getSummarizationFailure" \
         "reinstall pi with: bash pi-setup/update-pi.sh <current version>  # never copy pi-core-patches/compaction.js"
fi

# ── pi-tui: conservative widths in ALL copies (TUI smears without it) ──
if node "$SCRIPT_DIR/pi-core-patches/apply-pi-tui-width-patch.mjs" --check >/dev/null 2>&1; then
    pass "pi-tui: width patch present in ALL installed copies"
else
    fail "pi-tui: width patch missing in some copies (TUI will smear on exotic unicode)" \
         "node pi-setup/pi-core-patches/apply-pi-tui-width-patch.mjs"
fi

# ── anthropic-sub extension ──
# Children load it from CHILD_EXTENSIONS only when the file exists, so a missing
# bundle would silently drop the safety net.
if [ -f "$PI_AGENT/extensions/anthropic-sub.js" ] && \
   grep -q '"~/.pi/agent/extensions/anthropic-sub.js"' "$PI_AGENT/settings.json" 2>/dev/null; then
    pass "anthropic-sub: installed and enabled"
else
    fail "anthropic-sub: missing from the live extensions dir or settings.json" \
         "bash pi-setup/install.sh"
fi

# ── removed packages must stay removed (AGENTS.md "Removed — do not reinstall") ──
REMOVED_PKGS=(
    pi-context todos pi-web-access pi-tasks @tomooshi/condensed-milk-pi
    claude-agent-sdk-pi @sting8k/pi-vcc pi-computer-use pi-gpt-config pi-ask
    pi-grok-cli pi-claude-bridge lsp-pi pi-powerline-footer pi-anycopy
    pi-autoresearch pi-token-burden @marckrenn/pi-sub-bar @marckrenn/pi-sub-core
    pi-tool-display @benvargas/pi-claude-code-use pi-mcp-adapter pi-codex-goal
)
NPM_GLOBAL="$(npm root -g 2>/dev/null || true)"
removed_found=""
for pkg in "${REMOVED_PKGS[@]}"; do
    for root in "$PI_AGENT/npm/node_modules" ${PI_PREFIX:+"$PI_PREFIX/lib/node_modules"} ${NPM_GLOBAL:+"$NPM_GLOBAL"}; do
        [ -d "$root/$pkg" ] && removed_found+=" $root/$pkg"
    done
    git_hit=$(find "$PI_AGENT/git" -mindepth 3 -maxdepth 3 -type d -name "${pkg##*/}" 2>/dev/null)
    [ -n "$git_hit" ] && removed_found+=" $git_hit"
    for leftover in "${pkg##*/}" "${pkg##*/}.json" "${pkg##*/}.ts" "${pkg##*/}.js"; do
        [ -e "$PI_AGENT/extensions/$leftover" ] && removed_found+=" $PI_AGENT/extensions/$leftover"
    done
    grep -qE "\"npm:${pkg}(@[^\"]*)?\"|\"git:[^\"]*/${pkg##*/}(@[^\"]*)?\"" "$PI_AGENT/settings.json" 2>/dev/null \
        && removed_found+=" settings.json→$pkg"
done
if [ -z "$removed_found" ]; then
    pass "removed packages: none installed, configured or listed in settings.json"
else
    fail "removed packages are back:$removed_found" \
         "pi remove <source> for each, and trash any leftover dir or config named above"
fi

# ── images: pi still normalizes tool images with the profile lib/image-budget.ts assumes ──
# Our tools size every image to pass pi's normalizer untouched; that normalizer
# is also what clamps every OTHER tool's images under the API's many-image limit.
IMG_REPORT=$(python3 - "$PI_AGENT/settings.json" "$PI_DIST/utils/image-resize-core.js" "$PI_DIST/core/agent-session.js" <<'PY'
import json, re, sys
settings, core, session = sys.argv[1:4]
problems = []
try:
    if json.load(open(settings)).get("images", {}).get("autoResize") is False:
        problems.append("settings.json sets images.autoResize false")
except FileNotFoundError:
    pass
src = open(core).read()
if not re.search(r"maxWidth:\s*2000", src) or not re.search(r"maxHeight:\s*2000", src) or "4.5 * 1024 * 1024" not in src:
    problems.append("pi's default resize profile is no longer 2000x2000 / 4.5 MiB (update PI_DEFAULT_RESIZE)")
if "normalizeToolResultImages" not in open(session).read():
    problems.append("agent-session.js no longer normalizes tool result images")
print("; ".join(problems))
PY
)
if [ -z "$IMG_REPORT" ]; then
    pass "images: pi normalizes tool images, default profile 2000px / 4.5 MiB, autoResize on"
else
    fail "images: $IMG_REPORT" \
         "re-check lib/image-budget.ts against pi's utils/image-resize-core.js, then re-run bun test lib/image-fit.test.ts"
fi

# ── agent prompts: every repo prompt is deployed ──
# pi-spawn reads sub-agent prompts from here; a missing file silently
# degrades that agent to the default body.
agents_missing=""
for f in "$SCRIPT_DIR"/agents/*.md; do
    [ -f "$PI_AGENT/agents/$(basename "$f")" ] || agents_missing+=" $(basename "$f")"
done
if [ -z "$agents_missing" ]; then
    pass "agent prompts: every pi-setup/agents/*.md is deployed"
else
    fail "agent prompts missing from $PI_AGENT/agents:$agents_missing" \
         "mkdir -p $PI_AGENT/agents && cp pi-setup/agents/*.md $PI_AGENT/agents/"
fi

# ── our extensions: smear fixes present in the LIVE deployed copies ──
# install.sh deploys bundles; a .ts left beside one shadows it (pi prefers index.ts)
stale_ts=$(find "$PI_AGENT/extensions" -name node_modules -prune -o -name "*.ts" ! -name herdr-agent-state.ts -print 2>/dev/null | head -3)
if [ -z "$stale_ts" ] && [ -f "$PI_AGENT/extensions/tools/index.js" ]; then
    pass "extensions: deployed as bundles (no TypeScript sources to resolve at startup)"
else
    fail "extensions: not deployed as bundles${stale_ts:+ (found ${stale_ts//$'\n'/, })}" \
         "bash pi-setup/install.sh"
fi

if grep -q "flattenLabelText" "$PI_AGENT/extensions/editor/index.js" 2>/dev/null && \
   grep -q "flattenSegmentText" "$PI_AGENT/extensions/editor/index.js" 2>/dev/null; then
    pass "editor extension: label newline guards (describeToolCall + sinks)"
else
    fail "editor extension: label guards missing (multiline bash cmds smear the TUI)" \
         "bash pi-setup/install.sh"
fi

if grep -q "normalizeForDisplay" "$PI_AGENT/extensions/tools/index.js" 2>/dev/null; then
    pass "tools extension: box-format display normalization"
else
    fail "tools extension: box-format normalization missing" \
         "bash pi-setup/install.sh"
fi

# ── sub-agents: agent-models.json loads cleanly and every model is in pi's catalog ──
# Parsed by the loader the tools bundle is built from, so this cannot drift from
# what the tools read. `pi --list-models` lists only providers you are logged in
# to: a provider with nothing listed is a login still to do, not a broken model.
AM_REPORT=$(cd "$SCRIPT_DIR/extensions/tools" 2>/dev/null && bun -e '
const { loadAgentModels } = await import("./lib/agent-models.ts");
const { execFileSync } = await import("node:child_process");
const config = loadAgentModels();
const listed = new Set(execFileSync("pi", ["--list-models"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] })
  .split("\n").map((l) => l.trim().split(/\s+/)).filter((c) => c.length > 1).map(([p, m]) => `${p}/${m}`));
const provider = (id) => id.split("/")[0];
const providers = new Set([...listed].map(provider));
const missing = Object.entries(config.models).filter(([, m]) => !listed.has(m.id));
const unknown = missing.filter(([, m]) => providers.has(provider(m.id))).map(([n, m]) => `${n} → ${m.id}: pi has no such model`);
console.log(`problems:${[...config.problems, ...unknown].join("; ")}`);
console.log(`login:${[...new Set(missing.map(([, m]) => provider(m.id)).filter((p) => !providers.has(p)))].join(", ")}`);
' 2>&1)
AM_PROBLEMS=$(sed -n 's/^problems://p' <<<"$AM_REPORT")
AM_LOGIN=$(sed -n 's/^login://p' <<<"$AM_REPORT")
grep -q '^login:' <<<"$AM_REPORT" || AM_PROBLEMS="${AM_REPORT:-the check did not run}"
if [ ! -f "$PI_AGENT/agent-models.json" ] || [ -n "$AM_PROBLEMS" ]; then
    fail "sub-agents: agent-models.json — ${AM_PROBLEMS:-missing}" \
         "cp pi-setup/agent-models.json $PI_AGENT/agent-models.json  # then fix the named entries"
else
    pass "sub-agents: agent-models.json valid, every model of a provider you use is listed by pi"
    [ -z "$AM_LOGIN" ] || note "sub-agents: not logged in to $AM_LOGIN yet, so sub-agents set to those models run on your main model" \
        "/login <provider> inside pi, or set that provider's API key (e.g. DEEPSEEK_API_KEY)"
fi

# pi-spawn.ts starts children with --no-extensions -e <the four they use>; that
# relies on --no-extensions keeping exactly the -e paths
if grep -q "this.noExtensions ? cliEnabledExtensions" "$PI_DIST/core/resource-loader.js" 2>/dev/null; then
    pass "sub-agents: pi still loads only the -e extensions under --no-extensions"
else
    fail "sub-agents: pi changed how --no-extensions works; children may be missing their tools" \
         "check resource-loader.js, then call one real sub-agent; PI_SUBAGENT_ALL_EXTENSIONS=1 restores the full set meanwhile"
fi

echo
if [ "$FAIL" -eq 0 ]; then
    echo "ALL PATCHES IN PLACE ✓"
else
    echo "SOME PATCHES MISSING — run pi-setup/install.sh or the per-item fixes above"
fi
exit $FAIL
