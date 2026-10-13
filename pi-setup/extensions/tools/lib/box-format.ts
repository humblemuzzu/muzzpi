/**
 * box-format — shared diagnostic-style box renderer for tool output.
 *
 * produces miette/ariadne-style box-drawing output:
 *   ╭─[header text]
 *    42 │ highlighted line (base-color gutter)
 *    43 │ dim context line
 *       ·
 *   100 │ another block
 *   ╰────
 *
 * chrome (╭│╰─·) renders DIM. highlighted lines get base-color
 * gutter + content; non-highlighted lines are fully dim.
 * tools without line numbers omit the gutter column.
 *
 * pipeline: callers produce BoxSection[], optionally pass Excerpt[] for
 * per-block visual-line windowing. box-format computes chrome width,
 * expands content to visual lines at (width - chrome), applies
 * windowItems() from show.ts, then wraps the result in box chrome.
 *
 * IMPORTANT: all output lines are truncated to the provided `width`
 * via truncateToWidth() as a safety net. the TUI will crash if any
 * rendered line exceeds terminal width.
 */

import { Container, Text, truncateToWidth, visibleWidth as tuiVisibleWidth } from "@mariozechner/pi-tui";
import { windowItems, type Excerpt } from "./show";

const DIM = "\x1b[2m";
const RST = "\x1b[0m";

// --- display width normalization ---
//
// THE DESYNC BUG (root cause of the "smeared TUI on heavy output" breakage):
// pi-tui measures text in grapheme clusters (Intl.Segmenter + width of the
// base char), but real terminals (Ghostty, tmux, kitty) advance the cursor
// per spacing codepoint for complex scripts. Example: the Devanagari
// conjunct "क्त्र" is ONE grapheme cluster — pi-tui counts width 1, the
// terminal renders 3 columns. pi-tui's Box pads every tool line to exactly
// terminal width using its own measure, so a single undercounted cluster
// makes the padded line wider than the terminal → hard-wrap → the terminal
// scrolls a row pi-tui doesn't know about → every subsequent differential
// write lands on the wrong row → smeared screen (only a SIGWINCH redraw
// recovers). Heavy streaming output makes hitting one such grapheme
// near-certain. Reproduced and bisected in tmux (2026-07-04).
//
// THE FIX: normalize display text at this chokepoint. For every grapheme
// cluster, compare pi-tui's width with a model of the terminal's cursor
// advance; replace disagreeing clusters with U+FFFD "�" (width 1 in every
// model). Display-only — the model-visible tool result text is untouched.
// Single-codepoint clusters always agree by construction and are kept.

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const EXTENDED_PICTOGRAPHIC_RE = /\p{Extended_Pictographic}/u;
const EMOJI_PRESENTATION_RE = /\p{Emoji_Presentation}/u;
const EMOJI_MODIFIER_BASE_RE = /^\p{Emoji_Modifier_Base}/u;
const UNASSIGNED_RE = /\p{Cn}/u;

/** per-codepoint terminal width, using pi-tui's own tables for consistency */
const cpWidthCache = new Map<number, number>();
function codePointWidth(cp: number): number {
	// lone surrogates: pi-tui says 0, terminals render a 1-col replacement
	if (cp >= 0xd800 && cp <= 0xdfff) return 1;
	// hangul V/T conjoining jamo: wcwidth 0 (they compose into the L syllable)
	if ((cp >= 0x1160 && cp <= 0x11ff) || (cp >= 0xd7b0 && cp <= 0xd7ff)) return 0;
	let w = cpWidthCache.get(cp);
	if (w === undefined) {
		w = tuiVisibleWidth(String.fromCodePoint(cp));
		cpWidthCache.set(cp, w);
	}
	return w;
}

/**
 * cursor advance a modern terminal performs for one grapheme cluster.
 * modeled on Ghostty/tmux ≥3.4 behavior (validated empirically in tmux):
 * emoji sequences (ZWJ/VS16/flags) render as 2 columns; everything else
 * advances per spacing codepoint (combining marks are 0).
 *
 * returns NaN for AMBIGUOUS clusters — chars real terminals disagree on:
 * - text-presentation pictographs (EP without Emoji_Presentation, e.g. 🖐 ☹):
 *   tmux renders 2, others follow EAW and render 1
 * - codepoints unassigned in this Node's ICU tables: pi-tui guesses 1,
 *   terminals with newer Unicode data may render 0 or 2
 * NaN never equals the pi-tui width, so these clusters are replaced.
 */
function terminalClusterWidth(cluster: string): number {
	// regional indicator pairs (flags)
	const first = cluster.codePointAt(0)!;
	if (first >= 0x1f1e6 && first <= 0x1f1ff) return 2;
	// ZWJ emoji sequences and VS16 emoji presentation
	if (cluster.includes("\u200d") && EXTENDED_PICTOGRAPHIC_RE.test(cluster)) return 2;
	if (cluster.includes("\ufe0f")) return 2;
	let sum = 0;
	for (const ch of cluster) {
		const cp = ch.codePointAt(0)!;
		if (cp >= 0x1f3fb && cp <= 0x1f3ff) {
			// skin tone modifier: merges into a modifier base (width 0),
			// renders as its own 2-col emoji after anything else
			sum += EMOJI_MODIFIER_BASE_RE.test(cluster) ? 0 : 2;
			continue;
		}
		if (UNASSIGNED_RE.test(ch)) return NaN;
		const w = codePointWidth(cp);
		if (w === 1 && EXTENDED_PICTOGRAPHIC_RE.test(ch) && !EMOJI_PRESENTATION_RE.test(ch)) {
			return NaN;
		}
		sum += w;
	}
	return sum;
}

function isPlainAscii(s: string): boolean {
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c < 0x20 || c > 0x7e) return false;
	}
	return true;
}

/** normalize one ANSI-free text run */
function normalizeTextRun(run: string): string {
	if (isPlainAscii(run)) return run;
	// tabs → 3 spaces (matches pi-tui Text.render's own normalization)
	// strip stray control chars that would move the cursor (defense for
	// tools that render file/network content without bash's sanitizer)
	const cleaned = run
		.replace(/\t/g, "   ")
		.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
	if (isPlainAscii(cleaned)) return cleaned;
	let out = "";
	for (const { segment } of graphemeSegmenter.segment(cleaned)) {
		if (isPlainAscii(segment)) {
			out += segment;
			continue;
		}
		out += tuiVisibleWidth(segment) === terminalClusterWidth(segment) ? segment : "\ufffd";
	}
	return out;
}

/** matches the escape sequences our render pipeline legitimately emits */
const ANSI_TOKEN_RE = /\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/**
 * make a display string width-safe for the TUI: every grapheme cluster in it
 * measures identically under pi-tui and under a real terminal's cursor
 * advance. ANSI SGR/OSC sequences are preserved untouched.
 */
export function normalizeForDisplay(text: string): string {
	if (isPlainAscii(text)) return text;
	if (!text.includes("\x1b")) return normalizeTextRun(text);
	let out = "";
	let last = 0;
	ANSI_TOKEN_RE.lastIndex = 0;
	for (let m = ANSI_TOKEN_RE.exec(text); m !== null; m = ANSI_TOKEN_RE.exec(text)) {
		out += normalizeTextRun(text.slice(last, m.index));
		out += m[0];
		last = m.index + m[0].length;
	}
	out += normalizeTextRun(text.slice(last));
	return out;
}

/*
 * WIDTH MEASUREMENT — read before changing.
 *
 * box-format used to define its own `visibleWidth` and `truncateToWidth` here,
 * justified as "so box-format works where pi-tui isn't available". That premise
 * was false (line 26 hard-imports pi-tui unconditionally), and the local
 * measure counted **one column per codepoint**.
 *
 * That crashed pi. A Japanese web-search result title was clamped to "122
 * columns" — but 18 of those characters are East-Asian Wide and occupy 2
 * columns each, so the line rendered at 122 + 18 = 140 in a 125-column
 * terminal. pi-tui's doRender asserts every line fits and throws an
 * uncaughtException, which kills the process (that assertion has existed since
 * pi-tui 0.6.2 — nothing changed in pi; we simply started feeding arbitrary
 * web-page titles into box headers when web_search was added).
 *
 * THE INVARIANT: the function we clamp with must be the SAME function pi-tui
 * asserts with. Anything else makes agreement a coincidence. So we use pi-tui's
 * — imported live, so it also picks up our conservative-width patch (see
 * AGENTS.md "TUI Width Desync Fix"), which a private copy never would.
 *
 * Do not reintroduce a local width function. box-format.test.ts fails if the
 * two measures ever disagree.
 */

/**
 * defensive padding subtracted from width before truncating.
 * the pi TUI passes the content-area width to render(), but
 * border/padding chars can still cause off-by-one wrapping
 * that eats subsequent lines. 2 chars is conservative enough
 * to prevent wrapping without wasting visible space.
 */
const WIDTH_SAFETY_MARGIN = 2;

/**
 * collapse anything that would move the cursor to a new row.
 *
 * headers and notices are SINGLE-LINE sinks: the caller emits exactly one array
 * entry and the TUI accounts for exactly one row. A newline inside that string
 * is width-0 to every width check, so it passes clamping untouched — and then
 * the terminal advances a row nobody counted. The box chrome is left unclosed
 * and every later differential write lands on the wrong line. This is the same
 * mechanism as the editor-label smear documented in AGENTS.md, and it is a
 * distinct bug from over-wide lines: width is not violated at all.
 *
 * Headers come from web-page titles, LLM-generated session names and user
 * queries, so "callers won't pass a newline" is not an assumption we can hold.
 */
function flattenToSingleLine(text: string): string {
	return text.replace(/[\r\n\u2028\u2029\v\f]+/g, " ");
}

export interface BoxLine {
	/** optional gutter text (e.g., line number). right-aligned to gutter width. */
	gutter?: string;
	/** line content */
	text: string;
	/** when true, gutter + content render at base color instead of dim */
	highlight?: boolean;
}

export interface BoxBlock {
	lines: BoxLine[];
}

export interface BoxSection {
	/** text inside ╭─[...]. omit for headless boxes (no opening line). */
	header?: string;
	/** contiguous blocks. gaps between blocks show · elision marker. */
	blocks: BoxBlock[];
}

// --- visual-line-aware rendering (show + box-format pipeline) ---

/** re-export Excerpt so consumers import from box-format only */
export type { Excerpt };

export const COLLAPSED_EXCERPTS: Excerpt[] = [
	{ focus: "head", context: 3 },
	{ focus: "tail", context: 5 },
];

/** intermediate visual line produced by expanding BoxLine text */
interface VisualBoxLine {
	text: string;
	gutter: string;
	highlight: boolean;
	isElision: boolean;
	isGap: boolean;
}

/**
 * expand a block's logical BoxLine[] to visual lines at contentWidth.
 * wrapping is done by pi-tui's Text.render(). first visual line of
 * a wrapped logical line gets the gutter; continuation lines get "".
 */
function expandBlock(block: BoxBlock, contentWidth: number): VisualBoxLine[] {
	const result: VisualBoxLine[] = [];
	for (const line of block.lines) {
		// width-safety: replace graphemes whose terminal width disagrees with
		// pi-tui's measure BEFORE wrapping/padding (see normalizeForDisplay)
		const safeText = normalizeForDisplay(line.text);
		const visualLines = contentWidth > 0
			? new Text(safeText, 0, 0).render(contentWidth)
			: [safeText];

		for (let i = 0; i < visualLines.length; i++) {
			result.push({
				text: visualLines[i],
				gutter: i === 0 ? (line.gutter ?? "") : "",
				highlight: line.highlight ?? false,
				isElision: false,
				isGap: false,
			});
		}
	}
	return result;
}

/**
 * compute the chrome prefix width for a given gutter width.
 * with gutter:  "  42 │ " = gutterWidth + 3
 * without:      "│ "      = 2
 */
function chromeWidth(gutterWidth: number): number {
	return gutterWidth > 0 ? gutterWidth + 3 : 2;
}

export interface BoxWindowedOpts {
	/** max sections to show (rest get "… N more" footer) */
	maxSections?: number;
	/**
	 * excerpts applied independently to each block's visual lines.
	 * e.g., [{ focus: "head", context: 12 }, { focus: "tail", context: 13 }]
	 * caps each block at 25 visual lines (head 12 + tail 13).
	 */
	excerpts?: Excerpt[];
}

/**
 * visual-line-aware box renderer.
 *
 * pipeline: compute chrome width → expand to visual lines at content width
 * → window per-block via excerpts → render chrome around the result.
 *
 * wraps content to fit width
 * via pi-tui Text.render(). truncateToWidth is kept as a safety net.
 *
 * usage:
 *   formatBoxesWindowed(
 *     sections,
 *     { excerpts: [{ focus: "head", context: 12 }, { focus: "tail", context: 13 }] },
 *     ["some notice"],
 *     90,
 *   )
 */
export function formatBoxesWindowed(
	sections: BoxSection[],
	opts: BoxWindowedOpts = {},
	notices?: string[],
	width?: number,
): string {
	const maxSections = opts.maxSections ?? sections.length;
	const excerpts = opts.excerpts ?? [];
	const shown = sections.slice(0, maxSections);
	const out: string[] = [];

	const safeWidth = width != null ? Math.max(1, width - WIDTH_SAFETY_MARGIN) : undefined;
	const clamp = (line: string): string =>
		safeWidth != null ? truncateToWidth(line, safeWidth, "…") : line;

	for (let si = 0; si < shown.length; si++) {
		const section = shown[si];

		// compute gutter width from all lines (before any windowing)
		const allGutters = section.blocks.flatMap((b) => b.lines.map((l) => l.gutter ?? ""));
		const gw = Math.max(0, ...allGutters.map((g) => g.length));
		const pad = " ".repeat(gw);

		// compute content width for visual-line expansion
		const cw = chromeWidth(gw);
		const contentWidth = safeWidth != null ? Math.max(1, safeWidth - cw) : 80;

		if (si > 0) out.push("");

		// header (omitted for headless sections)
		if (section.header != null) {
			out.push(
				clamp(`${DIM}╭─[${RST}${flattenToSingleLine(normalizeForDisplay(section.header))}${DIM}]${RST}`),
			);
		}

		let anyBlockTruncated = false;

		for (let bi = 0; bi < section.blocks.length; bi++) {
			// gap marker between blocks
			if (bi > 0) {
				out.push(gw > 0 ? `${DIM}${pad} ·${RST}` : `${DIM}·${RST}`);
			}

			// expand to visual lines at content width
			const expanded = expandBlock(section.blocks[bi], contentWidth);

			// apply per-block excerpts
			const windowed = excerpts.length > 0
				? windowItems(expanded, excerpts, (count): VisualBoxLine => ({
					text: `· ··· ${count} more lines`,
					gutter: "",
					highlight: false,
					isElision: true,
					isGap: false,
				}))
				: { items: expanded, skippedRanges: [] as Array<[number, number]> };

			if (windowed.skippedRanges.length > 0) anyBlockTruncated = true;

			// render each visual line with chrome
			for (const vl of windowed.items) {
				if (vl.isElision) {
					const prefix = gw > 0 ? `${pad} ` : "";
					out.push(`${DIM}${prefix}${vl.text}${RST}`);
				} else if (gw > 0) {
					const gutter = vl.gutter.padStart(gw);
					if (vl.highlight) {
						out.push(clamp(`${gutter} ${DIM}│${RST} ${vl.text}`));
					} else {
						out.push(clamp(`${DIM}${gutter} │ ${vl.text}${RST}`));
					}
				} else {
					if (vl.highlight) {
						out.push(clamp(`${DIM}│${RST} ${vl.text}`));
					} else {
						out.push(clamp(`${DIM}│ ${vl.text}${RST}`));
					}
				}
			}
		}

		// footer
		// clamped like every other line: the footer is a constant, but a
		// constant is still 5 columns wide, and pi renders boxes into nested
		// contexts (sub-agent trees, indented panels) where the available width
		// can be smaller than the chrome. an unclamped "constant" line is
		// exactly how a hardcoded string becomes an uncaughtException.
		out.push(clamp(`${DIM}╰${"─".repeat(4)}${RST}`));
	}

	// section elision
	if (sections.length > maxSections) {
		const rem = sections.length - maxSections;
		out.push(`${DIM}… ${rem} more${RST}`);
	}

	if (notices?.length) {
		out.push("");
		out.push(clamp(`${DIM}[${flattenToSingleLine(normalizeForDisplay(notices.join(". ")))}]${RST}`));
	}

	return out.join("\n");
}

/**
 * convenience: wrap a single text block in a box section with no gutter.
 * all lines get highlight=true (base color) by default.
 */
export function textSection(header: string | undefined, text: string, dim = false): BoxSection {
	return {
		...(header != null && { header }),
		blocks: [{
			lines: text.split("\n").map((line) => ({
				text: line,
				highlight: !dim,
			})),
		}],
	};
}

/**
 * visual-line-aware boxRenderer. uses formatBoxesWindowed under the hood.
 * caches by width.
 *
 * `expanded` is a construction-time parameter (not a render-time one) because
 * pi's TUI calls render(width) — not render(width, expanded). when the user
 * presses Ctrl+O, ToolExecutionComponent calls renderResult() again with the
 * new expanded state, producing a fresh renderer that captures the new value.
 */
export function boxRendererWindowed(
	buildSections: () => BoxSection[],
	opts: { collapsed: BoxWindowedOpts; expanded: BoxWindowedOpts },
	notices?: string[],
	expanded = false,
) {
	let cachedWidth: number | undefined;
	let cachedLines: string[] | undefined;

	return {
		render(width: number): string[] {
			if (cachedLines !== undefined && cachedWidth === width) {
				return cachedLines;
			}
			const sections = buildSections();
			const visual = formatBoxesWindowed(
				sections,
				expanded ? opts.expanded : opts.collapsed,
				notices,
				width,
			);
			cachedLines = visual.split("\n");
			cachedWidth = width;
			return cachedLines;
		},
		invalidate() {
			cachedLines = undefined;
			cachedWidth = undefined;
		},
	};
}

export function renderBoxedText(result: any, _opts: unknown, _theme: unknown, context: any) {
	const container = context?.lastComponent ?? new Container();
	container.clear();
	const content = result.content?.[0];
	if (!content || content.type !== "text") {
		container.addChild(new Text("(no output)", 0, 0));
		return container;
	}
	const renderer = boxRendererWindowed(
		() => [textSection(undefined, content.text)],
		{ collapsed: { excerpts: COLLAPSED_EXCERPTS }, expanded: {} },
	);
	container.addChild(renderer);
	return container;
}

/**
 * wrap visible text in an OSC 8 terminal hyperlink.
 * terminals that support OSC 8 render this as a clickable link;
 * others silently ignore the sequences and show plain text.
 */
export function osc8Link(url: string, text: string): string {
	return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
}

/**
 * standardized call-line component for renderCall.
 * renders: bold(label) dim(context)
 *
 * usage: renderCallLine("Edit", "~/path/to/file.ts", theme)
 */
export function renderCallLine(label: string, context: string, theme: any): { render(width: number): string[]; invalidate(): void } {
	const line = theme.fg("toolTitle", theme.bold(normalizeForDisplay(label))) +
		(context ? " " + theme.fg("dim", normalizeForDisplay(context)) : "");
	let cachedWidth = -1;
	let cached: string[] = [];
	return {
		// `context` is usually a path, but nothing stops a caller passing a
		// title or query. Returning `line` unbounded made this the next crash
		// site after the box header: one over-wide line kills the process.
		render(width: number): string[] {
			if (!Number.isFinite(width) || width <= 0) return [line];
			if (width !== cachedWidth) {
				cachedWidth = width;
				cached = [truncateToWidth(line, width, "…")];
			}
			return cached;
		},
		invalidate() {
			cachedWidth = -1;
		},
	};
}
