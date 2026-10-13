/**
 * read tool — replaces pi's built-in with enhanced file reading.
 *
 * differences from pi's built-in:
 * - line-numbered output (`1: content`)
 * - directory listing integrated (no separate ls tool needed)
 * - secret file blocking (.env etc.)
 * - `~` expansion and `@` prefix stripping
 * - image support via base64
 * - compact variant for sub-agents (PI_READ_COMPACT=1)
 *
 * uses `path` + optional `read_range` [start, end] interface.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { formatBoxesWindowed, osc8Link, COLLAPSED_EXCERPTS, type BoxSection, type BoxLine } from "./lib/box-format";
import { expandPath, resolveToAbsolute } from "./lib/fs";
import { getText, getContainer } from "./lib/tui";
import { Type } from "@sinclair/typebox";
import { formatHeadTail } from "./lib/output-buffer";
import { defaultOutDir, fitImageFile, fitResultBlocks, pruneOutDir } from "./lib/image-fit";
import { planToolImages, recordReturnedImages, sessionNote } from "./lib/image-budget";
import { markSeen } from "./lib/seen-files";

// --- limits ---

export interface ReadLimits {
	maxLines: number;
	maxFileBytes: number;
	maxLineBytes: number;
	maxDirEntries: number;
}

export const NORMAL_LIMITS: ReadLimits = {
	maxLines: 500,
	maxFileBytes: 64 * 1024,
	maxLineBytes: 4096,
	maxDirEntries: 1000,
};

/** sub-agents get tighter limits to conserve their smaller context window */
export const COMPACT_LIMITS: ReadLimits = {
	maxLines: 200,
	maxFileBytes: 32 * 1024,
	maxLineBytes: 1024,
	maxDirEntries: 1000,
};

const SECRET_PATTERNS = [/^\.env$/, /^\.env\..+$/];
const SECRET_FILENAMES = new Set(["auth.json"]);
const SECRET_EXCEPTIONS = new Set([".env.example", ".env.sample", ".env.template"]);

/** Which files `read` treats as images. What they contain is decided from their bytes. */
const IMAGE_EXTENSIONS = new Set([
	".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".heif", ".avif", ".tif", ".tiff", ".bmp",
]);

export { expandPath, resolveToAbsolute };

/**
 * try macOS filesystem variants when file doesn't exist at resolved path.
 * covers NFD normalization and narrow no-break space in AM/PM timestamps.
 */
export function resolveWithVariants(filePath: string, cwd: string): string {
	const resolved = resolveToAbsolute(filePath, cwd);
	if (fs.existsSync(resolved)) return resolved;

	const amPm = resolved.replace(/ (AM|PM)\./g, `\u202F$1.`);
	if (amPm !== resolved && fs.existsSync(amPm)) return amPm;

	const nfd = resolved.normalize("NFD");
	if (nfd !== resolved && fs.existsSync(nfd)) return nfd;

	return resolved;
}

// --- checks ---

export function isSecretFile(filePath: string): boolean {
	const basename = path.basename(filePath);
	if (SECRET_EXCEPTIONS.has(basename)) return false;
	if (SECRET_FILENAMES.has(basename)) return true;
	// block auth.json anywhere under ~/.pi/
	const normalized = path.resolve(filePath);
	if (basename === "auth.json" && normalized.includes(".pi")) return true;
	return SECRET_PATTERNS.some((p) => p.test(basename));
}

function isImagePath(filePath: string): boolean {
	return IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

// --- directory listing ---

export function listDirectory(dirPath: string, maxEntries: number): string {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dirPath, { withFileTypes: true });
	} catch (err: any) {
		throw new Error(`cannot list directory: ${err.message}`);
	}

	const names = entries
		.map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
		.sort((a, b) => a.localeCompare(b));

	return formatHeadTail(names, maxEntries, (n) => `... [${n} more entries] ...`);
}

// --- file reading ---

interface ReadResult {
	text: string;
	/** the same lines without numbers or truncation, for codemode scripts. */
	raw: string;
	totalLines: number;
	shownStart: number;
	shownEnd: number;
}

/** a final "\n" ends the last line; it does not start an empty one. */
export function splitFileLines(raw: string): string[] {
	if (raw === "") return [];
	const lines = raw.split("\n");
	if (raw.endsWith("\n")) lines.pop();
	return lines;
}

/** why `readRange` cannot be served from a file of `totalLines` lines, or undefined. */
export function rangeError(readRange: [number, number], totalLines: number): string | undefined {
	const [start, end] = readRange;
	if (!Number.isFinite(start) || !Number.isFinite(end)) return `read_range must be two line numbers, got [${start}, ${end}].`;
	if (end < start) return `read_range [${start}, ${end}] is backwards: the end line comes before the start line.`;
	if (end < 1) return `read_range [${start}, ${end}] is before line 1; line numbers start at 1.`;
	if (Math.max(1, start) > totalLines) {
		return `read_range starts at line ${start}, but the file has only ${totalLines} line${totalLines === 1 ? "" : "s"}.`;
	}
	return undefined;
}

function readFileContent(
	filePath: string,
	limits: ReadLimits,
	readRange?: [number, number],
): ReadResult | { error: string } {
	const content = fs.readFileSync(filePath, "utf-8");
	const allLines = splitFileLines(content);
	const totalLines = allLines.length;
	if (totalLines === 0) return { text: "(empty file)", raw: "", totalLines: 0, shownStart: 0, shownEnd: 0 };

	if (readRange) {
		const error = rangeError(readRange, totalLines);
		if (error) return { error };
	}
	const start = Math.max(1, Math.floor(readRange?.[0] ?? 1));
	const end = Math.min(totalLines, Math.floor(readRange?.[1] ?? start + limits.maxLines - 1));
	const raw = allLines.slice(start - 1, end).join("\n") + (end === totalLines && content.endsWith("\n") ? "\n" : "");

	// number lines and truncate long lines
	const numbered: string[] = [];
	for (let i = start - 1; i < end; i++) {
		let line = allLines[i];
		const lineBytes = Buffer.byteLength(line, "utf-8");

		if (lineBytes > limits.maxLineBytes) {
			while (Buffer.byteLength(line, "utf-8") > limits.maxLineBytes) {
				line = line.slice(0, Math.max(1, line.length - 100));
			}
			line += "... (line truncated)";
		}

		numbered.push(`${i + 1}: ${line}`);
	}

	// if numbered output fits in byte limit, return as-is
	const totalBytes = numbered.reduce((sum, l) => sum + Buffer.byteLength(l, "utf-8") + 1, 0);
	if (totalBytes <= limits.maxFileBytes) {
		return { text: numbered.join("\n"), raw, totalLines, shownStart: start, shownEnd: end };
	}

	// otherwise apply head+tail truncation on the numbered lines
	const formatted = formatHeadTail(numbered, limits.maxLines, (n) =>
		`... [${n} lines truncated, ${limits.maxFileBytes / 1024}KB limit reached] ...`);

	return {
		text: formatted,
		raw,
		totalLines,
		shownStart: start,
		shownEnd: end,
	};
}

// --- tool factory ---

export function createReadTool(limits: ReadLimits): ToolDefinition {
	return {
		name: "read",
		label: "Read",
		description:
			"Read a file or list a directory from the file system. If the path is a directory, it returns a list of entries. If the file or directory doesn't exist, an error is returned.\n\n" +
			`- By default, this tool returns the first ${limits.maxLines} lines. To read more, call it multiple times with different read_ranges.\n` +
			"- Use the Grep tool to find specific content in large files or files with long lines.\n" +
			"- If you are unsure of the correct file path, use the find tool to look up filenames by glob pattern.\n" +
			"- The contents are returned with each line prefixed by its line number. For example, if a file has contents \"abc\\n\", you will receive \"1: abc\\n\". For directories, entries are returned one per line (without line numbers) with a trailing \"/\" for subdirectories.\n" +
			"- This tool can read images (such as PNG, JPEG, and GIF files) and present them to the model visually.\n" +
			"- When possible, call this tool in parallel for all files you will want to read.\n" +
			"      - Avoid tiny repeated slices (e.g., 50‑line chunks). If you need more context from the same file, read a larger range or the full default window instead.",

		// codemode scripts get the file's text, without line numbers (pi's read contract).
		// a result with no structuredContent (an image, a directory) falls back to its text.
		outputSchema: Type.String(),

		parameters: Type.Object({
			path: Type.String({
				description: "Path of the file or directory: absolute, relative to the working directory, or ~/...",
			}),
			read_range: Type.Optional(
				Type.Array(Type.Number(), {
					description:
						`An array of two integers specifying the start and end line numbers to view. Line numbers are 1-indexed. If not provided, defaults to [1, ${limits.maxLines}]. Examples: [500, 700], [700, 1400]`,
					minItems: 2,
					maxItems: 2,
				}),
			),
			offset: Type.Optional(
				Type.Number({
					description: "Line number to start reading from (1-indexed) — pi default param name.",
				}),
			),
			limit: Type.Optional(
				Type.Number({
					description: "Maximum number of lines to read — pi default param name.",
				}),
			),
		}),

		renderCall(args: any, theme: any, context: any) {
			const Text = getText();
			const text = context?.lastComponent ?? new Text("", 0, 0);
			const filePath = args.path || "...";
			const home = os.homedir();
			const shortened = filePath.startsWith(home) ? `~${filePath.slice(home.length)}` : filePath;
			const readRange = args.read_range;
			let label = shortened;
			if (Array.isArray(readRange) && readRange.length === 2) {
				label += `:${readRange[0]}-${readRange[1]}`;
			} else if (args.offset || args.limit) {
				const start = args.offset || 1;
				const end = args.limit ? start + args.limit - 1 : undefined;
				label += `:${start}${end ? `-${end}` : '+'}`;
			}
			const linked = filePath.startsWith("/") ? osc8Link(`file://${filePath}`, label) : label;
			text.setText(theme.fg("toolTitle", theme.bold("Read ")) + theme.fg("dim", linked));
			return text;
		},

		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			const resolved = resolveWithVariants(params.path, ctx.cwd);

			if (isSecretFile(resolved)) {
				return {
					content: [
						{
							type: "text" as const,
							text: `refused to read ${path.basename(resolved)}: file may contain secrets. ask the user to share relevant values.`,
						},
					],
					isError: true,
				} as any;
			}

			if (!fs.existsSync(resolved)) {
				return {
					content: [{ type: "text" as const, text: `file not found: ${resolved}` }],
					isError: true,
				} as any;
			}

			const stat = fs.statSync(resolved);

			// --- directory ---
			if (stat.isDirectory()) {
				try {
					let text = listDirectory(resolved, limits.maxDirEntries);
					return { content: [{ type: "text" as const, text }], details: { filePath: resolved, isDirectory: true } } as any;
				} catch (err: any) {
					return {
						content: [{ type: "text" as const, text: err.message }],
						isError: true,
					} as any;
				}
			}

			// --- image ---
			if (isImagePath(resolved)) {
				const images = planToolImages(ctx);
				if (!images.ok) {
					return { content: [{ type: "text" as const, text: images.reason }], isError: true } as any;
				}
				// No raw-bytes fallback: an image that cannot be fitted is corrupt or
				// over the limits, and sending it anyway fails the whole request.
				try {
					pruneOutDir(defaultOutDir());
					const fit = fitImageFile(resolved, {
						basename: `read-${Date.now()}`,
						tier: images.tier,
						limits: images.limits,
						budget: images.budget,
					});
					recordReturnedImages(ctx, toolCallId, fit.totalBase64, fit.outputs.length);
					const note = sessionNote(images.limits, images.usage, fit.totalBase64);
					const untouched = fit.outputs.length === 1 && fit.outputs[0]!.path === resolved;
					if (untouched && !note) {
						const out = fit.outputs[0]!;
						return { content: [{ type: "image" as const, data: out.base64, mimeType: out.mimeType }] } as any;
					}
					if (note) fit.notes.push(note);
					return { content: fitResultBlocks(fit), details: { header: resolved, plan: fit.plan } } as any;
				} catch (err: any) {
					return {
						content: [{ type: "text" as const, text: `cannot read ${resolved}: ${err?.message ?? err}` }],
						isError: true,
					} as any;
				}
			}

			// --- text file ---
			try {
				// resolve range: prefer read_range, fall back to offset/limit (pi default)
				let readRange = params.read_range as [number, number] | undefined;
				if (!readRange && (params.offset !== undefined || params.limit !== undefined)) {
					if (params.limit !== undefined && params.limit < 1) {
						return {
							content: [{ type: "text" as const, text: `limit must be at least 1, got ${params.limit}.` }],
							isError: true,
						} as any;
					}
					const start = Math.max(1, params.offset ?? 1);
					const end = params.limit !== undefined ? start + params.limit - 1 : start + limits.maxLines - 1;
					readRange = [start, end];
				}
				const read = readFileContent(resolved, limits, readRange);
				if ("error" in read) {
					return {
						content: [{ type: "text" as const, text: `${read.error} (${resolved})` }],
						isError: true,
					} as any;
				}
				const { text, raw, totalLines, shownStart, shownEnd } = read;

				let output = text;
				let notice: string | undefined;

				if (shownEnd < totalLines) {
					notice = `showing lines ${shownStart}-${shownEnd} of ${totalLines}`;
					output += `\n\n(${notice}. use read_range to see more.)`;
				}
				markSeen(ctx.sessionManager.getSessionId(), resolved);

				return {
					content: [{ type: "text" as const, text: output }],
					details: { filePath: resolved, notice },
					structuredContent: raw,
				} as any;
			} catch (err: any) {
				return {
					content: [{ type: "text" as const, text: `failed to read file: ${err.message}` }],
					isError: true,
				} as any;
			}
		},

		renderResult(result: any, { expanded }: { expanded: boolean }, _theme: any, context: any) {
			const Container = getContainer();
			const container = context?.lastComponent ?? new Container();
			container.clear();

			const text = result.content?.[0];
			if (text?.type !== "text") {
				container.addChild(new Text("(no output)", 0, 0));
				return container;
			}

			const filePath: string = result.details?.filePath ?? "";
			const isDir: boolean = result.details?.isDirectory ?? false;
			const notice: string | undefined = result.details?.notice;

			const rawLines = (text.text as string).split("\n");

			// parse numbered lines (e.g., "  42: content") into BoxLine[]
			const parsed: BoxLine[] = rawLines.map((line) => {
				const m = line.match(/^(\s*\d+): (.*)$/);
				if (m) return { gutter: m[1].trim(), text: m[2], highlight: true };
				return { text: line, highlight: true };
			});

			// strip trailing notice that we'll move to the box footer
			if (notice && parsed.length > 0) {
				const last = parsed[parsed.length - 1];
				if (last.text.startsWith(`(${notice}`)) {
					parsed.pop(); // notice line
					if (parsed.length && parsed[parsed.length - 1].text === "") {
						parsed.pop(); // blank before notice
					}
				}
			}

			const notices = notice ? [notice] : undefined;

			const section: BoxSection = { blocks: [{ lines: parsed }] };

			// capture expanded in closure — TUI calls render(width) not render(width, expanded)
			let cachedWidth: number | undefined;
			let cachedLines: string[] | undefined;

			container.addChild({
				render(width: number): string[] {
					if (cachedLines !== undefined && cachedWidth === width) {
						return cachedLines;
					}

					const visual = formatBoxesWindowed(
						[section],
						expanded ? {} : { excerpts: COLLAPSED_EXCERPTS },
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
			});

			return container;
		},
	};
}
