import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Ledger } from "../ledger";
import { estimate, type PriceBook, ratesCurrent } from "../pricing";
import { addCalls, addCompaction, addPrompt, addToolResult, addTurn, cleanText, emptyRecord, modelKey, num, type SessionRecord, ZERO_COST } from "../record";
import type { Progress } from "./files";

/**
 * Three overlapping stores: `message`/`part` (1.x), `session_message` (a
 * newer copy under the same ids, plus messages written since), and the
 * legacy `storage/message/<session>/<id>.json` tree left after migration.
 * Messages are their union by id. An old-style fork copies its parent's
 * messages under new ids with the same completion instant and tokens; that
 * fingerprint counts once, and pi's `[opencode]` imports carry it too. Read
 * with the `sqlite3` CLI, `-readonly`, in a child process.
 */

export function opencodeHome(): string {
	const xdg = process.env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), ".local", "share");
	return path.join(xdg, "opencode");
}

const US = "\x1f";
const RS = "\x1e";
const FULL_SCAN_ABOVE = 300;
const LEGACY = "opencode:legacy:";

export interface OpencodeExtra {
	legacyStamp?: string;
}

function sql(db: string, query: string, signal?: AbortSignal): Promise<string[][]> {
	return new Promise((resolve, reject) => {
		const child = spawn("sqlite3", ["-readonly", "-batch", "-noheader", "-separator", US, "-newline", RS, "-nullvalue", "", "-cmd", ".timeout 5000", db, query], {
			stdio: ["ignore", "pipe", "pipe"],
			signal,
		});
		const out: string[] = [];
		let err = "";
		child.stdout.setEncoding("utf8").on("data", (d: string) => out.push(d));
		child.stderr.setEncoding("utf8").on("data", (d: string) => (err += d));
		child.on("error", (e: NodeJS.ErrnoException) => reject(e.code === "ENOENT" ? new Error("sqlite3 is not on PATH") : e));
		child.on("close", (code) => {
			if (code !== 0) return reject(new Error(err.trim().split("\n")[0] || `sqlite3 exited ${code}`));
			const text = out.join("");
			resolve(text ? text.split(RS).filter((r) => r.length).map((r) => r.split(US)) : []);
		});
	});
}

const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;

interface Session {
	id: string;
	parent: string;
	dir: string;
	title: string;
	created: number;
	agent: string;
	/** Newest change to the session row or any of its messages. */
	mark: number;
	rows: number;
}

interface Message {
	id: string;
	session: string;
	role: string;
	provider: string;
	model: string;
	input: number;
	output: number;
	reasoning: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	ms: number;
	completed: number;
	variant: string;
	error: string;
	agent: string;
	promptLen: number;
	promptHead: string;
}

interface Tool {
	session: string;
	message: string;
	name: string;
	status: string;
	start: number;
	end: number;
	command: string;
	filePath: string;
	patch: string;
	ms: number;
}

const SESSION_COLS = (t: string, cols: Set<string>) =>
	`SELECT id, COALESCE(parent_id,''), COALESCE(directory,''), COALESCE(title,''), time_created, time_updated, ${cols.has("agent") ? "COALESCE(agent,'')" : "''"} FROM ${t}`;

const MESSAGE_COLS = (role: string, provider: string, model: string, variant: string) =>
	`${role}, json_extract(data,'${provider}'), json_extract(data,'${model}'), json_extract(data,'$.tokens.input'), json_extract(data,'$.tokens.output'), json_extract(data,'$.tokens.reasoning'), json_extract(data,'$.tokens.cache.read'), json_extract(data,'$.tokens.cache.write'), json_extract(data,'$.cost'), COALESCE(json_extract(data,'$.time.created'), time_created), json_extract(data,'$.time.completed'), json_extract(data,'${variant}'), json_extract(data,'$.error.name'), json_extract(data,'$.agent')`;

const TOOL_COLS = (src: string) =>
	`json_extract(${src},'$.state.status'), json_extract(${src},'$.state.time.start'), json_extract(${src},'$.state.time.end'), json_extract(${src},'$.state.input.command'), json_extract(${src},'$.state.input.filePath'), substr(json_extract(${src},'$.state.input.patchText'),1,20000)`;

const USER_TEXT = (agg: string) =>
	`CASE WHEN json_extract(m.data,'$.role')='user' THEN (SELECT ${agg} FROM part p WHERE p.message_id=m.id AND p.data LIKE '{"type":"text"%' AND json_extract(p.data,'$.synthetic') IS NULL ORDER BY p.id) END`;

function toMessage(r: string[]): Message {
	return {
		id: r[0],
		session: r[1],
		role: r[2],
		provider: r[3],
		model: r[4],
		input: num(r[5]),
		output: num(r[6]),
		reasoning: num(r[7]),
		cacheRead: num(r[8]),
		cacheWrite: num(r[9]),
		cost: num(r[10]),
		ms: num(r[11]),
		completed: num(r[12]),
		variant: r[13],
		error: r[14],
		agent: r[15],
		promptLen: num(r[16]),
		promptHead: r[17] ?? "",
	};
}

function toTool(r: string[]): Tool {
	return { session: r[0], message: r[1], name: r[2], status: r[3], start: num(r[4]), end: num(r[5]), command: r[6], filePath: r[7], patch: r[8], ms: num(r[9]) };
}

type Tables = Map<string, Set<string>>;

async function schema(db: string, signal?: AbortSignal): Promise<Tables> {
	const rows = await sql(db, "SELECT m.name, p.name FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type='table' AND m.name IN ('session','session_v2','message','session_message','part')", signal);
	const out: Tables = new Map();
	for (const [t, c] of rows) (out.get(t) ?? out.set(t, new Set()).get(t)!).add(c);
	return out;
}

async function sessions(db: string, tables: Tables, signal?: AbortSignal): Promise<Session[]> {
	const parts: string[] = [];
	if (tables.has("session")) parts.push(SESSION_COLS("session", tables.get("session")!));
	if (tables.has("session_v2")) parts.push(`${SESSION_COLS("session_v2", tables.get("session_v2")!)}${tables.has("session") ? " WHERE id NOT IN (SELECT id FROM session)" : ""}`);
	if (!parts.length) return [];
	const marks: string[] = [];
	if (tables.has("message")) marks.push("SELECT session_id, max(time_updated), count(*) FROM message GROUP BY session_id");
	if (tables.has("session_message")) marks.push("SELECT session_id, max(time_updated), count(*) FROM session_message GROUP BY session_id");
	const [rows, markRows] = await Promise.all([sql(db, parts.join(" UNION ALL "), signal), marks.length ? sql(db, marks.join(" UNION ALL "), signal) : Promise.resolve([])]);
	const mark = new Map<string, [number, number]>();
	for (const [s, u, n] of markRows) {
		const m = mark.get(s) ?? [0, 0];
		mark.set(s, [Math.max(m[0], num(u)), m[1] + num(n)]);
	}
	return rows.map((r) => {
		const [u, n] = mark.get(r[0]) ?? [0, 0];
		return { id: r[0], parent: r[1], dir: r[2], title: r[3], created: num(r[4]), agent: r[6], mark: Math.max(num(r[5]), u), rows: n };
	});
}

function within(col: string, ids: string[] | undefined): string {
	return ids ? ` AND ${col} IN (${ids.map(quote).join(",")})` : "";
}

async function messages(db: string, tables: Tables, ids: string[] | undefined, signal?: AbortSignal): Promise<Message[]> {
	const queries: Promise<string[][]>[] = [];
	if (tables.has("message")) {
		const prompt = tables.has("part") ? `${USER_TEXT("sum(length(json_extract(p.data,'$.text')))")}, ${USER_TEXT("substr(json_extract(p.data,'$.text'),1,160)")}` : "NULL, NULL";
		queries.push(sql(db, `SELECT m.id, m.session_id, ${MESSAGE_COLS("json_extract(data,'$.role')", "$.providerID", "$.modelID", "$.variant")}, ${prompt} FROM message m WHERE 1${within("m.session_id", ids)}`, signal));
	}
	if (tables.has("session_message")) {
		const notOld = tables.has("message") ? " AND id NOT IN (SELECT id FROM message)" : "";
		const cols = MESSAGE_COLS("type", "$.model.providerID", "$.model.id", "$.model.variant");
		queries.push(sql(db, `SELECT id, session_id, ${cols}, length(json_extract(data,'$.text')), substr(json_extract(data,'$.text'),1,160) FROM session_message WHERE type IN ('assistant','user')${notOld}${within("session_id", ids)}`, signal));
	}
	return (await Promise.all(queries)).flat().map(toMessage);
}

async function tools(db: string, tables: Tables, ids: string[] | undefined, signal?: AbortSignal): Promise<Tool[]> {
	const queries: Promise<string[][]>[] = [];
	if (tables.has("part")) {
		queries.push(sql(db, `SELECT session_id, message_id, json_extract(data,'$.tool'), ${TOOL_COLS("data")}, time_created FROM part WHERE data LIKE '{"type":"tool"%'${within("session_id", ids)}`, signal));
	}
	if (tables.has("session_message")) {
		const notOld = tables.has("message") ? " AND sm.id NOT IN (SELECT id FROM message)" : "";
		const from = "FROM session_message sm, json_each(sm.data,'$.content') c WHERE sm.type='assistant' AND json_extract(c.value,'$.type')='tool'";
		queries.push(sql(db, `SELECT sm.session_id, sm.id, json_extract(c.value,'$.name'), ${TOOL_COLS("c.value")}, sm.time_created ${from}${notOld}${within("sm.session_id", ids)}`, signal));
	}
	return (await Promise.all(queries)).flat().map(toTool);
}

async function compactions(db: string, tables: Tables, ids: string[] | undefined, signal?: AbortSignal): Promise<Array<[string, number]>> {
	const queries: Promise<string[][]>[] = [];
	if (tables.has("part")) queries.push(sql(db, `SELECT session_id, time_created FROM part WHERE data LIKE '{"type":"compaction"%'${within("session_id", ids)}`, signal));
	if (tables.has("session_message")) queries.push(sql(db, `SELECT session_id, time_created FROM session_message WHERE type='compaction'${within("session_id", ids)}`, signal));
	return (await Promise.all(queries)).flat().map((r) => [r[0], num(r[1])]);
}

/** OpenCode's `output` leaves reasoning out; ours includes it, as the bill does. A recorded cost wins over the catalog. */
function turnOf(m: Message, prices: PriceBook, rates: Record<string, string>) {
	const model = modelKey(m.provider, m.model || "unknown");
	const output = m.output + m.reasoning;
	const usage = { input: m.input, output, cacheRead: m.cacheRead, cacheWrite: m.cacheWrite, cacheWrite1h: 0 };
	let priced = estimate(prices, rates, model, usage);
	if (m.cost > 0) {
		const est = priced.estimated ? priced.cost : undefined;
		const k = est && est.total > 0 ? m.cost / est.total : 0;
		const cost = est && k ? { input: est.input * k, output: est.output * k, cacheRead: est.cacheRead * k, cacheWrite: est.cacheWrite * k, total: m.cost } : { ...ZERO_COST, total: m.cost };
		priced = { cost, estimated: false, unpriced: false };
	}
	return {
		ms: m.ms,
		model,
		thinking: m.variant && m.variant !== "default" ? m.variant : "unknown",
		input: m.input,
		output,
		cacheRead: m.cacheRead,
		cacheWrite: m.cacheWrite,
		cacheWrite1h: 0,
		reasoning: m.reasoning,
		...priced,
		durationMs: 0,
		stop: m.error === "MessageAbortedError" ? ("aborted" as const) : m.error ? ("error" as const) : undefined,
		calls: [],
	};
}

/** The same shape pi's importer leaves: completion instant, then input, output without reasoning, cache read, cache write. */
const fingerprint = (m: Pick<Message, "ms" | "completed" | "input" | "output" | "cacheRead" | "cacheWrite">) =>
	`${m.completed || m.ms}:${m.input}:${m.output}:${m.cacheRead}:${m.cacheWrite}`;

function group<T>(rows: T[], keyOf: (r: T) => string): Map<string, T[]> {
	const m = new Map<string, T[]>();
	for (const r of rows) {
		const k = keyOf(r);
		const list = m.get(k);
		if (list) list.push(r);
		else m.set(k, [r]);
	}
	return m;
}

function build(s: Session, root: Session, source: string, msgs: Message[], toolRows: Tool[], comps: number[], prices: PriceBook, seen: Set<string>): SessionRecord {
	const rec = emptyRecord("opencode", source, s.parent ? "agent" : "session");
	rec.key = `opencode:${s.id}`;
	rec.id = root.id;
	rec.cwd = root.dir || s.dir;
	rec.name = s.parent ? undefined : cleanText(s.title);
	rec.startMs = s.created;
	rec.mtimeMs = s.mark;
	rec.size = s.rows;
	rec.agentName = cleanText(s.agent || msgs.find((m) => m.agent)?.agent || "", 40) ?? "subagent";

	const byMessage = group(toolRows, (t) => t.message);
	type Event = [ms: number, kind: 0 | 1, message: Message | undefined];
	const events: Event[] = [...msgs.map((m): Event => [m.ms, 1, m]), ...comps.map((ms): Event => [ms, 0, undefined])];
	events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

	for (const [ms, , m] of events) {
		if (!m) {
			addCompaction(rec, ms, rec.state.prevTurn?.context ?? 0);
			continue;
		}
		if (m.role === "user") {
			if (m.promptHead.trim()) addPrompt(rec, m.ms, m.promptHead, Math.max(m.promptLen, m.promptHead.length));
			continue;
		}
		if (m.role !== "assistant") continue;
		const fp = fingerprint(m);
		if (m.output + m.input + m.cacheRead > 0) {
			if (seen.has(fp)) continue;
			seen.add(fp);
			rec.dedup[fp] = "";
		}
		addTurn(rec, turnOf(m, prices, rec.rates));
		let agents = 0;
		for (const t of byMessage.get(m.id) ?? []) {
			const at = t.start || t.ms || m.ms;
			agents = addCalls(rec, at, [{ name: t.name, args: { command: t.command || undefined, filePath: t.filePath || undefined, input: t.patch || undefined } }], agents);
			const done = t.status === "completed" || t.status === "error";
			addToolResult(rec, at, t.name, { error: t.status === "error", durationMs: done && t.end > t.start ? t.end - t.start : 0, known: done });
		}
	}
	return rec;
}

/** Legacy JSON messages missing from every database, one record per session. */
async function legacy(home: string, dbIds: Set<string>, prices: PriceBook, seen: Set<string>): Promise<SessionRecord[]> {
	const root = path.join(home, "storage", "message");
	const out: SessionRecord[] = [];
	const dirs = await fs.readdir(root).catch(() => [] as string[]);
	for (const sid of dirs.sort()) {
		const names = (await fs.readdir(path.join(root, sid)).catch(() => [] as string[])).filter((n) => n.endsWith(".json") && !dbIds.has(n.slice(0, -5)));
		const msgs: Message[] = [];
		let cwd = "";
		for (const n of names) {
			let d: any;
			try {
				d = JSON.parse(await fs.readFile(path.join(root, sid, n), "utf8"));
			} catch {
				continue;
			}
			cwd ||= d?.path?.root ?? d?.path?.cwd ?? "";
			msgs.push({
				id: n.slice(0, -5),
				session: sid,
				role: d?.role,
				provider: d?.providerID ?? "",
				model: d?.modelID ?? "",
				input: num(d?.tokens?.input),
				output: num(d?.tokens?.output),
				reasoning: num(d?.tokens?.reasoning),
				cacheRead: num(d?.tokens?.cache?.read),
				cacheWrite: num(d?.tokens?.cache?.write),
				cost: num(d?.cost),
				ms: num(d?.time?.created),
				completed: num(d?.time?.completed),
				variant: d?.variant ?? "",
				error: d?.error?.name ?? "",
				agent: d?.agent ?? d?.mode ?? "",
				promptLen: 0,
				promptHead: "",
			});
		}
		if (!msgs.length) continue;
		const created = Math.min(...msgs.map((m) => m.ms || Infinity));
		const s: Session = { id: sid, parent: "", dir: cwd, title: "", created: Number.isFinite(created) ? created : 0, agent: "", mark: 0, rows: msgs.length };
		const rec = build(s, s, path.join(root, sid), msgs, [], [], prices, seen);
		rec.key = `${LEGACY}${sid}`;
		out.push(rec);
	}
	return out;
}

async function legacyStamp(home: string): Promise<string> {
	try {
		const root = path.join(home, "storage", "message");
		const [st, dirs] = await Promise.all([fs.stat(root), fs.readdir(root)]);
		return `${st.mtimeMs}:${dirs.length}`;
	} catch {
		return "none";
	}
}

async function databases(home: string): Promise<string[]> {
	const names = await fs.readdir(home).catch(() => [] as string[]);
	return names.filter((n) => /^opencode(-[A-Za-z0-9._-]+)?\.db$/.test(n)).sort().map((n) => path.join(home, n));
}

interface Db {
	path: string;
	tables: Tables;
	list: Session[];
	stale: Session[];
}

/** Re-reads only sessions whose row, messages or catalog prices changed. Deleted sessions stay in the ledger. */
export async function ingestOpencode(
	ledger: Ledger<OpencodeExtra> | undefined,
	prices: PriceBook,
	onProgress: (p: Progress) => void,
	signal?: AbortSignal,
	home = opencodeHome(),
): Promise<{ records: SessionRecord[]; extra: OpencodeExtra; changed: boolean }> {
	const old = ledger?.records ?? [];
	const cached = new Map(old.map((r) => [r.key, r]));
	const progress: Progress = { files: 0, parsed: 0, bytes: 0, totalBytes: 0 };
	const sizes = new Map<string, number>();
	for (const db of await databases(home)) sizes.set(db, (await fs.stat(db).catch(() => undefined))?.size ?? 0);
	progress.totalBytes = [...sizes.values()].reduce((a, b) => a + b, 0);
	onProgress(progress);

	const claimed = new Set<string>();
	const dbs: Db[] = [];
	for (const db of sizes.keys()) {
		const tables = await schema(db, signal);
		const list = (await sessions(db, tables, signal)).filter((s) => !claimed.has(s.id));
		for (const s of list) claimed.add(s.id);
		const stale = list.filter((s) => {
			const c = cached.get(`opencode:${s.id}`);
			return ledger?.stale || !c || c.mtimeMs !== s.mark || c.size !== s.rows || !ratesCurrent(prices, c.rates);
		});
		progress.files += list.length;
		dbs.push({ path: db, tables, list, stale });
	}

	const stamp = await legacyStamp(home);
	const legacyOld = old.filter((r) => r.key.startsWith(LEGACY));
	const legacyStale = stamp !== ledger?.extra?.legacyStamp || !!ledger?.stale || !legacyOld.every((r) => ratesCurrent(prices, r.rates));

	const rebuilt = new Set(dbs.flatMap((d) => d.stale.map((s) => `opencode:${s.id}`)));
	const seen = new Set<string>();
	for (const r of old) if (!rebuilt.has(r.key) && !(legacyStale && r.key.startsWith(LEGACY))) for (const k in r.dedup) seen.add(k);

	const records: SessionRecord[] = [];
	for (const db of dbs) {
		if (signal?.aborted) break;
		const staleIds = new Set(db.stale.map((s) => s.id));
		for (const s of db.list) if (!staleIds.has(s.id)) records.push(cached.get(`opencode:${s.id}`)!);
		if (db.stale.length) {
			const ids = db.stale.length > FULL_SCAN_ABOVE ? undefined : [...staleIds];
			const [msgs, toolRows, comps] = await Promise.all([messages(db.path, db.tables, ids, signal), tools(db.path, db.tables, ids, signal), compactions(db.path, db.tables, ids, signal)]);
			const byId = new Map(db.list.map((s) => [s.id, s]));
			const rootOf = (s: Session): Session => {
				let cur = s;
				for (let i = 0; i < 32 && cur.parent && byId.has(cur.parent); i++) cur = byId.get(cur.parent)!;
				return cur;
			};
			const msgBy = group(msgs, (m) => m.session);
			const toolBy = group(toolRows, (t) => t.session);
			const compBy = group(comps, (c) => c[0]);
			for (const s of [...db.stale].sort((a, b) => a.created - b.created)) {
				records.push(build(s, rootOf(s), db.path, msgBy.get(s.id) ?? [], toolBy.get(s.id) ?? [], (compBy.get(s.id) ?? []).map((c) => c[1]), prices, seen));
			}
		}
		progress.parsed += db.list.length;
		progress.bytes += sizes.get(db.path) ?? 0;
		onProgress(progress);
	}

	let legacyRecords = legacyOld;
	if (legacyStale && !signal?.aborted) {
		const dbIds = new Set<string>();
		for (const db of dbs) {
			const q = [db.tables.has("message") && "SELECT id FROM message", db.tables.has("session_message") && "SELECT id FROM session_message"].filter(Boolean);
			if (q.length) for (const [id] of await sql(db.path, q.join(" UNION "), signal)) dbIds.add(id);
		}
		legacyRecords = await legacy(home, dbIds, prices, seen);
	}

	const live = new Set([...records, ...legacyRecords].map((r) => r.key));
	const retained = old.filter((r) => !live.has(r.key) && !r.key.startsWith(LEGACY));
	const all = [...records, ...legacyRecords, ...retained];
	const changed = rebuilt.size > 0 || legacyStale || all.length !== old.length;
	return { records: all, extra: { legacyStamp: stamp }, changed };
}
