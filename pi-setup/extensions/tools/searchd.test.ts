import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import * as net from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const SD_DIR = realpathSync.native(mkdtempSync(join(tmpdir(), "sd-")));
process.env.SEARCHD_DIR = SD_DIR;
const BUILT = [
	join(import.meta.dir, "../../searchd/target/release/searchd"),
	join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "muzzpi/searchd-target/release/searchd"),
].find((p) => existsSync(p));
const BIN = process.env.SEARCHD_BIN ?? BUILT ?? "";
process.env.SEARCHD_BIN = join(SD_DIR, "no-such-binary");

const { askSearchd, searchdSocket } = await import("./lib/searchd");
const SEARCHD_SOCKET = searchdSocket();
const { createGlobTool } = await import("./glob");
const { createGrepTool } = await import("./grep");

afterAll(() => rmSync(SD_DIR, { recursive: true, force: true }));

/** A stand-in daemon that answers every connection with `reply`. */
async function fakeDaemon(reply: (sock: net.Socket) => void): Promise<net.Server> {
	rmSync(SEARCHD_SOCKET, { force: true });
	const server = net.createServer(reply);
	await new Promise<void>((r) => server.listen(SEARCHD_SOCKET, r));
	return server;
}

describe("the client never breaks a tool", () => {
	test("no daemon: falls back at once", async () => {
		rmSync(SEARCHD_SOCKET, { force: true });
		const t = performance.now();
		const r = await askSearchd({ op: "find" });
		expect("fallback" in r).toBe(true);
		expect(performance.now() - t).toBeLessThan(50);
	});

	test("a daemon that never acknowledges: falls back after the ack timeout", async () => {
		const server = await fakeDaemon(() => {});
		const t = performance.now();
		const r = await askSearchd({ op: "find" });
		server.close();
		expect(r).toEqual({ fallback: "searchd did not answer" });
		expect(performance.now() - t).toBeLessThan(500);
	});

	test("a slow answer after the ack is waited for, not abandoned", async () => {
		const server = await fakeDaemon((s) => {
			s.write('{"type":"searchd_ack"}\n');
			setTimeout(() => s.end('"a.ts"\n{"type":"searchd_end","exit":0,"total":1,"head":1}\n'), 300);
		});
		const r = await askSearchd({ op: "find" });
		server.close();
		expect(r).toEqual({ lines: ['"a.ts"'], end: { type: "searchd_end", exit: 0, total: 1, head: 1 } } as any);
	});

	test("a character split across two packets arrives whole", async () => {
		const bytes = Buffer.from('{"type":"searchd_ack"}\n"naïve.ts"\n{"type":"searchd_end","exit":0}\n');
		const cut = bytes.indexOf(0xc3) + 1;
		const server = await fakeDaemon((s) => {
			s.write(bytes.subarray(0, cut));
			setTimeout(() => s.end(bytes.subarray(cut)), 30);
		});
		const r = await askSearchd({ op: "find" });
		server.close();
		expect(r).toEqual({ lines: ['"naïve.ts"'], end: { type: "searchd_end", exit: 0 } } as any);
	});

	test("a refusal mid-stream discards what came before it", async () => {
		const server = await fakeDaemon((s) => s.end('{"type":"searchd_ack"}\n"a.ts"\n{"type":"searchd_fallback","reason":"x"}\n'));
		const r = await askSearchd({ op: "find" });
		server.close();
		expect(r).toEqual({ fallback: "x" });
	});

	test("garbage and an early close fall back", async () => {
		let server = await fakeDaemon((s) => s.end('{"type":"searchd_ack"}\n{"type":"searchd_end",\n'));
		expect("fallback" in (await askSearchd({ op: "find" }))).toBe(true);
		server.close();
		server = await fakeDaemon((s) => s.end('{"type":"searchd_ack"}\n"a.ts"\n'));
		expect(await askSearchd({ op: "find" })).toEqual({ fallback: "searchd closed the connection" });
		server.close();
	});

	test("an abort ends the wait", async () => {
		const server = await fakeDaemon((s) => s.write('{"type":"searchd_ack"}\n'));
		const ac = new AbortController();
		setTimeout(() => ac.abort(), 50);
		const r = await askSearchd({ op: "find" }, ac.signal);
		server.close();
		expect(r).toEqual({ fallback: "aborted" });
	});
});

describe("find never shows a partial list as complete", () => {
	const PARTIAL = "some folders could not be read; the list may be incomplete";
	const findIn = async (cwd: string) => {
		const r: any = await createGlobTool().execute!("t", { filePattern: "**/*.ts" } as any, undefined, undefined, { cwd } as any);
		return r.content[0].text as string;
	};

	test("a daemon answer that exits 2 carries the notice", async () => {
		const answer = (code: number) => `{"type":"searchd_ack"}\n"a.ts"\n{"type":"searchd_end","exit":${code},"total":1,"head":1}\n`;
		let server = await fakeDaemon((s) => s.end(answer(2)));
		expect(await findIn(SD_DIR)).toContain(PARTIAL);
		server.close();
		server = await fakeDaemon((s) => s.end(answer(0)));
		expect(await findIn(SD_DIR)).not.toContain(PARTIAL);
		server.close();
	});

	test("an rg run that exits 2 over an unreadable folder carries the notice", async () => {
		const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "sd-locked-")));
		const locked = join(dir, "locked");
		mkdirSync(locked);
		writeFileSync(join(locked, "hidden.ts"), "x\n");
		writeFileSync(join(dir, "ok.ts"), "x\n");
		chmodSync(locked, 0o000);
		process.env.PI_SEARCHD = "0";
		try {
			const text = await findIn(dir);
			expect(text).toContain("ok.ts");
			expect(text).toContain(PARTIAL);
		} finally {
			chmodSync(locked, 0o755);
			rmSync(dir, { recursive: true, force: true });
			delete process.env.PI_SEARCHD;
		}
	});
});

describe.skipIf(!existsSync(BIN))("with a real searchd, the tools answer exactly as with rg", () => {
	const REPO = realpathSync.native(mkdtempSync(join(tmpdir(), "sd-repo-")));
	let daemon: ChildProcess;
	const write = (rel: string, body: string, ageSec = 0) => {
		mkdirSync(join(REPO, rel, ".."), { recursive: true });
		writeFileSync(join(REPO, rel), body);
		if (ageSec) utimesSync(join(REPO, rel), Date.now() / 1000 - ageSec, Date.now() / 1000 - ageSec);
	};

	beforeAll(async () => {
		mkdirSync(join(REPO, ".git"));
		write(".gitignore", "build/\n*.log\nnode_modules/\n");
		write("src/a.ts", "import { b } from './b';\nexport const needle = 1;\n", 30);
		write("src/b.ts", "export const b = 'needle';\n", 20);
		write("src/deep/c.md", "# needle\nplain\n", 10);
		write("build/out.ts", "needle in build\n");
		write("debug.log", "needle in log\n");
		write("node_modules/x/index.ts", "needle in deps\n");
		write(".hidden/h.txt", "needle hidden\n");
		const version = execFileSync(BIN, ["version"]).toString().trim();
		const rg = execFileSync("rg", ["--version"]).toString().split("\n")[0];
		writeFileSync(join(SD_DIR, "selftest.json"), JSON.stringify({ rg, searchd: version }));
		rmSync(SEARCHD_SOCKET, { force: true });
		daemon = spawn(BIN, ["serve", "--root", REPO], { env: { ...process.env, SEARCHD_DIR: SD_DIR }, stdio: ["ignore", "ignore", "pipe"] });
		let log = "";
		daemon.stderr!.on("data", (d) => (log += d));
		let last: any;
		for (let i = 0; i < 100; i++) {
			last = await askSearchd({ op: "find", dir: REPO, glob: "*" });
			if ("lines" in last) return;
			await new Promise((res) => setTimeout(res, 50));
		}
		throw new Error(`searchd did not become ready: ${JSON.stringify(last)} ${log}`);
	}, 15_000);

	afterAll(() => {
		daemon?.kill();
		rmSync(REPO, { recursive: true, force: true });
	});

	const run = async (tool: any, args: object, useDaemon: boolean) => {
		process.env.PI_SEARCHD = useDaemon ? "1" : "0";
		const r: any = await tool.execute!("t", args as any, undefined, undefined, { cwd: REPO } as any);
		delete process.env.PI_SEARCHD;
		return r.content[0].text as string;
	};

	test.each([
		[{ filePattern: "**/*.ts" }],
		[{ filePattern: "*" }],
		[{ filePattern: "*.log" }],
		[{ filePattern: "**/*", limit: 2 }],
		[{ filePattern: "**/*", limit: 2, offset: 1 }],
		[{ filePattern: "src/**" }],
		[{ filePattern: "*", path: "build" }],
	])("find %j", async (args) => {
		expect(await run(createGlobTool(), args, true)).toBe(await run(createGlobTool(), args, false));
	});

	const sorted = (s: string) => s.split("\n").sort().join("\n");
	test.each([
		[{ pattern: "needle" }],
		[{ pattern: "NEEDLE", caseSensitive: false }],
		[{ pattern: "needle", glob: "*.ts" }],
		[{ pattern: "needle", glob: "*" }],
		[{ pattern: "import|export", context: 0 }],
		[{ pattern: "needle", path: "src" }],
		[{ pattern: "nothing-matches-this" }],
	])("grep %j", async (args) => {
		expect(sorted(await run(createGrepTool(), args, true))).toBe(sorted(await run(createGrepTool(), args, false)));
	});

	test("the daemon really answered", async () => {
		const r = await askSearchd({ op: "grep", dir: REPO, pattern: "needle", context: 1, limit: 200 });
		expect("lines" in r).toBe(true);
	});
});
