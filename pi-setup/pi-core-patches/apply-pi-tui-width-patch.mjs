#!/usr/bin/env node
/**
 * apply-pi-tui-width-patch.mjs — conservative grapheme widths for EVERY
 * installed copy of pi-tui.
 *
 * WHY: pi-tui's graphemeWidth() undercounts the real terminal cursor advance
 * for complex scripts (Devanagari matras/conjuncts etc). Components pad lines
 * to exactly terminal width with that measure, so one undercounted grapheme
 * hard-wraps the line, the terminal scrolls a row the TUI doesn't know about,
 * and the differential renderer smears the whole screen until SIGWINCH.
 * Full analysis: AGENTS.md "TUI Width Desync Fix".
 *
 * WHY A SCRIPT (not a stored file): pi-tui exists in MULTIPLE copies —
 * pi core's node_modules, ~/.pi/agent/npm/node_modules (used by ALL npm
 * packages: pi-tool-display, pi-sub-bar, pi-token-burden, pi-context, ...), and
 * inactive packages. Versions differ (0.74.x, 0.80.x). A textual, idempotent
 * patch survives version drift; whole-file copies don't.
 *
 * Usage: node apply-pi-tui-width-patch.mjs        # patch all copies
 *        node apply-pi-tui-width-patch.mjs --check # report only
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const CHECK_ONLY = process.argv.includes("--check");
const MARKER = "function __clusterAdvance(";
export const FAST_MARKER = "LOCAL PATCH: single-cell fast path";

// Speed only. Every code below counts 1 in the patched graphemeWidth() whatever is beside it; the pictographs in
// these ranges count 2 there (__clusterAdvance), so they are left to the general path.
const FAST_PATH_CODE = `// ${FAST_MARKER}: Latin, punctuation, arrows, maths, box drawing,
// blocks and shapes are measured without segmenting, as graphemeWidth() measures each.
const __twoCellPictographs = new Set([0xa9, 0xae, 0x2194, 0x2195, 0x2196, 0x2197, 0x2198, 0x2199, 0x21a9, 0x21aa, 0x25aa, 0x25ab, 0x25b6, 0x25c0, 0x25fb, 0x25fc]);
function __singleCell(code) {
    return ((code >= 0xa0 && code <= 0x2ff && code !== 0xad) ||
        (code >= 0x2010 && code <= 0x2027) ||
        (code >= 0x2190 && code <= 0x22ff) ||
        (code >= 0x2500 && code <= 0x25fc)) && !__twoCellPictographs.has(code);
}
`;
export const FAST_EDITS = [
    [
        "function asciiVisibleWidth(str) {",
        `${FAST_PATH_CODE}function asciiVisibleWidth(str) {`,
    ],
    [
        "            i += length;\n        }\n        else {\n            return -1;\n        }\n    }\n    return width;\n}",
        "            i += length;\n        }\n        else if (__singleCell(code)) {\n            width++;\n            i++;\n        }\n        else {\n            return -1;\n        }\n    }\n    return width;\n}",
    ],
    [
        "    if (isPrintableAscii(text)) {\n        if (text.length <= maxWidth) {",
        `    // ${FAST_MARKER}: text that fits is returned as it is, as the general path below returns it
    const simpleWidth = asciiVisibleWidth(text);
    if (simpleWidth !== -1 && simpleWidth <= maxWidth) {
        return pad ? text + " ".repeat(maxWidth - simpleWidth) : text;
    }
    if (isPrintableAscii(text)) {
        if (text.length <= maxWidth) {`,
    ],
];

/** utils.js with the fast path, or undefined when an anchor is missing or not unique (an older pi-tui). */
export function withFastPath(src) {
    for (const [from, to] of FAST_EDITS) {
        const at = src.indexOf(from);
        if (at < 0 || src.indexOf(from, at + 1) >= 0) return undefined;
        src = src.slice(0, at) + to + src.slice(at + from.length);
    }
    return src;
}

const CLUSTER_ADVANCE_CODE = `
// LOCAL PATCH: per-codepoint cursor advance a terminal performs for a cluster.
// Zero-advance: nonspacing (Mn) + enclosing (Me) marks, format chars, default
// ignorables, controls. Spacing combining marks (Mc) deliberately COUNT 1:
// Ghostty gives Indic matras their own cell (हिंदी = 4 cols, measured via DSR
// 2026-07-04); tmux gives 0 — counting 1 is exact in Ghostty and a benign
// overcount in tmux. Invariant: may OVERCOUNT the terminal (benign — line
// pads a column short) but must NEVER UNDERCOUNT (fatal — hard-wrap desync).
const __zeroAdvanceRegex = /^[\\p{Mn}\\p{Me}\\p{Cf}\\p{Default_Ignorable_Code_Point}\\p{Cc}]$/v;
const __extPictographicRegex = /^\\p{Extended_Pictographic}$/u;
function __clusterAdvance(segment) {
    let advance = 0;
    for (const char of segment) {
        const c = char.codePointAt(0);
        if (c === undefined)
            continue;
        // lone surrogates: terminals typically render a 1-col replacement
        if (c >= 0xd800 && c <= 0xdfff) {
            advance += 1;
            continue;
        }
        // hangul V/T conjoining jamo compose into the leading syllable
        if ((c >= 0x1160 && c <= 0x11ff) || (c >= 0xd7b0 && c <= 0xd7ff))
            continue;
        if (__zeroAdvanceRegex.test(char))
            continue;
        const w = eastAsianWidth(c);
        // text-presentation pictographs (e.g. 🖐 U+1F590, EAW=N): several
        // terminals render them 2 cells wide — count 2 to stay conservative
        advance += __extPictographicRegex.test(char) ? Math.max(w, 2) : w;
    }
    return advance;
}
`;

// The global npm root (`npm root -g`) is NOT optional to scan, and leaving it
// out hid 8 unpatched copies for months (found 2026-08-14). pi's own
// `getNpmInstallPath` (dist/core/package-manager.js:1728) falls back to
// `join(npm root -g, name)` whenever a package is missing from the managed
// store — so that directory is genuinely loadable, and on this machine it is
// the nvm root, which is NOT under /opt/homebrew. A hardcoded root list also
// reports "ALL copies patched" while copies it never looked at sit unpatched,
// which is worse than reporting nothing.
function globalNpmRoot() {
    try {
        const out = execSync("npm root -g", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
        return out && fs.existsSync(out) ? out : null;
    } catch {
        return null; // no npm on PATH — the other roots still get scanned
    }
}

// Where the RUNNING pi actually lives, rather than assuming homebrew. Mirrors
// pi's own getPackageDir(): resolve the `pi` on PATH and walk up to the
// node_modules that contains it.
function runningPiRoot() {
    try {
        const bin = execSync("readlink -f \"$(command -v pi)\" 2>/dev/null || true", {
            encoding: "utf8",
            shell: "/bin/bash",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        if (!bin) return null;
        const marker = `${path.sep}node_modules${path.sep}`;
        const idx = bin.lastIndexOf(marker);
        if (idx === -1) return null;
        const root = bin.slice(0, idx + marker.length - 1);
        return fs.existsSync(root) ? root : null;
    } catch {
        return null;
    }
}

// This repo checkout, because it is the DEPLOYMENT SOURCE: install.sh does
// `cp -R "$SCRIPT_DIR/extensions" "$PI_AGENT/extensions"`, which copies
// pi-setup/extensions/tools/node_modules (gitignored build output, any pi-tui
// copies) straight into the loaded path. install.sh happens to re-patch
// afterwards (cp at :102, npm install at :107, this script at :250), but that
// makes correctness depend on step ORDER inside one script — anyone deploying
// with a manual `cp -R` gets unpatched copies in the live path. Patching the
// source removes the ordering dependency.
function repoRoot() {
    try {
        const here = path.dirname(fileURLToPath(import.meta.url)); // pi-setup/pi-core-patches
        const root = path.resolve(here, "..", "..");               // repo checkout
        return fs.existsSync(root) ? root : null;
    } catch {
        return null;
    }
}

function findPiTuiCopies() {
    const roots = [
        "/opt/homebrew/lib/node_modules",
        path.join(os.homedir(), ".pi/agent"),
        globalNpmRoot(),
        runningPiRoot(),
        repoRoot(),
    ].filter((r) => typeof r === "string" && r.length > 0);
    const found = new Set();
    for (const root of roots) {
        if (!fs.existsSync(root)) continue;
        let out = "";
        try {
            out = execSync(
                `find "${root}" -type f -path "*/pi-tui/dist/utils.js" -not -path "*/.git/*" 2>/dev/null`,
                { encoding: "utf8" },
            );
        } catch { /* find returns non-zero on permission errors — partial output is fine */ }
        for (const line of out.split("\n")) {
            if (line.trim()) found.add(path.resolve(line.trim()));
        }
    }
    return [...found].sort();
}

function patchFile(file) {
    const original = fs.readFileSync(file, "utf8");
    let src = original.includes(MARKER) ? original : addClusterAdvance(original);
    if (!src.includes(MARKER)) return src;
    // an older pi-tui without the anchors keeps the general path: correct, only slower
    if (!src.includes(FAST_MARKER)) src = withFastPath(src) ?? src;
    if (src === original) return "already-patched";
    fs.writeFileSync(file, src);
    return "patched";
}

function addClusterAdvance(src) {
    if (!src.includes("function graphemeWidth(segment)")) return "no-graphemeWidth";
    if (!src.includes("eastAsianWidth")) return "no-eastAsianWidth";

    // isolate the graphemeWidth function body (ends at first column-0 "}")
    const fnStart = src.indexOf("function graphemeWidth(segment)");
    const fnEnd = src.indexOf("\n}", fnStart);
    if (fnEnd === -1) return "no-fn-end";
    let fn = src.slice(fnStart, fnEnd + 2);

    // 1) all-marks early return → route through clusterAdvance (standalone
    //    spacing marks render 1 col in Ghostty)
    const zeroRet = /(if \(zeroWidthRegex\.test\(segment\)\) \{\n\s*)return 0;/;
    if (!zeroRet.test(fn)) return "no-zero-anchor";
    fn = fn.replace(zeroRet, "$1return __clusterAdvance(segment); // LOCAL PATCH: Mc marks advance 1 cell in Ghostty");

    // 2) final return → conservative max(heuristic, per-codepoint advance)
    const finalRet = /\n(\s*)return width;\n\}$/;
    if (!finalRet.test(fn)) return "no-final-anchor";
    fn = fn.replace(
        finalRet,
        "\n$1// LOCAL PATCH: conservative width — see __clusterAdvance below\n$1return Math.max(width, __clusterAdvance(segment));\n}",
    );

    return src.slice(0, fnStart) + fn + CLUSTER_ADVANCE_CODE + src.slice(fnEnd + 2);
}

function main() {
    const copies = findPiTuiCopies();
    if (copies.length === 0) {
        console.error("ERROR: no pi-tui dist/utils.js found — did pi move?");
        process.exit(1);
    }
    let failures = 0;
    for (const file of copies) {
        const version = (() => {
            try {
                return JSON.parse(fs.readFileSync(path.join(file, "../../package.json"), "utf8")).version;
            } catch { return "?"; }
        })();
        if (CHECK_ONLY) {
            const src = fs.readFileSync(file, "utf8");
            const patched = src.includes(MARKER) && (src.includes(FAST_MARKER) || withFastPath(src) === undefined);
            console.log(`${patched ? "PATCHED " : "UNPATCHED"} v${version}  ${file}`);
            if (!patched) failures++;
            continue;
        }
        const result = patchFile(file);
        console.log(`${result.padEnd(16)} v${version}  ${file}`);
        if (result !== "patched" && result !== "already-patched") failures++;
    }
    if (failures > 0) {
        console.error(CHECK_ONLY
            ? `\n${failures} unpatched cop${failures === 1 ? "y" : "ies"} — run without --check`
            : `\n${failures} cop${failures === 1 ? "y" : "ies"} FAILED to patch — upstream utils.js changed; re-derive the patch (see AGENTS.md)`);
        process.exit(1);
    }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) main();
