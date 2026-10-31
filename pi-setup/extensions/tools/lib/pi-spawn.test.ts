/**
 * piSpawn argv tests — what the child process is ACTUALLY launched with.
 *
 * pi 0.84's #7327 took out every sub-agent while every unit test stayed green,
 * because nothing looked at the flags we actually pass. AGENTS.md's update
 * workflow says it outright: an import-level audit cannot see a change in how
 * pi reads our arguments.
 *
 * so these tests run the real piSpawn against a stub `pi` that records its argv.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { getEventListeners } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { ALL_EXTENSIONS_ENV, CHILD_EXTENSIONS, forceReleaseMs, newSessionId, piSpawn, readAgentPrompt, startChild, unresumableReason, type UsageStats } from "./pi-spawn";

let dir: string;
let stub: string;
let argvOut: string;

const ARGV_ENV = "PI_SPAWN_TEST_ARGV_OUT";

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-spawn-test-"));
	stub = join(dir, "pi-stub.sh");
	argvOut = join(dir, "argv.txt");
	writeFileSync(
		stub,
		[
			"#!/bin/sh",
			"{",
			'  for a in "$@"; do echo "ARG:$a"; done',
			'  echo "ENV:PI_BASH_READ_ONLY=${PI_BASH_READ_ONLY:-}"',
			'  echo "ENV:PI_SUBAGENT_TOOLS=${PI_SUBAGENT_TOOLS:-}"',
			`} > "$${ARGV_ENV}"`,
			"exit 0",
			"",
		].join("\n"),
		{ mode: 0o755 },
	);
	chmodSync(stub, 0o755);
	process.env.PI_BIN = stub;
	process.env[ARGV_ENV] = argvOut;
});

afterAll(() => {
	delete process.env.PI_BIN;
	delete process.env[ARGV_ENV];
	rmSync(dir, { recursive: true, force: true });
});

interface Launch {
	args: string[];
	env: Record<string, string>;
	/** value that follows `flag`, or undefined when the flag is absent. */
	valueOf(flag: string): string | undefined;
}

async function launch(config: Record<string, unknown>): Promise<Launch> {
	writeFileSync(argvOut, "");
	await piSpawn({
		cwd: dir,
		task: "noop",
		...(config as any),
	});
	const lines = readFileSync(argvOut, "utf-8").split("\n").filter(Boolean);
	const args = lines.filter((l) => l.startsWith("ARG:")).map((l) => l.slice(4));
	const env: Record<string, string> = {};
	for (const line of lines.filter((l) => l.startsWith("ENV:"))) {
		const [key, ...rest] = line.slice(4).split("=");
		env[key] = rest.join("=");
	}
	return {
		args,
		env,
		valueOf(flag: string) {
			const index = args.indexOf(flag);
			return index === -1 ? undefined : args[index + 1];
		},
	};
}

describe("--model", () => {
	test("is passed verbatim, including ids whose model part has a slash", async () => {
		for (const model of ["xai/grok-4.6", "openrouter/deepseek/deepseek-v4.1-flash"]) {
			const run = await launch({ model });
			expect(run.valueOf("--model")).toBe(model);
		}
	});

	test("is absent when no model is given, so the child runs on pi's default", async () => {
		const run = await launch({});
		expect(run.args).not.toContain("--model");
	});
});

describe("child extensions", () => {
	const deployed = CHILD_EXTENSIONS.slice(0, 2).every((p) => existsSync(p));

	test.if(deployed)("a child loads only the extensions it uses", async () => {
		for (const config of [{}, { followUp: "report" }]) {
			const run = await launch(config);
			expect(run.args).toContain("--no-extensions");
			const loaded = run.args.filter((_, i) => run.args[i - 1] === "-e");
			expect(loaded).toEqual(CHILD_EXTENSIONS.filter((p) => existsSync(p)));
			expect(loaded.some((p) => p.endsWith("/extensions/tools"))).toBe(true);
			expect(loaded.some((p) => p.endsWith("/system-prompt.js"))).toBe(true);
		}
	});

	test.if(deployed)("builtin codemode loads only for a child whose tools include it", async () => {
		const loadedBy = async (extensionTools: string[]) => {
			const run = await launch({ extensionTools });
			return run.args.filter((_, i) => run.args[i - 1] === "-e");
		};
		expect(await loadedBy(["read", "codemode"])).toContain("builtin:codemode");
		expect(await loadedBy(["read"])).not.toContain("builtin:codemode");
	});

	test(`${ALL_EXTENSIONS_ENV}=1 gives a child every extension again`, async () => {
		process.env[ALL_EXTENSIONS_ENV] = "1";
		try {
			const run = await launch({});
			expect(run.args).not.toContain("--no-extensions");
			expect(run.args).not.toContain("-e");
		} finally {
			delete process.env[ALL_EXTENSIONS_ENV];
		}
	});
});

describe("thinkingLevel", () => {
	test("is passed as its own flag", async () => {
		const run = await launch({ model: "xai/grok-4.6", thinkingLevel: "high" });
		expect(run.valueOf("--thinking")).toBe("high");
	});

	test("is absent when not asked for, so the child keeps its own default", async () => {
		const run = await launch({ model: "xai/grok-4.6" });
		expect(run.args).not.toContain("--thinking");
	});
});

describe("the result reports what the child actually ran", () => {
	async function run(lines: string[], config: Record<string, unknown>) {
		const prev = process.env.PI_BIN;
		process.env.PI_BIN = writeStub(`reporting-${lines.length}.sh`, lines.map((l) => `echo '${l}'`));
		try {
			return await piSpawn({ cwd: dir, task: "noop", ...(config as any) });
		} finally {
			process.env.PI_BIN = prev;
		}
	}

	test("provider/model and the effective thinking level come from the child's message", async () => {
		const answered = JSON.stringify({
			type: "message_end",
			message: { role: "assistant", content: [], provider: "deepseek", model: "deepseek-flash", thinkingLevel: "max", stopReason: "stop" },
		});
		const result = await run([answered], { model: "deepseek/deepseek-flash", thinkingLevel: "xhigh" });
		expect(result.model).toBe("deepseek/deepseek-flash");
		expect(result.thinkingLevel).toBe("max");
	});

	test("before the child answers, the request is what is reported", async () => {
		const result = await run([], { model: "xai/grok-4.6", thinkingLevel: "high" });
		expect(result.model).toBe("xai/grok-4.6");
		expect(result.thinkingLevel).toBe("high");
	});
});

describe("readOnlyBash", () => {
	test("sets the env var the child's bash tool reads", async () => {
		const run = await launch({
			model: "xai/grok-4.6",
			readOnlyBash: true,
			builtinTools: ["read", "bash"],
		});
		expect(run.env.PI_BASH_READ_ONLY).toBe("1");
	});

	test("is absent by default — every other sub-agent keeps a normal bash", async () => {
		const run = await launch({ model: "xai/grok-4.6", builtinTools: ["read", "bash"] });
		expect(run.env.PI_BASH_READ_ONLY).toBe("");
	});
});

describe("tool allowlist still reaches the child both ways", () => {
	test("--tools and PI_SUBAGENT_TOOLS are fed by the same list", async () => {
		const run = await launch({
			model: "xai/grok-4.6",
			builtinTools: ["read", "grep"],
			extensionTools: ["read", "web_search", "glob"],
		});
		// glob -> find aliasing and dedupe happen once, at this seam
		expect(run.valueOf("--tools")).toBe("read,grep,web_search,find");
		expect(run.env.PI_SUBAGENT_TOOLS).toBe("read,grep,web_search,find");
	});
});

/*
 * STALL WATCHDOG
 *
 * a sub-agent is headless: there is no Esc, so a frozen child is
 * indistinguishable from a busy one until someone walks back to the laptop.
 * measured: a delegate sat wedged for 2h22m overnight while the parent waited
 * on `proc`.
 *
 * these run the real piSpawn against stub children that either go silent or
 * keep printing. the stubs matter more than usual here — the property under
 * test is "does the parent notice silence", which no unit-level assertion on
 * constants can reach.
 */

const SETTLED = '{"type":"agent_settled","aborted":false}';

/** write an executable stub child and return its path. */
function writeStub(name: string, body: string[]): string {
	const file = join(dir, name);
	writeFileSync(file, ["#!/bin/sh", ...body, ""].join("\n"), { mode: 0o755 });
	chmodSync(file, 0o755);
	return file;
}

/** run piSpawn against `bin` with a given stall window, restoring env after. */
async function withChild(
	bin: string,
	stallSec: string,
	config: Record<string, unknown> = {},
): Promise<{ exitCode: number; stopReason?: string; errorMessage?: string; ms: number; usage: UsageStats }> {
	const prevBin = process.env.PI_BIN;
	const prevStall = process.env.PI_SPAWN_STALL_SEC;
	process.env.PI_BIN = bin;
	process.env.PI_SPAWN_STALL_SEC = stallSec;
	const started = Date.now();
	try {
		const r = await piSpawn({ cwd: dir, task: "noop", ...(config as any) });
		return { exitCode: r.exitCode, stopReason: r.stopReason, errorMessage: r.errorMessage, ms: Date.now() - started, usage: r.usage };
	} finally {
		if (prevBin === undefined) delete process.env.PI_BIN; else process.env.PI_BIN = prevBin;
		if (prevStall === undefined) delete process.env.PI_SPAWN_STALL_SEC; else process.env.PI_SPAWN_STALL_SEC = prevStall;
	}
}

describe("the grace after a kill or a settle", () => {
	test("is 10 s unless PI_SPAWN_RELEASE_MS names a positive number", () => {
		const prev = process.env.PI_SPAWN_RELEASE_MS;
		try {
			for (const value of [undefined, "", "abc", "0", "-5"]) {
				if (value === undefined) delete process.env.PI_SPAWN_RELEASE_MS;
				else process.env.PI_SPAWN_RELEASE_MS = value;
				expect(forceReleaseMs()).toBe(10_000);
			}
			process.env.PI_SPAWN_RELEASE_MS = "750";
			expect(forceReleaseMs()).toBe(750);
		} finally {
			if (prev === undefined) delete process.env.PI_SPAWN_RELEASE_MS;
			else process.env.PI_SPAWN_RELEASE_MS = prev;
		}
	});
});

describe("stall watchdog", () => {
	// 1 s proves the same timer as production's 10 s
	const prevRelease = process.env.PI_SPAWN_RELEASE_MS;
	beforeAll(() => {
		process.env.PI_SPAWN_RELEASE_MS = "1000";
	});
	afterAll(() => {
		if (prevRelease === undefined) delete process.env.PI_SPAWN_RELEASE_MS;
		else process.env.PI_SPAWN_RELEASE_MS = prevRelease;
	});

	test("kills a child that produces no output at all", async () => {
		const bin = writeStub("silent.sh", ["sleep 60"]);
		const run = await withChild(bin, "1");
		expect(run.stopReason).toBe("stalled");
		expect(run.exitCode).toBe(1);
		expect(run.ms).toBeLessThan(15000);
	}, 30000);

	test("force-release: a killed child holding stdout still returns on the grace timer", async () => {
		// this stub's `sleep` inherits stdout, so killing the shell does NOT close
		// the pipe and `proc.on("close")` never fires — the exact reason killing is
		// not the same as being released. without FORCE_RELEASE_MS this returned at
		// 60s (the sleep's own length) despite the watchdog firing correctly at 1s.
		const bin = writeStub("silent-pipe.sh", ["sleep 60"]);
		const run = await withChild(bin, "1");
		// stall window 1s + 1s grace, and emphatically NOT the 60s the child wanted
		expect(run.ms).toBeGreaterThanOrEqual(2_000);
		// tight: the grace is its own timer, so it does not round up to a watchdog tick
		expect(run.ms).toBeLessThan(4_000);
		expect(run.stopReason).toBe("stalled");
	}, 40000);

	test("a child that settled is released on the grace timer even when a grandchild holds stdout", async () => {
		// stall is 60s so a missing release would show as a >60s run
		const bin = writeStub("rpc-done.sh", ["sleep 60 &", `echo '${SETTLED}'`, `echo '${SETTLED}'`, "wait"]);
		const run = await withChild(bin, "60", { followUp: "second turn" });
		expect(run.ms).toBeLessThan(4_000);
		expect(run.stopReason).not.toBe("stalled");
	}, 60000);

	test("the release backstop works even with the stall watchdog disabled", async () => {
		const bin = writeStub("rpc-nostall.sh", ["sleep 60 &", `echo '${SETTLED}'`, `echo '${SETTLED}'`, "wait"]);
		const run = await withChild(bin, "0", { followUp: "second turn" });
		expect(run.ms).toBeGreaterThanOrEqual(1_000);
		expect(run.ms).toBeLessThan(4_000);
	}, 40000);

	test("a stalled child that saved its conversation can be continued; an ephemeral one is relaunched", async () => {
		const bin = writeStub("silent2.sh", ["sleep 60"]);
		const saved = await withChild(bin, "1", { session: { id: "chad-stalled", dir: join(dir, "stall-sessions") } });
		expect(saved.errorMessage).toMatch(/no output for/);
		expect(saved.errorMessage).toMatch(/continue it by continueId/);
		const ephemeral = await withChild(bin, "1");
		expect(ephemeral.errorMessage).toMatch(/Launch a fresh one/);
	}, 60000);

	test("does NOT kill a child that keeps emitting events", async () => {
		// the events piSpawn ignores (tool_execution_update, message_update) are
		// exactly the ones that prove liveness, which is why the watchdog watches
		// raw bytes rather than parsed events.
		const bin = writeStub("chatty.sh", [
			'for i in 1 2 3 4 5 6 7 8; do echo \'{"type":"tool_execution_update"}\'; sleep 0.4; done',
		]);
		const run = await withChild(bin, "1");
		expect(run.stopReason).toBeUndefined();
		expect(run.exitCode).toBe(0);
	}, 30000);

	test("stderr-only output also counts as liveness", async () => {
		const bin = writeStub("chatty-err.sh", [
			"for i in 1 2 3 4 5 6; do echo noise >&2; sleep 0.4; done",
		]);
		const run = await withChild(bin, "1");
		expect(run.stopReason).toBeUndefined();
		expect(run.exitCode).toBe(0);
	}, 30000);

	const PING = '{"type":"entry_appended","entry":{"type":"custom","customType":"cache-ping","data":{"usage":{"input":2,"output":1,"cacheRead":14651,"cacheWrite":0,"cost":{"total":0.25}}},"id":"p1","parentId":null}}';

	test("keep-alive reads are not liveness: a child that only reads its cache still stalls out", async () => {
		const bin = writeStub("pinging.sh", [`for i in 1 2 3 4 5 6 7 8 9 10; do echo '${PING}'; sleep 0.4; done`]);
		const run = await withChild(bin, "1");
		expect(run.stopReason).toBe("stalled");
	}, 30000);

	test("a child's keep-alive reads count toward its usage, not its turns", async () => {
		const bin = writeStub("pinged.sh", [`echo '${PING}'`, `echo '${PING}'`, `echo '${SETTLED}'`]);
		const run = await withChild(bin, "60");
		expect(run.usage).toMatchObject({ turns: 0, cacheRead: 29302, input: 4, output: 2, cost: 0.5 });
	}, 30000);

	test("a child that finishes quickly is untouched and leaks no timer", async () => {
		// if the interval were not cleared in `finally`, this test file would hang
		// rather than exit.
		const bin = writeStub("quick.sh", ["echo hi", "exit 0"]);
		const run = await withChild(bin, "1");
		expect(run.exitCode).toBe(0);
		expect(run.stopReason).toBeUndefined();
		expect(run.ms).toBeLessThan(5000);
	}, 30000);

	test("PI_SPAWN_STALL_SEC=0 disables it", async () => {
		const bin = writeStub("silent3.sh", ["sleep 2", "echo done"]);
		const run = await withChild(bin, "0");
		expect(run.stopReason).toBeUndefined();
		expect(run.exitCode).toBe(0);
	}, 30000);

	test("a spawn failure resolves without the watchdog surviving it", async () => {
		// proc.on("error") is the other resolve path; the timer is cleared in
		// `finally`, which covers both.
		const run = await withChild(join(dir, "does-not-exist"), "1");
		expect(run.exitCode).toBe(1);
		expect(run.stopReason).toBeUndefined();
		expect(run.ms).toBeLessThan(5000);
	}, 30000);

	test("default window is 15 minutes when the env var is absent", async () => {
		const prev = process.env.PI_SPAWN_STALL_SEC;
		delete process.env.PI_SPAWN_STALL_SEC;
		const prevBin = process.env.PI_BIN;
		process.env.PI_BIN = writeStub("quick2.sh", ["echo hi", "exit 0"]);
		try {
			// a 2s child must not trip a 15m window
			const r = await piSpawn({ cwd: dir, task: "noop" });
			expect(r.stopReason).toBeUndefined();
		} finally {
			if (prev !== undefined) process.env.PI_SPAWN_STALL_SEC = prev;
			if (prevBin !== undefined) process.env.PI_BIN = prevBin;
		}
	}, 30000);
});

describe("persisted session ids", () => {
	test("a new id is named after the spawning tool", () => {
		for (const agent of ["chad", "review_code"]) expect(newSessionId(agent)).toMatch(new RegExp(`^${agent}-[0-9a-f-]{36}$`));
	});

	test("the id and its directory are passed through untouched", async () => {
		const run = await launch({ session: { id: "delegate-legacy-1", dir: join(dir, "sessions") } });
		expect(run.valueOf("--session-id")).toBe("delegate-legacy-1");
		expect(run.valueOf("--session-dir")).toBe(join(dir, "sessions"));
	});

	test("no session config stays ephemeral", async () => {
		const run = await launch({});
		expect(run.args).toContain("--no-session");
		expect(run.args).not.toContain("--session-id");
	});
});

describe("unresumableReason across agents", () => {
	let sessions: string;

	function saveSession(id: string, timestamp: string): void {
		writeFileSync(
			join(sessions, `${timestamp.replace(/[:.]/g, "-")}_${id}.jsonl`),
			JSON.stringify({ type: "session", id, timestamp, cwd: dir }) + "\n",
		);
	}

	beforeAll(() => {
		sessions = join(dir, "resume-sessions");
		mkdirSync(sessions);
		saveSession("delegate-aaa", "2026-01-01T00:00:00.000Z");
		saveSession("chad-bbb", "2026-11-01T00:00:00.000Z");
		saveSession("delegate-ccc", "2026-11-01T00:00:00.000Z");
	});

	test("a session resumes from the agent that made it", () => {
		expect(unresumableReason("delegate-aaa", dir, "delegate", sessions)).toBeUndefined();
		expect(unresumableReason("chad-bbb", dir, "chad", sessions)).toBeUndefined();
	});

	test("a chad id is refused by delegate, naming the right tool", () => {
		const reason = unresumableReason("chad-bbb", dir, "delegate", sessions);
		expect(reason).toContain("belongs to a chad, not a delegate");
	});

	test("a delegate- id from before agent-named ids still resumes from chad", () => {
		expect(unresumableReason("delegate-aaa", dir, "chad", sessions)).toBeUndefined();
	});

	test("a delegate- id made since agent-named ids is refused by chad", () => {
		expect(unresumableReason("delegate-ccc", dir, "chad", sessions)).toContain("belongs to a delegate, not a chad");
	});

	test("a session resumes from a symlinked path to the folder it started in", () => {
		const link = join(dir, "linked-cwd");
		symlinkSync(dir, link);
		expect(unresumableReason("delegate-aaa", link, "delegate", sessions)).toBeUndefined();
	});

	test("an id with no known agent prefix is judged only by the saved sessions", () => {
		expect(unresumableReason("probe-1", dir, "chad", sessions)).toMatch(/unknown continueId/);
	});
});

describe("readAgentPrompt", () => {
	test("strips frontmatter when present and trims a plain file the same way", () => {
		const home = join(dir, "home");
		mkdirSync(join(home, ".pi", "agent", "agents"), { recursive: true });
		writeFileSync(join(home, ".pi", "agent", "agents", "with.md"), "---\nname: x\n---\n\nbody text\n");
		writeFileSync(join(home, ".pi", "agent", "agents", "without.md"), "body text\nsecond line\n");
		const script =
			`import { readAgentPrompt } from ${JSON.stringify(join(import.meta.dir, "pi-spawn.ts"))};` +
			`console.log(JSON.stringify(["with.md", "without.md", "missing.md"].map(readAgentPrompt)));`;
		const out = Bun.spawnSync([process.execPath, "-e", script], { env: { ...process.env, HOME: home } });
		expect(JSON.parse(out.stdout.toString())).toEqual(["body text", "body text\nsecond line", ""]);
	});
});

describe("abort signal", () => {
	test("its listener is removed once the child has finished", async () => {
		const controller = new AbortController();
		const bin = writeStub("abort-quick.sh", ["echo hi", "exit 0"]);
		await withChild(bin, "0", { signal: controller.signal });
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
	});
});

describe("the RPC conversation with the child", () => {
	let logDir: string;
	let fake: string;
	const commands = (id: string) =>
		readFileSync(join(logDir, `${id}.jsonl`), "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).slice(1);

	beforeAll(() => {
		logDir = join(dir, "fake-log");
		fake = writeStub("fake-pi.sh", [`exec "${process.execPath}" "${join(import.meta.dir, "fake-pi.ts")}" "$@"`]);
		process.env.FAKE_PI_LOG = logDir;
	});

	afterAll(() => {
		delete process.env.FAKE_PI_LOG;
	});

	async function withFake<T>(fn: () => Promise<T>): Promise<T> {
		const prev = process.env.PI_BIN;
		process.env.PI_BIN = fake;
		try {
			return await fn();
		} finally {
			process.env.PI_BIN = prev;
		}
	}

	const session = (id: string) => ({ id, dir: join(dir, "rpc-sessions") });
	const model = "fake/fake-1";

	test("the task goes over stdin, never argv, and the child is closed once it settles", async () => {
		const result = await withFake(() => piSpawn({ cwd: dir, model, task: "look around", session: session("rpc-task") }));
		expect(result.exitCode).toBe(0);
		expect(commands("rpc-task")).toEqual([{ type: "prompt", id: "prompt-1", message: "Task: look around" }]);
		const argv = JSON.parse(readFileSync(join(logDir, "rpc-task.jsonl"), "utf-8").split("\n")[0]).argv as string[];
		expect(argv.slice(0, 2)).toEqual(["--mode", "rpc"]);
		expect(argv.some((a) => a.includes("look around"))).toBe(false);
		expect(result.messages.at(-1)?.role).toBe("assistant");
	}, 30000);

	test("a resume may run on the model its conversation was saved on, even one outside agent-models.json", async () => {
		const listed = { models: { sonnet: { id: "anthropic/claude-sonnet-5-5" } }, agents: {}, problems: [] };
		const resume = async (id: string, savedOn: string) => {
			const saved = session(id);
			mkdirSync(saved.dir, { recursive: true });
			const [provider, modelId] = savedOn.split("/");
			const manager = SessionManager.create(dir, saved.dir, { id });
			manager.appendModelChange(provider!, modelId!);
			manager.appendMessage({ role: "user", content: "earlier task", timestamp: Date.now() });
			return withFake(() => piSpawn({ cwd: dir, task: "continue", session: saved, agentModels: listed }));
		};
		const same = await resume("rpc-resume-same", model);
		expect(same.exitCode).toBe(0);
		expect(same.model).toBe(model);
		const moved = await resume("rpc-resume-moved", "fake/fake-2");
		expect(moved.exitCode).not.toBe(0);
		expect(moved.errorMessage).toContain("not one of the models");
	}, 30000);

	test("a followUp is sent only after the task's run settles, and not after an error", async () => {
		const ok = await withFake(() => piSpawn({ cwd: dir, model, task: "review", followUp: "write the report", session: session("rpc-follow") }));
		expect(commands("rpc-follow").map((c) => c.message)).toEqual(["Task: review", "write the report"]);
		expect((ok.messages.at(-1) as any).content[0].text).toBe("answer: write the report");

		const failed = await withFake(() => piSpawn({ cwd: dir, model, task: "FAIL", followUp: "write the report", session: session("rpc-follow-fail") }));
		expect(commands("rpc-follow-fail").map((c) => c.message)).toEqual(["Task: FAIL"]);
		expect(failed.stopReason).toBe("error");
	}, 30000);

	test("a steer reaches the running child and is part of its answer", async () => {
		const child = await withFake(async () => startChild({ cwd: dir, model, task: "SLEEP 1", session: session("rpc-steer") }));
		await Bun.sleep(300);
		expect(await child.steer("also check the tests")).toBeUndefined();
		const result = await child.done;
		expect((result.messages.at(-1) as any).content[0].text).toContain("steered: also check the tests");
		expect(commands("rpc-steer")[1]).toMatchObject({ type: "prompt", streamingBehavior: "steer", message: "also check the tests" });
		expect(await child.steer("too late")).toBe("it had already finished");
	}, 30000);

	test("stop aborts the run and reports the stop", async () => {
		const child = await withFake(async () => startChild({ cwd: dir, model, task: "SLEEP 30", session: session("rpc-stop") }));
		await Bun.sleep(300);
		const started = Date.now();
		child.stop();
		const result = await child.done;
		expect(Date.now() - started).toBeLessThan(2_000);
		expect(result.stopReason).toBe("aborted");
		expect(commands("rpc-stop").map((c) => c.type)).toEqual(["prompt", "abort"]);
	}, 30000);

	test("a dialog request is answered as cancelled, since nobody can answer it", async () => {
		const request = JSON.stringify({ type: "extension_ui_request", id: "ui-1", method: "confirm", title: "Allow?" });
		const bin = writeStub("asks.sh", [`echo '${request}'`, "read prompt", "read answer", 'echo "$answer" > "$PI_SPAWN_TEST_ARGV_OUT"', `echo '${SETTLED}'`, "read eof"]);
		await withChild(bin, "0");
		expect(JSON.parse(readFileSync(argvOut, "utf-8"))).toEqual({ type: "extension_ui_response", id: "ui-1", cancelled: true });
	}, 30000);

	test("a refused prompt ends the run with the refusal", async () => {
		const refusal = JSON.stringify({ type: "response", id: "prompt-1", command: "prompt", success: false, error: "No API key for deepseek" });
		const bin = writeStub("refuses.sh", ["read prompt", `echo '${refusal}'`, "read eof"]);
		const run = await withChild(bin, "0");
		expect(run.stopReason).toBe("error");
		expect(run.errorMessage).toBe("No API key for deepseek");
		expect(run.ms).toBeLessThan(5_000);
	}, 30000);

	test("a child killed mid-tool leaves a conversation that is repaired before anyone continues it", async () => {
		const sessions = join(dir, "repair-sessions");
		const manager = SessionManager.create(dir, sessions, { id: "chad-repair" });
		manager.appendMessage({ role: "user", content: [{ type: "text", text: "go" }], timestamp: Date.now() } as any);
		manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: {} }], stopReason: "toolUse", timestamp: Date.now() } as any);
		const bin = writeStub("ignores-abort.sh", ["exec sleep 60"]);
		const prev = process.env.PI_BIN;
		process.env.PI_BIN = bin;
		try {
			const child = startChild({ cwd: dir, task: "noop", session: { id: "chad-repair", dir: sessions } });
			child.stop();
			await child.done;
		} finally {
			process.env.PI_BIN = prev;
		}
		const last = SessionManager.open(manager.getSessionFile()!).buildSessionContext().messages.at(-1) as any;
		expect(last).toMatchObject({ role: "toolResult", toolCallId: "c1", isError: true });
	}, 30000);
});
