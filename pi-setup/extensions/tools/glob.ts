/**
 * glob tool — replaces pi's built-in find (same-name registration).
 *
 * - answered by searchd's index when it runs (lib/searchd.ts), else rg --files
 * - newest first: stat after a parallel walk (rg's --sortr walks on one thread)
 * - pagination via offset + limit; hidden files included; .git/.jj excluded
 * - .gitignore respected, and the glob only narrows: it never lists an ignored
 *   file (an ignored directory passed as `path` is still listed)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { formatHeadTail } from "./lib/output-buffer";
import { GITIGNORE_NOTE, rgFilesNarrowed, rgLocation } from "./lib/rg";
import { askSearchd, searchdNotices } from "./lib/searchd";
import { renderBoxedText } from "./lib/box-format";
import { getText } from "./lib/tui";

const DEFAULT_LIMIT = 500;
const truncatedMsg = (n: number) => `... [${n} more results, use a more specific pattern to narrow] ...`;
const PARTIAL = "some folders could not be read; the list may be incomplete";

/** Both rg and searchd exit 2 when a folder could not be read; with results, that list is partial. */
const exitNotices = (code: number | null, total: number): string[] => (code === 2 && total > 0 ? [PARTIAL] : []);

/** newest first, ties by path; a path that cannot be stat'ed goes last. */
export function sortNewestFirst(dir: string, rels: string[]): string[] {
	const keyed = rels.map((rel) => {
		const st = fs.statSync(path.join(dir, rel), { throwIfNoEntry: false });
		return { rel, mtime: st ? st.mtimeMs : -Infinity };
	});
	keyed.sort((a, b) => b.mtime - a.mtime || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
	return keyed.map((k) => k.rel);
}

interface Page {
	/** a slice, or the head then the tail of the sorted list */
	shown: string[];
	/** how many of `shown` are the head */
	head: number;
	total: number;
}

function pageOf(sorted: string[], offset: number, limit: number): Page {
	const total = sorted.length;
	if (offset > 0) {
		const shown = sorted.slice(offset, offset + limit);
		return { shown, head: shown.length, total };
	}
	if (total > limit) {
		const half = Math.floor(limit / 2);
		return { shown: [...sorted.slice(0, half), ...sorted.slice(total - half)], head: half, total };
	}
	return { shown: sorted, head: total, total };
}

function render(p: Page, offset: number, globPattern: string, notices: string[]): any {
	const note = notices.length > 0 ? `\n\n[${notices.join(". ")}]` : "";
	if (p.total === 0) {
		return { content: [{ type: "text" as const, text: `no files found matching pattern (${GITIGNORE_NOTE})${note}` }] };
	}
	let output: string;
	if (offset > 0) {
		output = `${p.shown.join("\n")}\n\n(showing ${offset + 1}-${offset + p.shown.length} of ${p.total} results)`;
	} else if (p.total > p.shown.length) {
		const head = p.shown.slice(0, p.head);
		const tail = p.shown.slice(p.head);
		output = `${[...head, "", truncatedMsg(p.total - head.length - tail.length), "", ...tail].join("\n")}\n\n(${p.total} total results)`;
	} else {
		output = formatHeadTail(p.shown, p.shown.length, truncatedMsg);
	}
	return { content: [{ type: "text" as const, text: output + note }], details: { header: globPattern } };
}

export function createGlobTool(): ToolDefinition {
	return {
		name: "find",
		label: "Find Files",
		description:
			"Fast file pattern matching tool that works with any codebase size.\n\n" +
			"Returns matching file paths sorted by most recent modification time first.\n\n" +
			"Respects .gitignore: ignored files are skipped unless their directory is passed as `path`.\n\n" +
			"## Pattern syntax\n" +
			"- `**/*.js` — All JavaScript files in any directory\n" +
			"- `src/**/*.ts` — TypeScript files under src/\n" +
			"- `*.json` — JSON files at any depth (a pattern without `/` matches file names anywhere)\n" +
			"- `/*.json` — JSON files directly in the search directory only\n" +
			"- `**/*test*` — Files with \"test\" in their name\n" +
			"- `**/*.{js,ts}` — JavaScript and TypeScript files\n",

		parameters: Type.Object({
			filePattern: Type.Optional(Type.String({
				description: 'Glob pattern like "**/*.js" or "src/**/*.ts" to match files.',
			})),
			pattern: Type.Optional(Type.String({
				description: 'Glob pattern (alias for filePattern — pi default param name).',
			})),
			path: Type.Optional(Type.String({
				description: "Directory to search in (default: current directory).",
			})),
			limit: Type.Optional(
				Type.Number({
					description: "Maximum number of results to return.",
				}),
			),
			offset: Type.Optional(
				Type.Number({
					description: "Number of results to skip (for pagination).",
				}),
			),
		}),

		renderCall(args: any, theme: any, context: any) {
			const Text = getText();
			const text = context?.lastComponent ?? new Text("", 0, 0);
			const pattern = args.filePattern || args.pattern || "...";
			text.setText(theme.fg("toolTitle", theme.bold("Find ")) + theme.fg("dim", pattern));
			return text;
		},

		renderResult: renderBoxedText,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const globPattern = params.filePattern ?? params.pattern;
			if (!globPattern) {
				return {
					content: [{ type: "text" as const, text: 'filePattern is required, e.g. { filePattern: "**/*.ts" }' }],
					isError: true,
				} as any;
			}
			const searchPath = params.path
				? (path.isAbsolute(params.path) ? params.path : path.resolve(ctx.cwd, params.path))
				: ctx.cwd;
			const limit = params.limit ?? DEFAULT_LIMIT;
			const offset = params.offset ?? 0;
			const where = rgLocation(searchPath);
			if ("error" in where) {
				return { content: [{ type: "text" as const, text: where.error }], isError: true } as any;
			}
			if (where.target !== ".") {
				return {
					content: [{ type: "text" as const, text: `${searchPath} is a file; find lists directories (use read or grep on a file)` }],
					isError: true,
				} as any;
			}
			const aborted = { content: [{ type: "text" as const, text: "search aborted" }], isError: true } as any;

			const sd = await askSearchd({ op: "find", dir: where.cwd, glob: globPattern, limit, offset }, signal);
			if (signal?.aborted) return aborted;
			if ("lines" in sd) {
				const shown = sd.lines.map((l) => JSON.parse(l) as string);
				const page = { shown, head: sd.end.head ?? shown.length, total: sd.end.total ?? shown.length };
				return render(page, offset, globPattern, [...exitNotices(sd.end.exit, page.total), ...searchdNotices(sd.end)]);
			}

			const found = await rgFilesNarrowed(where.cwd, globPattern, signal);
			if (found.aborted) return aborted;
			if (found.error) {
				return { content: [{ type: "text" as const, text: `find error: ${found.error}` }], isError: true } as any;
			}
			if (found.code !== 0 && found.code !== 1 && found.paths.length === 0) {
				return {
					content: [{ type: "text" as const, text: found.stderr.trim() || `rg exited with code ${found.code}` }],
					isError: true,
				} as any;
			}
			const page = pageOf(sortNewestFirst(where.cwd, found.paths), offset, limit);
			return render(page, offset, globPattern, exitNotices(found.code, page.total));
		},
	};
}
