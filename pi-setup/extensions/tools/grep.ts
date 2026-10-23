/**
 * grep tool — replaces pi's built-in with tighter limits and context lines.
 *
 * differences from pi's built-in:
 * - per-file match limit (10, prevents one noisy file from consuming quota)
 * - 200-char line truncation (vs pi's 500)
 * - caseSensitive param (default case-sensitive)
 * - suggests literal:true when pattern contains regex metacharacters
 * - answered by searchd's index when it runs (lib/searchd.ts), else rg
 * - includes ±1 context lines around matches by default (via rg --context)
 *   so the LLM sees surrounding code and show() has natural gaps to elide
 *
 * shadows pi's built-in `grep` tool via same-name registration.
 */

import { type ChildProcess, spawn } from "node:child_process";
import * as path from "node:path";
import * as os from "node:os";
import { createInterface, type Interface } from "node:readline";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { headTail } from "./lib/output-buffer";
import { boxRendererWindowed, osc8Link, type BoxSection, type BoxLine, type Excerpt } from "./lib/box-format";
import { getText, getContainer } from "./lib/tui";
import { GITIGNORE_NOTE, rgFiles, rgLocation } from "./lib/rg";
import { askSearchd, searchdNotices } from "./lib/searchd";

/** output lines past which the result shows only its first and last SHOWN_WHEN_CUT lines */
const MAX_OUTPUT_LINES = 300;
const SHOWN_WHEN_CUT = 200;
const MAX_COLLECT_MATCHES = 200;
const MAX_PER_FILE = 10;
const MAX_LINE_CHARS = 200;
const DEFAULT_CONTEXT_LINES = 1;
const MAX_CONTEXT_LINES = 10;
/** max files shown in collapsed display */
const COLLAPSED_MAX_FILES = 3;
/** per-block excerpts for collapsed display — show first 5 visual lines */
const COLLAPSED_EXCERPTS: Excerpt[] = [{ focus: "head" as const, context: 5 }];

function truncateLine(line: string): string {
	if (line.length <= MAX_LINE_CHARS) return line;
	return line.slice(0, MAX_LINE_CHARS) + "...";
}

function looksLikeRegex(pattern: string): boolean {
	return /[{}()\[\]|\\+*?^$]/.test(pattern);
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, Math.floor(value)));
}

// --- structured data for visual rendering ---

interface GrepMatch {
	lineNum: number;
	text: string;
	isContext: boolean;
}

interface GrepFile {
	path: string;
	matches: GrepMatch[];
	hitLimit: boolean;
}

/**
 * convert GrepFile[] to BoxSection[] for box-format rendering.
 * each file becomes a section, contiguous match groups become blocks.
 */
function grepToSections(files: GrepFile[]): BoxSection[] {
	return files.map((f) => {
		const blocks: { lines: BoxLine[] }[] = [];
		let current: BoxLine[] = [];
		let lastLineNum = -2;

		for (const m of f.matches) {
			// gap > 1 line means new block
			if (lastLineNum >= 0 && m.lineNum > lastLineNum + 1) {
				if (current.length > 0) {
					blocks.push({ lines: current });
					current = [];
				}
			}
			current.push({
				gutter: String(m.lineNum),
				text: m.text,
				highlight: !m.isContext,
			});
			lastLineNum = m.lineNum;
		}
		if (current.length > 0) blocks.push({ lines: current });

		return {
			header: f.path + (f.hitLimit ? ` [${MAX_PER_FILE} match limit]` : ""),
			blocks,
		};
	});
}

interface RgEvent {
	kind: "match" | "context";
	filePath: string;
	lineNumber: number;
	lineText: string;
}

export function createGrepTool(): ToolDefinition {
	return {
		name: "grep",
		label: "Grep",
		description:
			"Search for exact text patterns in files using ripgrep, a fast keyword search tool.\n\n" +
			"# When to use\n" +
			"- Finding exact text matches (variable names, function calls, specific strings)\n\n" +
			"# Constraints\n" +
			`- Stops after \`limit\` matches (default and max ${MAX_COLLECT_MATCHES}); at most ${MAX_PER_FILE} shown per file\n` +
			`- Lines are truncated at ${MAX_LINE_CHARS} characters\n` +
			"- Respects .gitignore: ignored files are skipped unless their directory is passed as `path`\n\n" +
			"# Strategy\n" +
			"- Use 'path' or 'glob' to narrow searches; run multiple focused calls rather than one broad search\n" +
			"- Uses Rust-style regex (escape `{` and `}`); use `literal: true` for literal text search\n",

		parameters: Type.Object({
			pattern: Type.String({
				description: "The pattern to search for (regex by default).",
			}),
			path: Type.Optional(
				Type.String({
					description: "The file or directory to search in (default: current directory).",
				}),
			),
			glob: Type.Optional(
				Type.String({
					description: "Glob that filters which files are searched (e.g., '**/*.ts'), relative to `path`.",
				}),
			),
			caseSensitive: Type.Optional(
				Type.Boolean({
					description: "Whether to search case-sensitively (default: true).",
				}),
			),
			ignoreCase: Type.Optional(
				Type.Boolean({
					description: "Case-insensitive search (alias — pi default param name).",
				}),
			),
			literal: Type.Optional(
				Type.Boolean({
					description: "Whether to treat the pattern as a literal string instead of a regex.",
				}),
			),
			context: Type.Optional(
				Type.Number({
					description: `Context lines around each match (default ${DEFAULT_CONTEXT_LINES}, max ${MAX_CONTEXT_LINES}), shown as \`path-N-\` where matches are \`path:N:\`.`,
				}),
			),
			limit: Type.Optional(
				Type.Number({
					description: `Stop after this many matches (default and max ${MAX_COLLECT_MATCHES}).`,
				}),
			),
		}),

		renderCall(args: any, theme: any, context: any) {
			const Text = getText();
			const text = context?.lastComponent ?? new Text("", 0, 0);
			const pattern = args.pattern || "...";
			const searchPath = args.path || args.glob || ".";
			const home = os.homedir();
			const shortened = searchPath.startsWith(home) ? `~${searchPath.slice(home.length)}` : searchPath;
			const linkedPath = searchPath.startsWith("/") ? osc8Link(`file://${searchPath}`, shortened) : shortened;
			const caseSuffix = args.caseSensitive === false ? " -i" : "";
			text.setText(theme.fg("toolTitle", theme.bold("Grep ")) + theme.fg("dim", `/${pattern}/${caseSuffix} in ${linkedPath}`));
			return text;
		},

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const searchPath = params.path
				? path.isAbsolute(params.path)
					? params.path
					: path.resolve(ctx.cwd, params.path)
				: ctx.cwd;
			const contextLines = clampInt(params.context, 0, MAX_CONTEXT_LINES, DEFAULT_CONTEXT_LINES);
			const maxMatches = clampInt(params.limit, 1, MAX_COLLECT_MATCHES, MAX_COLLECT_MATCHES);
			const where = rgLocation(searchPath);
			if ("error" in where) {
				return { content: [{ type: "text" as const, text: where.error }], isError: true } as any;
			}
			const rgCwd = where.cwd;
			const ignoreCase = params.caseSensitive === false || params.ignoreCase === true;

			const sd = where.target === "."
				? await askSearchd({
					op: "grep",
					dir: rgCwd,
					pattern: params.pattern,
					literal: params.literal === true,
					ignoreCase,
					context: contextLines,
					limit: maxMatches,
					glob: params.glob,
				}, signal)
				: { fallback: "a single file is searched by rg" };
			if (signal?.aborted) {
				return { content: [{ type: "text" as const, text: "search aborted" }], isError: true } as any;
			}
			// A matching --glob makes rg search ignored files too; the glob only
			// narrows the .gitignore-respecting list, as searchd does.
			let allowed: Set<string> | undefined;
			if (!("lines" in sd) && params.glob && where.target === ".") {
				const plain = await rgFiles(rgCwd, undefined, signal);
				allowed = new Set(plain.paths.map((p) => path.resolve(rgCwd, p)));
			}
			const extraNotices = "lines" in sd ? searchdNotices(sd.end) : [];

			return new Promise((resolve) => {
				let child: ChildProcess | undefined;
				let rl: Interface | undefined;
				let stderr = "";
				let totalMatches = 0;
				let killedDueToLimit = false;
				let aborted = false;
				/** all match + context events, in stream order */
				const events: RgEvent[] = [];

				const stop = () => {
					if (child && !child.killed) child.kill();
				};
				const onAbort = () => {
					aborted = true;
					stop();
				};
				signal?.addEventListener("abort", onAbort, { once: true });

				const handleLine = (line: string) => {
					if (!line.trim() || killedDueToLimit) return;

					let event: any;
					try {
						event = JSON.parse(line);
					} catch {
						return;
					}

					if (event.type !== "match" && event.type !== "context") return;

					const rawPath: string | undefined = event.data?.path?.text;
					const lineNumber: number | undefined = event.data?.line_number;
					const lineText: string = (event.data?.lines?.text ?? "").replace(/\r?\n$/, "");
					if (!rawPath || typeof lineNumber !== "number") return;
					const filePath = path.resolve(rgCwd, rawPath);
					if (allowed && !allowed.has(filePath)) return;

					if (event.type === "match") {
						totalMatches++;
					}

					events.push({
						kind: event.type as "match" | "context",
						filePath,
						lineNumber,
						lineText,
					});

					if (totalMatches >= maxMatches) {
						killedDueToLimit = true;
						stop();
					}
				};

				const finish = (code: number | null) => {
					rl?.close();
					signal?.removeEventListener("abort", onAbort);

					if (aborted) {
						resolve({
							content: [{ type: "text" as const, text: "search aborted" }],
							isError: true,
						} as any);
						return;
					}

					if (!killedDueToLimit && code !== 0 && code !== 1) {
						resolve({
							content: [{ type: "text" as const, text: stderr.trim() || `ripgrep exited with code ${code}` }],
							isError: true,
						} as any);
						return;
					}

					if (totalMatches === 0) {
						let text = `no matches found (${GITIGNORE_NOTE})`;
						if (!params.literal && looksLikeRegex(params.pattern)) {
							text += "\n\n(pattern contains regex characters — try literal: true if searching for exact text)";
						}
						if (extraNotices.length > 0) {
							text += `\n\n[${extraNotices.join(". ")}]`;
						}
						resolve({ content: [{ type: "text" as const, text }] } as any);
						return;
					}

					// --- phase 2: build output from collected events ---

					// group events by file, preserving order
					const fileOrder: string[] = [];
					const fileEvents = new Map<string, RgEvent[]>();
					for (const ev of events) {
						if (!fileEvents.has(ev.filePath)) {
							fileOrder.push(ev.filePath);
							fileEvents.set(ev.filePath, []);
						}
						fileEvents.get(ev.filePath)!.push(ev);
					}

					const outputLines: string[] = [];
					/** output line indices that are actual matches (not context) */
					const matchLineIndices: number[] = [];
					/** index of first match line per file — focus points for collapsed display */
					const firstMatchPerFile: number[] = [];
					const perFileMatchCount = new Map<string, number>();
					const fileGroups: GrepFile[] = [];

					for (let fi = 0; fi < fileOrder.length; fi++) {
						const filePath = fileOrder[fi];
						const fileEvts = fileEvents.get(filePath)!;

						// determine which matches to include (per-file limit)
						const includedMatchLines = new Set<number>();
						let matchesInFile = 0;
						for (const ev of fileEvts) {
							if (ev.kind === "match") {
								matchesInFile++;
								if (matchesInFile <= MAX_PER_FILE) {
									includedMatchLines.add(ev.lineNumber);
								}
							}
						}
						perFileMatchCount.set(filePath, Math.min(matchesInFile, MAX_PER_FILE));

						// include context lines only if adjacent to an included match
						const includedLines = new Set<number>();
						for (const ln of includedMatchLines) {
							includedLines.add(ln);
							for (let d = 1; d <= contextLines; d++) {
								includedLines.add(ln - d);
								includedLines.add(ln + d);
							}
						}

						// blank separator between file groups
						if (fi > 0) {
							outputLines.push("");
						}

						const rel = path.relative(rgCwd, filePath).replace(/\\/g, "/");
						const displayPath = rel && !rel.startsWith("..") ? rel : path.basename(filePath);

						const grepFile: GrepFile = {
							path: displayPath,
							matches: [],
							hitLimit: matchesInFile > MAX_PER_FILE,
						};

						let lastOutputLineNum = -Infinity;
						let isFirstMatchInFile = true;

						for (const ev of fileEvts) {
							if (!includedLines.has(ev.lineNumber)) continue;
							// deduplicate (rg can emit same line as both context for
							// adjacent matches — we only want it once)
							if (ev.lineNumber <= lastOutputLineNum) continue;

							// insert "--" separator for non-contiguous groups within file
							// (gap > 1 means there's a break in line numbers)
							if (lastOutputLineNum >= 0 && ev.lineNumber > lastOutputLineNum + 1) {
								outputLines.push("--");
							}

							const idx = outputLines.length;
							// rg/grep convention: `path:N:` is a match, `path-N-` is context.
							const mark = ev.kind === "match" ? ":" : "-";
							outputLines.push(`${displayPath}${mark}${ev.lineNumber}${mark} ${truncateLine(ev.lineText)}`);
							lastOutputLineNum = ev.lineNumber;

							grepFile.matches.push({
								lineNum: ev.lineNumber,
								text: truncateLine(ev.lineText),
								isContext: ev.kind === "context",
							});

							if (includedMatchLines.has(ev.lineNumber)) {
								matchLineIndices.push(idx);
								if (isFirstMatchInFile) {
									firstMatchPerFile.push(idx);
									isFirstMatchInFile = false;
								}
							}
						}
						fileGroups.push(grepFile);
					}

					// apply head+tail if over display limit
					let output: string;
					const notices: string[] = [];
					let finalMatchIndices: number[];

					if (outputLines.length > MAX_OUTPUT_LINES) {
						const limit = SHOWN_WHEN_CUT;
						const { head, tail, truncatedCount } = headTail(outputLines, limit);
						output = [
							...head,
							"",
							`... [${truncatedCount} lines truncated] ...`,
							"",
							...tail,
						].join("\n");
						// remap match indices into the truncated output
						const headLen = head.length;
						const gapLen = 3; // blank + marker + blank
						const tailStart = outputLines.length - tail.length;
						finalMatchIndices = matchLineIndices
							.map((i) => {
								if (i < headLen) return i;
								if (i >= tailStart) return headLen + gapLen + (i - tailStart);
								return -1; // truncated
							})
							.filter((i) => i >= 0);
						notices.push(`${truncatedCount} lines truncated, showing first and last ${limit / 2}`);
					} else {
						output = outputLines.join("\n");
						finalMatchIndices = matchLineIndices;
					}

					if (killedDueToLimit) {
						notices.push(`stopped at ${maxMatches} matches — refine pattern`);
					}

					const filesAtLimit = Array.from(perFileMatchCount.values()).filter((c) => c >= MAX_PER_FILE).length;
					if (filesAtLimit > 0) {
						notices.push(
							`${filesAtLimit} file${filesAtLimit > 1 ? "s" : ""} hit the ${MAX_PER_FILE}-per-file limit`,
						);
					}

					notices.push(...extraNotices);
					if (notices.length > 0) {
						output += `\n\n[${notices.join(". ")}]`;
					}

					resolve({
						content: [{ type: "text" as const, text: output }],
						details: { fileGroups, notices, matchLineIndices: finalMatchIndices, firstMatchPerFile, searchPath: rgCwd },
					} as any);
				};

				if ("lines" in sd) {
					for (const line of sd.lines) {
						handleLine(line);
						if (killedDueToLimit) break;
					}
					finish(sd.end.exit);
					return;
				}

				const args = [
					"--no-config", "--json", "--line-number", "--color=never", "--hidden",
					"--glob", "!.git", "--glob", "!.jj",
					"--context", String(contextLines),
				];
				if (ignoreCase) args.push("--ignore-case");
				if (params.literal) args.push("--fixed-strings");
				if (params.glob) args.push("--glob", params.glob);
				args.push("--", params.pattern, where.target);

				child = spawn("rg", args, { cwd: rgCwd, stdio: ["ignore", "pipe", "pipe"] });
				rl = createInterface({ input: child.stdout! });
				child.stderr?.on("data", (chunk: Buffer) => {
					stderr += chunk.toString();
				});
				rl.on("line", handleLine);
				child.on("error", (err) => {
					rl?.close();
					signal?.removeEventListener("abort", onAbort);
					resolve({
						content: [{ type: "text" as const, text: `grep error: ${err.message}` }],
						isError: true,
					} as any);
				});
				child.on("close", finish);
			});
		},

		renderResult(result: any, { expanded }: { expanded: boolean }, _theme: any, context: any) {
			const Container = getContainer();
			const container = context?.lastComponent ?? new Container();
			container.clear();

			const fileGroups: GrepFile[] | undefined = result.details?.fileGroups;
			const notices: string[] = result.details?.notices ?? [];
			const basePath: string | undefined = result.details?.searchPath;

			// fallback for old results or error results without fileGroups
			if (!fileGroups?.length) {
				const text = result.content?.[0]?.text ?? "(no output)";
				container.addChild(new Text(text, 0, 0));
				return container;
			}

			const sections = grepToSections(fileGroups);

			// wrap section headers in OSC 8 file:// links
			if (basePath) {
				for (let i = 0; i < sections.length; i++) {
					const relPath = fileGroups[i].path;
					const absPath = basePath + "/" + relPath;
					sections[i] = { ...sections[i], header: osc8Link(`file://${absPath}`, sections[i].header) };
				}
			}

			const renderer = boxRendererWindowed(
				() => sections,
				{
					collapsed: { maxSections: COLLAPSED_MAX_FILES, excerpts: COLLAPSED_EXCERPTS },
					expanded: {},
				},
				notices.length > 0 ? notices : undefined,
				expanded,
			);
			container.addChild(renderer);
			return container;
		},
	};
}
