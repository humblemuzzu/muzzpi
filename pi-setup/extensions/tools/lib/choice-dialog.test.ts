import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { visibleWidth } from "@mariozechner/pi-tui";
import {
	type ChoiceAnswers,
	ChoiceDialog,
	type ChoiceDialogSpec,
	type ChoiceQuestion,
	canShowChoiceDialog,
	openChoiceDialog,
	setBlockedReporter,
} from "./choice-dialog";

const KEY = {
	enter: "\r",
	esc: "\x1b",
	up: "\x1b[A",
	down: "\x1b[B",
	left: "\x1b[D",
	right: "\x1b[C",
	tab: "\t",
	shiftTab: "\x1b[Z",
	space: " ",
	backspace: "\x7f",
	ctrlC: "\x03",
};

const plain = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s };
const ansi = {
	fg: (_c: string, s: string) => `\x1b[31m${s}\x1b[39m`,
	bg: (_c: string, s: string) => `\x1b[44m${s}\x1b[49m`,
	bold: (s: string) => `\x1b[1m${s}\x1b[22m`,
};

const question = (overrides: Partial<ChoiceQuestion> = {}): ChoiceQuestion => ({
	question: "Which store?",
	options: [{ label: "Redis", description: "already deployed" }, { label: "SQLite" }, { label: "Memory" }],
	typeLabel: "Type your own answer",
	...overrides,
});

function open(spec: Partial<ChoiceDialogSpec> & { questions: ChoiceQuestion[] }, theme = plain) {
	const outcome: { done: boolean; answers?: ChoiceAnswers } = { done: false };
	const dialog = new ChoiceDialog({ title: "Question", ...spec }, { requestRender() {} }, theme, (answers) => {
		outcome.done = true;
		outcome.answers = answers;
	});
	dialog.focused = true;
	const press = (...keys: string[]) => {
		for (const key of keys) for (const k of key.length > 1 && !key.startsWith("\x1b") ? [...key] : [key]) dialog.handleInput(k);
	};
	return { dialog, outcome, press };
}

describe("one question, one choice", () => {
	test("enter picks the highlighted option and closes", () => {
		const { outcome, press } = open({ questions: [question()] });
		press(KEY.down, KEY.enter);
		expect(outcome).toEqual({ done: true, answers: [{ picked: ["SQLite"] }] });
	});

	test("a digit picks that option directly", () => {
		const { outcome, press } = open({ questions: [question()] });
		press("3");
		expect(outcome.answers).toEqual([{ picked: ["Memory"] }]);
	});

	test("typing on an option row moves to the free-text row and keeps the keystrokes", () => {
		const { outcome, press } = open({ questions: [question()] });
		press("use postgres", KEY.enter);
		expect(outcome.answers).toEqual([{ picked: [], typed: "use postgres" }]);
	});

	test("a digit inside the free-text row is text, not a pick", () => {
		const { outcome, press } = open({ questions: [question()] });
		press(KEY.down, KEY.down, KEY.down, "v2", KEY.enter);
		expect(outcome.answers).toEqual([{ picked: [], typed: "v2" }]);
	});

	test("enter on an empty free-text row does nothing", () => {
		const { outcome, press } = open({ questions: [question()] });
		press(KEY.down, KEY.down, KEY.down, KEY.enter);
		expect(outcome.done).toBe(false);
	});

	test("an open question with no options is just the text row", () => {
		const { outcome, press } = open({ questions: [question({ options: [] })] });
		press("call it fetchUser", KEY.enter);
		expect(outcome.answers).toEqual([{ picked: [], typed: "call it fetchUser" }]);
	});

	test("a paste or an emoji on an option row lands in the free-text row", () => {
		for (const [data, typed] of [["\x1b[200~use valkey\x1b[201~", "use valkey"], ["👩‍💻", "👩‍💻"]]) {
			const { outcome, dialog } = open({ questions: [question()] });
			dialog.handleInput(data!);
			dialog.handleInput(KEY.enter);
			expect(outcome.answers).toEqual([{ picked: [], typed }]);
		}
	});

	test("with digitsPick off a digit is text, so it can never pick by accident", () => {
		const { outcome, press } = open({ questions: [question()], digitsPick: false });
		press("1st choice", KEY.enter);
		expect(outcome.answers).toEqual([{ picked: [], typed: "1st choice" }]);
	});

	test("initialRow sets where the cursor starts", () => {
		const { outcome, press } = open({ questions: [question()], initialRow: 1 });
		press(KEY.enter);
		expect(outcome.answers).toEqual([{ picked: ["SQLite"] }]);
	});
});

describe("dismissing", () => {
	test("esc with nothing entered dismisses at once", () => {
		const { outcome, press } = open({ questions: [question()] });
		press(KEY.esc);
		expect(outcome).toEqual({ done: true, answers: undefined });
	});

	test("esc after typing needs a second press, and any other key disarms it", () => {
		const { dialog, outcome, press } = open({ questions: [question()] });
		press("draft", KEY.esc);
		expect(outcome.done).toBe(false);
		expect(dialog.render(80).join("\n")).toContain("Press Esc again");
		press("!", KEY.esc);
		expect(outcome.done).toBe(false);
		press(KEY.esc);
		expect(outcome).toEqual({ done: true, answers: undefined });
	});

	test("the warning goes away on any key, even one that does nothing else", () => {
		const { dialog, press } = open({ questions: [question({ multiple: true })] });
		press(KEY.space, KEY.esc);
		expect(dialog.render(80).join("\n")).toContain("Press Esc again");
		press(KEY.backspace);
		expect(dialog.render(80).join("\n")).not.toContain("Press Esc again");
	});

	test("ctrl+c dismisses like esc", () => {
		const { outcome, press } = open({ questions: [question()] });
		press(KEY.ctrlC);
		expect(outcome).toEqual({ done: true, answers: undefined });
	});
});

describe("several questions", () => {
	const two = [question({ header: "Store" }), question({ header: "Tone", question: "How formal?", options: [{ label: "Formal" }, { label: "Casual" }] })];

	test("answering moves to the next question, then enter on Review submits", () => {
		const { outcome, press } = open({ questions: two });
		press("1");
		expect(outcome.done).toBe(false);
		press("2");
		expect(outcome.done).toBe(false);
		press(KEY.enter);
		expect(outcome.answers).toEqual([{ picked: ["Redis"] }, { picked: ["Casual"] }]);
	});

	test("skipped questions are sent as unanswered", () => {
		const { outcome, press } = open({ questions: two });
		press(KEY.tab, KEY.tab, KEY.enter);
		expect(outcome.answers).toEqual([undefined, undefined]);
	});

	test("shift+tab goes back and a new pick replaces the old one", () => {
		const { outcome, press } = open({ questions: two });
		press("1", "1", KEY.shiftTab, KEY.shiftTab, "3", KEY.tab, KEY.enter);
		expect(outcome.answers).toEqual([{ picked: ["Memory"] }, { picked: ["Formal"] }]);
	});

	test("picking an option after typing replaces the typed text in a single-choice question", () => {
		const { outcome, press } = open({ questions: two });
		press("maybe", KEY.up, KEY.up, KEY.enter, KEY.tab, KEY.enter);
		expect(outcome.answers).toEqual([{ picked: ["SQLite"] }, undefined]);
	});
});

describe("multiple choice", () => {
	test("space and enter tick, ticking twice unticks, and typed text is kept beside the ticks", () => {
		const { outcome, press } = open({ questions: [question({ multiple: true })] });
		press(KEY.space, KEY.down, KEY.enter, "3", "3", KEY.down, KEY.down, "and caching", KEY.tab, KEY.enter);
		expect(outcome.answers).toEqual([{ picked: ["Redis", "SQLite"], typed: "and caching" }]);
	});

	test("one multiple-choice question still needs Review to submit", () => {
		const { outcome, press } = open({ questions: [question({ multiple: true })] });
		press("1");
		expect(outcome.done).toBe(false);
		press(KEY.tab, KEY.enter);
		expect(outcome.answers).toEqual([{ picked: ["Redis"] }]);
	});
});

describe("rendering", () => {
	const hostile = question({
		header: "雲\nheader\twith\x1b[2Jcontrol",
		question: "Line one\nLine two with 日本語のテキスト and emoji 👩‍👩‍👧‍👦 and a very long word " + "x".repeat(300),
		options: [
			{ label: "label\nwith newline and 🇯🇵 flags", description: "desc \x07 bell\nsecond line " + "宽".repeat(80) },
			{ label: "x".repeat(400) },
		],
	});

	test("no line is ever wider than the terminal, at any width, with any model text", () => {
		for (const theme of [plain, ansi]) {
			for (const multiple of [false, true]) {
				const { dialog, press } = open(
					{ title: "Title\nwith newline 📦".repeat(5), body: "- reason\n\nRuns on this machine:\n" + "rm -rf ./x ".repeat(50), questions: [hostile, { ...hostile, multiple }] },
					theme,
				);
				for (const keys of [[], [KEY.down, KEY.down, KEY.down, "typed 中文 text ".repeat(10)], [KEY.tab, KEY.tab]]) {
					press(...keys);
					for (let width = 8; width <= 140; width += 7) {
						for (const line of dialog.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
					}
				}
			}
		}
	});

	test("model text cannot move the cursor or emit escape sequences", () => {
		const { dialog } = open({ questions: [hostile] });
		for (const line of dialog.render(120)) {
			expect(line).not.toMatch(/[\r\n\x07]/);
			expect(line).not.toContain("\x1b[2J");
		}
	});

	test("a long body is capped and says where the rest is", () => {
		const { dialog } = open({ body: Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n"), questions: [question()] });
		const text = dialog.render(80).join("\n");
		expect(text).toContain("line 13");
		expect(text).not.toContain("line 14");
		expect(text).toContain("26 more lines");
	});

	test("lines are cached per width and rebuilt after a keypress", () => {
		const { dialog, press } = open({ questions: [question()] });
		const first = dialog.render(80);
		expect(dialog.render(80)).toBe(first);
		expect(dialog.render(70)).not.toBe(first);
		const again = dialog.render(80);
		press(KEY.down);
		expect(dialog.render(80)).not.toBe(again);
	});
});

describe("openChoiceDialog", () => {
	function tuiContext(keys: string[]) {
		return {
			hasUI: true,
			mode: "tui",
			ui: {
				custom: <T>(factory: any) =>
					new Promise<T>((resolve) => {
						const component = factory({ requestRender() {} }, plain, {}, resolve);
						component.focused = true;
						for (const key of keys) component.handleInput(key);
					}),
			},
		};
	}

	test("resolves with the answers", async () => {
		expect(await openChoiceDialog(tuiContext(["2"]), { title: "Q", questions: [question()] })).toEqual([{ picked: ["SQLite"] }]);
	});

	test("an abort closes an open dialog as dismissed", async () => {
		const controller = new AbortController();
		const pending = openChoiceDialog(tuiContext([]), { title: "Q", questions: [question()] }, controller.signal);
		controller.abort();
		expect(await pending).toBeUndefined();
	});

	test("an already-aborted signal never opens it", async () => {
		const controller = new AbortController();
		controller.abort();
		let opened = false;
		const ctx = { hasUI: true, mode: "tui", ui: { custom: async () => ((opened = true), undefined) } };
		expect(await openChoiceDialog(ctx as any, { title: "Q", questions: [question()] }, controller.signal)).toBeUndefined();
		expect(opened).toBe(false);
	});

	describe("herdr is told the user is needed, and every report is released exactly once", () => {
		const reports: [boolean, string][] = [];
		beforeEach(() => {
			reports.length = 0;
			setBlockedReporter((active, label) => reports.push([active, label]));
		});
		afterEach(() => setBlockedReporter(undefined));
		const spec = { title: "Q", notify: "Approval needed:\n rm -rf \x1b[31m./x", questions: [question()] };
		const label = "Approval needed: rm -rf [31m./x";

		for (const [name, keys] of [["answered", ["1"]], ["dismissed", [KEY.esc]]] as const) {
			test(name, async () => {
				const pending = openChoiceDialog(tuiContext([...keys]), spec);
				expect(reports).toEqual([[true, label]]);
				await pending;
				expect(reports).toEqual([[true, label], [false, label]]);
			});
		}

		test("aborted while open", async () => {
			const controller = new AbortController();
			const pending = openChoiceDialog(tuiContext([]), spec, controller.signal);
			controller.abort();
			await pending;
			expect(reports).toEqual([[true, label], [false, label]]);
		});

		test("the UI throws", async () => {
			const broken = { hasUI: true, mode: "tui", ui: { custom: async () => { throw new Error("tui gone"); } } };
			await expect(openChoiceDialog(broken as any, spec)).rejects.toThrow("tui gone");
			expect(reports).toEqual([[true, label], [false, label]]);
		});

		test("a reporter that throws cannot break the dialog", async () => {
			setBlockedReporter(() => {
				throw new Error("bus down");
			});
			expect(await openChoiceDialog(tuiContext(["2"]), spec)).toEqual([{ picked: ["SQLite"] }]);
		});

		test("never reported when it never opens", async () => {
			const controller = new AbortController();
			controller.abort();
			await openChoiceDialog(tuiContext([]), spec, controller.signal);
			expect(reports).toEqual([]);
		});
	});

	test("only the TUI can show it", () => {
		expect(canShowChoiceDialog(tuiContext([]))).toBe(true);
		expect(canShowChoiceDialog({ ...tuiContext([]), mode: "rpc" })).toBe(false);
		expect(canShowChoiceDialog({ ...tuiContext([]), hasUI: false })).toBe(false);
		expect(canShowChoiceDialog(undefined)).toBe(false);
	});
});
