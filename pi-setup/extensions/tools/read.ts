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
	/** the requested lines without numbers or truncation, byte for byte: only a codemode script gets them. */
	raw?: string;
	totalLines: number;
	/** false when counting stopped after COUNT_LIMIT_BYTES: the file has more than `totalLines` lines. */
	counted: boolean;
	shownStart: number;
	shownEnd: number;
}

const CHUNK_BYTES = 1 << 20;
const COUNT_LIMIT_BYTES = 1 << 30;
const BINARY_SNIFF_BYTES = 8192;
const MAX_UTF16_BYTES = 16 << 20;
/** a script gets the requested lines byte for byte or not at all: a shortened copy written back would cut the file. */
const RAW_LIMIT_BYTES = 4 << 20;

interface ScanOptions {
	from: number;
	to: number;
	/** bytes kept from the start of each line, for display. */
	headBytes: number;
	/** heads are kept until they total this much: the display stops before then. */
	headBudget: number;
	/** keep the lines whole too, while they total at most RAW_LIMIT_BYTES. */
	whole: boolean;
}

interface Scan {
	heads: Buffer[];
	/** the requested lines whole; undefined unless asked for and within RAW_LIMIT_BYTES. */
	whole?: Buffer[];
	totalLines: number;
	counted: boolean;
	endsWithNewline: boolean;
	/** the requested lines' bytes, each with its newline. */
	rangeBytes: number;
	longest: { line: number; bytes: number };
}

/**
 * Reads lines `from`..`to` and counts the rest. A final "\n" ends the last line;
 * it does not start an empty one. Only what the caller asked for is copied.
 */
async function scanLines(chunks: AsyncIterable<Buffer>, o: ScanOptions): Promise<Scan> {
	const heads: Buffer[] = [];
	let whole: Buffer[] | undefined = o.whole ? [] : undefined;
	let head: Buffer[] = [];
	let headLength = 0;
	let headTotal = 0;
	let parts: Buffer[] = [];
	let lineNo = 1;
	let lineBytes = 0;
	let rangeBytes = 0;
	let longest = { line: 0, bytes: -1 };
	let scanned = 0;
	let lastByte = -1;
	const inRange = () => lineNo >= o.from && lineNo <= o.to;
	const take = (piece: Buffer) => {
		lineBytes += piece.length;
		if (headLength < o.headBytes && headTotal <= o.headBudget) {
			const kept = Buffer.from(piece.subarray(0, o.headBytes - headLength));
			head.push(kept);
			headLength += kept.length;
		}
		if (whole && rangeBytes + lineBytes <= RAW_LIMIT_BYTES + 1) parts.push(Buffer.from(piece));
	};
	const endLine = () => {
		if (inRange()) {
			rangeBytes += lineBytes + 1;
			if (lineBytes > longest.bytes) longest = { line: lineNo, bytes: lineBytes };
			if (headTotal <= o.headBudget) {
				heads.push(Buffer.concat(head));
				headTotal += headLength + 1;
			}
			if (whole && rangeBytes <= RAW_LIMIT_BYTES + 1) whole.push(Buffer.concat(parts));
			else whole = undefined;
		}
		head = [];
		headLength = 0;
		parts = [];
		lineBytes = 0;
	};
	for await (const chunk of chunks) {
		scanned += chunk.length;
		lastByte = chunk[chunk.length - 1]!;
		let start = 0;
		for (let nl = chunk.indexOf(0x0a, start); nl !== -1; nl = chunk.indexOf(0x0a, start)) {
			if (inRange()) take(chunk.subarray(start, nl));
			endLine();
			lineNo++;
			start = nl + 1;
		}
		if (start < chunk.length && inRange()) take(chunk.subarray(start));
		if (lineNo > o.to && scanned >= COUNT_LIMIT_BYTES) return { heads, whole, totalLines: lineNo - 1, counted: false, endsWithNewline: false, rangeBytes, longest };
	}
	const endsWithNewline = lastByte === 0x0a;
	if (scanned > 0 && !endsWithNewline) endLine();
	return { heads, whole, totalLines: scanned === 0 || endsWithNewline ? lineNo - 1 : lineNo, counted: true, endsWithNewline, rangeBytes, longest };
}

const size = (bytes: number) => (bytes < 1 << 20 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / (1 << 20)).toFixed(1)} MB`);

async function* fileChunks(handle: fs.promises.FileHandle, signal?: AbortSignal): AsyncIterable<Buffer> {
	const buf = Buffer.allocUnsafe(CHUNK_BYTES);
	for (let position = 0; ; ) {
		signal?.throwIfAborted();
		const { bytesRead } = await handle.read(buf, 0, CHUNK_BYTES, position);
		if (bytesRead === 0) return;
		position += bytesRead;
		yield buf.subarray(0, bytesRead);
	}
}

/** The longest prefix of `line` within `maxBytes` that does not split a UTF-8 character. */
function cutUtf8(line: Buffer, maxBytes: number): Buffer {
	let end = maxBytes;
	while (end > 0 && (line[end]! & 0xc0) === 0x80) end--;
	return line.subarray(0, end);
}

/** a UTF-16 byte-order mark; UTF-32's `FF FE 00 00` is not one. */
function utf16Order(bytes: Buffer): "le" | "be" | undefined {
	if (bytes[0] === 0xff && bytes[1] === 0xfe && !(bytes[2] === 0 && bytes[3] === 0)) return "le";
	if (bytes[0] === 0xfe && bytes[1] === 0xff) return "be";
	return undefined;
}

/** UTF-16 text after its byte-order mark, re-encoded as UTF-8; a dangling odd byte is dropped. */
function decodeUtf16(bytes: Buffer, order: "le" | "be"): Buffer {
	const body = Buffer.from(bytes.subarray(2, 2 + ((bytes.length - 2) & ~1)));
	return Buffer.from((order === "be" ? body.swap16() : body).toString("utf16le"), "utf8");
}

async function* once(bytes: Buffer): AsyncIterable<Buffer> {
	if (bytes.length) yield bytes;
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

/**
 * The model sees whole lines up to `maxFileBytes`, each cut to `maxLineBytes`.
 * A codemode script (`forScript`) also gets the requested lines byte for byte,
 * or an error when they pass RAW_LIMIT_BYTES.
 */
async function readFileContent(
	filePath: string,
	limits: ReadLimits,
	readRange: [number, number] | undefined,
	forScript: boolean,
	signal?: AbortSignal,
): Promise<ReadResult | { error: string }> {
	const start = Math.max(1, Math.floor(readRange?.[0] ?? 1));
	const requestedEnd = Math.floor(readRange?.[1] ?? start + limits.maxLines - 1);
	const options: ScanOptions = { from: start, to: requestedEnd, headBytes: limits.maxLineBytes + 1, headBudget: limits.maxFileBytes, whole: forScript };
	const empty = { text: "(empty file)", raw: forScript ? "" : undefined, totalLines: 0, counted: true, shownStart: 0, shownEnd: 0 };

	const handle = await fs.promises.open(filePath, "r");
	let scan: Scan;
	try {
		if ((await handle.stat()).size === 0) return empty;
		const invalid = readRange && rangeError(readRange, Number.POSITIVE_INFINITY);
		if (invalid) return { error: invalid };
		const sniff = Buffer.alloc(BINARY_SNIFF_BYTES);
		const { bytesRead } = await handle.read(sniff, 0, sniff.length, 0);
		const sniffed = sniff.subarray(0, bytesRead);
		const order = utf16Order(sniffed);
		if (order) {
			if ((await handle.stat()).size > MAX_UTF16_BYTES) return { error: `a UTF-16 file over ${size(MAX_UTF16_BYTES)} is not read; search it with grep instead.` };
			scan = await scanLines(once(decodeUtf16(await handle.readFile(), order)), options);
		} else if (sniffed.includes(0)) {
			return { error: `${path.basename(filePath)} is a binary file (it holds NUL bytes); inspect it with bash (file, xxd, strings) instead.` };
		} else {
			scan = await scanLines(fileChunks(handle, signal), options);
		}
	} finally {
		await handle.close();
	}

	const { totalLines, counted } = scan;
	if (totalLines === 0) return empty;

	if (readRange) {
		const error = rangeError(readRange, totalLines);
		if (error) return { error };
	}
	const end = Math.min(totalLines, requestedEnd);
	const trailingNewline = end === totalLines && scan.endsWithNewline;

	let raw: string | undefined;
	if (forScript) {
		const rawBytes = scan.rangeBytes - 1 + (trailingNewline ? 1 : 0);
		if (rawBytes > RAW_LIMIT_BYTES || !scan.whole) {
			const { line, bytes } = scan.longest;
			return {
				error: bytes > RAW_LIMIT_BYTES
					? `line ${line} alone is ${size(bytes)}, more than a script's read returns (${size(RAW_LIMIT_BYTES)}): no range fits it. Search the file with grep instead.`
					: `lines ${start}-${end} hold ${size(rawBytes)} (the longest, line ${line}, is ${size(bytes)}), more than a script's read returns (${size(RAW_LIMIT_BYTES)}). Read a smaller read_range, or search the file with grep.`,
			};
		}
		raw = scan.whole.map((line) => line.toString("utf8")).join("\n") + (trailingNewline ? "\n" : "");
	}

	// whole lines from `start` until the byte limit; the first line always shows
	const numbered: string[] = [];
	let bytes = 0;
	for (const [i, head] of scan.heads.entries()) {
		const text = head.length > limits.maxLineBytes
			? `${cutUtf8(head, limits.maxLineBytes).toString("utf8")}... (line truncated)`
			: head.toString("utf8");
		const entry = `${start + i}: ${text}`;
		const entryBytes = Buffer.byteLength(entry, "utf-8") + 1;
		if (numbered.length > 0 && bytes + entryBytes > limits.maxFileBytes) break;
		numbered.push(entry);
		bytes += entryBytes;
	}
	return { text: numbered.join("\n"), raw, totalLines, counted, shownStart: start, shownEnd: start + numbered.length - 1 };
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

		async execute(toolCallId, params, signal, _onUpdate, ctx) {
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
				// pi gives a call a codemode script makes the id `<script call id>/<n>`
				const read = await readFileContent(resolved, limits, readRange, toolCallId.includes("/"), signal);
				if ("error" in read) {
					return {
						content: [{ type: "text" as const, text: `${read.error} (${resolved})` }],
						isError: true,
					} as any;
				}
				const { text, raw, totalLines, counted, shownStart, shownEnd } = read;

				let output = text;
				let notice: string | undefined;

				if (shownEnd < totalLines || !counted) {
					notice = `showing lines ${shownStart}-${shownEnd} of ${counted ? totalLines : `more than ${totalLines}`}`;
					output += `\n\n(${notice}. use read_range to see more.)`;
				}
				markSeen(ctx.sessionManager.getSessionId(), resolved);

				return {
					content: [{ type: "text" as const, text: output }],
					details: { filePath: resolved, notice },
					...(raw !== undefined ? { structuredContent: raw } : {}),
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
