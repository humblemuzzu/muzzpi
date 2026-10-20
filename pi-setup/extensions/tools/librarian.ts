/**
 * librarian tool — cross-repo codebase understanding via a sub-agent.
 *
 * replaces the generic subagent pattern with a dedicated tool. the model
 * calls librarian(query: "...", repository?: [...], context?: "...") directly.
 *
 * SCHEMA IS THE CONTRACT. `query` is genuinely required and `repository` is a
 * real field, because the previous shape lied: the schema marked everything
 * optional while the prose said "REQUIRED", and the description talked about
 * "what repositories you want to understand" when no repository parameter
 * existed. a model asked to explore two specific repos could not trust the
 * spec, so it read this file to find the argument shape. see the tool-contract
 * invariants in tool-contract.test.ts, which now fail if that regresses.
 *
 * spawns a child pi constrained to the 7
 * github tools (read_github, search_github, list_directory_github,
 * list_repositories, glob_github, commit_search, diff). the librarian
 * explores repos thoroughly before providing comprehensive answers.
 *
 * system prompt loaded from agents/agent.amp.librarian.md at init time.
 */

import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { resolveAliases } from "./lib/pi-spawn";
import { emptyAgentModels, modelParams, type AgentModels } from "./lib/agent-models";
import { AgentRuns } from "./lib/agent-runs";
import { AGENT_SHELL, renderAgentCall, renderAgentRunResult } from "./lib/agent-inline";
import { requireParam, stringList } from "./lib/params";

/** canonical name first; the rest are what models actually guess (see lib/params.ts). */
const LIBRARIAN_PARAM_NAMES = ["query", "task", "prompt", "question", "description"] as const;

export interface LibrarianConfig {
	systemPrompt?: string;
	models?: AgentModels;
	runs?: AgentRuns;
}

/** github tools are extension tools, not builtins. */
const BUILTIN_TOOLS: string[] = [];
const EXTENSION_TOOLS = [
	"read_github",
	"search_github",
	"list_directory_github",
	"list_repositories",
	"glob_github",
	"commit_search",
	"diff",
];

/**
 * the merged, deduped, alias-resolved allowlist piSpawn turns into `--tools`
 * and exports to the child as its tool list. exported so tests can pin the
 * exact surface a librarian child receives (the seven github tools, and
 * nothing local).
 */
export function librarianAllowlist(): string[] {
	return resolveAliases([...BUILTIN_TOOLS, ...EXTENSION_TOOLS]);
}

export function createLibrarianTool(config: LibrarianConfig = {}): ToolDefinition {
	const models = config.models ?? emptyAgentModels();
	const runs = config.runs ?? new AgentRuns();
	return {
		name: "librarian",
		label: "Librarian",
		description:
			"The Librarian — a specialized codebase understanding agent that helps answer " +
			"questions about large, complex codebases across GitHub repositories.\n\n" +
			"The Librarian reads from GitHub — it can see public repositories and private " +
			"repositories you have access to via `gh` CLI auth.\n\n" +
			"WHEN TO USE THE LIBRARIAN:\n" +
			"- Understanding complex multi-repository codebases\n" +
			"- Exploring relationships between different repositories\n" +
			"- Analyzing architectural patterns across projects\n" +
			"- Finding specific implementations across codebases\n" +
			"- Understanding code evolution and commit history\n" +
			"- Getting comprehensive explanations of how features work\n\n" +
			"WHEN NOT TO USE THE LIBRARIAN:\n" +
			"- Simple local file reading (use Read directly)\n" +
			"- Local codebase searches (use finder)\n" +
			"- Code modifications (use other tools)\n\n" +
			"USAGE GUIDELINES:\n" +
			"- Name the repositories in `repository` (as owner/repo or a full URL)\n" +
			"- Provide context about what you're trying to achieve\n" +
			"- The Librarian explores thoroughly before providing comprehensive answers\n" +
			"- When getting an answer from the Librarian, show it to the user in full, do not summarize it.\n\n" +
			runs.backgroundNote +
			'Example: librarian({ repository: ["xai-org/grok-build"], query: "how are sub-agent results rendered in the TUI?" })',

		parameters: Type.Object({
			query: Type.String({
				description:
					"Your question about the codebase. Be specific about what you want to understand. " +
					"(Also accepted: task, prompt, question, description.)",
			}),
			repository: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Repositories to explore, each as 'owner/repo' or a full GitHub URL. " +
						"Pass several to compare across repos. Omit only if the query itself names them.",
				}),
			),
			context: Type.Optional(
				Type.String({
					description: "Optional context about what you're trying to achieve or background information.",
				}),
			),
			...runs.params("librarian"),
			...modelParams(models, "librarian"),
		}),

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const resolved = requireParam(params as Record<string, unknown>, LIBRARIAN_PARAM_NAMES, "librarian");
			if ("error" in resolved) return resolved.error;

			const parts: string[] = [resolved.value];
			// repository is structured input; the sub-agent only reads prose, so
			// surface it explicitly rather than hoping the query mentions it.
			const repos = stringList(params.repository);
			if (repos.length > 0) {
				parts.push(`\nRepositories to explore:\n${repos.map((r) => `- ${r}`).join("\n")}`);
			}
			if (params.context) parts.push(`\nContext: ${params.context}`);

			return runs.launch(
				{
					agent: "librarian",
					label: resolved.value,
					working: "(exploring...)",
					models,
					params: params as Record<string, unknown>,
					spawn: {
						task: parts.join("\n"),
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
			return renderAgentCall("librarian", args.query || "...", theme, context);
		},

		renderShell: AGENT_SHELL,
		renderResult: renderAgentRunResult("librarian"),
	};
}
