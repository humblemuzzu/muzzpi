import { beforeAll, describe, expect, test } from "bun:test";
import { initTheme } from "@mariozechner/pi-coding-agent";
import { visibleWidth } from "@mariozechner/pi-tui";
import { renderRunCards, RunCard } from "./agent-card";
import { renderAgentCall, renderAgentRunResult } from "./agent-inline";
import type { RunReport } from "./agent-notice";
import { firstAnswerLine, freshTokens, identityColor } from "./agent-style";
import type { SingleResult } from "./sub-agent-render";
import { theme } from "./test-theme";

beforeAll(() => initTheme("dark"));

const WIDTHS = [20, 40, 80, 160];
const strip = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "");

function report(overrides: Partial<RunReport> = {}): RunReport {
	return {
		agent: "chad",
		label: "audit the token flow in the session layer",
		continueId: "chad-1",
		status: "done",
		durationMs: 312_000,
		toolCount: 12,
		files: [],
		usage: { input: 380_000, output: 32_000, cacheRead: 900_000, cacheWrite: 0, cost: 0.2512, contextTokens: 0, turns: 9 },
		messages: [{ role: "assistant", content: [{ type: "text", text: "## Finding\n\n**The token** is refreshed twice.\n\nSecond paragraph." }] }] as any[],
		...overrides,
	};
}

function rendersFromCache(component: { render(width: number): string[]; invalidate(): void }): void {
	const first = component.render(80);
	expect(component.render(80)).toBe(first);
	expect(component.render(60)).not.toBe(first);
	const again = component.render(80);
	component.invalidate();
	expect(component.render(80)).not.toBe(again);
}

describe("the finished-run card", () => {
	test("header, facts and the first line of the answer", () => {
		const lines = new RunCard(report(), false, theme, 1).render(100).map(strip);
		expect(lines[0]).toStartWith(" ✓ chad finished  audit the token flow in the session layer");
		expect(lines[0]).toEndWith("5m12s · ↑412k · $0.25");
		expect(lines[1]).toBe("   Finding");
		expect(lines).toHaveLength(2);
	});

	test("never wider than the width, cached per width", () => {
		const card = new RunCard(report({ overlaps: [{ continueId: "delegate-1", files: ["src/a.ts", "src/b.ts"] }] }), false, theme, 1);
		for (const width of WIDTHS) expect(card.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
		rendersFromCache(card);
	});

	test("facts move to their own line when the label would be squeezed", () => {
		const lines = new RunCard(report(), false, theme, 1).render(40).map(strip);
		expect(lines[0]).not.toContain("5m12s");
		expect(lines[1]).toContain("5m12s · ↑412k · $0.25");
	});

	test("a failed run shows why instead of an answer", () => {
		const lines = new RunCard(report({ status: "failed", errorMessage: "provider exploded\nsecond line" }), false, theme, 1).render(100).map(strip);
		expect(lines[0]).toContain("✕ chad failed");
		expect(lines[1]).toBe("   provider exploded");
	});

	test("a file another run changed meanwhile is flagged, one line per run", () => {
		const lines = new RunCard(report({ overlaps: [{ continueId: "delegate-1", files: ["src/a.ts", "src/b.ts"] }] }), false, theme, 1).render(120).map(strip);
		expect(lines.filter((line) => line.includes("also changed by"))).toEqual(["   ⚠ also changed by delegate-1 while this ran: src/a.ts, src/b.ts"]);
	});

	test("expanded it renders the whole answer as markdown", () => {
		const lines = new RunCard(report(), true, theme, 1).render(80).map(strip).join("\n");
		expect(lines).toContain("Second paragraph.");
		expect(lines).not.toContain("**");
	});

	test("the message is the cards alone: no hint line under them", () => {
		const container = renderRunCards([report(), report({ agent: "oracle", continueId: "oracle-1" })], false, theme, 1);
		const lines = container.render(80).map(strip);
		expect(lines.some((line) => line.includes("expand"))).toBe(false);
		expect(lines.filter((line) => line.includes("finished"))).toHaveLength(2);
	});
});

describe("style helpers", () => {
	test("an agent keeps one colour, and unknown agents get a stable one", () => {
		expect(identityColor("chad")).toBe(identityColor("chad"));
		expect(identityColor("chad")).not.toBe(identityColor("oracle"));
		expect(identityColor("mystery")).toBe(identityColor("mystery"));
	});

	test("tokens count fresh work, never cache reads", () => {
		expect(freshTokens({ input: 10, output: 5, cacheWrite: 3 })).toBe(18);
	});

	test("the first answer line loses its markdown", () => {
		expect(firstAnswerLine("\n\n## **Done** with `x`\nmore")).toBe("Done with x");
		expect(firstAnswerLine("- item one\n- two")).toBe("item one");
		expect(firstAnswerLine("   ")).toBe("");
	});
});

function details(overrides: Partial<SingleResult> = {}): SingleResult {
	const calls = Array.from({ length: 5 }, (_, i) => ({ type: "toolCall", id: `t${i}`, name: "read", arguments: { path: `src/file${i}.ts` } }));
	return {
		agent: "chad",
		task: "audit",
		exitCode: -1,
		usage: { input: 30_000, output: 15_200, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 3 },
		messages: [{ role: "assistant", content: calls }] as any[],
		...overrides,
	};
}

describe("a background launch in the chat", () => {
	const stub = { background: true, agent: "chad", task: "audit the token flow", continueId: "chad-1", model: "deepseek/deepseek-flash" };
	const render = renderAgentRunResult("Chad");

	test("is one calm line: icon, agent, label, model", () => {
		const state = {};
		const lines = render({ details: stub, content: [] }, { expanded: false }, theme, { state, outputPad: 1 }).render(100).map(strip);
		expect(lines).toEqual([" ◐ chad  audit the token flow · deepseek-flash"]);
	});

	test("replaces the call header, which comes back when the result is an error", () => {
		const state: Record<string, unknown> = {};
		const context = { state, outputPad: 1 };
		const header = renderAgentCall("Chad", "audit the token flow", theme, context) as any;
		expect(header.render(80).map(strip)).toEqual([" Chad audit the token flow"]);
		render({ details: stub, content: [] }, { expanded: false }, theme, context);
		expect(header.render(80)).toEqual([]);
		render({ details: undefined, content: [{ type: "text", text: "continueId is wrong" }] }, { expanded: false }, theme, context);
		expect(header.render(80).map(strip)).toEqual([" Chad audit the token flow"]);
	});

	test("the call header is cached per width and per launch state", () => {
		const context = { state: {}, outputPad: 1 };
		const header = renderAgentCall("Chad", "x", theme, context) as any;
		const first = header.render(80);
		expect(header.render(80)).toBe(first);
		(context.state as any).launched = true;
		expect(header.render(80)).not.toBe(first);
	});

	test("never wider than the width", () => {
		const row = render({ details: stub, content: [] }, { expanded: false }, theme, { state: {}, outputPad: 1 });
		for (const width of WIDTHS) expect(row.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
	});
});

describe("a blocking call in the chat", () => {
	const render = renderAgentRunResult("Chad");
	const context = (extra: object = {}) => ({ state: {}, outputPad: 1, ...extra });

	test("running shows the last three tool calls, then the in-progress line", () => {
		const lines = render({ details: details(), content: [] }, { expanded: false }, theme, context()).render(120).map(strip);
		expect(lines).toHaveLength(4);
		expect(lines[0]).toContain("Read src/file2.ts");
		expect(lines[2]).toContain("Read src/file4.ts");
		expect(lines[3]).toBe("   In progress… · 5 tool uses · 45k tokens · (ctrl+o to expand)");
	});

	test("done collapses to one line with the count, tokens and time", () => {
		const lines = render({ details: details({ exitCode: 0 }), content: [] }, { expanded: false }, theme, context({ durationMs: 72_000 })).render(120).map(strip);
		expect(lines).toEqual(["   Done (5 tool uses · 45k tokens · 1m12s)"]);
	});

	test("a failure names the error", () => {
		const lines = render({ details: details({ exitCode: 1, errorMessage: "boom\nmore" }), content: [] }, { expanded: false }, theme, context()).render(120).map(strip);
		expect(lines[0]).toStartWith("   Failed (");
		expect(lines[1]).toBe("   boom");
	});

	test("only the count is bold", () => {
		const line = render({ details: details({ exitCode: 0 }), content: [] }, { expanded: false }, theme, context()).render(120)[0]!;
		expect(line).toContain(theme.bold("5"));
		expect(line).not.toContain(theme.bold("Done"));
	});

	test("expanded it is the whole tree", () => {
		const lines = render({ details: details({ exitCode: 0 }), content: [] }, { expanded: true }, theme, context()).render(100).map(strip);
		expect(lines.some((line) => line.includes("src/file0.ts"))).toBe(true);
	});

	test("never wider than the width, and rebuilt lines are cached per width", () => {
		const row = render({ details: details(), content: [] }, { expanded: false }, theme, context());
		for (const width of WIDTHS) expect(row.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
		for (const child of (row as any).children) rendersFromCache(child);
	});
});
