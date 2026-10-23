import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { completeWords } from "../../tools/lib/command-args.ts";
import { type CommandHost, fillGoalTemplate, GOAL_WORDS, goalMenu, handleGoalCommand } from "./commands.ts";
import { replaceGoal } from "./state.ts";
import type { ThreadGoal } from "./types.ts";

function goalWith(status: ThreadGoal["status"]): ThreadGoal {
  const goal = replaceGoal("ship the release").goal!;
  return { ...goal, status, ...(status === "blocked" ? { blockedReason: "needs a key" } : {}) };
}

function harness(start: ThreadGoal | null = null) {
  let goal = start;
  const notes: [string, string | undefined][] = [];
  const sent: { text: string; options?: unknown }[] = [];
  const hidden: unknown[] = [];
  const calls: string[] = [];
  let confirmAnswer = true;
  const pi = {
    registerCommand() {},
    sendMessage: (message: unknown) => hidden.push(message),
    sendUserMessage: (text: string, options?: unknown) => sent.push({ text, options }),
  } as any;
  const host: CommandHost = {
    getGoal: () => goal,
    setGoal: (next) => {
      goal = next;
      calls.push(`set:${next.status}`);
    },
    clearGoal: () => {
      goal = null;
      calls.push("clear");
    },
    cancelProviderLimitAutoResume: () => calls.push("cancel-auto"),
    isProviderLimitAutoResumeScheduled: () => false,
    getGoalStartTurnStrategy: () => "hiddenFollowUp" as any,
    resumeGoalWithContinuation: (id) => {
      calls.push(`resume:${id === goal?.goalId}`);
      return { ok: true, message: "Goal resumed.", goal };
    },
    strictGoalPrompt: (task) => `STRICT<${task}>`,
  };
  const ctx = {
    hasUI: false,
    ui: {
      notify: (text: string, level?: string) => notes.push([text, level]),
      confirm: async () => confirmAnswer,
      setStatus() {},
    },
    isIdle: () => true,
  } as any;
  const run = (args: string) => handleGoalCommand(pi, host, args, ctx, async () => ({ ok: true }) as any);
  return { run, notes, sent, hidden, calls, goal: () => goal, refuse: () => (confirmAnswer = false), ui: (on: boolean) => (ctx.hasUI = on) };
}

describe("typed words", () => {
  test("one unknown word is an error that says how to set a goal; no goal is made", async () => {
    const h = harness();
    await h.run("paus");
    expect(h.goal()).toBeNull();
    expect(h.notes).toEqual([
      ['/goal has no "paus". Try: pause, resume, clear, copy, or strict <task>. To set a goal, write it out, like: /goal make every test in src/ pass', "error"],
    ]);
  });

  test("one unknown word becomes a goal only once confirmed", async () => {
    const h = harness();
    h.ui(true);
    await h.run("refactor");
    expect(h.goal()?.objective).toBe("refactor");
    const typo = harness();
    typo.ui(true);
    typo.refuse();
    await typo.run("paus");
    expect(typo.goal()).toBeNull();
    expect(typo.notes.at(-1)![1]).toBe("error");
  });

  test("strict cancels a pending automatic resume of the old goal", async () => {
    const h = harness(goalWith("paused"));
    await h.run("strict ship the new release");
    expect(h.calls).toEqual(["cancel-auto"]);
    expect(h.sent.length).toBe(1);
  });

  test("the words work in any case; a sentence that starts with one is still a goal", async () => {
    const h = harness(goalWith("active"));
    await h.run("PAUSE");
    expect(h.calls).toEqual(["set:paused"]);
    await h.run("Resume");
    expect(h.calls.at(-1)).toBe("resume:true");
    await h.run("resume   cancel");
    expect(h.calls.at(-1)).toBe("cancel-auto");

    const fresh = harness();
    await fresh.run("pause the deploy until the migration lands");
    expect(fresh.goal()?.objective).toBe("pause the deploy until the migration lands");
    expect(fresh.hidden.length).toBe(1);
  });

  test("replacing an open goal asks first; without a screen it says to clear it first", async () => {
    const h = harness(goalWith("active"));
    h.ui(true);
    h.refuse();
    await h.run("write the docs");
    expect(h.goal()?.objective).toBe("ship the release");
    expect(h.notes.at(-1)).toEqual(["Goal unchanged.", undefined]);
    h.ui(false);
    await h.run("write the docs");
    expect(h.notes.at(-1)).toEqual(["Clear the current goal first (/goal clear), then set the new one.", "error"]);
  });

  test("strict sends the template with the task; with nothing after it, it says what to write", async () => {
    const h = harness();
    await h.run("strict  ship it with tests green ");
    expect(h.sent).toEqual([{ text: "STRICT<ship it with tests green>", options: undefined }]);
    await h.run("strict");
    expect(h.notes.at(-1)![1]).toBe("error");
  });

  test("without a screen, /goal alone gives the state and what can be typed", async () => {
    const h = harness();
    await h.run("");
    expect(h.notes[0]![0]).toContain("No goal set.");
    expect(h.notes[0]![0]).toContain("You can type: /goal <what should be done>");
  });
});

describe("the template", () => {
  test("a task with $ patterns goes in exactly as typed", () => {
    expect(fillGoalTemplate("Task: $@\nend", "make `echo $$` print; cost $& $' $`")).toBe("Task: make `echo $$` print; cost $& $' $`\nend");
  });

  test("frontmatter goes, the task goes in for $@", () => {
    const template = readFileSync(join(import.meta.dir, "..", "create-goal.md"), "utf8");
    const filled = fillGoalTemplate(template, "  make it fast ");
    expect(filled.startsWith("User task:\nmake it fast\n")).toBe(true);
    expect(filled).not.toContain("$@");
    expect(filled).not.toContain("argument-hint");
  });
});

describe("the menu", () => {
  const ids = (goal: ThreadGoal | null, auto = false) => goalMenu(goal, auto).items.map((i) => i.id);

  test("only what applies to the goal's status", () => {
    expect(ids(null)).toEqual(["set", "strict"]);
    expect(ids(goalWith("active"))).toEqual(["pause", "set", "strict", "copy", "clear"]);
    expect(ids(goalWith("paused"), true)).toEqual(["resume", "cancel-auto", "set", "strict", "copy", "clear"]);
    expect(ids(goalWith("complete"))).toEqual(["set", "strict", "copy", "clear"]);
    expect(goalMenu(goalWith("active"), false).items.find((i) => i.id === "set")?.label).toBe("Replace it with a new goal");
  });

  test("the state lines name the goal and its status", () => {
    const status = goalMenu(goalWith("blocked"), false).status!;
    expect(status[0]).toBe("Goal: ship the release");
    expect(status[1]).toStartWith("Status: blocked · ");
    expect(status.at(-1)).toBe("Blocked on: needs a key");
  });
});

describe("suggestions", () => {
  test("words with what they do; strict and resume leave room for more", () => {
    expect(completeWords(GOAL_WORDS, "")!.map((i) => i.value)).toEqual(["pause", "resume ", "clear", "copy", "strict "]);
    expect(completeWords(GOAL_WORDS, "resume c")).toEqual([
      { value: "resume cancel", label: "cancel", description: "only stop the automatic resume after a provider limit" },
    ]);
  });
});
