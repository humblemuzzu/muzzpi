/**
 * delegate — spawn a sub-agent for an independent chunk of work.
 *
 * PROVENANCE
 * ported from bdsqqq/dots `user/pi/packages/extensions/delegate/index.ts`
 * (MIT, commit e04b620), replacing our `task.ts`. adapted:
 *   - `@bds_pi/*` -> `./lib/*`, `typebox` -> `@sinclair/typebox`,
 *     `@earendil-works/*` -> `@mariozechner/*`
 *   - his DI wrapper / config plumbing dropped; tool lists are consts here,
 *     matching how finder/oracle/librarian are written in this repo
 *   - model and thinking level come from lib/agent-models.ts
 *   - `description` is optional with a derived fallback (see PARAMS below)
 *
 * WHAT IT ADDS OVER `Task`
 * continuation. a delegate child can be resumed by passing back the
 * `continueId` from its result, so a follow-up question costs one more turn
 * instead of re-establishing the entire context. `Task` always ran
 * `--no-session`, so every child was a dead end.
 */

import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { requireParam, resolveParam } from "./lib/params";
import { resolveAliases, SUB_AGENT_SESSION_DIR, unresumableReason } from "./lib/pi-spawn";
import { emptyAgentModels, modelParams, resolveRoute, type AgentModels } from "./lib/agent-models";
import { runSubAgent, toolError } from "./lib/run-sub-agent";
import { clip, firstLine, renderSubAgentResult } from "./lib/sub-agent-render";

const BUILTIN_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write"];
const EXTENSION_TOOLS = [
	"read", "grep", "find", "ls", "bash",
	"edit", "write", "format_file", "skill", "finder",
	"web_search", "read_web_page", "screenshot",
];

/**
 * the merged, deduped, alias-resolved allowlist piSpawn turns into `--tools`.
 * exported so tests can pin the exact tool surface a child actually receives —
 * testing the raw constants alone would drift from what the child gets, since
 * aliasing (glob -> find) and dedupe happen at the spawn seam.
 */
export function delegateAllowlist(): string[] {
	return resolveAliases([...BUILTIN_TOOLS, ...EXTENSION_TOOLS]);
}

/** parameter names models actually reach for, canonical first. */
const PROMPT_PARAMS = ["prompt", "task", "instructions", "query", "question"] as const;
const DESCRIPTION_PARAMS = ["description", "title", "summary"] as const;

export interface DelegateConfig {
	models?: AgentModels;
}

export function createDelegateTool(config: DelegateConfig = {}): ToolDefinition {
	const models = config.models ?? emptyAgentModels();
	return {
		name: "delegate",
		label: "Delegate",
		description:
			"Delegate a sub-task to a sub-agent.\n\n" +
			"Tools: read, grep, find, ls, bash, edit, write, format_file, skill, finder, " +
			"web_search, read_web_page, screenshot.\n\n" +
			"When to use delegate:\n" +
			"- Complex multi-step tasks that are independent of your current thread\n" +
			"- Work whose intermediate output would flood your context but is not needed afterwards\n" +
			"- Changes across many layers, once you have already planned them\n" +
			'- When the user asks you to launch an "agent" or "subagent"\n\n' +
			"When NOT to use delegate:\n" +
			"- A single logical task you can do yourself in a few tool calls\n" +
			"- Reading one file (use read), one search (use grep), one edit (use edit)\n" +
			"- When you are not yet sure what changes you want\n\n" +
			"How to use delegate:\n" +
			"- Run several delegates concurrently for independent work by issuing multiple tool calls in one message.\n" +
			"- The sub-agent shares no context with you: put everything it needs in `prompt`.\n" +
			"- Tell it how to verify its own work.\n" +
			"- To ask a follow-up of the SAME sub-agent, pass `continueId` from its previous result " +
			"instead of starting a new delegate — it keeps its full history.\n\n" +
			'Example: delegate({ prompt: "In /repo, convert src/auth/*.ts to strict mode. Run `bun test` and report failures.", description: "auth strict mode" })',

		parameters: Type.Object({
			prompt: Type.String({
				description:
					"The task for the sub-agent. It shares none of your context, so include the working " +
					"directory, the goal, the files involved, and how to verify success. " +
					`(Also accepted: ${PROMPT_PARAMS.slice(1).join(", ")}.)`,
			}),
			description: Type.Optional(
				Type.String({
					description:
						"Short label for the task, shown to the user. Defaults to the first line of the prompt.",
				}),
			),
			continueId: Type.Optional(
				Type.String({
					description:
						"Resume a previous delegate child by the continueId returned in its result. The child keeps its full conversation history.",
				}),
			),
			...modelParams(models, "delegate"),
		}),

		async execute(_toolCallId, params: any, signal, onUpdate, ctx) {
			const prompt = requireParam(params, PROMPT_PARAMS, "delegate");
			if ("error" in prompt) return prompt.error as any;
			const continueId = resolveParam(params, ["continueId", "continue_id", "sessionId"]);
			const unresumable = continueId && unresumableReason(continueId, ctx.cwd, "delegate");
			if (unresumable) return toolError(unresumable);
			const route = resolveRoute(models, "delegate", params, ctx.modelRegistry, !!continueId);
			if ("error" in route) return toolError(route.error);

			return runSubAgent({
				agent: "delegate",
				label: resolveParam(params, DESCRIPTION_PARAMS) ?? firstLine(prompt.value, "delegated task"),
				working: "(working...)",
				returnImages: true,
				ctx,
				signal,
				onUpdate,
				spawn: {
					task: prompt.value,
					model: route.model,
					thinkingLevel: route.thinking,
					builtinTools: BUILTIN_TOOLS,
					extensionTools: EXTENSION_TOOLS,
					// sub-agent directory so resumable children never clutter /resume.
					session: { id: continueId, persist: true, dir: SUB_AGENT_SESSION_DIR },
				},
			});
		},

		renderCall(args: any, theme: any, context: any) {
			const text = context?.lastComponent ?? new Text("", 0, 0);
			const raw =
				args?.description ||
				(typeof args?.prompt === "string" ? firstLine(args.prompt, "") : "") ||
				"...";
			const marker = args?.continueId ? "Delegate ↻ " : "Delegate ";
			text.setText(theme.fg("toolTitle", theme.bold(marker)) + theme.fg("dim", clip(raw, 80)));
			return text;
		},

		renderResult: renderSubAgentResult("Delegate"),
	};
}
