/**
 * code_review tool — structured diff review via a sub-agent.
 *
 * spawns a sub-agent that:
 * 1. runs git diff (or other bash command) based on diff_description
 * 2. reads changed files for context
 * 3. produces a Markdown report with per-comment severity/type
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
import { emptyAgentModels, modelParams, type AgentModels } from "./lib/agent-models";
import { AgentRuns, continueIdOf } from "./lib/agent-runs";
import { clip, getFinalOutput, isBackgroundStub, renderAgentTree, renderBackgroundStub, type SingleResult } from "./lib/sub-agent-render";
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

const DEFAULT_SYSTEM_PROMPT = `You are an expert code reviewer. Review the provided diff for bugs, security issues, and code quality. Report findings with file locations and severity. Include untracked files when the scope covers the working tree. Confirm each bug by running it or tracing it with file:line before reporting it. Never change anything: no file edits, installs or formatters, and no git command that changes state (add, commit, stash, checkout, switch, reset, restore); scratch files only inside a fresh \`mktemp -d\` directory.

Today's date: {date}
Current working directory (cwd): {cwd}`;

const DEFAULT_REPORT_FORMAT = `Write your review as Markdown: a "# Code review" title, a "## Summary" section, then "## Comments" holding one heading per finding, ordered by severity, written "### <severity> · <short title>" with the severity one of critical, high, medium or low. Under each heading write one bullet per line, in this order: "- **Filename:**" (relative to the repo root), "- **Start line:**", "- **End line:**", "- **Comment type:**" (bug, suggested_edit, compliment or non_actionable), "- **Text:**", "- **Why:**", "- **Checked:**" (for a bug: the command you ran and what it showed, the file:line path you traced, or "not verified", which caps it at medium), and "- **Fix:**" (left out for compliment and non_actionable).`;

export interface CodeReviewConfig {
	systemPrompt?: string;
	reportFormat?: string;
	models?: AgentModels;
	runs?: AgentRuns;
}

// --- Markdown parsing ---

interface ReviewComment {
	filename: string;
	startLine: number;
	endLine: number;
	severity: string;
	commentType: string;
	text: string;
	why: string;
	checked: string;
	fix: string;
}

const WRAPPED_IN_FENCE = /^\s*(`{3,}|~{3,})[^\n]*\n([\s\S]*)\n[ \t]*\1\s*$/;
const PROOF = /^[*_`]*(?:ran|traced)\b.*(?:→|->)/i;
const FENCED_BLOCK = /^[ \t]*(`{3,}|~{3,}).*$[\s\S]*?(?:^[ \t]*\1[ \t]*$|(?![\s\S]))/gm;
const COMMENTS_SECTION = /^##[ \t]+comments[ \t]*:?[ \t]*$/im;
const NEXT_SECTION = /^#{1,2}[ \t]/m;
const COMMENT_HEADING = /^###[ \t]+(.*)$/m;
const HEADING_SEVERITY = /^[^a-z]*(critical|high|medium|low)\b/i;

function labelPattern(label: string): RegExp {
	return new RegExp(`^[ \\t]*(?:[-*+]|\\d+[.)])?[ \\t]*\\*\\*${label}:?\\*\\*:?[ \\t]*(.*)$`, "im");
}

const LABELS = {
	filename: labelPattern("filename"),
	startLine: labelPattern("start line"),
	endLine: labelPattern("end line"),
	severity: labelPattern("severity"),
	commentType: labelPattern("comment type"),
	text: labelPattern("text"),
	why: labelPattern("why"),
	checked: labelPattern("checked"),
	fix: labelPattern("fix"),
};

type Vocabulary = ReadonlyArray<readonly [term: string, pattern: RegExp]>;

function vocabulary(terms: string[]): Vocabulary {
	return terms.map((term) => [term, new RegExp(`\\b${term.replaceAll("_", "[ _-]?")}\\b`, "i")] as const);
}

const SEVERITIES = vocabulary(["critical", "high", "medium", "low"]);
const COMMENT_TYPES = vocabulary(["bug", "suggested_edit", "compliment", "non_actionable"]);

function field(block: string, label: RegExp): string {
	const match = block.match(label);
	return match ? match[1].trim().replace(/^(?:`([^`]*)`|\*\*([^*]*)\*\*)$/, "$1$2") : "";
}

function keyword(value: string, terms: Vocabulary): string {
	let found = "";
	let at = Infinity;
	for (const [term, pattern] of terms) {
		const index = value.search(pattern);
		if (index !== -1 && index < at) {
			found = term;
			at = index;
		}
	}
	return found;
}

function commentsSection(output: string): string {
	const start = output.match(COMMENTS_SECTION);
	if (start?.index === undefined) return output;
	const rest = output.slice(start.index + start[0].length);
	const end = rest.search(NEXT_SECTION);
	return end === -1 ? rest : rest.slice(0, end);
}

interface Block {
	heading: string;
	body: string;
}

function blocksOf(section: string): Block[] {
	const parts = section.split(COMMENT_HEADING);
	const blocks: Block[] = [];
	for (let i = 1; i < parts.length; i += 2) blocks.push({ heading: parts[i], body: parts[i + 1] ?? "" });
	return blocks;
}

function commentBlocks(output: string): Block[] {
	const report = output.match(WRAPPED_IN_FENCE)?.[2] ?? output;
	const outsideFences = blocksOf(commentsSection(report.replace(FENCED_BLOCK, "")));
	return outsideFences.length > 0 ? outsideFences : blocksOf(commentsSection(report));
}

function severityOf({ heading, body }: Block): string {
	return heading.match(HEADING_SEVERITY)?.[1].toLowerCase() ?? keyword(field(body, LABELS.severity), SEVERITIES);
}

function isUnverifiedBug(comment: ReviewComment): boolean {
	return comment.commentType === "bug" && !PROOF.test(comment.checked);
}

export function parseReviewMarkdown(output: string): ReviewComment[] {
	return commentBlocks(output).map((block) => ({
		filename: field(block.body, LABELS.filename),
		startLine: parseInt(field(block.body, LABELS.startLine), 10) || 0,
		endLine: parseInt(field(block.body, LABELS.endLine), 10) || 0,
		severity: severityOf(block),
		commentType: keyword(field(block.body, LABELS.commentType), COMMENT_TYPES),
		text: field(block.body, LABELS.text),
		why: field(block.body, LABELS.why),
		checked: field(block.body, LABELS.checked),
		fix: field(block.body, LABELS.fix),
	}));
}

export function formatReviewSummary(comments: ReviewComment[]): string {
	if (comments.length === 0) return "";

	const counts = new Map<string, number>();
	for (const c of comments) {
		const severity = c.severity || "unrated";
		counts.set(severity, (counts.get(severity) ?? 0) + 1);
	}

	const parts = [...SEVERITIES.map(([term]) => term), "unrated"]
		.filter((s) => counts.has(s))
		.map((s) => `${counts.get(s)} ${s}`);

	const unverified = comments.filter(isUnverifiedBug).length;
	const tail = unverified > 0 ? ` · ${unverified} unverified` : "";
	return `${comments.length} comment${comments.length !== 1 ? "s" : ""}: ${parts.join(", ")}${tail}`;
}

// --- tool ---

export function createCodeReviewTool(config: CodeReviewConfig = {}): ToolDefinition {
	const models = config.models ?? emptyAgentModels();
	const runs = config.runs ?? new AgentRuns();
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
			runs.backgroundNote +
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
			...runs.params("code_review"),
			...modelParams(models, "code_review"),
		}),

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const resolved = requireParam(
				params as Record<string, unknown>,
				CODE_REVIEW_PARAM_NAMES,
				"code_review",
			);
			if ("error" in resolved) return resolved.error;

			const parts: string[] = [`Review the following diff:\n${resolved.value}`];
			if (params.files && params.files.length > 0) {
				parts.push(`\nFocus the review on these files:\n${params.files.join("\n")}`);
			}
			if (params.instructions) {
				parts.push(`\nAdditional review instructions:\n${params.instructions}`);
			}

			return runs.launch(
				{
					agent: "code_review",
					label: resolved.value,
					working: "(reviewing...)",
					returnImages: true,
					models,
					params: params as Record<string, unknown>,
					spawn: {
						task: parts.join("\n"),
						builtinTools: BUILTIN_TOOLS,
						extensionTools: EXTENSION_TOOLS,
						systemPromptBody: config.systemPrompt || DEFAULT_SYSTEM_PROMPT,
						followUp: continueIdOf(params as Record<string, unknown>) ? undefined : config.reportFormat || DEFAULT_REPORT_FORMAT,
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
			if (isBackgroundStub(details)) {
				renderBackgroundStub(details, container, theme);
				return container;
			}
			if (!details) {
				const text = result.content[0];
				container.addChild(new Text(text?.type === "text" ? normalizeForDisplay(text.text) : "(no output)", 0, 0));
				return container;
			}

			const output = getFinalOutput(details.messages);
			const comments = parseReviewMarkdown(output);
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
