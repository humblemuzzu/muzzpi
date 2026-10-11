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
PATCHED=(
    core/resource-loader.js
    modes/interactive/components/session-selector.js
    core/keybindings.js
)

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
for f in "${PATCHED[@]}"; do
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

npm install --prefix "$PREFIX" -g --ignore-scripts "$PKG@$VERSION"
ln -sfn "../lib/node_modules/$PKG/dist/cli.js" "$PREFIX/bin/pi"
for f in "${PATCHED[@]}"; do
    cp "$SCRIPT_DIR/pi-core-patches/$(basename "$f")" "$PI_DIR/dist/$f"
done
node "$SCRIPT_DIR/pi-core-patches/apply-pi-tui-width-patch.mjs"

bash "$SCRIPT_DIR/verify-patches.sh"

reply="$(pi --mode json -p --thinking low "Reply with exactly UPDATE_OK and nothing else." 2>/dev/null)"
if ! grep -q '"text":"UPDATE_OK"' <<<"$reply"; then
    echo "FAIL  headless smoke test did not reply UPDATE_OK"
    echo "rollback: trash '$PI_DIR' && cp -R '$BACKUP' '$PI_DIR' && ln -sfn ../lib/node_modules/$PKG/dist/cli.js $PREFIX/bin/pi"
    exit 1
fi

echo "pi $(pi --version) installed and patched. Now call one sub-agent (finder/chad) from a live session."
echo "rollback: trash '$PI_DIR' && cp -R '$BACKUP' '$PI_DIR' && ln -sfn ../lib/node_modules/$PKG/dist/cli.js $PREFIX/bin/pi"
