import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FILE_LOCK_DIR_ENV, lockFileFor, withProcessLock } from "./file-lock";

const ROOT = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "file-lock-")));
const LOCKS = path.join(ROOT, "locks");
process.env[FILE_LOCK_DIR_ENV] = LOCKS;
const WORKER = path.join(import.meta.dir, "file-lock.test-worker.ts");

afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));
beforeEach(() => fs.rmSync(LOCKS, { recursive: true, force: true }));

const leftovers = () => (fs.existsSync(LOCKS) ? fs.readdirSync(LOCKS) : []);

function plant(target: string, holder: { pid: number; at: number; agent?: string }): string {
	const file = lockFileFor(target);
	fs.mkdirSync(LOCKS, { recursive: true });
	fs.writeFileSync(file, JSON.stringify({ token: "planted", agent: "chad-1", ...holder }));
	return file;
}

function deadPid(): number {
	const child = spawnSync(process.execPath, ["-e", "0"]);
	return child.pid!;
}

describe("withProcessLock", () => {
	test("returns the result and leaves no lock file", async () => {
		expect(await withProcessLock("/x/a", async () => 7)).toBe(7);
		expect(leftovers()).toEqual([]);
	});

	test("releases when the work throws", async () => {
		await expect(withProcessLock("/x/a", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
		expect(leftovers()).toEqual([]);
		expect(await withProcessLock("/x/a", async () => "again")).toBe("again");
	});

	test("recovers a lock whose process is dead", async () => {
		plant("/x/a", { pid: deadPid(), at: Date.now() });
		expect(await withProcessLock("/x/a", async () => "ok", { waitMs: 500 })).toBe("ok");
		expect(leftovers()).toEqual([]);
	});

	test("recovers a lock held longer than the bound by a live pid", async () => {
		plant("/x/a", { pid: process.pid, at: Date.now() - 5_000 });
		expect(await withProcessLock("/x/a", async () => "ok", { waitMs: 500, staleMs: 1_000 })).toBe("ok");
	});

	test("recovers an unreadable lock only once it is old", async () => {
		const file = lockFileFor("/x/a");
		fs.mkdirSync(LOCKS, { recursive: true });
		fs.writeFileSync(file, "");
		await expect(withProcessLock("/x/a", async () => 1, { waitMs: 150 })).rejects.toThrow("another process");
		const old = new Date(Date.now() - 60_000);
		fs.utimesSync(file, old, old);
		expect(await withProcessLock("/x/a", async () => 2, { waitMs: 500 })).toBe(2);
	});

	test("a live holder is waited for, then named in the failure", async () => {
		const file = plant("/x/a", { pid: process.ppid, at: Date.now(), agent: "delegate-9" });
		const started = Date.now();
		const error = await withProcessLock("/x/a", async () => 1, { waitMs: 300 }).catch((e: Error) => e);
		expect(Date.now() - started).toBeGreaterThanOrEqual(280);
		expect((error as Error).message).toContain("delegate-9");
		expect((error as Error).message).toContain(`pid ${process.ppid}`);
		expect((error as Error).message).toContain("Nothing was changed");
		expect(fs.existsSync(file)).toBe(true);
	});

	test("a lock freed during the wait is taken", async () => {
		const file = plant("/x/a", { pid: process.ppid, at: Date.now() });
		setTimeout(() => fs.unlinkSync(file), 120);
		expect(await withProcessLock("/x/a", async () => "got it", { waitMs: 2_000 })).toBe("got it");
	});

	test("an aborted wait stops at once", async () => {
		plant("/x/a", { pid: process.ppid, at: Date.now() });
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 50);
		await expect(withProcessLock("/x/a", async () => 1, { signal: controller.signal })).rejects.toThrow("aborted");
	});

	test("never removes a lock someone else took over", async () => {
		const file = lockFileFor("/x/a");
		await withProcessLock("/x/a", async () => {
			fs.writeFileSync(file, JSON.stringify({ pid: process.ppid, token: "thief", at: Date.now(), agent: "x" }));
		});
		expect(fs.existsSync(file)).toBe(true);
	});

	test("concurrent breakers of one stale lock all get a turn, one at a time", async () => {
		plant("/x/a", { pid: deadPid(), at: Date.now() });
		let inside = 0;
		let overlap = false;
		await Promise.all(
			Array.from({ length: 6 }, () =>
				withProcessLock("/x/a", async () => {
					if (++inside > 1) overlap = true;
					await new Promise((resolve) => setTimeout(resolve, 5));
					inside--;
				}, { waitMs: 5_000 }),
			),
		);
		expect(overlap).toBe(false);
		expect(leftovers()).toEqual([]);
	});
});

function run(mode: string, file: string, name: string, count: number): Promise<number> {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [WORKER, mode, file, name, String(count)], {
			env: { ...process.env, [FILE_LOCK_DIR_ENV]: LOCKS, PI_SUBAGENT_ID: `worker-${name}`, PI_TRASH_DIR: path.join(ROOT, ".trash") },
			cwd: ROOT,
			stdio: "ignore",
		});
		child.on("close", (code) => resolve(code ?? 1));
	});
}

describe("two processes on one file", () => {
	test("a read-modify-write counter loses no update", async () => {
		const file = path.join(ROOT, "counter.txt");
		fs.writeFileSync(file, "0");
		const codes = await Promise.all([run("counter", file, "a", 60), run("counter", file, "b", 60), run("counter", file, "c", 60)]);
		expect(codes).toEqual([0, 0, 0]);
		expect(fs.readFileSync(file, "utf8")).toBe("180");
		expect(leftovers()).toEqual([]);
	}, 60_000);

	test("the real edit tool loses no edit", async () => {
		const file = path.join(ROOT, "edited.txt");
		fs.writeFileSync(file, "// END\n");
		const codes = await Promise.all([run("edit", file, "a", 40), run("edit", file, "b", 40)]);
		expect(codes).toEqual([0, 0]);
		const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
		expect(lines.length).toBe(81);
		for (const who of ["a", "b"]) for (let i = 0; i < 40; i++) expect(lines).toContain(`${who}-${i}`);
		expect(leftovers()).toEqual([]);
	}, 60_000);
});
