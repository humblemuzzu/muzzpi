import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export interface Commit {
	hash: string;
	ms: number;
	root: string;
	added: number;
	deleted: number;
	subject: string;
	/** From the `Session-Id:` trailer our bash tool adds to every commit pi makes. */
	sessionId?: string;
}

export interface GitData {
	commits: Commit[];
	/** cwd → repository root, for every session cwd that is inside a repo. */
	roots: Map<string, string>;
}

interface RepoCache {
	key: string;
	commits: Commit[];
}

const TIMEOUT_MS = 15_000;
const CONCURRENCY = 8;

function git(cwd: string, args: string[]): Promise<string | undefined> {
	return new Promise((resolve) => {
		execFile("git", ["-C", cwd, ...args], { timeout: TIMEOUT_MS, maxBuffer: 64 << 20 }, (err, stdout) => {
			resolve(err ? undefined : stdout);
		});
	});
}

async function mapLimit<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const i = next++;
			out[i] = await fn(items[i]);
		}
	};
	await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
	return out;
}

const RS = "\x1e";
const US = "\x1f";
const FORMAT = `${RS}%H${US}%at${US}%ae${US}%s${US}%(trailers:key=Session-Id,valueonly,separator=%x2C)`;

function readLog(root: string, sinceSec: number, email: string | undefined): Promise<Commit[]> {
	const emails = new Set(email?.trim() ? [email.trim().toLowerCase()] : []);
	return git(root, ["log", "--all", "--no-merges", `--since=@${sinceSec}`, `--format=${FORMAT}`, "--shortstat"]).then((log) => (log ? parseLog(root, log, emails) : []));
}

function byHash(lists: Commit[][]): Commit[] {
	const seen = new Map<string, Commit>();
	for (const list of lists) for (const c of list) if (!seen.has(c.hash)) seen.set(c.hash, c);
	return [...seen.values()].sort((a, b) => a.ms - b.ms);
}

export function parseLog(root: string, stdout: string, emails: Set<string>): Commit[] {
	const commits: Commit[] = [];
	for (const block of stdout.split(RS)) {
		if (!block.trim()) continue;
		const [head, ...rest] = block.split("\n");
		const [hash, at, email, subject, trailer] = head.split(US);
		const sessionId = trailer?.trim().split(",")[0] || undefined;
		if (!sessionId && emails.size && !emails.has(email?.toLowerCase())) continue;
		const stat = rest.join(" ");
		commits.push({
			hash,
			ms: Number(at) * 1000,
			root,
			added: Number(stat.match(/(\d+) insertion/)?.[1] ?? 0),
			deleted: Number(stat.match(/(\d+) deletion/)?.[1] ?? 0),
			subject: subject ?? "",
			sessionId,
		});
	}
	return commits;
}

async function readRepoCache(file: string): Promise<Record<string, RepoCache>> {
	try {
		return JSON.parse(await fs.readFile(file, "utf8"));
	} catch {
		return {};
	}
}

/**
 * Your commits (configured user.email, or carrying a pi Session-Id) in every
 * repo a session ran in, since that repo's first session. Read-only; a repo
 * is re-logged only when its refs or user.email change.
 */
export async function loadGit(firstSeen: Map<string, number>, cacheDir: string): Promise<GitData> {
	const cwds = [...firstSeen.keys()].filter((c) => c && existsSync(c));
	const tops = await mapLimit(cwds, (c) => git(c, ["rev-parse", "--show-toplevel"]));
	const roots = new Map<string, string>();
	const since = new Map<string, number>();
	cwds.forEach((cwd, i) => {
		const root = tops[i]?.trim();
		if (!root) return;
		roots.set(cwd, root);
		since.set(root, Math.min(since.get(root) ?? Infinity, firstSeen.get(cwd)!));
	});

	const cacheFile = path.join(cacheDir, "git-v1.json");
	const cache = await readRepoCache(cacheFile);
	const fresh: Record<string, RepoCache> = {};

	await mapLimit([...since], async ([root, ms]) => {
		const sinceSec = Math.floor(ms / 1000);
		const [refs, email] = await Promise.all([
			git(root, ["for-each-ref", "--format=%(objectname)"]),
			git(root, ["config", "user.email"]),
		]);
		const key = `${sinceSec}|${email?.trim()}|${refs?.length}|${hash(refs ?? "")}`;
		const hit = cache[root];
		if (hit?.key === key) {
			fresh[root] = hit;
			return;
		}
		fresh[root] = { key, commits: await readLog(root, sinceSec, email) };
	});

	await fs.mkdir(cacheDir, { recursive: true, mode: 0o700 });
	const tmp = `${cacheFile}.${process.pid}.tmp`;
	await fs.writeFile(tmp, JSON.stringify(fresh), { mode: 0o600 });
	await fs.rename(tmp, cacheFile);

	return { commits: byHash(Object.values(fresh).map((r) => r.commits)), roots };
}

/** Commits since `sinceMs` in the repos holding `cwds`, by the same author rule as `loadGit`, without touching its cache. */
export async function commitsSince(cwds: string[], sinceMs: number): Promise<Commit[]> {
	const tops = await mapLimit(cwds.filter((c) => c && existsSync(c)), (c) => git(c, ["rev-parse", "--show-toplevel"]));
	const roots = [...new Set(tops.map((t) => t?.trim()).filter((t): t is string => !!t))];
	return byHash(await mapLimit(roots, async (root) => readLog(root, Math.floor(sinceMs / 1000), await git(root, ["config", "user.email"]))));
}

function hash(s: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
	return (h >>> 0).toString(36);
}
