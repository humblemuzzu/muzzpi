#!/usr/bin/env bash
set -euo pipefail

VERSION="${1:?usage: update-pi.sh <version>}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=pi-location.sh
source "$SCRIPT_DIR/pi-location.sh"
# shellcheck source=pi-core-patches/patches.sh
source "$SCRIPT_DIR/pi-core-patches/patches.sh"
pi_locate || { echo "cannot locate pi's package directory; set PI_PKG_DIR and rerun"; exit 1; }
[ -n "$PI_PREFIX" ] || { echo "pi at $PI_PKG is not under <prefix>/lib/node_modules; update it by hand"; exit 1; }
PREFIX="$PI_PREFIX"
PKG="$PI_PACKAGE"
PI_DIR="$PREFIX/lib/node_modules/$PKG"
BASE="$(tr -d '[:space:]' < "$SCRIPT_DIR/pi-core-patches/base-version")"

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
for entry in "${PI_CORE_PATCHES[@]}"; do
    f="$(patch_dist_path "$entry")"
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
# keep the fresh stock file beside its patch, as install.sh does: pi_patch_drift reads it
for entry in "${PI_CORE_PATCHES[@]}"; do
    target="$PI_DIR/dist/$(patch_dist_path "$entry")"
    cp "$target" "$target.stock"
    cp "$SCRIPT_DIR/pi-core-patches/$(patch_source "$entry")" "$target"
done
node "$SCRIPT_DIR/pi-core-patches/apply-pi-tui-width-patch.mjs"
if ! node "$SCRIPT_DIR/pi-bundle/build-pi-bundle.mjs" --pkg "$PI_DIR" --link "$PREFIX/bin/pi"; then
    echo "WARN  pi runs the patched files directly (~170 ms slower per start) until build-pi-bundle.mjs builds (see above)"
fi

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

echo "pi $(pi --version) installed and patched; \`pi\` → $(readlink "$PREFIX/bin/pi"). Now call one sub-agent (finder/chad) from a live session."
echo "$ROLLBACK"
