/**
 * Comment gate — decides whether an edit or write call adds too much commentary.
 *
 * Pure. No I/O, no pi imports, so the whole decision is testable without a
 * session. index.ts owns the hook; this file owns the judgement.
 *
 * Two independent triggers, because one number cannot catch both offences:
 *
 *   RUN    a single unbroken comment block over MAX_RUN lines. This is the
 *          30-line file header above a 5-line const. A ratio check misses it
 *          whenever the rest of the file is long enough to dilute it.
 *   RATIO  comments outnumber code by more than MAX_RATIO across the change.
 *          This is death by a thousand one-liners, where no single run is big.
 *
 * Everything unrecognised passes. A gate that guesses wrong blocks real work,
 * and the cost of a missed essay is one rewrite while the cost of a false
 * block is the tool being turned off.
 */

/** Comment lines allowed in one unbroken run before the run trigger fires. */
export const MAX_RUN = 12;
/** Comment-to-code ratio allowed before the ratio trigger fires. */
export const MAX_RATIO = 0.5;
/** Below this many comment lines in a change, neither trigger fires. */
export const MIN_COMMENTS = 8;

type Syntax = "c" | "hash" | "dash" | "markup";

/*
 * Only real source files are gated. Config and prose are excluded outright:
 * `#` is a heading in markdown and a key comment in yaml, and neither is the
 * behaviour we are trying to stop.
 */
const SYNTAX_BY_EXT: Record<string, Syntax> = {
	ts: "c", tsx: "c", js: "c", jsx: "c", mjs: "c", cjs: "c", mts: "c", cts: "c",
	java: "c", c: "c", h: "c", cpp: "c", cc: "c", hpp: "c", cs: "c", go: "c",
	rs: "c", swift: "c", kt: "c", kts: "c", scala: "c", php: "c", m: "c",
	mm: "c", dart: "c", zig: "c", proto: "c", gradle: "c", groovy: "c",
	py: "hash", rb: "hash", sh: "hash", bash: "hash", zsh: "hash", pl: "hash",
	r: "hash", jl: "hash", nim: "hash", ex: "hash", exs: "hash",
	sql: "dash", lua: "dash", hs: "dash", elm: "dash",
	vue: "markup", svelte: "markup", html: "markup", xml: "markup",
};

function syntaxFor(filePath: string): Syntax | undefined {
	const base = filePath.split("/").pop() ?? filePath;
	const dot = base.lastIndexOf(".");
	if (dot <= 0) return undefined;
	return SYNTAX_BY_EXT[base.slice(dot + 1).toLowerCase()];
}

export interface LineCounts {
	comment: number;
	code: number;
	longestRun: number;
}

/**
 * Classify lines as comment or code and measure the longest comment run.
 *
 * Block comments are tracked with a depth-free open/close scan: a line that
 * opens a block and never closes it puts every following line in the run until
 * the close arrives. That is exactly the shape we are hunting, so the scan
 * deliberately errs toward calling the interior of a block a comment.
 *
 * Python triple-quoted strings count only when they START a line. A docstring
 * does; `x = """..."""` does not, and misreading an assigned heredoc as prose
 * would block legitimate code.
 */
export function countLines(lines: string[], syntax: Syntax): LineCounts {
	let comment = 0;
	let code = 0;
	let run = 0;
	let longestRun = 0;
	let inBlock = false;
	let blockCloser = "";

	const closeRun = () => {
		if (run > longestRun) longestRun = run;
		run = 0;
	};

	for (const raw of lines) {
		const line = raw.trim();

		if (inBlock) {
			comment++;
			run++;
			if (line.includes(blockCloser)) inBlock = false;
			continue;
		}

		if (line === "") {
			// A blank line neither breaks a doc block visually nor adds code.
			// It is left out of both counts and does not reset the run, so
			// `/** … */` split by a blank line still reads as one block.
			continue;
		}

		let isComment = false;

		if (syntax === "c") {
			if (line.startsWith("//")) isComment = true;
			else if (line.startsWith("*") && !line.startsWith("*/")) isComment = true;
			else if (line.startsWith("*/")) isComment = true;
			else if (line.startsWith("/*")) {
				isComment = true;
				if (!line.includes("*/", 2)) {
					inBlock = true;
					blockCloser = "*/";
				}
			}
		} else if (syntax === "hash") {
			// A shebang is machine-readable, not commentary.
			if (line.startsWith("#") && !line.startsWith("#!")) isComment = true;
			else if (line.startsWith('"""') || line.startsWith("'''")) {
				const quote = line.slice(0, 3);
				isComment = true;
				if (line.length < 6 || !line.slice(3).includes(quote)) {
					inBlock = true;
					blockCloser = quote;
				}
			}
		} else if (syntax === "dash") {
			if (line.startsWith("--")) isComment = true;
		} else if (syntax === "markup") {
			if (line.startsWith("//")) isComment = true;
			else if (line.startsWith("*") && !line.startsWith("*/")) isComment = true;
			else if (line.startsWith("<!--")) {
				isComment = true;
				if (!line.includes("-->", 4)) {
					inBlock = true;
					blockCloser = "-->";
				}
			} else if (line.startsWith("/*")) {
				isComment = true;
				if (!line.includes("*/", 2)) {
					inBlock = true;
					blockCloser = "*/";
				}
			}
		}

		if (isComment) {
			comment++;
			run++;
		} else {
			code++;
			closeRun();
		}
	}

	closeRun();
	return { comment, code, longestRun };
}

/** One chunk of newly added text, pulled out of an edit or write call. */
export interface AddedText {
	path: string;
	lines: string[];
}

/**
 * Lines present in `next` but not in `prev`, compared as a multiset.
 *
 * An edit's newText usually replays surrounding context that was already on
 * disk. Counting all of it would blame the model for comments it merely moved,
 * so only genuinely new lines are judged.
 */
function newLines(prev: string, next: string): string[] {
	const remaining = new Map<string, number>();
	for (const line of prev.split("\n")) {
		remaining.set(line, (remaining.get(line) ?? 0) + 1);
	}

	const added: string[] = [];
	for (const line of next.split("\n")) {
		const left = remaining.get(line) ?? 0;
		if (left > 0) remaining.set(line, left - 1);
		else added.push(line);
	}
	return added;
}

/** Arguments arrive after pi's prepareArguments: `{ path, content }` or `{ path, edits: [{ oldText, newText }] }`. */
export function collectAdded(args: Record<string, unknown>): AddedText[] {
	const filePath = args.path;
	if (typeof filePath !== "string" || !filePath) return [];
	if (typeof args.content === "string") return [{ path: filePath, lines: args.content.split("\n") }];
	if (!Array.isArray(args.edits)) return [];
	const out: AddedText[] = [];
	for (const raw of args.edits) {
		if (!raw || typeof raw !== "object") continue;
		const { oldText, newText } = raw as { oldText?: unknown; newText?: unknown };
		if (typeof newText !== "string") continue;
		out.push({ path: filePath, lines: newLines(typeof oldText === "string" ? oldText : "", newText) });
	}
	return out;
}

export interface Verdict {
	blocked: boolean;
	reason?: string;
}

export interface Thresholds {
	maxRun: number;
	maxRatio: number;
	minComments: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
	maxRun: MAX_RUN,
	maxRatio: MAX_RATIO,
	minComments: MIN_COMMENTS,
};

/**
 * Judge one edit or write call.
 *
 * Reports the first chunk that trips a trigger rather than every chunk, because
 * the message is an instruction to the model and a list invites it to fix the
 * cheapest entry and retry.
 */
export function judge(
	args: Record<string, unknown>,
	thresholds: Thresholds = DEFAULT_THRESHOLDS,
): Verdict {
	for (const added of collectAdded(args)) {
		const syntax = syntaxFor(added.path);
		if (!syntax) continue;

		const { comment, code, longestRun } = countLines(added.lines, syntax);
		if (comment < thresholds.minComments) continue;

		if (longestRun > thresholds.maxRun) {
			return {
				blocked: true,
				reason:
					`Blocked: ${added.path} adds a ${longestRun}-line comment block. ` +
					`Cap is ${thresholds.maxRun}. Keep only the lines a careful reader ` +
					`would need to avoid misreading the code, and delete the rest. ` +
					`Do not explain what the code does, and do not describe the task, ` +
					`the fix, or the callers. Re-send the edit.`,
			};
		}

		if (code > 0 && comment / code > thresholds.maxRatio) {
			return {
				blocked: true,
				reason:
					`Blocked: ${added.path} adds ${comment} comment lines against ` +
					`${code} lines of code. Cap is ${thresholds.maxRatio} comment lines ` +
					`per line of code. Delete the comments that restate what the code ` +
					`already says, keep only a non-obvious why, and re-send the edit.`,
			};
		}
	}

	return { blocked: false };
}
