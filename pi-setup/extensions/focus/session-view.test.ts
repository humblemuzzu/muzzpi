import { describe, expect, test } from "bun:test";
import { GOAL_CONTINUATION_PREFIX, YSK_PROMPT_PREFIX } from "../tools/lib/injected-prompts";
import { answerOf, buildSessionView, matches, searchWords, SessionIndex, type SessionView } from "./session-view";
import { session } from "./test-helpers";

describe("turns", () => {
	test("each prompt owns the replies and tool results up to the next prompt", () => {
		const s = session();
		s.prompt("fix the cache");
		s.call("t1");
		s.result("t1");
		s.reply("fixed it");
		s.prompt("now the tests");
		s.reply("all green");
		const { turns, active } = s.view();
		expect(turns.map((turn) => [turn.number, turn.prompt, turn.steps.length, turn.toolCalls])).toEqual([
			[1, "fix the cache", 3, 1],
			[2, "now the tests", 1, 0],
		]);
		expect(answerOf(turns[0]!)).toEqual({ state: "done", text: "fixed it" });
		expect(active).toBe(turns[1]);
	});

	test("the steps are pi's own entry objects, not copies", () => {
		const s = session();
		s.prompt("hi");
		s.reply("hello");
		const entries = s.manager.getEntries();
		expect(s.view().turns[0]!.steps[0]).toBe(entries[1]!);
	});

	test("how the last reply ended decides the answer", () => {
		const s = session();
		s.prompt("a");
		s.reply("partial", "length");
		s.prompt("b");
		s.reply("", "error", { errorMessage: "rate limited" });
		s.prompt("c");
		s.call("t1");
		s.prompt("d");
		const states = s.view().turns.map((turn) => answerOf(turn));
		expect(states).toEqual([
			{ state: "cut", text: "partial" },
			{ state: "failed", text: "", error: "rate limited" },
			{ state: "interrupted", text: "" },
			{ state: "none", text: "" },
		]);
	});
});

describe("/tree branches", () => {
	test("prompts on an abandoned branch stay listed, marked off the current path", () => {
		const s = session();
		s.prompt("first");
		const firstReply = s.reply("one");
		s.prompt("abandoned idea");
		s.reply("tried it");
		s.manager.branch(firstReply);
		s.prompt("better idea");
		s.reply("did it");
		const { turns, active } = s.view();
		expect(turns.map((turn) => [turn.prompt, turn.onPath])).toEqual([
			["first", true],
			["abandoned idea", false],
			["better idea", true],
		]);
		expect(active?.prompt).toBe("better idea");
		expect(answerOf(turns[1]!).text).toBe("tried it");
	});

	test("a turn follows the current branch where it forked mid-work", () => {
		const s = session();
		s.prompt("task");
		const call = s.call("t1");
		s.result("t1", "old result");
		s.reply("old answer");
		s.manager.branch(call);
		s.result("t1", "new result");
		s.reply("new answer");
		expect(answerOf(s.view().turns[0]!).text).toBe("new answer");
	});
});

describe("compaction", () => {
	test("prompts summarised away are numbered by the compaction that took them; the rest are live", () => {
		const s = session();
		s.prompt("one");
		s.reply("1");
		const second = s.prompt("two");
		s.reply("2");
		s.manager.appendCompaction("## Goal\nfirst summary", second, 400_000);
		s.prompt("three");
		const fourth = s.prompt("four");
		s.manager.appendCompaction("## Goal\nsecond summary", fourth, 500_000);
		s.prompt("five");
		const view = s.view();
		expect(view.turns.map((turn) => [turn.prompt, turn.compacted])).toEqual([
			["one", 1],
			["two", 2],
			["three", 2],
			["four", 0],
			["five", 0],
		]);
		expect(view.compactions).toBe(2);
		expect(view.marks.filter((mark) => mark.kind === "summary").map((mark) => mark.title)).toEqual([
			"Summary 1: 400k tokens before",
			"Summary 2: 500k tokens before",
		]);
	});
});

describe("prompts sent by goal and /ysk", () => {
	function withInjected() {
		const s = session();
		s.prompt("build the feature");
		s.reply("started");
		s.prompt(`${GOAL_CONTINUATION_PREFIX}g1">\nContinue working toward the active thread goal.`);
		s.reply("kept going");
		s.prompt(`${YSK_PROMPT_PREFIX}\n\n> you missed a test`);
		s.reply("added the test");
		return s;
	}

	test("folded, they stay inside your prompt, whose answer is the last reply", () => {
		const { turns } = withInjected().view(true);
		expect(turns).toHaveLength(1);
		expect(turns[0]!.steps.length).toBe(5);
		expect(answerOf(turns[0]!).text).toBe("added the test");
	});

	test("unfolded, each is a turn of its own, labelled by who sent it", () => {
		const { turns } = withInjected().view(false);
		expect(turns.map((turn) => turn.kind)).toEqual(["human", "goal", "ysk"]);
	});

	test("one with no prompt of yours before it is still a turn", () => {
		const s = session();
		s.prompt(`${GOAL_CONTINUATION_PREFIX}g1">`);
		s.reply("resumed");
		expect(s.view(true).turns.map((turn) => turn.kind)).toEqual(["goal"]);
	});
});

describe("marks", () => {
	test("labels, goals and branch summaries are marks that know their turn", () => {
		const s = session();
		const first = s.prompt("plan the rewrite");
		s.reply("the plan");
		s.manager.appendLabelChange(first, "★");
		s.manager.appendCustomEntry("pi-codex-goal", { version: 1, kind: "set", goal: { objective: "ship the rewrite\nwith tests" }, at: 1 });
		s.manager.branchWithSummary(first, "## Goal\nwhat the old branch did");
		const view = s.view();
		const turn = view.turns[0]!;
		expect(turn.label).toBe("★");
		expect(view.marks.map((mark) => [mark.kind, mark.title, mark.turn === turn])).toEqual([
			["label", "plan the rewrite", true],
			["goal", "Goal: ship the rewrite", true],
			["branch", "Branch summary: ## Goal", true],
		]);
	});

	test("a label removed later is no mark", () => {
		const s = session();
		const first = s.prompt("x");
		s.manager.appendLabelChange(first, "★");
		s.manager.appendLabelChange(first, undefined);
		const view = s.view();
		expect(view.marks).toEqual([]);
		expect(view.turns[0]!.label).toBeUndefined();
	});
});

describe("search", () => {
	test("every word must appear in the prompt or the answer, in any case", () => {
		const s = session();
		s.prompt("Fix the cache drain");
		s.reply("It was the TTL");
		const [turn] = s.view().turns;
		expect(matches(turn!, searchWords("cache ttl"))).toBe(true);
		expect(matches(turn!, searchWords("cache ttl"), true)).toBe(false);
		expect(matches(turn!, searchWords("cache redis"))).toBe(false);
		expect(matches(turn!, [])).toBe(true);
	});
});

describe("SessionIndex: extending in place equals rebuilding", () => {
	const project = (view: SessionView) => ({
		turns: view.turns.map((t) => [t.id, t.number, t.kind, t.onPath, t.compacted, t.steps.map((s) => s.id), t.lastId, t.toolCalls, t.label ?? null]),
		marks: view.marks.map((m) => [m.kind, m.id, m.title, m.turn?.id ?? null]),
		compactions: view.compactions,
		active: view.active?.id ?? null,
	});

	test("after every append of random sessions with compactions, labels, goals and /tree moves", () => {
		let seed = 7;
		const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
		const pick = (ids: string[]) => ids[Math.floor(rand() * ids.length)]!;
		for (let run = 0; run < 30; run++) {
			for (const fold of [true, false]) {
				const s = session();
				const index = new SessionIndex();
				const ids: string[] = [];
				for (let step = 0; step < 60; step++) {
					const r = rand();
					if (r > 0.93 && ids.length > 0) {
						s.manager.branch(pick(ids));
						continue;
					}
					const id =
						r < 0.15 ? s.prompt(`p${step}`)
						: r < 0.2 ? s.prompt(`${GOAL_CONTINUATION_PREFIX}g">`)
						: r < 0.45 ? s.call(`c${step}`)
						: r < 0.6 ? s.result(`c${step}`)
						: r < 0.75 ? s.reply(`a${step}`)
						: r < 0.8 && ids.length > 0 ? s.manager.appendCompaction("## Goal\nx", pick(ids), 1000)
						: r < 0.86 && ids.length > 0 ? s.manager.appendLabelChange(pick(ids), rand() < 0.7 ? "★" : undefined)
						: r < 0.9 ? s.manager.appendCustomEntry("pi-codex-goal", { kind: "set", goal: { objective: `o${step}` } })
						: s.manager.appendCustomEntry("cache-ping", {});
					ids.push(id);
					const entries = s.manager.getEntries();
					const leaf = s.manager.getLeafId();
					expect(project(index.update(entries, leaf, fold))).toEqual(project(buildSessionView(entries, leaf, fold)));
				}
			}
		}
	});

	test("a plain append extends the same turns in place; a /tree move or a setting change rebuilds", () => {
		const s = session();
		const index = new SessionIndex();
		const first = s.prompt("one");
		const before = index.update(s.manager.getEntries(), s.manager.getLeafId(), true);
		s.reply("answer");
		const after = index.update(s.manager.getEntries(), s.manager.getLeafId(), true);
		expect(after.turns).toBe(before.turns);
		expect(index.update(s.manager.getEntries(), s.manager.getLeafId(), true)).toBe(after);
		s.manager.branch(first);
		s.reply("other answer");
		expect(index.update(s.manager.getEntries(), s.manager.getLeafId(), true).turns).not.toBe(before.turns);
		const current = index.update(s.manager.getEntries(), s.manager.getLeafId(), true);
		expect(index.update(s.manager.getEntries(), s.manager.getLeafId(), false).turns).not.toBe(current.turns);
	});

	test("an append to a large session costs a small fraction of a rebuild", () => {
		const s = session();
		for (let turn = 0; turn < 2_000; turn++) {
			s.prompt(`prompt ${turn}`);
			s.call(`c${turn}`);
			s.result(`c${turn}`);
			s.reply(`answer ${turn}`);
		}
		const index = new SessionIndex();
		index.update(s.manager.getEntries(), s.manager.getLeafId(), true);
		let extending = 0;
		let rebuilding = 0;
		for (let round = 0; round < 50; round++) {
			s.reply(`more ${round}`);
			const entries = s.manager.getEntries();
			const leaf = s.manager.getLeafId();
			let started = performance.now();
			index.update(entries, leaf, true);
			extending += performance.now() - started;
			started = performance.now();
			buildSessionView(entries, leaf, true);
			rebuilding += performance.now() - started;
		}
		expect(extending * 10).toBeLessThan(rebuilding);
	});
});

test("a session bigger than any on this machine indexes in well under a frame budget per open", () => {
	const s = session();
	for (let turn = 0; turn < 2_000; turn++) {
		s.prompt(`prompt ${turn}`);
		s.call(`c${turn}`);
		s.result(`c${turn}`);
		s.call(`d${turn}`);
		s.result(`d${turn}`);
		s.reply(`answer ${turn}`);
	}
	const entries = s.manager.getEntries();
	const leaf = s.manager.getLeafId();
	const started = performance.now();
	const view = buildSessionView(entries, leaf, true);
	const took = performance.now() - started;
	expect(view.turns).toHaveLength(2_000);
	expect(took).toBeLessThan(250);
});
