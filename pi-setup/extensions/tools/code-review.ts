/**
 * code_review tool — structured diff review via a sub-agent.
 *
 * spawns a sub-agent that:
 * 1. runs git diff (or other bash command) based on diff_description
 * 2. reads changed files for context
 * 3. produces XML <codeReview> report with per-comment severity/type
 *
 * review system prompt defines the expert reviewer role. report format
 * is injected as a follow-up message after exploration via piSpawn's
 * RPC mode — follow-up injection after exploration completes.
 *
 * v1: main review agent only.
 */

import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Container, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { resolveAliases } from "./lib/pi-spawn";
import { emptyAgentModels, modelParams, resolveRoute, type AgentModels } from "./lib/agent-models";
import { runSubAgent, toolError } from "./lib/run-sub-agent";
import { clip, getFinalOutput, renderAgentTree, type SingleResult } from "./lib/sub-agent-render";
import { normalizeForDisplay } from "./lib/box-format";
import { requireParam } from "./lib/params";

/** canonical name first; the rest are what models actually guess (see lib/params.ts). */
const CODE_REVIEW_PARAM_NAMES = ["diff_description", "task", "query", "prompt", "description"] as const;

/** sub-agent needs bash (git diff), read/grep/find (context), web tools (docs lookup) */
const BUILTIN_TOOLS = ["read", "grep", "find", "ls", "bash"];
const EXTENSION_TOOLS = [
	"read", "grep", "find", "ls", "bash", "codemode",
	"web_search", "read_web_page", "screenshot",
];

/**
 * the merged, deduped, alias-resolved allowlist piSpawn turns into `--tools`
 * and exports to the child as its tool list. exported so tests can pin the
 * exact surface a code_review child receives.
 */
export function codeReviewAllowlist(): string[] {
	return resolveAliases([...BUILTIN_TOOLS, ...EXTENSION_TOOLS]);
}

const DEFAULT_SYSTEM_PROMPT = `You are an expert code reviewer. Review the provided diff for bugs, security issues, and code quality. Report findings with file locations and severity.

Today's date: {date}
Current working directory (cwd): {cwd}`;

const DEFAULT_REPORT_FORMAT = `Emit findings as XML: <codeReview><comment> elements with filename, startLine, endLine, severity (critical/high/medium/low), commentType (bug/suggested_edit/compliment/non_actionable), text, why, and fix fields.`;

export interface CodeReviewConfig {
	systemPrompt?: string;
	reportFormat?: string;
	models?: AgentModels;
}

// --- XML parsing ---

interface ReviewComment {
	filename: string;
	startLine: number;
	endLine: number;
	severity: string;
	commentType: string;
	text: string;
	why: string;
	fix: string;
}

function parseReviewXml(output: string): ReviewComment[] {
	const comments: ReviewComment[] = [];
	const commentRegex = /<comment>([\s\S]*?)<\/comment>/g;
	let match: RegExpExecArray | null;

	while ((match = commentRegex.exec(output)) !== null) {
		const block = match[1];
		const get = (tag: string): string => {
			const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
			return m ? m[1].trim() : "";
		};
		comments.push({
			filename: get("filename"),
			startLine: parseInt(get("startLine"), 10) || 0,
			endLine: parseInt(get("endLine"), 10) || 0,
			severity: get("severity"),
			commentType: get("commentType"),
			text: get("text"),
			why: get("why"),
			fix: get("fix"),
		});
	}
	return comments;
}

function formatReviewSummary(comments: ReviewComment[]): string {
	if (comments.length === 0) return "";

	const bySeverity: Record<string, number> = {};
	for (const c of comments) {
		bySeverity[c.severity] = (bySeverity[c.severity] || 0) + 1;
	}

	const severityOrder = ["critical", "high", "medium", "low"];
	const parts = severityOrder
		.filter((s) => bySeverity[s])
		.map((s) => `${bySeverity[s]} ${s}`);

	return `${comments.length} comment${comments.length !== 1 ? "s" : ""}: ${parts.join(", ")}`;
}

// --- tool ---

export function createCodeReviewTool(config: CodeReviewConfig = {}): ToolDefinition {
	const models = config.models ?? emptyAgentModels();
	return {
		name: "code_review",
		label: "Code Review",
		description:
			"Review code changes, diffs, outstanding changes, or modified files. " +
			"Use when asked to review changes, check code quality, analyze uncommitted work, " +
			"or perform a code review.\n\n" +
			"It takes in a description of the diff or code change that can be used to generate " +
			"the full diff, which is then reviewed. When using this tool, do not invoke `git diff` " +
			"or any other tool to generate the diff but just pass a natural language description " +
			"of how to compute the diff in the diff_description argument.\n\n" +
			'Example: code_review({ diff_description: "uncommitted changes on the current branch vs HEAD" })',

		parameters: Type.Object({
			diff_description: Type.String({
				description:
					"A description of the diff or code change that can be used to generate the full diff. " +
					"This can include a git or bash command to generate the diff or a description of the diff " +
					"which can then be used to generate the git or bash command to generate the full diff. " +
					"(Also accepted: task, query, prompt, description.)",
			}),
			files: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Specific files to focus the review on. If empty, all changed files covered " +
						"by the diff description are reviewed.",
				}),
			),
			instructions: Type.Optional(
				Type.String({
					description: "Additional instructions to guide the review agent.",
				}),
			),
			...modelParams(models, "code_review"),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const resolved = requireParam(
				params as Record<string, unknown>,
				CODE_REVIEW_PARAM_NAMES,
				"code_review",
			);
			if ("error" in resolved) return resolved.error;
			const route = resolveRoute(models, "code_review", params, ctx.modelRegistry);
			if ("error" in route) return toolError(route.error);

			const parts: string[] = [`Review the following diff:\n${resolved.value}`];
			if (params.files && params.files.length > 0) {
				parts.push(`\nFocus the review on these files:\n${params.files.join("\n")}`);
			}
			if (params.instructions) {
				parts.push(`\nAdditional review instructions:\n${params.instructions}`);
			}

			return runSubAgent({
				agent: "code_review",
				label: resolved.value,
				working: "(reviewing...)",
				returnImages: true,
				ctx,
				signal,
				onUpdate,
				spawn: {
					task: parts.join("\n"),
					model: route.model,
					thinkingLevel: route.thinking,
					builtinTools: BUILTIN_TOOLS,
					extensionTools: EXTENSION_TOOLS,
					systemPromptBody: config.systemPrompt || DEFAULT_SYSTEM_PROMPT,
					followUp: config.reportFormat || DEFAULT_REPORT_FORMAT,
				},
			});
		},

		renderCall(args: any, theme: any, context: any) {
			const text = context?.lastComponent ?? new Text("", 0, 0);
			let label = theme.fg("toolTitle", theme.bold("code_review ")) + theme.fg("dim", clip(args.diff_description || "...", 70));
			if (args.files?.length) {
				label += theme.fg("muted", ` (${args.files.length} file${args.files.length > 1 ? "s" : ""})`);
			}
			text.setText(label);
			return text;
		},

		renderResult(result: any, { expanded }: { expanded: boolean }, theme: any, context: any) {
			const container = context?.lastComponent ?? new Container();
			container.clear();
			const details = result.details as SingleResult | undefined;
			if (!details) {
				const text = result.content[0];
				container.addChild(new Text(text?.type === "text" ? normalizeForDisplay(text.text) : "(no output)", 0, 0));
				return container;
			}

			// parse XML comments from output for summary line
			const output = getFinalOutput(details.messages);
			const comments = parseReviewXml(output);
			if (comments.length > 0) {
				const summary = formatReviewSummary(comments);
				container.addChild(
					new Text(theme.fg("accent", summary), 0, 0),
				);
			}

			renderAgentTree(details, container, expanded, theme, { label: "code_review", header: "statusOnly" });
			return container;
		},
	};
}
