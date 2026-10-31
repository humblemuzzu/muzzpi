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

# ── pi core: fast /resume (stock decodes every tool result of every session, and lowercases all of it per keystroke) ──
if grep -q "LOCAL PATCH: fast /resume" "$PI_DIST/core/session-manager.js" 2>/dev/null && \
   grep -q "LOCAL PATCH: fast /resume search" "$PI_DIST/modes/interactive/components/session-selector-search.js" 2>/dev/null; then
    pass "pi core: fast /resume"
else
    fail "pi core: fast /resume missing" \
         "cp pi-setup/pi-core-patches/session-manager.js $PI_DIST/core/session-manager.js && cp pi-setup/pi-core-patches/session-selector-search.js $PI_DIST/modes/interactive/components/session-selector-search.js"
fi
# session-selector-search.js carries a copy of pi-tui's fuzzyMatch (fuzzyMatchLower) taking lowercased text
FUZZY_SHA="$(shasum -a 256 "$PI_PKG/node_modules/@earendil-works/pi-tui/dist/fuzzy.js" 2>/dev/null | cut -d' ' -f1)"
if [ "$FUZZY_SHA" = "f873c8e2d808d215e57942ac325b9e635bde9632526d25b56b4eef253362b91b" ]; then
    pass "pi-tui: fuzzyMatch is the one fast /resume copied"
else
    fail "pi-tui: fuzzy.js changed since fast /resume copied fuzzyMatch" \
         "re-copy fuzzyMatch into fuzzyMatchLower in pi-setup/pi-core-patches/session-selector-search.js, then update FUZZY_SHA here"
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

# ── images: every enabled Claude model carries the 128 MB request limit ──
# pi's catalog still says 32 MiB; without the models.json override the image
# tools refuse at a quarter of what the API accepts.
REQ_REPORT=$(python3 - "$PI_AGENT/settings.json" "$PI_AGENT/models.json" <<'PY'
import json, sys
try:
    enabled = json.load(open(sys.argv[1])).get("enabledModels") or []
    providers = json.load(open(sys.argv[2])).get("providers") or {}
    overrides = (providers.get("anthropic") or {}).get("modelOverrides") or {}
    missing = [m for m in enabled if m.startswith("anthropic/")
               and ((overrides.get(m[len("anthropic/"):]) or {}).get("inputLimits") or {}).get("maxRequestBytes") != 128000000]
    print(" ".join(missing))
except Exception as e:
    print(f"cannot read config: {type(e).__name__}: {e}")
PY
)
if [ -z "$REQ_REPORT" ]; then
    pass "images: every enabled Claude model has the 128 MB request limit"
else
    fail "images: 128 MB request limit (maxRequestBytes override) missing — $REQ_REPORT" \
         "add it under providers.anthropic.modelOverrides in pi-setup/models.json, then ./install.sh pi"
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

if [ -f "$PI_AGENT/extensions/agents-ui/index.js" ] && [ ! -e "$PI_AGENT/extensions/subagent-inspector" ] && \
   grep -q '"~/.pi/agent/extensions/agents-ui"' "$PI_AGENT/settings.json" 2>/dev/null; then
    pass "agents-ui: deployed and listed; the old subagent-inspector is gone"
else
    fail "agents-ui: missing from the live extensions dir or settings.json, or subagent-inspector is still deployed" \
         "bash pi-setup/install.sh, then trash $PI_AGENT/extensions/subagent-inspector if it remains"
fi

# focus mode covers exactly pi's fullscreen chat rows, read from pi-tui's private getPrimaryScrollView()
PI_TUI_DIST="$PI_PKG/node_modules/@earendil-works/pi-tui/dist"
if grep -q "getPrimaryScrollView() {" "$PI_TUI_DIST/tui-alt-screen.js" 2>/dev/null && \
   grep -q "get viewportHeight()" "$PI_TUI_DIST/components/scroll-view.js" 2>/dev/null; then
    pass "focus: pi-tui still exposes the fullscreen chat height focus mode sizes itself to"
else
    fail "focus: pi-tui no longer has getPrimaryScrollView()/viewportHeight, so focus mode cannot size itself" \
         "re-derive extensions/focus/viewport.ts against the new pi-tui (cd pi-setup/extensions && bun test focus/viewport.test.ts)"
fi

# ── sub-agents: agent-models.json loads cleanly and every model is in pi's catalog ──
# Parsed by the loader the tools bundle is built from, so this cannot drift from
# what the tools read. `pi --list-models` lists only providers you are logged in
# to: a provider with nothing listed is a login still to do, not a broken model.
AM_REPORT=$(cd "$SCRIPT_DIR/extensions/tools" 2>/dev/null && bun -e '
const { loadAgentModels, MAIN_MODEL_ID } = await import("./lib/agent-models.ts");
const { execFileSync } = await import("node:child_process");
const config = loadAgentModels();
const listed = new Set(execFileSync("pi", ["--list-models"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] })
  .split("\n").map((l) => l.trim().split(/\s+/)).filter((c) => c.length > 1).map(([p, m]) => `${p}/${m}`));
const provider = (id) => id.split("/")[0];
const providers = new Set([...listed].map(provider));
const missing = Object.entries(config.models).filter(([, m]) => m.id !== MAIN_MODEL_ID && !listed.has(m.id));
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

# ── searchd: the optional index behind find and grep (without it they run rg) ──
SD_BIN="$PI_AGENT/bin/searchd"
SD_STAMP="$PI_AGENT/searchd/selftest.json"
SD_REPO_VERSION=$(sed -n 's/^version = "\(.*\)"/\1/p' "$SCRIPT_DIR/searchd/Cargo.toml" 2>/dev/null | head -1)
SD_RG="$(rg --version 2>/dev/null | head -1)"
SD_STATE=""
if [ -f "$SD_STAMP" ]; then
    # "changed": the daemon re-checks itself at its next start; "failed": the
    # check ran against this very rg and did not pass.
    SD_STATE=$(python3 - "$SD_STAMP" "$SD_RG" <<'PY'
import json, sys
path, rg = sys.argv[1:3]
try:
    stamp = json.load(open(path))
except Exception:
    print("unreadable")
    raise SystemExit
if stamp.get("rg") != rg:
    print("changed")
elif stamp.get("ok") is False:
    print("failed")
else:
    print("ok")
PY
)
fi
if [ ! -x "$SD_BIN" ]; then
    note "searchd: not installed, so find and grep run rg" "bash pi-setup/install.sh --with-deps   (installs Rust, builds it, stamps it)"
elif [ "$("$SD_BIN" version 2>/dev/null)" != "$SD_REPO_VERSION" ]; then
    note "searchd: the installed build is not the repo's version $SD_REPO_VERSION" "bash pi-setup/install.sh"
elif [ ! -f "$SD_STAMP" ] || [ "$SD_STATE" = "unreadable" ]; then
    note "searchd: no selftest stamp, so it answers nothing and find/grep run rg" "$SD_BIN selftest --stamp"
elif [ "$SD_STATE" = "changed" ]; then
    note "searchd: rg changed since the selftest — the daemon re-checks itself at its next start" "$SD_BIN selftest --stamp (to check now)"
elif [ "$SD_STATE" = "failed" ]; then
    fail "searchd: its selftest FAILED against this rg, so find/grep run rg" "$SD_BIN selftest --verbose, then bash pi-setup/install.sh"
else
    pass "searchd: installed, selftest passed against this rg"
fi

# A global gitignore rule that is not `**/`-prefixed is anchored to the folder rg
# runs in, so searchd refuses every search below another folder and hands it to
# rg: worth naming, since it costs the index silently. Read from a daemon that
# already answers; verify-patches never starts one.
SD_ANCHORED=""
if [ -x "$SD_BIN" ]; then
    SD_ANCHORED=$("$SD_BIN" status 2>/dev/null | python3 -c '
import json, sys
try:
    s = json.load(sys.stdin)
except Exception:
    raise SystemExit
if s.get("globalIgnoreAnchored"):
    print("%s in %s" % (s.get("globalIgnoreRule"), s.get("globalIgnoreFile")))
' 2>/dev/null)
fi
if [ -n "$SD_ANCHORED" ]; then
    note "searchd: a global gitignore rule is anchored ($SD_ANCHORED), so searches below other folders run rg" \
         "put '**/' in front of that rule in the file named (the daemon picks the change up itself)"
fi

echo
if [ "$FAIL" -eq 0 ]; then
    echo "ALL PATCHES IN PLACE ✓"
else
    echo "SOME PATCHES MISSING — run pi-setup/install.sh or the per-item fixes above"
fi
exit $FAIL
