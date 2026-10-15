import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { type Ledger, readLedger, writeLedger } from "./ledger";
import type { PriceBook } from "./pricing";
import { HARNESSES, type Harness, type SessionRecord } from "./record";
import { claudeArchive, claudeHome, claudeSpec } from "./sources/claude";
import { codexHome, codexSpec } from "./sources/codex";
import { type FileSpec, ingestFiles, type Progress } from "./sources/files";
import { ingestOpencode, type OpencodeExtra, opencodeHome } from "./sources/opencode";
import { piSpec } from "./sources/pi";

export type SourceState = "waiting" | "reading" | "done" | "absent" | "failed";

export interface SourceStatus extends Progress {
	state: SourceState;
	error?: string;
}

export type IngestProgress = Record<Harness, SourceStatus>;

export interface Loaded {
	records: SessionRecord[];
	status: IngestProgress;
}

export interface IngestOptions {
	piSessions: string;
	cacheDir: string;
	prices: PriceBook;
	onProgress?: (p: IngestProgress) => void;
	signal?: AbortSignal;
}

const LEGACY_CACHE = "index-v4.json";

function blank(): SourceStatus {
	return { state: "waiting", files: 0, parsed: 0, bytes: 0, totalBytes: 0 };
}

function firstDay(records: SessionRecord[]): string | undefined {
	let first: string | undefined;
	for (const r of records) {
		for (const k of [...Object.keys(r.usage), ...Object.keys(r.agents)]) {
			const day = k.slice(0, 10);
			if (!first || day < first) first = day;
		}
	}
	return first;
}

interface SourceResult {
	records: SessionRecord[];
	changed: boolean;
	extra?: unknown;
}

type Reader = (ledger: Ledger | undefined, report: (p: Progress) => void) => Promise<SourceResult>;

const files = (spec: FileSpec, opts: IngestOptions): Reader => (ledger, report) => ingestFiles(spec, ledger, opts.prices, report, opts.signal);

/** Where each harness keeps its sessions; a harness with none of these present is shown as not installed. */
function sourcePaths(piSessions: string): Record<Harness, string[]> {
	return {
		pi: [piSessions],
		claude: [path.join(claudeHome(), "projects"), path.join(claudeHome(), "stats-cache.json")],
		codex: [path.join(codexHome(), "sessions"), path.join(codexHome(), "archived_sessions")],
		opencode: [opencodeHome()],
	};
}

/** pi sessions imported from another harness whose original turns are still in that harness's ledger. */
export function dropImports(records: SessionRecord[]): SessionRecord[] {
	const originals = new Map<Harness, Set<string>>();
	for (const r of records) {
		if (r.importOf || r.harness === "pi") continue;
		const set = originals.get(r.harness) ?? originals.set(r.harness, new Set()).get(r.harness)!;
		for (const k in r.dedup) set.add(k);
	}
	return records.filter((r) => {
		const keys = r.importOf ? Object.keys(r.dedup) : [];
		if (!keys.length) return true;
		const set = originals.get(r.importOf!);
		const found = set ? keys.filter((k) => set.has(k)).length : 0;
		return found * 2 < keys.length;
	});
}

/**
 * Every harness at once, each against its own ledger. A source that fails
 * keeps its last ledger, so one broken harness never blanks the others.
 */
export async function ingestAll(opts: IngestOptions): Promise<Loaded> {
	const status = Object.fromEntries(HARNESSES.map((h) => [h, blank()])) as IngestProgress;
	const emit = () => opts.onProgress?.(status);
	const where = sourcePaths(opts.piSessions);

	const run = async (h: Harness, read: Reader): Promise<SessionRecord[]> => {
		const s = status[h];
		const installed = where[h].some((p) => existsSync(p));
		const ledger = await readLedger(opts.cacheDir, h);
		if (!installed && !ledger?.records.length) {
			s.state = "absent";
			emit();
			return [];
		}
		s.state = "reading";
		emit();
		try {
			const out = await read(ledger, (p) => {
				Object.assign(s, p);
				emit();
			});
			if (out.changed && !opts.signal?.aborted) await writeLedger(opts.cacheDir, h, out.records, out.extra);
			s.state = "done";
			emit();
			return out.records;
		} catch (err) {
			s.state = "failed";
			s.error = err instanceof Error ? err.message.split("\n")[0] : String(err);
			emit();
			return ledger?.records ?? [];
		}
	};

	const [pi, claude, codex, opencode] = await Promise.all([
		run("pi", files(piSpec(opts.piSessions), opts)),
		run("claude", files(claudeSpec(), opts)),
		run("codex", files(codexSpec(), opts)),
		run("opencode", (ledger, report) => ingestOpencode(ledger as Ledger<OpencodeExtra> | undefined, opts.prices, report, opts.signal)),
	]);
	const archive = status.claude.state === "absent" ? undefined : await claudeArchive(opts.prices, firstDay(claude));
	if (!opts.signal?.aborted) await fs.unlink(path.join(opts.cacheDir, LEGACY_CACHE)).catch(() => {});
	return { records: dropImports([...pi, ...claude, ...(archive ? [archive] : []), ...codex, ...opencode]), status };
}

/** pi's sessions only, and only on top of an existing ledger: the widget must never trigger a first full read. */
export async function ingestPiWarm(piSessions: string, cacheDir: string, prices: PriceBook): Promise<SessionRecord[] | undefined> {
	const ledger = await readLedger(cacheDir, "pi");
	if (!ledger || ledger.stale) return undefined;
	const out = await ingestFiles(piSpec(piSessions), ledger, prices, () => {});
	if (out.changed) await writeLedger(cacheDir, "pi", out.records);
	return out.records;
}
