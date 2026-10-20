import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const FILE_LOCK_DIR_ENV = "PI_FILE_LOCK_DIR";
export const HOLDER_ENV = "PI_SUBAGENT_ID";

const WAIT_MS = 10_000;
const STALE_MS = 60_000;
const UNREADABLE_MS = 5_000;
const BREAK_STALE_MS = 2_000;
const FIRST_BACKOFF_MS = 5;
const MAX_BACKOFF_MS = 100;

interface Holder {
	pid: number;
	token: string;
	at: number;
	agent: string;
}

interface LockOptions {
	signal?: AbortSignal;
	waitMs?: number;
	staleMs?: number;
}

const lockDir = () => process.env[FILE_LOCK_DIR_ENV] || path.join(os.homedir(), ".pi", "agent", "locks");

export const lockFileFor = (realPath: string) =>
	path.join(lockDir(), `${crypto.createHash("sha256").update(realPath).digest("hex").slice(0, 32)}.lock`);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function readHolder(file: string): Holder | "unreadable" | undefined {
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		return "unreadable";
	}
	try {
		const parsed = JSON.parse(text) as Holder;
		return Number.isInteger(parsed.pid) && typeof parsed.token === "string" ? parsed : "unreadable";
	} catch {
		return "unreadable";
	}
}

function ageOf(file: string): number {
	try {
		return Date.now() - fs.statSync(file).mtimeMs;
	} catch {
		return 0;
	}
}

function isStale(file: string, holder: Holder | "unreadable", staleMs: number): boolean {
	if (holder === "unreadable") return ageOf(file) > UNREADABLE_MS;
	return !pidAlive(holder.pid) || Date.now() - holder.at > staleMs;
}

/** Two waiters that both judged the lock stale must not both unlink it: the second would delete the first one's new lock. */
function breakStale(file: string, staleMs: number): void {
	const guard = `${file}.break`;
	let fd: number;
	try {
		fd = fs.openSync(guard, "wx");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST" && ageOf(guard) > BREAK_STALE_MS) unlinkQuietly(guard);
		return;
	}
	try {
		const holder = readHolder(file);
		if (holder && isStale(file, holder, staleMs)) unlinkQuietly(file);
	} finally {
		fs.closeSync(fd);
		unlinkQuietly(guard);
	}
}

function unlinkQuietly(file: string): void {
	try {
		fs.unlinkSync(file);
	} catch {}
}

function holderLabel(holder: Holder | "unreadable"): string {
	if (holder === "unreadable") return "another process";
	const seconds = Math.max(0, Math.round((Date.now() - holder.at) / 1000));
	return `${holder.agent} (pid ${holder.pid}, holding it for ${seconds}s)`;
}

function tryCreate(file: string, mine: Holder): boolean {
	let fd: number;
	try {
		fd = fs.openSync(file, "wx");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	}
	try {
		fs.writeSync(fd, JSON.stringify(mine));
	} catch (error) {
		fs.closeSync(fd);
		unlinkQuietly(file);
		throw error;
	}
	fs.closeSync(fd);
	return true;
}

/**
 * Exclusive across processes on `realPath` (already resolved) while `fn` runs.
 * Held for one read-modify-write only; waits up to 10 s, then throws naming the holder.
 */
export async function withProcessLock<T>(realPath: string, fn: () => Promise<T>, options: LockOptions = {}): Promise<T> {
	const file = lockFileFor(realPath);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const mine: Holder = { pid: process.pid, token: crypto.randomUUID(), at: Date.now(), agent: process.env[HOLDER_ENV] || "the main agent" };
	const deadline = Date.now() + (options.waitMs ?? WAIT_MS);
	const staleMs = options.staleMs ?? STALE_MS;
	let backoff = FIRST_BACKOFF_MS;
	for (;;) {
		if (options.signal?.aborted) throw new Error("aborted while waiting for the file lock");
		if (tryCreate(file, mine)) break;
		const holder = readHolder(file);
		if (holder && isStale(file, holder, staleMs)) breakStale(file, staleMs);
		else if (Date.now() >= deadline) {
			throw new Error(
				`${realPath} is being changed by ${holder ? holderLabel(holder) : "another process"}; waited ${Math.round((options.waitMs ?? WAIT_MS) / 1000)}s for it to finish. ` +
					"Nothing was changed. Retry in a moment, or leave this file to its owner.",
			);
		}
		await sleep(backoff + Math.random() * backoff);
		backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
	}
	try {
		return await fn();
	} finally {
		const current = readHolder(file);
		if (current && current !== "unreadable" && current.token === mine.token) unlinkQuietly(file);
	}
}
