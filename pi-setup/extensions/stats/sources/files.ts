import { createReadStream, existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { type Ledger } from "../ledger";
import { type PriceBook, ratesCurrent } from "../pricing";
import type { Harness, SessionRecord } from "../record";

export interface LineEnv {
	prices: PriceBook;
	/** Turn identities already counted by any record of this harness, with what was counted (see `SessionRecord.dedup`). */
	seen: Map<string, string>;
	parentExists(p: string): boolean;
}

export interface FileSpec {
	harness: Harness;
	roots: string[];
	accept(file: string): boolean;
	/** A record for a file read from its first byte. */
	create(file: string): SessionRecord;
	line(rec: SessionRecord, line: Buffer, env: LineEnv): void;
	/** After a read: give the record its ledger key and session id. */
	finish(rec: SessionRecord): void;
}

export interface Progress {
	files: number;
	parsed: number;
	bytes: number;
	totalBytes: number;
}

export interface FileResult {
	records: SessionRecord[];
	changed: boolean;
}

/** Element-wise maximum of two CSV number lists; plain identities have empty values. */
function maxCsv(a: string | undefined, b: string): string {
	if (!a || !b) return a || b;
	const x = a.split(",").map(Number);
	return b.split(",").map((v, i) => Math.max(Number(v) || 0, x[i] || 0)).join(",");
}

async function walk(root: string, accept: (f: string) => boolean): Promise<string[]> {
	const out: string[] = [];
	const stack = [root];
	while (stack.length) {
		const dir = stack.pop()!;
		let entries;
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const e of entries) {
			const p = path.join(dir, e.name);
			if (e.isDirectory()) stack.push(p);
			else if (e.isFile() && accept(p)) out.push(p);
		}
	}
	return out;
}

/** Sources only grow, so a record resumes where it stopped unless the file shrank or the byte before the offset is no longer a newline. */
async function canResume(rec: SessionRecord, size: number): Promise<boolean> {
	if (rec.offset === 0) return true;
	if (size < rec.offset) return false;
	const fh = await fs.open(rec.source, "r").catch(() => undefined);
	if (!fh) return false;
	try {
		const buf = Buffer.alloc(1);
		await fh.read(buf, 0, 1, rec.offset - 1);
		return buf[0] === 0x0a;
	} finally {
		await fh.close();
	}
}

/** Feeds complete lines from `rec.offset` on; a partly written last line is left for the next run. */
async function parseFrom(spec: FileSpec, rec: SessionRecord, env: LineEnv, onBytes: (n: number) => void, signal?: AbortSignal): Promise<void> {
	const stream = createReadStream(rec.source, { start: rec.offset, highWaterMark: 1 << 20 });
	let pending: Buffer[] = [];
	let consumed = rec.offset;
	try {
		for await (const chunk of stream as AsyncIterable<Buffer>) {
			if (signal?.aborted) return;
			let start = 0;
			let nl = chunk.indexOf(0x0a, start);
			while (nl !== -1) {
				const piece = chunk.subarray(start, nl);
				const line = pending.length ? Buffer.concat([...pending, piece]) : piece;
				pending = [];
				consumed += line.length + 1;
				if (line.length) spec.line(rec, line, env);
				start = nl + 1;
				nl = chunk.indexOf(0x0a, start);
			}
			if (start < chunk.length) pending.push(chunk.subarray(start));
			onBytes(chunk.length);
		}
	} finally {
		stream.destroy();
	}
	rec.offset = consumed;
}

/**
 * Every matching file under the spec's roots, read incrementally against
 * the ledger. Files are read oldest first and share one `seen` map, so a
 * transcript that replays another's turns (a resume, a fork) counts none of
 * them twice.
 */
export async function ingestFiles(spec: FileSpec, ledger: Ledger | undefined, prices: PriceBook, onProgress: (p: Progress) => void, signal?: AbortSignal): Promise<FileResult> {
	const files = (await Promise.all(spec.roots.map((r) => walk(r, spec.accept)))).flat();
	const stats = await Promise.all(files.map((f) => fs.stat(f).catch(() => undefined)));
	const cached = new Map((ledger?.records ?? []).map((r) => [r.source, r]));

	const keep: SessionRecord[] = [];
	const work: Array<{ rec: SessionRecord; prev?: SessionRecord; size: number; mtimeMs: number; order: number }> = [];
	const present = new Set<string>();
	let totalBytes = 0;
	for (let i = 0; i < files.length; i++) {
		const st = stats[i];
		if (!st) continue;
		present.add(files[i]);
		const prev = cached.get(files[i]);
		const fresh = !ledger?.stale && prev && ratesCurrent(prices, prev.rates);
		if (prev && fresh && prev.size === st.size && prev.mtimeMs === st.mtimeMs) {
			keep.push(prev);
			continue;
		}
		const resume = prev && fresh && (await canResume(prev, st.size));
		const rec = resume ? structuredClone(prev) : spec.create(files[i]);
		work.push({ rec, prev: resume ? prev : undefined, size: st.size, mtimeMs: st.mtimeMs, order: rec.startMs || st.birthtimeMs || st.mtimeMs });
		totalBytes += st.size - rec.offset;
	}

	const retained = (ledger?.records ?? []).filter((r) => !present.has(r.source));
	const seen = new Map<string, string>();
	for (const r of [...keep, ...work.flatMap((w) => (w.prev ? [w.prev] : [])), ...retained]) for (const [k, v] of Object.entries(r.dedup)) seen.set(k, maxCsv(seen.get(k), v));

	const parents = new Map<string, boolean>();
	const env: LineEnv = {
		prices,
		seen,
		parentExists: (p) => {
			let hit = parents.get(p);
			if (hit === undefined) parents.set(p, (hit = existsSync(p)));
			return hit;
		},
	};

	work.sort((a, b) => a.order - b.order);
	const progress: Progress = { files: files.length, parsed: 0, bytes: 0, totalBytes };
	onProgress(progress);
	const current = [...keep];
	for (const item of work) {
		if (signal?.aborted) break;
		try {
			await parseFrom(spec, item.rec, env, (n) => {
				progress.bytes += n;
				onProgress(progress);
			}, signal);
		} catch {
			// unreadable since the walk: keep what the ledger had, and try again next time
			if (item.prev) current.push(item.prev);
			continue;
		}
		if (signal?.aborted) break;
		item.rec.size = item.size;
		item.rec.mtimeMs = item.mtimeMs;
		spec.finish(item.rec);
		current.push(item.rec);
		progress.parsed++;
		onProgress(progress);
	}

	const keys = new Set(current.map((r) => r.key));
	const records = [...current, ...retained.filter((r) => !keys.has(r.key))];
	return { records, changed: work.length > 0 || records.length !== (ledger?.records.length ?? 0) };
}
