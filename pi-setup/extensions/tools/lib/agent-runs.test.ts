import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { parseAgentModels } from "./agent-models";
import type { RunSnapshot } from "./agent-channel";
import type { AgentResultDetails } from "./agent-notice";
import { AgentRuns, MAX_RUNNING, type RunEntry, type RunHost } from "./agent-runs";
import { SUB_AGENT_TOOLS_ENV } from "./sub-agent-prompt";

let dir: string;
let sessions: string;
let logDir: string;
let prevBin: string | undefined;
let prevTools: string | undefined;

beforeAll(() => {
	prevTools = process.env[SUB_AGENT_TOOLS_ENV];
	delete process.env[SUB_AGENT_TOOLS_ENV];
	dir = mkdtempSync(join(tmpdir(), "agent-runs-"));
	sessions = join(dir, "sessions");
	logDir = join(dir, "log");
	const fake = join(dir, "pi.sh");
	writeFileSync(fake, `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, "fake-pi.ts")}" "$@"\n`);
	chmodSync(fake, 0o755);
	prevBin = process.env.PI_BIN;
	process.env.PI_BIN = fake;
	process.env.FAKE_PI_LOG = logDir;
});

afterAll(() => {
	if (prevTools !== undefined) process.env[SUB_AGENT_TOOLS_ENV] = prevTools;
	if (prevBin === undefined) delete process.env.PI_BIN;
	else process.env.PI_BIN = prevBin;
	delete process.env.FAKE_PI_LOG;
	rmSync(dir, { recursive: true, force: true });
});

const models = parseAgentModels({
	models: { fake: { id: "fake/fake-1" } },
	agents: { chad: { model: "fake" }, delegate: { model: "fake" } },
});

class FakeHost implements RunHost {
	notified: AgentResultDetails[] = [];
	texts: string[] = [];
	wakes: boolean[] = [];
	records: RunEntry[] = [];
	snapshots = 0;
	last: RunSnapshot[] = [];
	notify(content: string, details: AgentResultDetails, wake: boolean) {
		this.texts.push(content);
		this.notified.push(details);
		this.wakes.push(wake);
	}
	broadcast(runs: RunSnapshot[]) {
		this.snapshots++;
		this.last = runs;
	}
	record(entry: RunEntry) {
		this.records.push(entry);
	}
}

function setup(mode = "tui", host = new FakeHost()) {
	const runs = new AgentRuns(host, sessions);
	const ctx = { cwd: dir, mode };
	let calls = 0;
	const launch = (task: string, params: Record<string, unknown> = {}, agent: "chad" | "delegate" = "chad", options: { toolCallId?: string; signal?: AbortSignal } = {}) =>
		runs.launch(
			{ agent, label: task, working: "(working...)", models, params, spawn: { task } },
			options.toolCallId ?? `call-${++calls}`,
			ctx,
			options.signal,
		);
	return { host, runs, launch };
}

const idOf = (result: any): string => /continueId: ([\w-]+)/.exec(result.content.at(-1).text)![1]!;
const textOf = (result: any): string => result.content.at(-1).text;

async function until(check: () => boolean, ms = 8_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("timed out");
		await Bun.sleep(25);
	}
}

function argvOf(id: string, nth = 0): string[] {
	const starts = readFileSync(join(logDir, `${id}.jsonl`), "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.argv);
	return starts[nth].argv;
}

function saveHeader(id: string): void {
	mkdirSync(sessions, { recursive: true });
	writeFileSync(join(sessions, `2026-01-01T00-00-00-000Z_${id}.jsonl`), `${JSON.stringify({ type: "session", id, cwd: dir, timestamp: new Date().toISOString() })}\n`);
}

describe("a background run", () => {
	test("returns a stub at once, then one notification carries the answer", async () => {
		const { host, launch } = setup();
		const started = Date.now();
		const stub = await launch("SLEEP 1 find the bug");
		expect(Date.now() - started).toBeLessThan(500);
		expect(textOf(stub)).toContain("is running in the background");
		expect(stub.details).toMatchObject({ agent: "chad", background: true });
		await until(() => host.notified.length > 0);
		const [run] = host.notified[0]!.runs;
		expect(run).toMatchObject({ agent: "chad", status: "done", continueId: idOf(stub), model: "fake/fake-1" });
		expect(run!.usage.output).toBe(5);
		expect(host.texts[0]).toStartWith("[Automated agent event. This was not written by the user");
		expect(host.texts[0]).toContain("answer: Task: SLEEP 1 find the bug");
		expect(host.wakes).toEqual([true]);
		await Bun.sleep(1_800);
		expect(host.notified).toHaveLength(1);
		expect(host.records.map((r) => r.status)).toEqual(["done"]);
		expect(host.snapshots).toBeGreaterThan(0);
	}, 20000);

	test("runs that finish together arrive as one notification", async () => {
		const { host, launch } = setup();
		await launch("SLEEP 0.2 one");
		await launch("SLEEP 0.6 two");
		await until(() => host.notified.length > 0);
		await Bun.sleep(1_800);
		expect(host.notified).toHaveLength(1);
		expect(host.notified[0]!.runs.map((r) => r.label)).toEqual(["SLEEP 0.2 one", "SLEEP 0.6 two"]);
		expect(host.texts[0]).toContain("2 background sub-agents finished.");
	}, 20000);

	test("a result taken by wait is never notified again", async () => {
		const { host, runs, launch } = setup();
		const id = idOf(await launch("SLEEP 0.3 quick"));
		const waited = await runs.wait([id], 10);
		expect(waited.details.runs.map((r) => r.continueId)).toEqual([id]);
		expect(waited.text).toContain("answer: Task: SLEEP 0.3 quick");
		await Bun.sleep(2_000);
		expect(host.notified).toHaveLength(0);
		expect((await runs.wait([id], 1)).text).toContain("already delivered");
	}, 20000);

	test("a child learns its own id, by which the file lock names its holder", async () => {
		const { host, launch } = setup();
		const id = idOf(await launch("SLEEP 0.1 who am i"));
		await until(() => host.notified.length > 0);
		const first = readFileSync(join(logDir, `${id}.jsonl`), "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l))[0];
		expect(first.holder).toBe(id);
	}, 20000);

	test("a run reports what it is doing, how many tools it called and which files it wrote", async () => {
		const { host, runs, launch } = setup();
		const id = idOf(await launch("SLEEP 1 TOOL src/new.ts"));
		await Bun.sleep(400);
		expect(runs.list()).toContain(`${id} · chad · running 0s · write src/new.ts`);
		await until(() => host.notified.length > 0);
		expect(host.notified[0]!.runs[0]).toMatchObject({ toolCount: 1, files: ["src/new.ts"] });
		expect(host.texts[0]).toContain("files changed: src/new.ts");
	}, 20000);

	test("a run that changed a file while another run changed it too says so", async () => {
		const { host, launch } = setup();
		const first = idOf(await launch("SLEEP 0.8 TOOL shared.ts"));
		const second = idOf(await launch("SLEEP 0.8 TOOL shared.ts"));
		await until(() => host.notified.length > 0);
		const byId = new Map(host.notified.flatMap((n) => n.runs).map((r) => [r.continueId, r]));
		expect(byId.get(first)!.overlaps).toEqual([{ continueId: second, files: ["shared.ts"] }]);
		expect(byId.get(second)!.overlaps).toEqual([{ continueId: first, files: ["shared.ts"] }]);
		const lines = host.texts[0]!.split("\n").filter((line) => line.startsWith("also changed by"));
		expect(lines.sort()).toEqual([`also changed by ${first} while this ran: shared.ts`, `also changed by ${second} while this ran: shared.ts`].sort());
	}, 20000);

	test("runs that did not overlap in time, or changed different files, say nothing", async () => {
		const { host, runs, launch } = setup();
		const earlier = idOf(await launch("SLEEP 0.2 TOOL shared.ts"));
		await runs.wait([earlier], 10);
		const later = idOf(await launch("SLEEP 0.4 TOOL shared.ts"));
		const other = idOf(await launch("SLEEP 0.4 TOOL other.ts"));
		const waited = await runs.wait([later, other], 10);
		expect(waited.details.runs.map((r) => r.overlaps)).toEqual([[], []]);
		expect(waited.text).not.toContain("also changed by");
		expect(host.notified).toHaveLength(0);
	}, 20000);

	test("a failed run is reported as failed with the provider's error", async () => {
		const { host, launch } = setup();
		await launch("FAIL break");
		await until(() => host.notified.length > 0);
		expect(host.notified[0]!.runs[0]).toMatchObject({ status: "failed", errorMessage: "provider exploded" });
	}, 20000);

	test("wait returns at its timeout with what is still running", async () => {
		const { runs, launch } = setup();
		const id = idOf(await launch("SLEEP 30 slow"));
		const started = Date.now();
		const waited = await runs.wait([id], 1);
		expect(Date.now() - started).toBeLessThan(2_000);
		expect(waited.text).toBe(`${id}: still running`);
		await runs.stop([id]);
	}, 20000);
});

describe("control requests from the agents UI", () => {
	const snapshotOf = (host: FakeHost, id: string): RunSnapshot => host.last.findLast((run) => run.id === id) ?? ({} as RunSnapshot);

	test("stop shows stopping, ends the run as stopped and still reports it to the main agent", async () => {
		const { host, runs, launch } = setup();
		const id = idOf(await launch("SLEEP 30 slow"));
		await until(() => host.last.some((run) => run.status === "running"));
		await runs.control({ action: "stop", id });
		await until(() => snapshotOf(host, id).stopping || snapshotOf(host, id).status === "stopped");
		await until(() => host.notified.length > 0);
		expect(host.notified[0]!.runs[0]).toMatchObject({ continueId: id, status: "stopped", errorMessage: "The user stopped this agent from the agents panel before it finished." });
		expect(host.wakes).toEqual([true]);
		await until(() => snapshotOf(host, id).status === "stopped");
		expect(snapshotOf(host, id).stopping).toBe(false);
	}, 20000);

	test("stop on a finished run is refused on that run", async () => {
		const { host, runs, launch } = setup();
		const id = idOf(await launch("SLEEP 0.1 quick"));
		await runs.wait([id], 10);
		await runs.control({ action: "stop", id });
		await until(() => snapshotOf(host, id).control !== undefined);
		expect(snapshotOf(host, id).control).toMatchObject({ action: "stop", ok: false });
		expect(snapshotOf(host, id).control!.text).toContain("already finished");
	}, 20000);

	test("stopAll stops every live background run and nothing else", async () => {
		const { host, runs, launch } = setup();
		const a = idOf(await launch("SLEEP 30 one"));
		const b = idOf(await launch("SLEEP 30 two"));
		const done = idOf(await launch("SLEEP 0.1 quick"));
		await runs.wait([done], 10);
		await runs.control({ action: "stopAll" });
		await until(() => host.notified.flatMap((n) => n.runs).length >= 2);
		expect(host.notified.flatMap((n) => n.runs.map((r) => [r.continueId, r.status])).sort()).toEqual([[a, "stopped"], [b, "stopped"]].sort());
	}, 20000);

	test("steer on a running agent reaches it as a message from the user", async () => {
		const { host, runs, launch } = setup();
		const id = idOf(await launch("SLEEP 1.5 investigate"));
		await until(() => snapshotOf(host, id)?.status === "running");
		await Bun.sleep(300);
		await runs.control({ action: "steer", id, text: "look at the tests too" });
		await until(() => snapshotOf(host, id).control?.action === "steer");
		expect(snapshotOf(host, id).control).toMatchObject({ ok: true });
		await until(() => host.notified.length > 0);
		expect(host.texts[0]).toContain("steered: Message from the user while you work:\n\nlook at the tests too");
	}, 20000);

	test("steer on a finished run is refused and says to continue", async () => {
		const { host, runs, launch } = setup();
		const id = idOf(await launch("SLEEP 0.1 quick"));
		await runs.wait([id], 10);
		await runs.control({ action: "steer", id, text: "more" });
		await until(() => snapshotOf(host, id).control !== undefined);
		expect(snapshotOf(host, id).control).toMatchObject({ action: "steer", ok: false });
		expect(snapshotOf(host, id).control!.text).toContain("continue it instead");
	}, 20000);

	test("continue starts the same conversation again with the user's message and reports the new answer", async () => {
		const { host, runs, launch } = setup();
		const id = idOf(await launch("SLEEP 0.1 first"));
		await runs.wait([id], 10);
		saveHeader(id);
		await runs.control({ action: "continue", id, text: "now the second part" });
		await until(() => host.notified.length > 0);
		expect(host.notified[0]!.runs[0]).toMatchObject({ continueId: id, status: "done" });
		expect(host.texts[0]).toContain("answer: Task: now the second part");
		const continued = argvOf(id, 1);
		expect(continued[continued.indexOf("--session-id") + 1]).toBe(id);
	}, 20000);

	test("continue on a running agent is refused", async () => {
		const { host, runs, launch } = setup();
		const id = idOf(await launch("SLEEP 30 busy"));
		await runs.control({ action: "continue", id, text: "more" });
		await until(() => snapshotOf(host, id).control !== undefined);
		expect(snapshotOf(host, id).control).toMatchObject({ action: "continue", ok: false });
		expect(snapshotOf(host, id).control!.text).toContain("still running");
		await runs.stop([id]);
	}, 20000);

	test("continue on a run from an earlier session is refused", async () => {
		const { host, runs } = setup();
		runs.restore([{ type: "custom", customType: "agent-run", data: { agent: "chad", label: "old", continueId: "chad-old", status: "done", durationMs: 5000, startedAt: 0 } }]);
		await runs.control({ action: "continue", id: "chad-old", text: "more" });
		await until(() => host.last.find((run) => run.id === "chad-old")?.control !== undefined);
		expect(host.last.find((run) => run.id === "chad-old")!.control).toMatchObject({ ok: false });
	}, 20000);
});

describe("continueId", () => {
	test("on a running agent steers it; the answer still arrives once", async () => {
		const { host, launch } = setup();
		const id = idOf(await launch("SLEEP 1.5 investigate"));
		await Bun.sleep(400);
		const steered = await launch("also read the tests", { continueId: id });
		expect(textOf(steered)).toContain(`Sent to the running chad (continueId: ${id})`);
		await until(() => host.notified.length > 0);
		expect(host.texts[0]).toContain("steered: Message from the main agent while you work:\n\nalso read the tests");
		expect(host.notified[0]!.runs).toHaveLength(1);
	}, 20000);

	test("sent before the child has started its run waits for the start, then joins it", async () => {
		const { host, launch } = setup();
		const id = idOf(await launch("PREFLIGHT 0.5 SLEEP 0.5 investigate"));
		const steered = await launch("also read the tests", { continueId: id });
		expect(textOf(steered)).toContain("Sent to the running chad");
		await until(() => host.notified.length > 0);
		await Bun.sleep(1_800);
		expect(host.notified).toHaveLength(1);
		expect(host.texts[0]).toContain("answer: Task: PREFLIGHT 0.5 SLEEP 0.5 investigate | steered: ");
	}, 20000);

	test("of another agent's running child is refused", async () => {
		const { runs, launch } = setup();
		const id = idOf(await launch("SLEEP 30 investigate"));
		const refused = await launch("do it", { continueId: id }, "delegate");
		expect(refused.isError).toBe(true);
		expect(textOf(refused)).toContain("belongs to a running chad");
		await runs.stop([id]);
	}, 20000);

	test("of a finished agent continues it as a new run on the same conversation", async () => {
		const { host, runs, launch } = setup();
		const id = idOf(await launch("first question"));
		await runs.wait([id], 10);
		saveHeader(id);
		const again = await launch("second question", { continueId: id });
		expect(idOf(again)).toBe(id);
		await until(() => host.notified.length > 0);
		expect(host.notified[0]!.runs[0]!.status).toBe("done");
		expect(host.texts[0]).toContain("answer: Task: second question");
		const argv = argvOf(id, 1);
		expect(argv[argv.indexOf("--session-id") + 1]).toBe(id);
		expect(argv).not.toContain("--model");
	}, 20000);

	test("repairs a conversation its earlier process left mid-tool before continuing it", async () => {
		const { runs, launch } = setup();
		const manager = SessionManager.create(dir, sessions, { id: "chad-orphan" });
		manager.appendMessage({ role: "user", content: [{ type: "text", text: "go" }], timestamp: Date.now() } as any);
		manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "c9", name: "bash", arguments: {} }], stopReason: "toolUse", timestamp: Date.now() } as any);
		await launch("what happened?", { continueId: "chad-orphan" });
		const last = SessionManager.open(manager.getSessionFile()!).buildSessionContext().messages.at(-1) as any;
		expect(last).toMatchObject({ role: "toolResult", toolCallId: "c9", isError: true });
		await runs.wait(["chad-orphan"], 10);
	}, 20000);

	test("that no agent saved is refused", async () => {
		const { launch } = setup();
		const refused = await launch("x", { continueId: "chad-nope" });
		expect(textOf(refused)).toContain('unknown continueId "chad-nope"');
	});
});

describe("blocking runs", () => {
	test("print mode, a sub-agent, a codemode script and background:false all block", async () => {
		const blocked = async (result: any) => {
			expect(result.details.background).toBeUndefined();
			expect(textOf(result)).toContain("answer: Task: hi");
			expect(textOf(result)).toContain("continueId: chad-");
		};
		await blocked(await setup("print").launch("hi"));
		await blocked(await setup().launch("hi", { background: false }));
		await blocked(await setup().launch("hi", {}, "chad", { toolCallId: "call-1/2" }));
		const { runs, launch } = setup();
		const nested = launch("SLEEP 0.5 hi", {}, "chad", { toolCallId: "call-9/1" });
		await Bun.sleep(200);
		expect(runs.detachForeground()).toBe(false);
		expect(textOf(await nested)).toContain("answer: Task: SLEEP 0.5 hi");
		process.env[SUB_AGENT_TOOLS_ENV] = "read,finder";
		try {
			await blocked(await setup("rpc").launch("hi"));
		} finally {
			delete process.env[SUB_AGENT_TOOLS_ENV];
		}
	}, 30000);

	test("Esc stops a blocking run", async () => {
		const controller = new AbortController();
		const { launch } = setup();
		const pending = launch("SLEEP 30", { background: false }, "chad", { signal: controller.signal });
		await Bun.sleep(300);
		controller.abort();
		const result = await pending;
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("Stopped before the sub-agent finished");
	}, 20000);

	test("Ctrl+B moves a blocking run to the background", async () => {
		const { host, runs, launch } = setup();
		const pending = launch("SLEEP 1 long", { background: false });
		await Bun.sleep(300);
		expect(runs.detachForeground()).toBe(true);
		const stub = await pending;
		expect(stub.details.background).toBe(true);
		expect(textOf(stub)).toStartWith("The user moved this chad to the background with Ctrl+B.");
		await until(() => host.notified.length > 0);
		expect(host.notified[0]!.runs[0]!.status).toBe("done");
		expect(runs.detachForeground()).toBe(false);
	}, 20000);
});

test("pi still names a codemode script's tool calls <callerId>/<n>, which is how a nested run is told apart", () => {
	const pi = join(import.meta.dir, "..", "node_modules", "@mariozechner", "pi-coding-agent");
	const source = readFileSync(join(pi, "dist", "core", "nested-tool-calls.js"), "utf-8");
	expect(source).toContain("id: `${callerId}/${scope.nextId++}`");
});

describe("the queue", () => {
	test(`at most ${MAX_RUNNING} run at once; the rest start in order as slots free`, async () => {
		const { host, runs, launch } = setup();
		const ids: string[] = [];
		for (let i = 0; i < MAX_RUNNING; i++) ids.push(idOf(await launch(`SLEEP 1.2 n${i}`)));
		const queued = await launch("SLEEP 0.1 last");
		expect(textOf(queued)).toContain(`is queued behind ${MAX_RUNNING} running agents`);
		expect(runs.list()).toContain(`${idOf(queued)} · chad · queued`);
		expect(existsSync(join(logDir, `${idOf(queued)}.jsonl`))).toBe(false);
		await until(() => host.notified.flatMap((n) => n.runs).length === MAX_RUNNING + 1, 15_000);
		expect(host.notified.flatMap((n) => n.runs).at(-1)!.continueId).toBe(idOf(queued));
	}, 30000);
});

describe("agents stop and list", () => {
	test("stop ends a running agent, reports it, and it is not notified", async () => {
		const { host, runs, launch } = setup();
		const id = idOf(await launch("SLEEP 30 forever"));
		await Bun.sleep(300);
		expect(runs.list()).toMatch(new RegExp(`^${id} · chad · running \\d+s · SLEEP 30 forever$`));
		const stopped = await runs.stop([id]);
		expect(stopped.text).toContain("status: stopped");
		expect(stopped.details.runs.map((r) => [r.continueId, r.status])).toEqual([[id, "stopped"]]);
		await Bun.sleep(1_800);
		expect(host.notified).toHaveLength(0);
		expect((await runs.stop(["all"])).text).toBe("No agent is running.");
		expect((await runs.stop([])).text).toContain("Name the continueIds to stop");
	}, 20000);
});

describe("shutdown", () => {
	test("interrupts running agents, records them, reports them without waking and refuses new ones", async () => {
		const { host, runs, launch } = setup();
		const id = idOf(await launch("SLEEP 30 forever"));
		await Bun.sleep(300);
		const started = Date.now();
		await runs.shutdown();
		expect(Date.now() - started).toBeLessThan(3_000);
		expect(host.records.map((r) => [r.continueId, r.status])).toEqual([[id, "interrupted"]]);
		expect(host.notified.map((n) => n.runs.map((r) => r.status))).toEqual([["interrupted"]]);
		expect(host.wakes).toEqual([false]);
		await Bun.sleep(1_800);
		expect(host.notified).toHaveLength(1);
		expect(textOf(await launch("hi"))).toContain("session is closing");
	}, 20000);

	test("a result still in its batch window reaches the session instead of being lost", async () => {
		const { host, runs, launch } = setup();
		await launch("SLEEP 0.2 quick");
		await Bun.sleep(700);
		expect(host.notified).toHaveLength(0);
		await runs.shutdown();
		expect(host.notified.map((n) => n.runs.map((r) => r.status))).toEqual([["done"]]);
		expect(host.wakes).toEqual([false]);
	}, 20000);

	test("a reload hands its runs over: the interrupted one continues, the unreported one is reported", async () => {
		const before = setup();
		const longId = idOf(await before.launch("SLEEP 30 long job"));
		const quickId = idOf(await before.launch("SLEEP 0.2 quick job"));
		await Bun.sleep(700);
		await before.runs.shutdown(true);
		expect(before.host.notified).toHaveLength(0);

		const handoff = AgentRuns.takeReloadHandoff();
		expect(AgentRuns.takeReloadHandoff()).toBeUndefined();
		const after = setup();
		after.runs.adoptReload(handoff!);
		expect(after.host.notified.map((n) => n.runs.map((r) => [r.continueId, r.status]))).toEqual([[[longId, "interrupted"]]]);
		expect(after.host.wakes).toEqual([false]);
		expect(after.runs.list()).toContain(`${longId} · chad · running`);
		await until(() => after.host.notified.length > 1);
		expect(after.host.notified[1]!.runs.map((r) => [r.continueId, r.status])).toEqual([[quickId, "done"], [longId, "done"]]);
		expect(after.host.texts[1]).toContain("answer: Task: The main session reloaded and interrupted you.");
		expect(after.host.wakes[1]).toBe(true);
		const continued = argvOf(longId, 1);
		expect(continued[continued.indexOf("--session-id") + 1]).toBe(longId);
	}, 20000);

	test("a resumed session lists the runs its records name", () => {
		const { runs } = setup();
		runs.restore([
			{ type: "custom", customType: "agent-run", data: { agent: "oracle", label: "why", continueId: "oracle-1", status: "interrupted", durationMs: 5000, startedAt: 0 } },
			{ type: "custom", customType: "other", data: {} },
		]);
		expect(runs.list()).toBe("oracle-1 · oracle · interrupted 5s · why");
	});

	test("a restored run keeps the model, usage and tool count its record holds", async () => {
		const { host, runs } = setup();
		const usage = { input: 9, output: 4, cacheRead: 0, cacheWrite: 0, cost: 0.5, contextTokens: 0, turns: 2 };
		runs.restore([{ type: "custom", customType: "agent-run", data: { agent: "chad", label: "x", continueId: "chad-r", status: "done", durationMs: 1000, startedAt: 0, model: "fake/fake-1", usage, toolCount: 3 } }]);
		await until(() => host.last.length > 0);
		expect(host.last[0]).toMatchObject({ id: "chad-r", model: "fake/fake-1", usage, toolCount: 3 });
	});
});
