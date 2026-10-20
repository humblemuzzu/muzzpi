/**
 * oracle tool — expert technical advisor via a sub-agent.
 *
 * replaces the generic subagent(agent: "oracle", task: ...) pattern
 * with a dedicated tool. the model calls
 * oracle(task: "...", context?: "...", files?: [...]) directly.
 *
 * the oracle operates zero-shot: no follow-up questions, makes its
 * final message comprehensive. only the last assistant message is
 * returned to the parent agent.
 *
 * system prompt loaded from agents/agent.amp.oracle.md at init time.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { resolveAliases } from "./lib/pi-spawn";
import { emptyAgentModels, modelParams, type AgentModels } from "./lib/agent-models";
import { AgentRuns } from "./lib/agent-runs";
import { clip, renderSubAgentResult } from "./lib/sub-agent-render";
import { requireParam } from "./lib/params";

/** canonical name first; the rest are what models actually guess (see lib/params.ts). */
const ORACLE_PARAM_NAMES = ["task", "query", "prompt", "question", "description"] as const;

const BUILTIN_TOOLS = ["read", "grep", "find", "ls", "bash"];
/*
 * `screenshot` is here so the oracle can look at a rendering bug rather than
 * reason about it blind. `web_search` + `read_web_page` let it pull current
 * references when local information is insufficient — the agent prompt already
 * instructs this ("Use web tools only when local information is insufficient
 * or a current reference is needed"), so these tools now fulfil that line.
 * Screenshots return to the parent via `collectSubAgentImages` (most recent 2).
 */
const EXTENSION_TOOLS = [
	"read", "grep", "find", "ls", "bash",
	"web_search", "read_web_page", "screenshot",
];

/**
 * the merged, deduped, alias-resolved allowlist piSpawn turns into `--tools`.
 * exported so tests can pin the exact tool surface a child actually receives —
 * testing the raw constants alone would drift from what the child gets, since
 * aliasing (glob -> find) and dedupe happen at the spawn seam.
 */
export function oracleAllowlist(): string[] {
	return resolveAliases([...BUILTIN_TOOLS, ...EXTENSION_TOOLS]);
}

export interface OracleConfig {
	systemPrompt?: string;
	models?: AgentModels;
	runs?: AgentRuns;
}

export function createOracleTool(config: OracleConfig = {}): ToolDefinition {
	const models = config.models ?? emptyAgentModels();
	const runs = config.runs ?? new AgentRuns();
	return {
		name: "oracle",
		label: "Oracle",
		description:
			"Consult the oracle - an AI advisor powered by a reasoning model " +
			"that can plan, review, and provide expert guidance.\n\n" +
			"The oracle has access to tools: read, grep, find, ls, bash, web_search, " +
			"read_web_page, and screenshot.\n\n" +
			"The oracle returns a VERDICT: one recommendation, its trade-offs, and an " +
			"effort estimate. It is deliberately instructed to keep its own exploration " +
			"shallow and to lean on judgement, so give it the context it needs.\n\n" +
			"You should consult the oracle for:\n" +
			"- Code reviews and architecture feedback\n" +
			"- Diagnosing a difficult bug once you know where it lives\n" +
			"- Planning complex implementations or refactors\n" +
			"- Answering complex technical questions requiring deep reasoning\n" +
			"- Providing an alternative point of view\n\n" +
			"You should NOT consult the oracle for:\n" +
			"- File reads or simple keyword searches (use Read or Grep directly)\n" +
			"- Codebase searches (use finder)\n" +
			"- Establishing what the code actually does across many files (use chad, which " +
			"reads exhaustively and cites path:line \u2014 then hand its findings to the oracle " +
			"as `context` if a decision is still needed)\n" +
			"- Basic code modifications (do it yourself or use delegate)\n\n" +
			"Usage guidelines:\n" +
			"- Be specific about what you want reviewed, planned, or debugged\n" +
			"- Provide relevant context. If you know which files are involved, list them.\n\n" +
			runs.backgroundNote +
			'Example: oracle({ task: "is this retry loop correct under concurrent writes?", files: ["src/queue.ts"] })',

		parameters: Type.Object({
			task: Type.String({
				description:
					"The task or question for the oracle. Be specific about what guidance you need. " +
					"(Also accepted: query, prompt, question, description.)",
			}),
			context: Type.Optional(
				Type.String({
					description: "Optional context about the current situation or background information.",
				}),
			),
			files: Type.Optional(
				Type.Array(Type.String(), {
					description: "Optional file paths the oracle should examine.",
				}),
			),
			...runs.params("oracle"),
			...modelParams(models, "oracle"),
		}),

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const resolved = requireParam(params as Record<string, unknown>, ORACLE_PARAM_NAMES, "oracle");
			if ("error" in resolved) return resolved.error;

			const parts: string[] = [resolved.value];
			if (params.context) parts.push(`\nContext: ${params.context}`);
			if (params.files && params.files.length > 0) {
				for (const filePath of params.files) {
					const absolute = path.isAbsolute(filePath)
						? filePath
						: path.resolve(ctx.cwd, filePath);
					try {
						const content = fs.readFileSync(absolute, "utf-8");
						parts.push(`\nFile: ${filePath}\n\`\`\`\n${content}\n\`\`\``);
					} catch {
						parts.push(`\nFile: ${filePath} (could not read)`);
					}
				}
			}

			return runs.launch(
				{
					agent: "oracle",
					label: resolved.value,
					working: "(thinking...)",
					returnImages: true,
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
			const text = context?.lastComponent ?? new Text("", 0, 0);
			let label = theme.fg("toolTitle", theme.bold("oracle ")) + theme.fg("dim", args.task ? clip(args.task, 80) : "...");
			if (args.files?.length) {
				label += theme.fg("muted", ` (${args.files.length} file${args.files.length > 1 ? "s" : ""})`);
			}
			text.setText(label);
			return text;
		},

		renderResult: renderSubAgentResult("oracle"),
	};
}
