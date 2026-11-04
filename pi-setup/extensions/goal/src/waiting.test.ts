import { describe, expect, test } from "bun:test";

import { goalMenu } from "./commands.ts";
import { formatFooterStatus, formatGoalStatus, toToolGoal } from "./format.ts";
import { planGoalTransition } from "./goal-transition.ts";
import { compactContinuationPrompt, continuationPrompt, TOOL_PROMPT_GUIDELINES } from "./prompts.ts";
import { isThreadGoal, replaceGoal, updateGoalStatus } from "./state.ts";

const active = () => replaceGoal("integrate the explorer reports").goal!;
const reason = "explorers alpha and beta will report back";

describe("a goal waiting on background work", () => {
	test("needs a reason, keeps it, and loses it when it is paused, resumed or completed", () => {
		for (const missing of [undefined, "", "   "]) expect(updateGoalStatus(active(), "waiting", missing).ok).toBe(false);
		const waiting = updateGoalStatus(active(), "waiting", `  ${reason}  `).goal!;
		expect(waiting).toMatchObject({ status: "waiting", waitingReason: reason });
		expect(isThreadGoal(waiting)).toBe(true);
		expect(isThreadGoal({ ...waiting, waitingReason: "" })).toBe(false);
		expect(updateGoalStatus(waiting, "blocked", "needs a key").ok).toBe(false);
		expect(updateGoalStatus(waiting, "paused").goal).toMatchObject({ status: "paused" });
		expect(updateGoalStatus(waiting, "paused").goal!.waitingReason).toBeUndefined();
		expect(updateGoalStatus(waiting, "complete").goal!.waitingReason).toBeUndefined();
		expect(updateGoalStatus(waiting, "active").goal).toMatchObject({ status: "active" });
		expect(updateGoalStatus(updateGoalStatus(active(), "blocked", "needs a key").goal!, "waiting", reason).ok).toBe(false);
	});

	test("waking it makes the goal active again and drops the reason", () => {
		const waiting = updateGoalStatus(active(), "waiting", reason).goal!;
		const plan = planGoalTransition(waiting, { kind: "resume_waiting" });
		expect(plan.nextGoal?.status).toBe("active");
		expect(plan.nextGoal?.waitingReason).toBeUndefined();
		expect(() => planGoalTransition(active(), { kind: "resume_waiting" })).toThrow();
	});

	test("the footer shows the reason on one line with no terminal sequences", () => {
		const goal = { ...updateGoalStatus(active(), "waiting", reason).goal!, waitingReason: "\x1b]0;title\x07\x1b[31mexplorer\x1b[0m\n report\tA" };
		expect(formatFooterStatus(goal)).toBe("Goal waiting: explorer report A (/goal resume)");
		expect(formatGoalStatus(goal)).toContain(`Waiting for: ${goal.waitingReason}`);
		expect(toToolGoal(goal).waitingReason).toBe(goal.waitingReason);
	});

	test("the menu offers both resume and pause", () => {
		const ids = goalMenu(updateGoalStatus(active(), "waiting", reason).goal!, false).items.map((item) => item.id);
		expect(ids).toContain("resume");
		expect(ids).toContain("pause");
	});

	test("every place the model is told how to stop names waiting, and still keeps blocked for an explicit resume", () => {
		const goal = active();
		for (const text of [TOOL_PROMPT_GUIDELINES.join("\n"), continuationPrompt(goal), compactContinuationPrompt(goal)]) {
			expect(text).toContain('status "waiting" and a reason naming that work');
			expect(text).toContain("Do not poll it.");
			expect(text).toContain("/goal resume");
		}
	});
});
