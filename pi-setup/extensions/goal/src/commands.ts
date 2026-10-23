import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { completeWords, splitArgs, type Word } from "../../tools/lib/command-args.ts";
import { askText, canShowMenu, type MenuItem, type MenuSpec, showMenu } from "../../tools/lib/command-menu.ts";
import { copyTextToClipboard, type ClipboardCopyResult } from "./clipboard.ts";
import { formatGoalStatus, formatGoalSummary } from "./format.ts";
import type { GoalStartTurnStrategy } from "./recovery-machine.ts";
import { compactContinuationPrompt, continuationPrompt } from "./prompts.ts";
import { replaceGoal, updateGoalStatus } from "./state.ts";
import { CUSTOM_ENTRY_TYPE, type GoalEntrySource, type ThreadGoal } from "./types.ts";

export interface CommandHost {
  getGoal(): ThreadGoal | null;
  setGoal(goal: ThreadGoal, source: GoalEntrySource, ctx: GoalCommandContext): void;
  clearGoal(source: GoalEntrySource, ctx: GoalCommandContext): void;
  cancelProviderLimitAutoResume(goalId: string, ctx: GoalCommandContext): void;
  isProviderLimitAutoResumeScheduled(goalId: string): boolean;
  getGoalStartTurnStrategy(): GoalStartTurnStrategy;
  resumeGoalWithContinuation(
    goalId: string,
    source: GoalEntrySource,
    ctx: GoalCommandContext,
  ): { ok: boolean; message: string; goal: ThreadGoal | null };
  /** the prompt that asks the model to turn `task` into a checked goal and set it */
  strictGoalPrompt(task: string): string;
}

type CopyText = (text: string) => Promise<ClipboardCopyResult>;

export type GoalCommandPi = Pick<ExtensionAPI, "registerCommand" | "sendMessage" | "sendUserMessage">;

export interface GoalCommandContext {
  hasUI: boolean;
  mode?: string;
  ui: Pick<ExtensionCommandContext["ui"], "confirm" | "notify" | "setStatus"> &
    Partial<Pick<ExtensionCommandContext["ui"], "input" | "custom" | "theme">>;
  isIdle?(): boolean;
}

export const GOAL_WORDS: readonly Word[] = [
  { name: "pause", description: "stop working on the goal until you resume it" },
  {
    name: "resume",
    description: "carry on working on the goal",
    next: () => [{ value: "cancel", description: "only stop the automatic resume after a provider limit" }],
  },
  { name: "clear", description: "remove the goal" },
  { name: "copy", description: "copy the goal's text to the clipboard" },
  { name: "strict", description: "<task>: the agent writes a goal it must prove is met, then works on it", next: () => [] },
];

const SET_HINT = "To set a goal, write it out, like: /goal make every test in src/ pass";

function queueGoalTurn(pi: GoalCommandPi, goal: ThreadGoal, kind: "command_start" | "command_resume"): void {
  pi.sendMessage(
    {
      customType: CUSTOM_ENTRY_TYPE,
      content: continuationPrompt(goal),
      display: false,
      details: { kind, goalId: goal.goalId },
    },
    { triggerTurn: true, deliverAs: "followUp" },
  );
}

function queueGoalUserTurn(pi: GoalCommandPi, goal: ThreadGoal): void {
  pi.sendUserMessage(compactContinuationPrompt(goal), { deliverAs: "followUp" });
}

/** The prompt template with its frontmatter dropped and the task put in for `$@`. */
export function fillGoalTemplate(template: string, task: string): string {
  const body = template.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
  // a function, so `$$` or `$&` in the task stay as typed instead of acting as replacement patterns
  return body.replaceAll("$@", () => task.trim()).trim();
}

export function goalMenu(goal: ThreadGoal | null, autoResumeScheduled: boolean): MenuSpec {
  const items: MenuItem[] = [];
  const status = goal?.status;
  if (status === "active") {
    items.push({ id: "pause", label: "Pause", description: "The agent stops working on it until you resume." });
  }
  if (status === "paused" || status === "blocked") {
    items.push({ id: "resume", label: "Resume", description: "The agent carries on working on it." });
  }
  if (autoResumeScheduled) {
    items.push({ id: "cancel-auto", label: "Stop the automatic resume", description: "It stays paused until you resume it." });
  }
  const open = status === "active" || status === "paused" || status === "blocked";
  items.push(
    { id: "set", label: open ? "Replace it with a new goal" : "Set a goal", description: "Type what should be true when the work is done." },
    {
      id: "strict",
      label: "Have the agent write a strict goal",
      description: "Describe the task; the agent turns it into a goal it must prove is met, with evidence, then starts.",
    },
  );
  if (goal) {
    items.push(
      { id: "copy", label: "Copy the goal's text" },
      { id: "clear", label: "Clear the goal", description: "Removes it; the agent stops treating it as unfinished work." },
    );
  }
  return { title: "Goal", status: formatGoalStatus(goal), items };
}

async function setObjective(
  pi: GoalCommandPi,
  host: CommandHost,
  objective: string,
  ctx: GoalCommandContext,
  confirmed: boolean,
): Promise<void> {
  const current = host.getGoal();
  if (current && current.status !== "complete" && !confirmed) {
    if (!ctx.hasUI) {
      ctx.ui.notify("Clear the current goal first (/goal clear), then set the new one.", "error");
      return;
    }
    const shouldReplace = await ctx.ui.confirm("Replace the goal?", `Current goal:\n${current.objective}\n\nNew goal:\n${objective}`);
    if (!shouldReplace) {
      ctx.ui.notify("Goal unchanged.");
      return;
    }
  }

  const result = replaceGoal(objective);
  if (!result.ok || !result.goal) {
    ctx.ui.notify(result.message, "error");
    return;
  }
  host.setGoal(result.goal, "command", ctx);
  ctx.ui.notify(result.message);
  if (host.getGoalStartTurnStrategy() === "userFollowUp") {
    queueGoalUserTurn(pi, result.goal);
  } else {
    queueGoalTurn(pi, result.goal, "command_start");
  }
}

function startStrictGoal(pi: GoalCommandPi, host: CommandHost, task: string, ctx: GoalCommandContext): void {
  let prompt: string;
  try {
    prompt = host.strictGoalPrompt(task);
  } catch (error) {
    ctx.ui.notify(`Could not read the strict-goal prompt: ${error instanceof Error ? error.message : String(error)}`, "error");
    return;
  }
  // a prompt from an extension skips the goal's user-input handling, which would cancel this
  const current = host.getGoal();
  if (current) host.cancelProviderLimitAutoResume(current.goalId, ctx);
  if (ctx.isIdle?.() === false) pi.sendUserMessage(prompt, { deliverAs: "followUp" });
  else pi.sendUserMessage(prompt);
}

function pauseOrResume(pi: GoalCommandPi, host: CommandHost, action: "pause" | "resume", ctx: GoalCommandContext): void {
  const current = host.getGoal();
  if (action === "resume" && current?.status === "active" && host.getGoalStartTurnStrategy() === "userFollowUp") {
    queueGoalUserTurn(pi, current);
    ctx.ui.notify("The goal is already active; asked the agent to carry on.");
    return;
  }
  if (action === "resume" && (current?.status === "paused" || current?.status === "blocked")) {
    const result = host.resumeGoalWithContinuation(current.goalId, "command", ctx);
    ctx.ui.notify(result.message, result.ok ? undefined : "warning");
    return;
  }
  const result = updateGoalStatus(current, action === "pause" ? "paused" : "active");
  if (!result.ok || !result.goal) {
    ctx.ui.notify(result.message, "warning");
    return;
  }
  host.setGoal(result.goal, "command", ctx);
  ctx.ui.notify(result.message);
}

async function copyGoal(host: CommandHost, ctx: GoalCommandContext, copyText: CopyText): Promise<void> {
  const goal = host.getGoal();
  if (!goal) {
    ctx.ui.notify("No goal is set.", "warning");
    return;
  }
  const result = await copyText(goal.objective);
  if (!result.ok) {
    ctx.ui.notify(result.message ? `Could not copy the goal: ${result.message}` : "Could not copy the goal.", "error");
    return;
  }
  ctx.ui.notify("Goal copied.");
}

function clearGoal(host: CommandHost, ctx: GoalCommandContext): void {
  if (!host.getGoal()) {
    ctx.ui.notify("No goal is set.", "warning");
    return;
  }
  host.clearGoal("command", ctx);
  ctx.ui.notify("Goal cleared.");
}

function cancelAutoResume(host: CommandHost, ctx: GoalCommandContext): void {
  const current = host.getGoal();
  if (!current) {
    ctx.ui.notify("No goal is set.", "warning");
    return;
  }
  host.cancelProviderLimitAutoResume(current.goalId, ctx);
  ctx.ui.notify("Automatic resume cancelled. /goal resume carries on when you're ready.");
}

async function ask(ctx: GoalCommandContext, title: string, hint: string): Promise<string | undefined> {
  const { input } = ctx.ui;
  if (!input) return undefined;
  const text = await askText({ mode: ctx.mode, ui: { input, theme: ctx.ui.theme } }, title, hint);
  return text?.trim() || undefined;
}

async function openMenu(pi: GoalCommandPi, host: CommandHost, ctx: GoalCommandContext, copyText: CopyText): Promise<void> {
  const goal = host.getGoal();
  const choice = await showMenu(ctx, goalMenu(goal, goal ? host.isProviderLimitAutoResumeScheduled(goal.goalId) : false));
  switch (choice?.id) {
    case "pause":
    case "resume":
      return pauseOrResume(pi, host, choice.id, ctx);
    case "cancel-auto":
      return cancelAutoResume(host, ctx);
    case "copy":
      return copyGoal(host, ctx, copyText);
    case "clear":
      return clearGoal(host, ctx);
    case "set": {
      const objective = await ask(ctx, "New goal", "what should be true when the work is done");
      if (objective) await setObjective(pi, host, objective, ctx, true);
      return;
    }
    case "strict": {
      const task = await ask(ctx, "Task for a strict goal", "describe the task; the agent writes the goal and starts");
      if (task) startStrictGoal(pi, host, task, ctx);
      return;
    }
  }
}

export async function handleGoalCommand(
  pi: GoalCommandPi,
  host: CommandHost,
  args: string,
  ctx: GoalCommandContext,
  copyText: CopyText = copyTextToClipboard,
): Promise<void> {
  const { word, rest } = splitArgs(args);
  if (!word) {
    if (canShowMenu(ctx)) return openMenu(pi, host, ctx, copyText);
    ctx.ui.notify(formatGoalSummary(host.getGoal()));
    return;
  }

  if (word === "strict") {
    if (rest) return startStrictGoal(pi, host, rest, ctx);
    const task = canShowMenu(ctx) ? await ask(ctx, "Task for a strict goal", "describe the task; the agent writes the goal and starts") : undefined;
    if (task) startStrictGoal(pi, host, task, ctx);
    else if (!canShowMenu(ctx)) ctx.ui.notify("Write the task after it, like: /goal strict ship the release with every test green", "error");
    return;
  }

  if (!rest) {
    if (word === "pause" || word === "resume") return pauseOrResume(pi, host, word, ctx);
    if (word === "clear") return clearGoal(host, ctx);
    if (word === "copy") return copyGoal(host, ctx, copyText);
    // one word is far more often a mistyped command than a goal, so it is only set once confirmed
    const objective = args.trim();
    if (ctx.hasUI && (await ctx.ui.confirm(`Set the goal to "${objective}"?`, `pause, resume, clear and copy are the commands; anything else is a goal. ${SET_HINT}`))) {
      return setObjective(pi, host, objective, ctx, false);
    }
    ctx.ui.notify(`/goal has no "${word}". Try: pause, resume, clear, copy, or strict <task>. ${SET_HINT}`, "error");
    return;
  }

  if (word === "resume" && rest.toLowerCase() === "cancel") return cancelAutoResume(host, ctx);
  await setObjective(pi, host, args.trim(), ctx, false);
}

export function registerGoalCommand(pi: GoalCommandPi, host: CommandHost): void {
  pi.registerCommand("goal", {
    description: "Give the agent a goal it keeps working on until it's done",
    getArgumentCompletions: (prefix) => completeWords(GOAL_WORDS, prefix),
    async handler(args: string, ctx: ExtensionCommandContext) {
      await handleGoalCommand(pi, host, args, ctx);
    },
  });
}
