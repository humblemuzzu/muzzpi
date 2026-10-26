import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { parseSessionHeader, SUB_AGENT_SESSION_DIR, type SessionHeader } from "./pi-spawn";

/**
 * A summary of every session file, kept on disk and refreshed by size and
 * mtime, so search_sessions and read_session never parse the whole history.
 * Everything here is async and yields every SLICE_MS: pi draws its screen on
 * this thread.
 */

/** One session entry, reduced to what branches are built from. */
interface SessionNode {
	id: string;
	parentId: string | null;
	type: string;
	ts?: string;
	role?: string;
	text?: string[];
	files?: string[];
	model?: string;
}

interface SessionSummary {
	header: SessionHeader | null;
	name: string;
	nodes: SessionNode[];
}

interface IndexRow {
	path: string;
	size: number;
	mtimeMs: number;
	id: string;
	cwd: string;
	key: string;
}

export interface BranchResult {
	sessionId: string;
	sessionName: string;
	leafId: string;
	workspace: string;
	filePath: string;
	timestampStart: string;
	timestampEnd: string;
	filesTouched: string[];
	models: string[];
	messageCount: number;
	firstUserMessage: string;
	searchableText: string;
	parentSessionPath?: string;
}

/** bump with any change to what a summary holds: summaries of another format are thrown away */
const FORMAT = 1;
const SLICE_MS = 8;
const CHUNK = 1 << 20;
const MANIFEST_EVERY = 50;
/** another pi may be mid-write: its newer summaries and temp files are not yet in any manifest */
const ORPHAN_AGE_MS = 10 * 60 * 1000;
const RG_TIMEOUT_MS = 10_000;
const PATH_KEYS = ["path", "filePath", "file_path"];
const PREFIX = /^\{"type":"([a-z_]+)","id":"([^"]+)","parentId":(null|"[^"]*"),"timestamp":"([^"]+)",/;
const TOOL_RESULT = Buffer.from('"message":{"role":"toolResult"');
/** an entry's own key: a second one means a torn line ran into the next entry */
const PARENT_KEY = Buffer.from(',"parentId":');
const HEAD_BYTES = 512;
const STRUCTURAL_ONLY = 4096;

/** The user's sessions first, then sub-agents': a session id resolves to the user's own first. */
export function sessionRoots(): string[] {
	return [path.join(getAgentDir(), "sessions"), SUB_AGENT_SESSION_DIR];
}

export function createSlicer(sliceMs = SLICE_MS): () => Promise<void> {
	let start = performance.now();
	return async () => {
		if (performance.now() - start < sliceMs) return;
		await new Promise<void>((resolve) => setImmediate(resolve));
		start = performance.now();
	};
}

/**
 * Calls `onLine` with every line of the file as bytes, without the newline.
 * `complete` is false for a last line with no newline: a writer may not have finished it.
 */
export async function forEachLine(file: string, onLine: (line: Buffer, complete: boolean) => void | Promise<void>, signal?: AbortSignal): Promise<void> {
	const handle = await fs.open(file, "r");
	try {
		const buf = Buffer.allocUnsafe(CHUNK);
		let carry: Buffer[] = [];
		let position = 0;
		for (;;) {
			signal?.throwIfAborted();
			const { bytesRead } = await handle.read(buf, 0, CHUNK, position);
			if (bytesRead === 0) break;
			position += bytesRead;
			const view = buf.subarray(0, bytesRead);
			let start = 0;
			for (let nl = view.indexOf(0x0a, start); nl !== -1; nl = view.indexOf(0x0a, start)) {
				const piece = view.subarray(start, nl);
				const line = carry.length ? Buffer.concat([...carry, piece]) : piece;
				carry = [];
				await onLine(line, true);
				start = nl + 1;
			}
			if (start < bytesRead) carry.push(Buffer.from(view.subarray(start)));
		}
		if (carry.length) await onLine(Buffer.concat(carry), false);
	} finally {
		await handle.close();
	}
}

/**
 * A tool-result line, or any long line that is neither a message nor one of the
 * entries a summary reads, contributes only its place in the tree: it is read
 * from the line's fixed prefix instead of parsing megabytes.
 */
function structuralNode(line: Buffer, complete: boolean): SessionNode | undefined {
	if (!complete || line.length < 2 || line[line.length - 1] !== 0x7d) return undefined;
	const m = PREFIX.exec(line.subarray(0, HEAD_BYTES).toString("utf8"));
	if (!m) return undefined;
	const [prefix, type, id, parent, ts] = m;
	const parentId = parent === "null" ? null : parent!.slice(1, -1);
	const at = Buffer.byteLength(prefix);
	if (type === "message") {
		if (!line.subarray(at, at + TOOL_RESULT.length).equals(TOOL_RESULT) || line[line.length - 2] !== 0x7d) return undefined;
	} else if (line.length < STRUCTURAL_ONLY || type === "session" || type === "session_info" || type === "model_change") {
		return undefined;
	}
	if (line.indexOf(PARENT_KEY, at) !== -1) return undefined;
	return type === "message" ? { id: id!, parentId, type, ts, role: "toolResult" } : { id: id!, parentId, type: type!, ts };
}

function extractFilePaths(args: Record<string, unknown> | undefined): string[] {
	if (!args) return [];
	return PATH_KEYS.map((key) => args[key]).filter((value): value is string => typeof value === "string");
}

function extractFilePathsFromText(text: string): string[] {
	const paths: string[] = [];
	for (const match of text.matchAll(/@([\w./-]+\/[\w./-]+)/g)) if (match[1]) paths.push(match[1]);
	for (const match of text.matchAll(/(?:^|\s)(\/[\w./-]+)/gm)) if (match[1]) paths.push(match[1]);
	return paths;
}

function messageNode(entry: any): SessionNode {
	const node: SessionNode = { id: entry.id, parentId: entry.parentId ?? null, type: entry.type, ts: entry.timestamp };
	if (entry.type === "model_change" && typeof entry.modelId === "string") node.model = entry.modelId;
	const message = entry.type === "message" ? entry.message : undefined;
	if (!message) return node;
	node.role = typeof message.role === "string" ? message.role : "other";
	const text: string[] = [];
	const files: string[] = [];
	const parts = Array.isArray(message.content) ? message.content : [];
	if (message.role === "user") {
		for (const part of parts) {
			if (part?.type !== "text" || typeof part.text !== "string" || !part.text) continue;
			text.push(part.text);
			files.push(...extractFilePathsFromText(part.text));
		}
	} else if (message.role === "assistant") {
		for (const part of parts) {
			if (part?.type === "text" && typeof part.text === "string" && part.text) text.push(part.text);
			if (part?.type === "toolCall" && part.arguments) files.push(...extractFilePaths(part.arguments));
		}
	}
	if (text.length) node.text = text;
	if (files.length) node.files = files;
	return node;
}

export async function summarizeSession(file: string, signal?: AbortSignal, slice = createSlicer()): Promise<SessionSummary> {
	const summary: SessionSummary = { header: null, name: "", nodes: [] };
	await forEachLine(file, async (line, complete) => {
		await slice();
		const structural = structuralNode(line, complete);
		if (structural) return void summary.nodes.push(structural);
		let entry: any;
		try {
			entry = JSON.parse(line.toString("utf8"));
		} catch {
			return;
		}
		if (!entry || typeof entry !== "object") return;
		if (entry.type === "session") summary.header = entry;
		else if (entry.type === "session_info" && typeof entry.name === "string") summary.name = entry.name;
		if (typeof entry.id === "string") summary.nodes.push(messageNode(entry));
	}, signal);
	return summary;
}

const NON_LEAF_TYPES = new Set(["session", "model_change", "thinking_level_change"]);

export function branchesOf(summary: SessionSummary, filePath: string): BranchResult[] {
	const header = summary.header;
	if (!header) return [];
	const byId = new Map<string, SessionNode>();
	const hasChildren = new Set<string>();
	for (const node of summary.nodes) {
		byId.set(node.id, node);
		if (node.parentId) hasChildren.add(node.parentId);
	}
	// a corrupt file can loop its parents: a walk stops at the first entry it has seen
	const ancestors = function* (leaf: SessionNode) {
		const seen = new Set<SessionNode>();
		for (let current: SessionNode | undefined = leaf; current && !seen.has(current); current = current.parentId ? byId.get(current.parentId) : undefined) {
			seen.add(current);
			yield current;
		}
	};
	const branches: BranchResult[] = [];
	for (const leaf of summary.nodes) {
		if (hasChildren.has(leaf.id)) continue;
		if (NON_LEAF_TYPES.has(leaf.type) && ![...ancestors(leaf)].some((node) => node.type === "message")) continue;
		const chain = [...ancestors(leaf)].reverse();
		const files = new Set<string>();
		const models = new Set<string>();
		const text: string[] = [];
		let messageCount = 0;
		let firstUserMessage = "";
		for (const node of chain) {
			if (node.model) models.add(node.model);
			if (!node.role) continue;
			messageCount++;
			if (node.role === "user" && !firstUserMessage && node.text?.[0]) firstUserMessage = node.text[0].slice(0, 200);
			if (node.text) text.push(...node.text);
			for (const file of node.files ?? []) files.add(file);
		}
		const timestamps = chain.map((node) => node.ts).filter((ts): ts is string => Boolean(ts)).sort();
		branches.push({
			sessionId: header.id,
			sessionName: summary.name,
			leafId: leaf.id,
			workspace: header.cwd,
			filePath,
			timestampStart: timestamps[0] || header.timestamp,
			timestampEnd: timestamps.at(-1) || header.timestamp,
			filesTouched: [...files],
			models: [...models],
			messageCount,
			firstUserMessage,
			searchableText: text.join("\n"),
			parentSessionPath: header.parentSession,
		});
	}
	return branches;
}

let writes = 0;
async function writeAtomic(file: string, text: string): Promise<void> {
	const tmp = `${file}.${process.pid}-${++writes}.tmp`;
	await fs.writeFile(tmp, text, { mode: 0o600 });
	await fs.rename(tmp, file);
}

/** The header line, read from at most the first 64 KB of the file. */
export async function readSessionHeader(file: string): Promise<SessionHeader | undefined> {
	let handle: fs.FileHandle | undefined;
	try {
		handle = await fs.open(file, "r");
		const buf = Buffer.alloc(64 * 1024);
		const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
		return parseSessionHeader(buf.subarray(0, bytesRead));
	} catch {
		return undefined;
	} finally {
		await handle?.close();
	}
}

export async function listSessionFiles(roots: string[]): Promise<string[]> {
	const files: string[] = [];
	const walk = async (dir: string) => {
		let entries: import("node:fs").Dirent[];
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) await walk(full);
			else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(full);
		}
	};
	for (const root of roots) await walk(root);
	return files;
}

const isRow = (row: any): row is IndexRow =>
	!!row && typeof row.path === "string" && typeof row.key === "string" && typeof row.id === "string" && typeof row.cwd === "string" &&
	Number.isFinite(row.size) && Number.isFinite(row.mtimeMs);

export class SessionIndex {
	private rowsByPath = new Map<string, IndexRow>();
	private loaded = false;
	private running: Promise<void> | undefined;
	private readonly filesDir: string;
	private readonly manifest: string;

	constructor(readonly roots: string[], readonly dir: string) {
		this.filesDir = path.join(dir, "files");
		this.manifest = path.join(dir, "manifest.json");
	}

	/** Rows in listing order: the roots in order, each in directory order. */
	rows(): IndexRow[] {
		return [...this.rowsByPath.values()];
	}

	/** A row's summary; one that is missing or unreadable is rebuilt from the session file. */
	async summary(row: IndexRow, signal?: AbortSignal): Promise<SessionSummary | undefined> {
		const file = path.join(this.filesDir, `${row.key}.json`);
		try {
			return JSON.parse(await fs.readFile(file, "utf8"));
		} catch {}
		try {
			const summary = await summarizeSession(row.path, signal);
			await fs.mkdir(this.filesDir, { recursive: true, mode: 0o700 });
			await writeAtomic(file, JSON.stringify(summary));
			return summary;
		} catch (error) {
			if (signal?.aborted) throw error;
			return undefined;
		}
	}

	/** A refresh already running is joined; one that fails, say aborted by its own caller, is run again. */
	async refresh(signal?: AbortSignal, onProgress?: (p: { done: number; total: number }) => void): Promise<void> {
		while (this.running) {
			signal?.throwIfAborted();
			try {
				return await this.running;
			} catch {}
		}
		signal?.throwIfAborted();
		this.running = this.doRefresh(signal, onProgress).finally(() => {
			this.running = undefined;
		});
		await this.running;
	}

	private async loadManifest(): Promise<void> {
		if (this.loaded) return;
		this.loaded = true;
		let saved: any;
		try {
			saved = JSON.parse(await fs.readFile(this.manifest, "utf8"));
		} catch {}
		if (saved?.format === FORMAT && Array.isArray(saved.rows)) {
			for (const row of saved.rows) if (isRow(row)) this.rowsByPath.set(row.path, row);
		} else if (saved !== undefined) {
			await fs.rm(this.filesDir, { recursive: true, force: true });
		}
		await this.dropOrphans();
	}

	/** summaries no row names, and temp files a killed writer left behind */
	private async dropOrphans(): Promise<void> {
		let names: string[];
		try {
			names = await fs.readdir(this.filesDir);
		} catch {
			return;
		}
		const keys = new Set([...this.rowsByPath.values()].map((row) => `${row.key}.json`));
		const cutoff = Date.now() - ORPHAN_AGE_MS;
		for (const name of names) {
			if (keys.has(name)) continue;
			const file = path.join(this.filesDir, name);
			const st = await fs.stat(file).catch(() => undefined);
			if (st && st.mtimeMs < cutoff) await fs.unlink(file).catch(() => {});
		}
	}

	private async saveManifest(rows: Map<string, IndexRow>): Promise<void> {
		await writeAtomic(this.manifest, JSON.stringify({ format: FORMAT, rows: [...rows.values()] }));
	}

	private async doRefresh(signal?: AbortSignal, onProgress?: (p: { done: number; total: number }) => void): Promise<void> {
		await this.loadManifest();
		await fs.mkdir(this.filesDir, { recursive: true, mode: 0o700 });
		const files = await listSessionFiles(this.roots);
		const stats = await Promise.all(files.map((file) => fs.stat(file).catch(() => undefined)));
		// a stale row stays, with its old summary, until the new one is written
		const next = new Map<string, IndexRow>();
		const stale: Array<{ file: string; size: number; mtimeMs: number }> = [];
		files.forEach((file, i) => {
			const st = stats[i];
			if (!st) return;
			const prev = this.rowsByPath.get(file);
			if (prev) next.set(file, prev);
			if (!prev || prev.size !== st.size || prev.mtimeMs !== st.mtimeMs) stale.push({ file, size: st.size, mtimeMs: st.mtimeMs });
		});
		const gone = [...this.rowsByPath.values()].filter((row) => !next.has(row.path));
		this.rowsByPath = next;
		const slice = createSlicer();
		let unsaved = gone.length > 0;
		try {
			for (let i = 0; i < stale.length; i++) {
				signal?.throwIfAborted();
				onProgress?.({ done: i, total: stale.length });
				const { file, size, mtimeMs } = stale[i]!;
				let summary: SessionSummary;
				try {
					summary = await summarizeSession(file, signal, slice);
				} catch (error) {
					if (signal?.aborted) throw error;
					continue;
				}
				const key = next.get(file)?.key ?? keyOf(file);
				await writeAtomic(path.join(this.filesDir, `${key}.json`), JSON.stringify(summary));
				next.set(file, { path: file, size, mtimeMs, id: summary.header?.id ?? "", cwd: summary.header?.cwd ?? "", key });
				unsaved = true;
				if (i % MANIFEST_EVERY === MANIFEST_EVERY - 1) {
					await this.saveManifest(next);
					unsaved = false;
				}
			}
		} finally {
			if (unsaved) await this.saveManifest(next);
		}
		for (const row of gone) await fs.unlink(path.join(this.filesDir, `${row.key}.json`)).catch(() => {});
	}

	/**
	 * Keys of the summaries containing `needle`, by ripgrep over the summary files.
	 * Undefined, meaning every row must be read, when rg's case folding or JSON
	 * escaping could miss a match JavaScript's `toLowerCase` finds, or rg fails.
	 */
	async keysContaining(needle: string, signal?: AbortSignal): Promise<Set<string> | undefined> {
		// "İ" lowercases to "i" plus a combining dot in JavaScript; rg folds it to nothing
		if (!/^[\x20-\x7e]+$/.test(needle) || /["\\]/.test(needle) || /i$/i.test(needle)) return undefined;
		return new Promise((resolve) => {
			const args = ["--no-config", "--no-ignore", "--hidden", "--no-messages", "-l", "-i", "-F", "--", needle, "."];
			const child = spawn("rg", args, { cwd: this.filesDir, stdio: ["ignore", "pipe", "ignore"], signal, timeout: RG_TIMEOUT_MS });
			let out = "";
			child.stdout.setEncoding("utf8");
			child.stdout.on("data", (chunk) => (out += chunk));
			child.on("error", () => resolve(undefined));
			child.on("close", (code) => {
				if (code !== 0 && code !== 1) return resolve(undefined);
				resolve(new Set(out.split("\n").filter(Boolean).map((file) => path.basename(file, ".json"))));
			});
		});
	}
}

let shared: SessionIndex | undefined;

export function defaultSessionIndex(): SessionIndex {
	shared ??= new SessionIndex(sessionRoots(), path.join(getAgentDir(), "cache", "session-index"));
	return shared;
}

function keyOf(file: string): string {
	return crypto.createHash("sha1").update(file).digest("hex").slice(0, 20);
}
