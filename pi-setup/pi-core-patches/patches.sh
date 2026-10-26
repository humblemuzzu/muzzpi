# shellcheck shell=bash disable=SC2034
# The pi files pi-core-patches/ replaces, shared by install.sh and update-pi.sh. Sourced.
#
# <dist path>[=<file in pi-core-patches/>]; the file defaults to the path's basename.
PI_CORE_PATCHES=(
    core/resource-loader.js
    modes/interactive/components/session-selector.js
    modes/interactive/components/session-selector-search.js
    core/session-manager.js
    core/keybindings.js
    extensions/mcp/index.js=mcp-index.js
)
PI_CORE_PATCHES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

patch_dist_path() { echo "${1%%=*}"; }
patch_source() { case "$1" in *=*) echo "${1#*=}" ;; *) basename "$1" ;; esac; }

# Prints each file under $1 (pi's dist/) whose stock copy differs from pi $2's, so
# the patch made on $2 does not fit it. The stock copy is <file>.stock when
# install.sh kept one; a file that is already our patch fits. Exit 2: no tarball.
pi_patch_drift() {
    local dist="$1" version="$2" work entry file stock status=0
    # /tmp, not $TMPDIR: npm takes devEngines from the nearest package.json above
    # cwd, and ~/package.json may demand bun.
    work="$(mktemp -d /tmp/pi-drift.XXXXXX)" || return 2
    if (cd "$work" && npm pack "@earendil-works/pi-coding-agent@$version" --silent --fetch-retries=0 --fetch-timeout=20000 >/dev/null 2>&1 &&
        tar -xzf ./*.tgz); then
        for entry in "${PI_CORE_PATCHES[@]}"; do
            file="$(patch_dist_path "$entry")"
            stock="$dist/$file"
            [ -f "$stock.stock" ] && stock="$stock.stock"
            cmp -s "$stock" "$PI_CORE_PATCHES_DIR/$(patch_source "$entry")" && continue
            cmp -s "$stock" "$work/package/dist/$file" || echo "$file"
        done
    else
        status=2
    fi
    rm -rf "$work"
    return "$status"
}
