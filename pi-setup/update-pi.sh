#!/usr/bin/env bash
set -euo pipefail

VERSION="${1:?usage: update-pi.sh <version>}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=pi-location.sh
source "$SCRIPT_DIR/pi-location.sh"
pi_locate || { echo "cannot locate pi's package directory; set PI_PKG_DIR and rerun"; exit 1; }
[ -n "$PI_PREFIX" ] || { echo "pi at $PI_PKG is not under <prefix>/lib/node_modules; update it by hand"; exit 1; }
PREFIX="$PI_PREFIX"
PKG="$PI_PACKAGE"
PI_DIR="$PREFIX/lib/node_modules/$PKG"
BASE="$(tr -d '[:space:]' < "$SCRIPT_DIR/pi-core-patches/base-version")"
# <dist path>[=<file in pi-core-patches/>]; the file defaults to the path's basename
PATCHED=(
    core/resource-loader.js
    modes/interactive/components/session-selector.js
    core/keybindings.js
    extensions/mcp/index.js=mcp-index.js
)
dist_path() { echo "${1%%=*}"; }
patch_file() { case "$1" in *=*) echo "${1#*=}" ;; *) basename "$1" ;; esac; }

WORK="$(mktemp -d /tmp/pi-update.XXXXXX)"
# npm takes devEngines from the nearest package.json above cwd; ~/package.json demands bun.
cd "$WORK"

CURRENT="$(node -p "require('$PI_DIR/package.json').version")"
echo "installed $CURRENT, patches derived on $BASE, target $VERSION"

npm pack "$PKG@$BASE" "$PKG@$VERSION" --silent >/dev/null
mkdir base new
tar -xzf "earendil-works-pi-coding-agent-$BASE.tgz" -C base
tar -xzf "earendil-works-pi-coding-agent-$VERSION.tgz" -C new

drift=0
for entry in "${PATCHED[@]}"; do
    f="$(dist_path "$entry")"
    if ! cmp -s "base/package/dist/$f" "new/package/dist/$f"; then
        echo "DRIFT  stock $f changed between $BASE and $VERSION"
        drift=1
    fi
done
if [ "$drift" -ne 0 ]; then
    echo "re-derive pi-core-patches/ onto $WORK/new/package/dist, set base-version to $VERSION, rerun"
    exit 1
fi

BACKUP="$HOME/pi-update-backup-$CURRENT-$(date +%Y%m%d-%H%M%S)"
cp -R "$PI_DIR" "$BACKUP"
echo "backup: $BACKUP"
ROLLBACK="rollback: trash '$PI_DIR' && cp -R '$BACKUP' '$PI_DIR' && ln -sfn ../lib/node_modules/$PKG/dist/cli.js $PREFIX/bin/pi"

npm install --prefix "$PREFIX" -g --ignore-scripts "$PKG@$VERSION"
ln -sfn "../lib/node_modules/$PKG/dist/cli.js" "$PREFIX/bin/pi"
for entry in "${PATCHED[@]}"; do
    cp "$SCRIPT_DIR/pi-core-patches/$(patch_file "$entry")" "$PI_DIR/dist/$(dist_path "$entry")"
done
node "$SCRIPT_DIR/pi-core-patches/apply-pi-tui-width-patch.mjs"

bash "$SCRIPT_DIR/verify-patches.sh"

reply="$(pi --mode json -p --thinking low "Reply with exactly UPDATE_OK and nothing else." 2>/dev/null)"
if ! grep -q '"text":"UPDATE_OK"' <<<"$reply"; then
    echo "FAIL  headless smoke test did not reply UPDATE_OK"
    echo "$ROLLBACK"
    exit 1
fi

# exit 2 = no Claude-plan login, which is fine for anyone not using Claude.
canary=0
bun "$SCRIPT_DIR/port-harness/anthropic-oauth-canary.ts" || canary=$?
if [ "$canary" -eq 2 ]; then
    echo "skip  Claude-plan canary: no /login anthropic"
elif [ "$canary" -ne 0 ]; then
    echo "FAIL  Claude-plan requests are no longer billed to the plan (canary output above)"
    echo "$ROLLBACK"
    exit 1
fi

echo "pi $(pi --version) installed and patched. Now call one sub-agent (finder/chad) from a live session."
echo "$ROLLBACK"
