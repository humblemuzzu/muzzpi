import { describe, expect, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import { createAskTool, formatAnswers, prepareAskArguments } from "./ask";
import { chadAllowlist } from "./chad";
import { codeReviewAllowlist } from "./code-review";
import { delegateAllowlist } from "./delegate";
import { finderAllowlist } from "./finder";
import { librarianAllowlist } from "./librarian";
import { oracleAllowlist } from "./oracle";

const tool = createAskTool() as any;
const plain = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s };
const store = { question: "Which store?", header: "Store", options: [{ label: "Redis" }, { label: "SQLite" }] };

const valid = (args: unknown) => Value.Check(tool.parameters, prepareAskArguments(args));

describe("arguments: every shape a model sends is accepted", () => {
	test("the canonical shape passes through unchanged", () => {
		expect(prepareAskArguments({ questions: [store] })).toEqual({ questions: [store] });
	});

	test("questions sent as a JSON string, the exact shape that broke pi-ask", () => {
		const args = { questions: JSON.stringify([store]) };
		expect(prepareAskArguments(args)).toEqual({ questions: [store] });
		expect(valid(args)).toBe(true);
	});

	test("one question object, or one bare string, instead of a list", () => {
		expect(prepareAskArguments({ questions: store })).toEqual({ questions: [store] });
		expect(prepareAskArguments({ questions: "What should the function be called?" })).toEqual({
			questions: [{ question: "What should the function be called?" }],
		});
	});

	test("a single question spread over the top level", () => {
		const args = { question: "Which store?", options: ["Redis", "SQLite"] };
		expect(prepareAskArguments(args)).toEqual({ questions: [{ question: "Which store?", options: [{ label: "Redis" }, { label: "SQLite" }] }] });
		expect(valid(args)).toBe(true);
	});

	test("options as plain strings or a JSON string, and multiple as a string", () => {
		const args = { questions: [{ question: "Q", options: '["a","b"]', multiple: "true" }] };
		expect(prepareAskArguments(args)).toEqual({ questions: [{ question: "Q", options: [{ label: "a" }, { label: "b" }], multiple: true }] });
		expect(valid(args)).toBe(true);
	});

	test("a question that only looks like JSON stays text", () => {
		expect(prepareAskArguments({ questions: ["[urgent] ship today?"] })).toEqual({ questions: [{ question: "[urgent] ship today?" }] });
	});

	test("the schema still refuses what cannot be shown", () => {
		expect(valid({ questions: [] })).toBe(false);
		expect(valid({ questions: Array.from({ length: 7 }, () => store) })).toBe(false);
		expect(valid({ questions: [{ ...store, options: Array.from({ length: 10 }, (_, i) => ({ label: `o${i}` })) }] })).toBe(false);
		expect(valid({ questions: [{ question: "" }] })).toBe(false);
	});
});

describe("what the model reads back", () => {
	test("picks, several picks, own words and skipped questions", () => {
		const questions = [store, { question: "Which tones?" }, { question: "Name?" }, { question: "Deadline?" }];
		const text = formatAnswers(questions, [{ picked: ["Redis"] }, { picked: ["Formal", "Short"], typed: "no jargon" }, { picked: [], typed: "fetchUser" }, undefined]);
		expect(text).toBe(
			[
				"The user answered:",
				"- Which store? → Redis",
				'- Which tones? → Formal, Short; in their own words: "no jargon"',
				'- Name? → in their own words: "fetchUser"',
				"- Deadline? → (no answer)",
			].join("\n"),
		);
	});
});

function tuiCtx(keys: string[]) {
	const shown: any[] = [];
	return {
		shown,
		ctx: {
			hasUI: true,
			mode: "tui",
			ui: {
				setWorkingVisible: (visible: boolean) => shown.push(visible),
				custom: (factory: any) =>
					new Promise((resolve) => {
						const component = factory({ requestRender() {} }, plain, {}, resolve);
						component.focused = true;
						for (const key of keys) component.handleInput(key);
					}),
			},
		},
	};
}

const run = (ctx: unknown, questions: unknown[] = [store], signal?: AbortSignal) =>
	tool.execute("call-1", { questions }, signal, undefined, ctx);

describe("execute", () => {
	test("answered: the answers come back, the turn continues, and the spinner is restored", async () => {
		const { ctx, shown } = tuiCtx(["2"]);
		const result = await run(ctx);
		expect(result.content[0].text).toBe("The user answered:\n- Which store? → SQLite");
		expect(result.terminate).toBeUndefined();
		expect(result.details).toMatchObject({ outcome: "answered", answers: [{ picked: ["SQLite"] }] });
		expect(shown).toEqual([false, true]);
	});

	test("dismissed: the agent is told to stop and the turn ends", async () => {
		const result = await run(tuiCtx(["\x1b"]).ctx);
		expect(result.content[0].text).toContain("Stop and wait");
		expect(result.terminate).toBe(true);
		expect(result.details.outcome).toBe("dismissed");
	});

	test("no UI: no dialog, and the agent is told to carry on with stated assumptions", async () => {
		const result = await run({ hasUI: false });
		expect(result.content[0].text).toContain("make reasonable assumptions, state them");
		expect(result.terminate).toBeUndefined();
	});

	test("RPC clients get pi's own select and input dialogs", async () => {
		const calls: string[] = [];
		const ui = {
			select: async (title: string, items: string[]) => (calls.push(`select ${title} [${items.join("|")}]`), "Type your own answer"),
			input: async (title: string) => (calls.push(`input ${title}`), "  use valkey  "),
		};
		const result = await run({ hasUI: true, mode: "rpc", ui }, [store, { question: "Open?" }]);
		expect(calls).toEqual(["select Store: Which store? [Redis|SQLite|Type your own answer]", "input Store: Which store?", "input Open?"]);
		expect(result.content[0].text).toContain('Which store? → in their own words: "use valkey"');
		expect(result.content[0].text).toContain('Open? → in their own words: "use valkey"');
	});

	test("cancelling an RPC dialog counts as dismissing", async () => {
		const ui = { select: async () => undefined, input: async () => "x" };
		expect((await run({ hasUI: true, mode: "rpc", ui })).terminate).toBe(true);
	});
});

describe("transcript rows", () => {
	test("the call and the result reuse their component, so each caches per width", async () => {
		const call = tool.renderCall({ questions: [store, { question: "Tone?", header: "Tone" }] }, plain, {});
		expect(call.render(100).join("")).toContain("Ask 2 questions: Store, Tone");
		expect(tool.renderCall({ questions: [store] }, plain, { lastComponent: call })).toBe(call);
		const first = call.render(100);
		expect(call.render(100)).toBe(first);

		const answered = await run(tuiCtx(["1"]).ctx);
		const row = tool.renderResult(answered, {}, plain, {});
		expect(row.render(100).join("\n")).toContain("→ Redis");
		expect(tool.renderResult(answered, {}, plain, { lastComponent: row })).toBe(row);
		expect(row.render(100)).toBe(row.render(100));
	});
});

describe("contract", () => {
	test("no sub-agent can call ask: a child has nobody to ask", () => {
		for (const allowlist of [chadAllowlist, codeReviewAllowlist, delegateAllowlist, finderAllowlist, librarianAllowlist, oracleAllowlist]) {
			expect(allowlist()).not.toContain("ask");
		}
	});

	test("the description carries a literal Example call that validates", () => {
		const example = tool.description.slice(tool.description.indexOf("Example: ask(") + "Example: ask(".length, -1);
		const args = Function(`return (${example})`)();
		expect(valid(args)).toBe(true);
	});
});
