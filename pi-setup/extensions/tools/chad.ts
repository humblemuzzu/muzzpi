/**
 * chad — a read-only deep research sub-agent.
 *
 * WHAT IT IS FOR
 *
 * research at swarm scale. five or eight chads go out in one message, each on
 * its own question, and each returns a structured report instead of a pile of
 * file contents. the parent keeps its context for the work.
 *
 * WHY IT IS READ-ONLY
 *
 * two reasons, and the second is the one that shaped the tool surface.
 *
 * first: research is what a swarm is good at. six agents reading in parallel
 * compose; six agents writing in parallel need coordination our locks cannot
 * provide, because `lib/mutex.ts` is a module-level Map and every sub-agent is
 * a separate OS process.
 *
 * second: dropping `edit`/`write` is only half a constraint. bash writes. so the
 * child also runs under the read-only bash policy (lib/read-only-bash.ts),
 * enforced in its own process, not requested in its prompt.
 *
 */

import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { requireParam, resolveParam } from "./lib/params";
import { resolveAliases } from "./lib/pi-spawn";
import { emptyAgentModels, modelParams, type AgentModels } from "./lib/agent-models";
import { AgentRuns } from "./lib/agent-runs";
import { AGENT_SHELL, renderAgentCall, renderAgentRunResult } from "./lib/agent-inline";
import { firstLine } from "./lib/sub-agent-render";

/*
 * NO mutation tool of any kind: no edit, no write, no format_file, no undo_edit.
 * `bash` is present but runs under the read-only policy.
 *
 * `screenshot` is in — grok sees images. `oracle`/`finder`/`librarian` are out
 * because nesting one is a whole extra process for tools chad can call itself.
 * the seven github tools are here directly for the same reason. `chad`/`delegate`
 * are out — a swarm that spawns swarms is a fork bomb. `codemode` scripts
 * reach only the tools listed here, through the same hooks, so bash stays
 * read-only inside a script too.
 */
const BUILTIN_TOOLS = ["read", "grep", "find", "ls", "bash"];
const EXTENSION_TOOLS = [
	"read", "grep", "find", "ls", "bash", "skill", "codemode",
	"web_search", "read_web_page", "screenshot",
	"read_github", "search_github", "list_directory_github",
	"list_repositories", "glob_github", "commit_search", "diff",
];

/**
 * the merged, deduped, alias-resolved allowlist piSpawn turns into `--tools`
 * and exports to the child as its tool list. exported so tests can pin the
 * exact surface a chad child receives — testing the raw constants alone would
 * drift from what the child gets, since aliasing (glob -> find) and dedupe
 * happen at the spawn seam.
 */
export function chadAllowlist(): string[] {
	return resolveAliases([...BUILTIN_TOOLS, ...EXTENSION_TOOLS]);
}

/** parameter names models actually reach for, canonical first. */
const PROMPT_PARAMS = ["prompt", "task", "query", "question", "instructions"] as const;
const DESCRIPTION_PARAMS = ["description", "title", "summary"] as const;

export interface ChadConfig {
	systemPrompt?: string;
	models?: AgentModels;
	runs?: AgentRuns;
}

export function createChadTool(config: ChadConfig = {}): ToolDefinition {
	const models = config.models ?? emptyAgentModels();
	const runs = config.runs ?? new AgentRuns();
	return {
		name: "chad",
		label: "Chad",
		description:
			"Deep read-only research agent. Several can be launched at once for genuinely " +
			"parallel research.\n\n" +
			"Tools: read, grep, find, ls, bash (read-only), skill, web_search, read_web_page, " +
			"screenshot, and the seven GitHub tools.\n\n" +
			"IT CANNOT CHANGE ANYTHING. There is no edit or write, and bash is restricted to " +
			"read-only commands. Use it to find out; use delegate to do.\n\n" +
			"When to use chad:\n" +
			"- A question that needs a lot of reading to answer properly\n" +
			"- Several independent questions at once — issue one call per question, in a single message\n" +
			"- Research whose intermediate reading would flood your context but whose conclusion is small\n" +
			"- Tracing how something works across many files, repos, or the web\n\n" +
			"When NOT to use chad:\n" +
			"- Anything that must change a file (use delegate, or do it yourself)\n" +
			"- A single lookup you can do with read or grep\n" +
			"- A search for one symbol or exact string (use grep or finder)\n" +
			"- Architecture judgement or an expert second opinion (use oracle)\n\n" +
			"How to use chad:\n" +
			"- Give each chad ONE question and everything it needs to answer it: the working " +
			"directory, the files or repos to start from, and what a complete answer looks like.\n" +
			"- It shares none of your context. Do not refer to earlier conversation.\n" +
			"- It reports back as Answer / Evidence / Verified vs inferred / Gaps, with path:line " +
			"citations you can check.\n" +
			"- To redirect a running chad or push a finished one further, pass its `continueId` rather than " +
			"starting a new one — it keeps its full history.\n\n" +
			runs.backgroundNote +
			'Example: chad({ prompt: "In /repo, how does the session file get written and what names it? Start from src/session/. Answer with the exact function and path:line.", description: "session file naming" })',

		parameters: Type.Object({
			// required in the schema, which is what models actually trust.
			// requireParam() below stays as a safety net for providers that do not
			// enforce the schema and for models that guess an alias name.
			prompt: Type.String({
				description:
					"The research question. The agent shares none of your context, so include the " +
					"working directory, where to start looking, and what a complete answer looks like. " +
					"(Also accepted: task, query, question, instructions.)",
			}),
			description: Type.Optional(
				Type.String({
					description:
						"Short label for the task, shown to the user. Defaults to the first line of the prompt.",
				}),
			),
			...runs.params("chad"),
			...modelParams(models, "chad"),
		}),

		async execute(toolCallId, params: any, signal, onUpdate, ctx) {
			const prompt = requireParam(params, PROMPT_PARAMS, "chad");
			if ("error" in prompt) return prompt.error as any;
			return runs.launch(
				{
					agent: "chad",
					label: resolveParam(params, DESCRIPTION_PARAMS) ?? firstLine(prompt.value, "research task"),
					working: "(researching...)",
					returnImages: true,
					models,
					params,
					spawn: {
						task: prompt.value,
						readOnlyBash: true,
						builtinTools: BUILTIN_TOOLS,
						extensionTools: EXTENSION_TOOLS,
						systemPromptBody: config.systemPrompt,
					},
				},
				toolCallId,
				ctx,
				signal,
				onUpdate,
			);
		},

		renderCall(args: any, theme: any, context: any) {
			const raw =
				args?.description ||
				(typeof args?.prompt === "string" ? firstLine(args.prompt, "") : "") ||
				"...";
			return renderAgentCall(args?.continueId ? "Chad ↻" : "Chad", raw, theme, context);
		},

		renderShell: AGENT_SHELL,
		renderResult: renderAgentRunResult("Chad"),
	};
}
