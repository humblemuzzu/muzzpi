import fs from "node:fs/promises";
import path from "node:path";
import { A_LEN, type Harness, type SessionRecord, T_LEN, U_LEN } from "./record";

/**
 * One file per harness under the stats cache dir. It is a ledger more than a
 * cache: a session whose source file is gone (Claude Code prunes transcripts
 * after 30 days) keeps its record, so lifetime totals never shrink.
 */

/** Bump when a parser's output changes: present sources are re-read, records of vanished ones carry over. */
const VERSION = 9;
let saves = 0;

interface LedgerFile<X = unknown> {
	version: number;
	/** Day keys are local dates. */
	timeZone: string;
	records: SessionRecord[];
	extra?: X;
}

export interface Ledger<X = unknown> {
	records: SessionRecord[];
	/** Written by an older parser or in another time zone: re-read every record whose source still exists. */
	stale: boolean;
	extra?: X;
}

function timeZone(): string {
	return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "local";
}

const ledgerFile = (dir: string, harness: Harness, version = VERSION) => path.join(dir, `ledger-${harness}-v${version}.json`);

/** Rows written before a bucket was added are shorter; the missing buckets are zero. */
function upgrade(rec: SessionRecord): SessionRecord {
	const fill = (map: Record<string, number[]>, len: number) => {
		for (const row of Object.values(map)) while (row.length < len) row.push(0);
	};
	fill(rec.usage, U_LEN);
	fill(rec.agents, A_LEN);
	fill(rec.tools, T_LEN);
	if (Array.isArray(rec.dedup)) rec.dedup = Object.fromEntries((rec.dedup as string[]).map((k) => [k, ""]));
	rec.rates ??= {};
	return rec;
}

export async function readLedger<X>(dir: string, harness: Harness): Promise<Ledger<X> | undefined> {
	for (let v = VERSION; v >= 1; v--) {
		let raw: LedgerFile<X>;
		try {
			raw = JSON.parse(await fs.readFile(ledgerFile(dir, harness, v), "utf8"));
		} catch {
			continue;
		}
		if (!Array.isArray(raw.records)) continue;
		const stale = v !== VERSION || raw.timeZone !== timeZone();
		return { records: stale ? raw.records.map(upgrade) : raw.records, stale, extra: v === VERSION ? raw.extra : undefined };
	}
	return undefined;
}

/** Atomic and private: the ledger holds prompt titles, paths and commands. Older versions go once this one is written. */
export async function writeLedger<X>(dir: string, harness: Harness, records: SessionRecord[], extra?: X): Promise<void> {
	await fs.mkdir(dir, { recursive: true, mode: 0o700 });
	const file = ledgerFile(dir, harness);
	const tmp = `${file}.${process.pid}-${++saves}.tmp`;
	const body: LedgerFile<X> = { version: VERSION, timeZone: timeZone(), records, extra };
	await fs.writeFile(tmp, JSON.stringify(body), { mode: 0o600 });
	await fs.rename(tmp, file);
	for (let v = VERSION - 1; v >= 1; v--) await fs.unlink(ledgerFile(dir, harness, v)).catch(() => {});
}
