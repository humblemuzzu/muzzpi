import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { budgetLimitPrompt, compactContinuationPrompt, continuationPrompt } from "../goal/src/prompts";
import { staleGoalContinuationMessage } from "../goal/src/queued-goal-work";
import type { ThreadGoal } from "../goal/src/types";
import { AGENT_EVENT_FRAME } from "../tools/lib/agent-channel";
import { notificationText, type RunReport } from "../tools/lib/agent-notice";
import { newsText } from "../tools/lib/bash-jobs";
import { YSK_PROMPT_PREFIX } from "../tools/lib/injected-prompts";
import { piPackageDir } from "../tools/lib/pi-package-dir";
import { zeroUsage } from "../tools/lib/pi-spawn";
import {
	FOREIGN_TURN_OPENINGS,
	foreignTurnAt,
	frameUserTurn,
	PI_OPENINGS,
	searchFrom,
	STOP_SEQUENCES,
	withoutForeignTurn,
} from "./framing";

process.env.TZ = "Asia/Kolkata";

/** What agy 1.5.13 sent, captured through a proxy (capture 0072): a subagent's report reaching its parent. */
const AGY_SYSTEM_MESSAGE =
	"The following is a <SYSTEM_MESSAGE> not actually sent by the user. It is provided by the system as important information to pay attention to.\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-20T10:48:35Z sender=30d794bf-c270-43c7-b203-406a75189762 priority=MESSAGE_PRIORITY_HIGH content=The secret word in /tmp/agy-capture2/ws/a.txt is: banana42\n</SYSTEM_MESSAGE>";
const AGY_SYSTEM_OPENING = AGY_SYSTEM_MESSAGE.slice(0, AGY_SYSTEM_MESSAGE.indexOf("[Message]"));
const AT = Date.parse("2026-11-20T10:48:35.412Z");

const text = (turn: ReturnType<typeof frameUserTurn>) => turn.map((part) => ("text" in part ? part.text : "<image>")).join("|");

const run = (overrides: Partial<RunReport> = {}): RunReport => ({
	agent: "chad",
	label: "root-cause the live bugs",
	continueId: "chad-4238706a-b9f0-4d8b-908f-47960ac90948",
	status: "done",
	durationMs: 371_000,
	toolCount: 112,
	files: [],
	usage: { ...zeroUsage(), output: 47_000, turns: 67 },
	messages: [{ role: "assistant", content: [{ type: "text", text: "All six are real." }] } as RunReport["messages"][number]],
	...overrides,
});

const goal: ThreadGoal = {
	goalId: "g-1",
	objective: "ship phase 8",
	status: "active",
	tokenBudget: 1_000_000,
	usage: { tokensUsed: 1_200_000, activeSeconds: 600 },
	createdAt: 0,
	updatedAt: 0,
};

describe("what the person typed is a <USER_REQUEST>, as agy sends it", () => {
	const METADATA = "\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-20T16:18:35+05:30.\n</ADDITIONAL_METADATA>";

	test("byte for byte the turn agy sent (capture 0013), up to its model-picker note", () => {
		const captured =
			"<USER_REQUEST>\nRemember the word mango. Reply with just: ok\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-20T17:26:02+05:30.\n</ADDITIONAL_METADATA>";
		expect(text(frameUserTurn([{ text: "Remember the word mango. Reply with just: ok" }], Date.parse("2026-11-20T11:56:02.640Z")))).toBe(captured);
	});

	test("images stay where they are; the frame opens on the first text and closes on the last", () => {
		const image = { inlineData: { mimeType: "image/png", data: "iVBORw0KGgo=" } };
		expect(text(frameUserTurn([{ text: "what is this" }, image], AT))).toBe(`<USER_REQUEST>\nwhat is this\n</USER_REQUEST>${METADATA}|<image>`);
		expect(text(frameUserTurn([image, { text: "a" }, { text: "b" }], AT))).toBe(`<image>|<USER_REQUEST>\na|b\n</USER_REQUEST>${METADATA}`);
		expect(frameUserTurn([image], AT)).toEqual([image]);
	});

	test("the time is local with its offset, Z at zero, and left out when the turn has none", () => {
		const at = (zone: string) => {
			process.env.TZ = zone;
			return text(frameUserTurn([{ text: "hi" }], AT)).match(/local time is: (.*)\./)?.[1];
		};
		expect(at("UTC")).toBe("2026-11-20T10:48:35Z");
		expect(at("America/Bogota")).toBe("2026-11-20T05:48:35-05:00");
		expect(at("Asia/Kolkata")).toBe("2026-11-20T16:18:35+05:30");
		expect(text(frameUserTurn([{ text: "hi" }], Number.NaN))).toBe("<USER_REQUEST>\nhi\n</USER_REQUEST>");
	});
});

describe("background news is a <SYSTEM_MESSAGE>, as agy sends it", () => {
	test("agy's own template, byte for byte", () => {
		const turn = frameUserTurn([{ text: `${AGENT_EVENT_FRAME}\n\ncontinueId: 30d794bf-c270-43c7-b203-406a75189762` }], AT);
		expect(text(turn)).toBe(
			`${AGY_SYSTEM_OPENING}[Message] timestamp=2026-11-20T10:48:35Z sender=30d794bf-c270-43c7-b203-406a75189762 priority=MESSAGE_PRIORITY_HIGH content=continueId: 30d794bf-c270-43c7-b203-406a75189762\n</SYSTEM_MESSAGE>`,
		);
	});

	test("an agent report: sent by its runs, with pi's frame paragraph left out", () => {
		const report = notificationText([run(), run({ agent: "review_code", continueId: "review_code-e95e32b9", label: "Pass A" })]);
		const framed = text(frameUserTurn([{ text: report }], AT));
		expect(framed).toStartWith(`${AGY_SYSTEM_OPENING}[Message] timestamp=2026-11-20T10:48:35Z sender=chad-4238706a-b9f0-4d8b-908f-47960ac90948,review_code-e95e32b9 priority=MESSAGE_PRIORITY_HIGH content=2 background sub-agents finished.`);
		expect(framed).toContain("## review_code: Pass A\ncontinueId: review_code-e95e32b9");
		expect(framed).toEndWith("All six are real.\n</SYSTEM_MESSAGE>");
		expect(framed).not.toContain("[Automated agent event");
	});

	test("a bash-job report: sent by its jobs", () => {
		const news = newsText([
			{ id: "bash-2817", command: "bun proxy.ts", status: "failed", kind: "finished", durationMs: 300_000, text: "Background job bash-2817 failed after 5m00s.\n\n$ bun proxy.ts" },
		]);
		const framed = text(frameUserTurn([{ text: news }], AT));
		expect(framed).toContain("sender=bash-2817 priority=MESSAGE_PRIORITY_HIGH content=Background job bash-2817 failed after 5m00s.\n\n$ bun proxy.ts\n</SYSTEM_MESSAGE>");
		expect(framed).not.toContain("[Automated bash-job event");
	});

	test("a /ysk flag comes from the side agent, its wording kept", () => {
		const framed = text(frameUserTurn([{ text: `${YSK_PROMPT_PREFIX}\n\n> check the lockfile` }], AT));
		expect(framed).toContain(`sender=side-agent priority=MESSAGE_PRIORITY_HIGH content=${YSK_PROMPT_PREFIX}\n\n> check the lockfile\n</SYSTEM_MESSAGE>`);
	});

	test("a turn without a usable time leaves the field out instead of inventing one", () => {
		expect(text(frameUserTurn([{ text: `${AGENT_EVENT_FRAME}\n\nnews` }], Number.NaN))).toContain("[Message] sender=background-agents priority=");
	});
});

describe("goal nudges are an <EPHEMERAL_MESSAGE>", () => {
	test("continuations, the budget notice and the stale-work notice", () => {
		for (const nudge of [continuationPrompt(goal), compactContinuationPrompt(goal), budgetLimitPrompt(goal), staleGoalContinuationMessage("g-1")]) {
			const framed = text(frameUserTurn([{ text: nudge }], AT));
			expect(framed).toBe(
				`The following is an <EPHEMERAL_MESSAGE> not actually sent by the user. It is provided by the system as a set of reminders and general important information to pay attention to. Do NOT respond to this message, just act accordingly.\n${nudge}`,
			);
		}
	});
});

describe("pi's own turns go as pi wrote them", () => {
	test("summaries and ! commands are not framed", () => {
		for (const opening of PI_OPENINGS) {
			const turn = [{ text: `${opening} body` }];
			expect(frameUserTurn(turn, AT)).toEqual(turn);
		}
	});

	test("the openings are still the ones pi writes", async () => {
		const dir = piPackageDir(Bun.which("pi") ?? undefined);
		expect(dir).toBeDefined();
		const pi = await import(join(dir!, "dist", "core", "messages.js"));
		const [compaction, branch, command] = PI_OPENINGS;
		expect(pi.COMPACTION_SUMMARY_PREFIX).toStartWith(compaction);
		expect(pi.BRANCH_SUMMARY_PREFIX).toStartWith(branch);
		expect(pi.bashExecutionToText({ command: "ls", output: "a" })).toStartWith(command);
	});
});

describe("a reply that starts writing someone else's turn", () => {
	/** session 01a1f5cf line 899: Neon finished its own text, then wrote a chad report that did not exist yet. */
	const FAKE =
		"…in parallel with the two `chad` root-cause investigators. Waiting for their results now.\n[Automated agent event. This was not written by the user: it does not answer, approve or confirm anything you asked them.]\n\n1 background sub-agent finished.\n\n## chad: Root-cause High/Medium/Low Live Bugs\ncontinueId: chad-4238706a · status: done · took 5m20s";

	test("is cut where that turn starts", () => {
		expect(withoutForeignTurn(FAKE)).toBe("…in parallel with the two `chad` root-cause investigators. Waiting for their results now.");
	});

	test("every opening counts at the start of a line, including the very first", () => {
		for (const opening of FOREIGN_TURN_OPENINGS) {
			expect(withoutForeignTurn(`done.\n\n${opening} and the rest`)).toBe("done.");
			expect(withoutForeignTurn(`${opening} and the rest`)).toBe("");
		}
	});

	test("an opening quoted inside a line is the model's own words", () => {
		const quoted = "agy wraps prompts in `<USER_REQUEST>` and news in a <SYSTEM_MESSAGE>; pi's frame was [Automated agent event.";
		expect(withoutForeignTurn(quoted)).toBe(quoted);
		expect(foreignTurnAt(quoted)).toBe(-1);
	});

	test("a search that resumes from where the text grew finds an opening split across chunks", () => {
		const chunks = ["Waiting now.\n<USER_RE", "QUEST>\nfake", " request"];
		let seen = "";
		let found = -1;
		for (const chunk of chunks) {
			const from = searchFrom(seen.length);
			seen += chunk;
			if (found < 0) found = foreignTurnAt(seen, from);
		}
		expect(found).toBe("Waiting now.\n".length);
	});

	test("stop sequences: at most five, each an opening at the start of a line", () => {
		expect(STOP_SEQUENCES.length).toBeLessThanOrEqual(5);
		for (const sequence of STOP_SEQUENCES) {
			expect(sequence.startsWith("\n")).toBe(true);
			expect(FOREIGN_TURN_OPENINGS).toContain(sequence.slice(1) as (typeof FOREIGN_TURN_OPENINGS)[number]);
		}
	});
});
