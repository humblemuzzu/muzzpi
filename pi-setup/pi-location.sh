# shellcheck shell=bash disable=SC2034
# Finds the pi install that the `pi` on PATH runs. Sourced, never executed.
#
#   source pi-setup/pi-location.sh && pi_locate
#
# Sets PI_BIN (the `pi` on PATH), PI_PKG (the @earendil-works/pi-coding-agent
# directory), PI_DIST ($PI_PKG/dist) and PI_PREFIX (the npm prefix it is
# installed under, empty when it is not under <prefix>/lib/node_modules).
# PI_PKG_DIR in the environment skips the lookup.

PI_PACKAGE="@earendil-works/pi-coding-agent"

pi_locate() {
    PI_BIN="$(command -v pi 2>/dev/null || true)"
    PI_PKG="${PI_PKG_DIR:-}"
    if [ -z "$PI_PKG" ] && [ -n "$PI_BIN" ] && command -v node >/dev/null 2>&1; then
        PI_PKG="$(node -e '
const fs = require("fs"), path = require("path");
let dir = path.dirname(fs.realpathSync(process.argv[1]));
for (;;) {
    try {
        if (JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).name === process.argv[2]) {
            console.log(dir);
            process.exit(0);
        }
    } catch {}
    const up = path.dirname(dir);
    if (up === dir) process.exit(1);
    dir = up;
}' "$PI_BIN" "$PI_PACKAGE" 2>/dev/null || true)"
    fi
    PI_DIST="${PI_PKG:+$PI_PKG/dist}"
    PI_PREFIX=""
    case "$PI_PKG" in
        */lib/node_modules/"$PI_PACKAGE") PI_PREFIX="${PI_PKG%/lib/node_modules/"$PI_PACKAGE"}" ;;
    esac
    [ -n "$PI_PKG" ] && [ -d "$PI_DIST" ]
}

# pi's package.json points `pi` at dist/bundle/cli.js, which inlines its own
# copy of every file pi-core-patches/ replaces.
pi_bin_is_bundle() {
    [[ "$(readlink "$PI_BIN" 2>/dev/null)" == *dist/bundle/cli.js ]]
}

# Ours: pi's recipe run on the patched files by pi-bundle/build-pi-bundle.mjs.
pi_bin_is_our_bundle() {
    [[ "$(readlink "$PI_BIN" 2>/dev/null)" == *dist/muzzpi-bundle/cli.js ]]
}
