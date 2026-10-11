/**
 * shiki-diff — syntax-highlighted, word-level diff rendering for the edit/write
 * tools, delegating to @heyhuynhgiabuu/pi-diff's proven render pipeline.
 *
 * ── why this exists ────────────────────────────────────────────────────────
 * We consume pi-diff as a plain LIBRARY (a dependency of extensions/tools),
 * NOT as a pi extension/package. pi never loads it, so its own tool
 * registrations never run → ZERO collision with our edit/write tools.
 * Only the DISPLAY of our tools' results changes.
 *
 * We call pi-diff's render functions via its `__testing` export. That is an
 * internal surface with no semver guarantee, so this module is defensive:
 * loadRenderers() returns null when the export is missing/renamed, and callers
 * fall back to their existing plain renderer. An upstream change therefore
 * degrades gracefully — never a crash. `npm update @heyhuynhgiabuu/pi-diff`
 * pulls new rendering; verify-patches.sh asserts the export still exists.
 *
 * ── how the async→sync bridge works ───────────────────────────────────────
 * Shiki highlighting is async. pi's tool `renderResult` renderer is sync. So:
 * a sync cache lookup returns highlighted lines on a hit; on a miss we show the
 * plain fallback AND fire the async render, which calls context.invalidate() on
 * completion to trigger a re-render (now a cache hit → highlighted). This is the
 * same pattern pi-diff uses internally.
 */

import * as path from "node:path";
import { truncateToWidth } from "@mariozechner/pi-tui";

// ── pi-diff render pipeline (lazy, defensive) ──────────────────────────────

interface DiffColors {
	fgAdd: string;
	fgDel: string;
	fgCtx: string;
}

type RenderFn = (
	diff: unknown,
	language: string | undefined,
	max?: number,
	dc?: DiffColors,
) => Promise<string>;

interface PiDiffRenderers {
	/** parse a unified diff string into ParsedDiff[] */
	parsePatchFiles: (patch: string) => unknown[];
	/** render a ParsedDiff to a Shiki-highlighted, width-padded ANSI string */
	renderUnified: RenderFn;
	/** side-by-side render; self-falls-back to unified on narrow/wrap-heavy diffs. optional. */
	renderSplit?: RenderFn;
}

// undefined = not yet attempted, null = unavailable (drives fallback)
let _renderers: PiDiffRenderers | null | undefined;
let _loading = false;
// invalidators from renders that showed the fallback while the import was still
// in flight — flushed once when load settles so that first paint upgrades to the
// highlighted diff instead of waiting for an unrelated re-render (G1).
const _onReady = new Set<() => void>();
// render keys with an async shiki render currently in flight — dedups concurrent
// renders of the same diff across the per-render-cycle component rebuilds (S3).
const _inFlight = new Set<string>();

/** kick off the (one-time) dynamic import of pi-diff's render pipeline. */
function kickLoad(): void {
	if (_renderers !== undefined || _loading) return;
	_loading = true;
	import("@heyhuynhgiabuu/pi-diff")
		.then((mod: any) => {
			const t = mod?.__testing;
			if (
				t &&
				typeof t.parsePatchFiles === "function" &&
				typeof t.renderUnified === "function"
			) {
				_renderers = {
					parsePatchFiles: t.parsePatchFiles,
					renderUnified: t.renderUnified,
					renderSplit: typeof t.renderSplit === "function" ? t.renderSplit : undefined,
				};
			} else {
				_renderers = null;
			}
		})
		.catch(() => {
			_renderers = null;
		})
		.finally(() => {
			_loading = false;
			// wake up any diffs that rendered fallback while we were loading.
			const cbs = [..._onReady];
			_onReady.clear();
			for (const cb of cbs) {
				try {
					cb();
				} catch {
					/* ignore */
				}
			}
		});
}

// fire at module load so the Shiki highlighter warms before the first diff.
kickLoad();

// ── theme + language ───────────────────────────────────────────────────────

/** gruvbox-matched colors for gutter markers / non-highlighted spans. */
const GRUVBOX_COLORS: DiffColors = {
	fgAdd: "\x1b[38;2;184;187;38m", // gruvbox green
	fgDel: "\x1b[38;2;251;73;52m", // gruvbox red
	fgCtx: "\x1b[38;2;146;131;116m", // gruvbox gray
};

/** file extension → Shiki bundled language id. unknown → undefined (no highlight). */
const EXT_LANG: Record<string, string> = {
	ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx",
	js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx",
	py: "python", rb: "ruby", go: "go", rs: "rust", java: "java",
	c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp",
	cs: "csharp", php: "php", html: "html", htm: "html", css: "css",
	scss: "scss", sass: "sass", less: "less", json: "json", jsonc: "json",
	yaml: "yaml", yml: "yaml", toml: "toml", md: "markdown", markdown: "markdown",
	sh: "bash", bash: "bash", zsh: "bash", fish: "fish", ps1: "powershell",
	sql: "sql", swift: "swift", kt: "kotlin", kts: "kotlin", lua: "lua",
	r: "r", pl: "perl", pm: "perl", ex: "elixir", exs: "elixir", erl: "erlang",
	clj: "clojure", scala: "scala", dart: "dart", vue: "vue", svelte: "svelte",
	astro: "astro", proto: "proto", graphql: "graphql", gql: "graphql",
	ini: "ini", xml: "xml", diff: "diff", patch: "diff", nix: "nix", zig: "zig",
	hs: "haskell", elm: "elm", ml: "ocaml", fs: "fsharp", jl: "julia",
};

function detectLanguage(filePath: string): string | undefined {
	const base = path.basename(filePath).toLowerCase();
	if (base === "dockerfile" || base.endsWith(".dockerfile")) return "docker";
	if (base === "makefile") return "make";
	if (base === "cmakelists.txt") return "cmake";
	const ext = path.extname(base).slice(1);
	return EXT_LANG[ext];
}

// ── LRU cache of rendered lines ────────────────────────────────────────────

const CACHE_LIMIT = 128;
const _cache = new Map<string, string[]>();

function hashKey(s: string): string {
	// djb2 — small, fast, collision-tolerant enough for a display cache
	let h = 5381;
	for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
	return String(h >>> 0);
}

function cacheGet(k: string): string[] | undefined {
	const v = _cache.get(k);
	if (v) {
		_cache.delete(k);
		_cache.set(k, v);
	}
	return v;
}

function cacheSet(k: string, v: string[]): void {
	_cache.delete(k);
	_cache.set(k, v);
	while (_cache.size > CACHE_LIMIT) {
		const first = _cache.keys().next().value;
		if (first === undefined) break;
		_cache.delete(first);
	}
}

// ── width safety ───────────────────────────────────────────────────────────

/**
 * pi-diff pads every rendered line to its OWN detected width — clamp(columns-4,
 * 80, 210). In the common case that is ≤ pi's tool render region (so diffs sit a
 * few columns short of the right edge — pi-diff's built-in safety margin, not a
 * bug). As a hard guard against smear at the floor/cap edges, truncate any line
 * wider than the width pi actually gave us. We reuse pi-tui's own
 * `truncateToWidth` — ANSI-aware and measuring with the SAME (patched) width
 * tables pi renders with, so the cut aligns exactly. Under-width lines pass
 * through unchanged.
 */
function refitToWidth(lines: string[], width: number): string[] {
	if (width <= 0) return lines;
	return lines.map((line) => truncateToWidth(line, width));
}

// ── the component ──────────────────────────────────────────────────────────

export interface ShikiDiffOptions {
	/** unified diff text (our simpleDiff output) */
	diffText: string;
	/** absolute file path — drives Shiki language detection + is display-only */
	filePath?: string;
	/** header line(s) to prepend (e.g. the +/~/- stats line) */
	header?: string[];
	/** whether the tool result is expanded (raises the line cap) */
	expanded?: boolean;
	/** prefer side-by-side (split) rendering when the terminal is wide enough.
	 * pi-diff auto-falls-back to unified on narrow/wrap-heavy diffs. */
	split?: boolean;
	/** plain renderer used until Shiki is ready / when unavailable */
	fallback: (width: number) => string[];
	/** context.invalidate — re-render trigger when the async render completes */
	invalidate?: () => void;
}

const MAX_LINES_COLLAPSED = 48;
const MAX_LINES_EXPANDED = 600;
// side-by-side needs room for two readable code panes. below this, pi-diff's
// termW() floors at 80 and would emit a 2-column layout wider than a narrow
// pane (the right pane would then be chopped by the refit) — so force unified.
const SPLIT_MIN_WIDTH = 100;

/**
 * build a pi-tui-compatible render component that shows a Shiki-highlighted
 * unified diff, falling back to `fallback` while loading / on any failure.
 */
export function createShikiDiffComponent(opts: ShikiDiffOptions): {
	render(width: number): string[];
	invalidate(): void;
} {
	const lang = opts.filePath ? detectLanguage(opts.filePath) : undefined;
	const maxLines = opts.expanded ? MAX_LINES_EXPANDED : MAX_LINES_COLLAPSED;
	const diffHash = hashKey(opts.diffText);

	return {
		render(width: number): string[] {
			// refit the header too (defense in depth); reused in every return path.
			const head = refitToWidth(opts.header ?? [], width);
			const renderers = _renderers;

			if (!renderers) {
				// only worth waiting on the import if it might still load (undefined);
				// once it has permanently failed (null) we stay on the fallback.
				if (_renderers === undefined) {
					kickLoad();
					if (opts.invalidate) _onReady.add(opts.invalidate);
				}
				return [...head, ...opts.fallback(width)];
			}

			// split only when requested, available, AND the pane is wide enough for
			// two readable columns; renderSplit still self-falls-back to unified for
			// wrap-heavy diffs.
			const useSplit =
				!!opts.split &&
				typeof renderers.renderSplit === "function" &&
				width >= SPLIT_MIN_WIDTH;
			const renderFn: RenderFn = useSplit ? renderers.renderSplit! : renderers.renderUnified;

			// key by view + width: pi-diff renders at its own detected width, so a
			// resize must trigger a fresh render; split vs unified cache separately.
			const key = `${useSplit ? "s" : "u"}\0${lang ?? ""}\0${maxLines}\0${width}\0${diffHash}`;
			const cached = cacheGet(key);
			if (cached) {
				return cached.length === 0
					? [...head, ...opts.fallback(width)]
					: [...head, ...refitToWidth(cached, width)];
			}

			// kick the async shiki render once per key (dedups concurrent renders of
			// the same diff across per-cycle component rebuilds).
			if (!_inFlight.has(key)) {
				let parsed: unknown[] = [];
				try {
					parsed = renderers.parsePatchFiles(opts.diffText);
				} catch {
					parsed = [];
				}
				if (!parsed.length) {
					cacheSet(key, []); // remember failure → stable fallback
				} else {
					_inFlight.add(key);
					renderFn(parsed[0], lang, maxLines, GRUVBOX_COLORS)
						.then((str) => {
							const trimmed = str.endsWith("\n") ? str.slice(0, -1) : str;
							cacheSet(key, trimmed.length ? trimmed.split("\n") : []);
						})
						.catch(() => {
							cacheSet(key, []);
						})
						.finally(() => {
							_inFlight.delete(key);
							opts.invalidate?.();
						});
				}
			}

			return [...head, ...opts.fallback(width)];
		},
		invalidate() {},
	};
}
