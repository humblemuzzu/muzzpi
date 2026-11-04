import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { goalToolResponse, toToolText, type GoalToolResponse } from "./format.ts";
import { createGoal, parseTokenBudgetPolicy, replaceGoal, type TokenBudgetPolicy } from "./state.ts";
import { TOOL_PROMPT_GUIDELINES } from "./prompts.ts";
import type { GoalEntrySource, GoalResult, ThreadGoal } from "./types.ts";

function StringEnum<const T extends readonly string[]>(values: T, options: { description: string }) {
  return Type.Unsafe<T[number]>({ type: "string", enum: values, description: options.description });
}

const EmptyParams = Type.Object({});

function createGoalParams(policy: TokenBudgetPolicy) {
  return Type.Object({
    objective: Type.String({
      description: "Concrete objective to pursue until completion.",
    }),
    ...(policy === "disabled" ? {} : {
      token_budget: Type.Optional(Type.Integer({
        description: `Optional token budget of at least ${policy}; omit for unlimited.`,
        minimum: policy,
        maximum: Number.MAX_SAFE_INTEGER,
      })),
    }),
    replace_existing: Type.Optional(Type.Boolean({
      description:
        "Replace an existing non-complete goal. Use only when the user explicitly asks to set a new goal over the current one.",
    })),
  }, policy === "disabled" ? { additionalProperties: false } : {});
}

const UpdateGoalParams = Type.Object({
  status: StringEnum(["complete", "blocked", "waiting"] as const, {
    description: "Complete only when no required work remains; waiting only while background work that reports back by itself runs; blocked only when missing input or external work prevents meaningful progress.",
  }),
  reason: Type.Optional(Type.String({ minLength: 1, description: "Required for waiting: name the background work. Required for blocked: explain the missing input or external dependency." })),
});

export interface ToolHost {
  getGoal(): ThreadGoal | null;
  setGoal(goal: ThreadGoal, source: GoalEntrySource, ctx: ExtensionContext): void;
  updateGoal(source: GoalEntrySource, ctx: ExtensionContext, toolCallId: string, status: "complete" | "blocked" | "waiting", reason?: string): GoalResult;
}

function textResult(
  text: string,
  goal: ThreadGoal | null,
  includeCompletionBudgetReport = false,
): AgentToolResult<GoalToolResponse & { error: string | null }> {
  return {
    content: [{ type: "text", text }],
    details: { ...goalToolResponse(goal, includeCompletionBudgetReport), error: null },
  };
}

function throwToolError(message: string): never {
  throw new Error(message);
}

export function registerGoalTools(pi: ExtensionAPI, host: ToolHost): void {
  const policy = parseTokenBudgetPolicy(process.env.PI_CODEX_GOAL_TOKEN_BUDGET_POLICY);
  pi.registerTool({
    name: "get_goal",
    label: "Get Goal",
    description: "Get the current goal and its usage.",
    promptGuidelines: TOOL_PROMPT_GUIDELINES,
    parameters: EmptyParams,
    async execute() {
      const goal = host.getGoal();
      return textResult(toToolText(goal), goal);
    },
  });

  pi.registerTool({
    name: "create_goal",
    label: "Create Goal",
    description: "Create a long-running goal, pursued until complete or blocked.",
    promptGuidelines: TOOL_PROMPT_GUIDELINES,
    parameters: createGoalParams(policy),
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const current = host.getGoal();
      if (policy === "disabled" && params.token_budget !== undefined) {
        throwToolError("Explicit token budgets are disabled; omit token_budget for unlimited.");
      }
      const tokenBudget = params.token_budget;
      if (tokenBudget != null && typeof tokenBudget !== "number") {
        throwToolError("Token budget must be a number.");
      }
      const shouldReplaceExisting = params.replace_existing === true && current !== null && current.status !== "complete";
      const result = shouldReplaceExisting
        ? replaceGoal(params.objective, tokenBudget ?? null, policy)
        : createGoal(current, params.objective, tokenBudget ?? null, policy);
      if (!result.ok || !result.goal) {
        throwToolError(result.message);
      }
      host.setGoal(result.goal, "tool", ctx);
      return textResult(toToolText(result.goal), result.goal);
    },
  });

  pi.registerTool({
    name: "update_goal",
    label: "Update Goal",
    description:
      "Mark the goal complete after an evidence-backed audit, waiting with a reason while background work that reports back by itself runs, or blocked with a reason when missing input or external work stops progress. A waiting goal resumes on new input or that result; a blocked goal only on an explicit /goal resume.",
    promptGuidelines: TOOL_PROMPT_GUIDELINES,
    parameters: UpdateGoalParams,
    executionMode: "sequential",
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      if (params.status !== "complete" && params.status !== "blocked" && params.status !== "waiting") {
        throwToolError("Status must be complete, blocked or waiting.");
      }
      const result = host.updateGoal("tool", ctx, toolCallId, params.status, params.reason);
      if (!result.ok || !result.goal) {
        throwToolError(result.message);
      }
      const includeCompletionReport = result.goal.status === "complete";
      return textResult(toToolText(result.goal, includeCompletionReport), result.goal, includeCompletionReport);
    },
  });
}
