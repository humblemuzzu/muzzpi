#!/usr/bin/env bash
# idea.sh: the /idea capture box from pi's ideas extension, for ⌘I. HERDR_ACTIVE_PANE_CWD picks the project.
CLI="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions/ideas/cli.js"

fail() {
    printf '\n  %s\n\n  press any key to close\n' "$*"
    read -rsn1
    exit 1
}

[ -f "$CLI" ] || fail "$CLI is missing: run ./install.sh pi"

# herdr-core starts this without your login shell, so node may not be on PATH
PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:$HOME/.bun/bin"
if command -v node >/dev/null 2>&1; then exec node --no-warnings "$CLI" prompt; fi
if command -v bun >/dev/null 2>&1; then exec bun "$CLI" prompt; fi
for node in "$HOME"/.nvm/versions/node/*/bin/node; do
    [ -x "$node" ] && exec "$node" --no-warnings "$CLI" prompt
done
fail "⌘I needs node or bun"
