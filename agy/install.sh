#!/usr/bin/env bash
# Antigravity CLI (agy): no permission prompts, a status line, telemetry off.
#   bash agy/install.sh                the settings, the status line, telemetry off
#   bash agy/install.sh --with-rules   also the working rules and the /handoff skill
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
D="$HOME/.gemini/antigravity-cli"
STAMP="$(date +%Y%m%d-%H%M%S)"

with_rules=0
case "${1:-}" in
    "") ;;
    --with-rules) with_rules=1 ;;
    -h|--help) sed -n '2,4p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
esac

command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }
command -v agy >/dev/null || echo "note: agy is not on PATH yet; install it from https://antigravity.google/cli"

mkdir -p "$D"
[ -f "$D/settings.json" ] && cp "$D/settings.json" "$D/settings.json.bak-$STAMP"

python3 - <<'PY'
import json, os, pathlib
home = os.path.expanduser("~")
p = pathlib.Path(home, ".gemini/antigravity-cli/settings.json")
text = p.read_text() if p.exists() else ""
s = json.loads(text) if text.strip() else {}
s.update({
    "$schema": "https://antigravity.google/schemas/v1/settings.json",
    "agentMode": "accept-edits",
    "toolPermission": "always-proceed",
    "artifactReviewPolicy": "always-proceed",
    "allowNonWorkspaceAccess": True,
    "notifications": True,
    "altScreenMode": "always",
    "queuedMessages": "send-immediately",
    "showTips": False,
    "showFeedbackSurvey": False,
    "statusLine": {"type": "command", "command": "python3 ~/.gemini/antigravity-cli/statusline.py"},
})
perm = s.setdefault("permissions", {})
allow = perm.setdefault("allow", [])
deny = perm.setdefault("deny", [])
for rule in ["command(*)", "read_file(*)", f"write_file({home})", "read_url(*)", "execute_url(*)", "mcp(*)"]:
    if rule not in allow:
        allow.append(rule)
for rule in ["command(rm -rf /)", "command(rm -rf ~)", "command(git push --force)", "command(git push -f)", f"write_file({home}/.ssh)"]:
    if rule not in deny:
        deny.append(rule)
p.write_text(json.dumps(s, indent=2) + "\n")
os.chmod(p, 0o600)
if perm.get("ask"):
    print("NOTE: these ask rules will still prompt; remove them in /permissions:", perm["ask"])
PY
echo "settings     $D/settings.json"

cp "$HERE/statusline.py" "$D/statusline.py"
echo "status line  $D/statusline.py"

case "${SHELL:-}" in
    */bash) RC="$HOME/.bashrc" ;;
    *) RC="$HOME/.zshrc" ;;
esac
touch "$RC"
if ! grep -q ANTIGRAVITY_SENTRY_SAMPLE_RATE "$RC"; then
    printf '\n# Antigravity: no crash reports, no Chrome DevTools usage stats\nexport ANTIGRAVITY_SENTRY_SAMPLE_RATE=0\nexport CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS=1\n' >> "$RC"
fi
echo "telemetry    $RC"

ARGV="$HOME/.antigravity/argv.json"
if [ -f "$ARGV" ]; then
    python3 - "$ARGV" <<'PY'
import sys, pathlib
p = pathlib.Path(sys.argv[1])
p.write_text(p.read_text().replace('"enable-crash-reporter": true', '"enable-crash-reporter": false'))
PY
    echo "crash report $ARGV"
fi

if [ "$with_rules" = 1 ]; then
    RULES="$HOME/.gemini/GEMINI.md"
    if [ -s "$RULES" ] && ! cmp -s "$HERE/rules/GEMINI.md" "$RULES"; then
        cp "$RULES" "$RULES.bak-$STAMP"
    fi
    cp "$HERE/rules/GEMINI.md" "$RULES"
    mkdir -p "$HOME/.gemini/config/skills/handoff"
    cp "$HERE/skills/handoff/SKILL.md" "$HOME/.gemini/config/skills/handoff/SKILL.md"
    echo "rules        $RULES"
    echo "skill        ~/.gemini/config/skills/handoff"
fi

echo
echo "Done. Open a new terminal, then:"
echo "  agy -p \"/config\"            check the settings"
echo "  agy → /config → telemetry   turn Enable Telemetry off if it says on"
