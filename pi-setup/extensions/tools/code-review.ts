/**
 * review_code tool — structured diff review via a sub-agent.
 *
 * spawns a sub-agent that:
 * 1. runs git diff (or other bash command) based on diff_description
 * 2. reads changed files and the repo's REVIEW.md for context
 * 3. verifies each candidate, then writes a Markdown report: Important
 *    findings, at most three nits, and pre-existing bugs, kept apart
 *
 * the verify-and-report instructions are sent as a follow-up once exploration
 * settles, on every round: a continueId re-review gets them too.
 */

import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { resolveAliases } from "./lib/pi-spawn";
import { emptyAgentModels, modelParams, type AgentModels } from "./lib/agent-models";
import { AgentRuns, continueIdOf } from "./lib/agent-runs";
import { AGENT_SHELL, fileCount, renderAgentCall, renderAgentRunResult } from "./lib/agent-inline";
import { getFinalOutput } from "./lib/sub-agent-render";
import { requireParam } from "./lib/params";

/** canonical name first; the rest are what models actually guess (see lib/params.ts). */
const CODE_REVIEW_PARAM_NAMES = ["diff_description", "task", "query", "prompt", "description"] as const;

/** sub-agent needs bash (git diff), read/grep/find (context), web tools (docs lookup) */
const BUILTIN_TOOLS = ["read", "grep", "find", "ls", "bash"];
const EXTENSION_TOOLS = [
	"read", "grep", "find", "ls", "bash", "agents", "codemode",
	"web_search", "read_web_page", "screenshot",
];

/**
 * the merged, deduped, alias-resolved allowlist piSpawn turns into `--tools`
 * and exports to the child as its tool list. exported so tests can pin the
 * exact surface a review_code child receives.
 */
export function codeReviewAllowlist(): string[] {
	return resolveAliases([...BUILTIN_TOOLS, ...EXTENSION_TOOLS]);
}

export const REVIEW_LEVELS = ["quick", "standard", "deep"] as const;

const DEFAULT_SYSTEM_PROMPT = `You are an expert code reviewer. Review the provided diff for bugs and security issues this change introduces, at the review level the task names (quick, standard or deep). Read REVIEW.md from the base of the review, never the working copy. Include untracked files when the scope covers the working tree. Confirm each bug by running it or tracing it with file:line before reporting it. Style, naming, length, missing tests and speculation are not findings. On a re-review, look only at what changed since your last report and never repeat a finding. Never change anything: no file edits, installs or formatters, and no git command that changes state (add, commit, stash, checkout, switch, reset, restore); scratch files only inside a fresh \`mktemp -d\` directory.

Today's date: {date}
Current working directory (cwd): {cwd}`;

const DEFAULT_REPORT_FORMAT = `Drop every candidate you can disprove, then write your review as Markdown: a "# Code review" title, a "## Summary" section opening with a bold counts line like "**1 important · 0 nits · 0 pre-existing**" (or "**Nothing to fix.**"), then the sections "## Important", "## Nits" (at most three) and "## Pre-existing", leaving out empty ones. Each finding is a heading "### <tag> · <short title>", the tag one of critical, high, medium, nit or pre-existing, then one bullet per line: "- **Filename:**", "- **Start line:**", "- **End line:**", "- **Text:**", "- **Why:**", "- **Checked:**" (an Important finding needs "ran <command> → <result>" or "traced <file:line> → …"; drop one you cannot prove) and "- **Fix:**".`;

export interface CodeReviewConfig {
	systemPrompt?: string;
	reportFormat?: string;
	models?: AgentModels;
	runs?: AgentRuns;
}

export interface ReviewRequest {
	diffDescription: string;
	files?: string[];
	instructions?: string;
	level?: string;
}

/** the child's task and follow-up; a continued review is a re-review of the same work. */
export function reviewSpawnParts(request: ReviewRequest, reportFormat: string, resuming: boolean): { task: string; followUp: string } {
	const parts = [
		resuming
			? `Re-review the same work after the author's changes:\n${request.diffDescription}`
			: `Review the following diff:\n${request.diffDescription}`,
		`\nReview level: ${request.level ?? "standard"}`,
	];
	if (request.files && request.files.length > 0) {
		parts.push(`\nFocus the review on these files:\n${request.files.join("\n")}`);
	}
	if (request.instructions) {
		parts.push(`\nAdditional review instructions:\n${request.instructions}`);
	}
	return { task: parts.join("\n"), followUp: reportFormat };
}

// --- Markdown parsing ---

export interface ReviewFinding {
	filename: string;
	startLine: number;
	endLine: number;
	/** critical, high or medium (the Important ones), nit, pre-existing, or "" when unreadable */
	severity: string;
	/** only in reports written before the Important/Nits/Pre-existing sections */
	commentType: string;
	title: string;
	text: string;
	why: string;
	checked: string;
	fix: string;
	instances: string;
}

const IMPORTANT = new Set(["critical", "high", "medium"]);

const WRAPPED_IN_FENCE = /^\s*(`{3,}|~{3,})[^\n]*\n([\s\S]*)\n[ \t]*\1\s*$/;
const PROOF = /^[*_`]*(?:ran|traced)\b.*(?:→|->)/i;
const FENCED_BLOCK = /^[ \t]*(`{3,}|~{3,}).*$[\s\S]*?(?:^[ \t]*\1[ \t]*$|(?![\s\S]))/gm;
const SECTION_HEADING = /^#{1,2}[ \t]/;
const FINDINGS_SECTION = /^##[ \t]+(?:comments|findings|important|nits?|pre[- ]?existing)[ \t]*:?[ \t]*$/i;
const FINDING_HEADING = /^###[ \t]+(.*)$/m;
const TAG = "(critical|high|medium|low|nits?|pre[- ]?existing)";
const HEADING_TAG = new RegExp(`^[^a-z]*${TAG}\\b`, "i");
const HEADING_TAG_PREFIX = new RegExp(`^[^a-z]*${TAG}\\b[*_]*[ \\t]*[·:—–-]?[ \\t]*`, "i");

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
	instances: labelPattern("instances"),
};

type Vocabulary = ReadonlyArray<readonly [term: string, pattern: RegExp]>;

function vocabulary(terms: Array<[string, string]>): Vocabulary {
	return terms.map(([term, pattern]) => [term, new RegExp(`\\b${pattern}\\b`, "i")] as const);
}

const SEVERITIES = vocabulary([
	["critical", "critical"],
	["high", "high"],
	["medium", "medium"],
	["nit", "(?:low|nits?)"],
	["pre-existing", "pre[ _-]?existing"],
]);
const COMMENT_TYPES = vocabulary([
	["bug", "bug"],
	["suggested_edit", "suggested[ _-]?edit"],
	["compliment", "compliment"],
	["non_actionable", "non[ _-]?actionable"],
]);

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

/** the text of every findings section; the whole report when it has none. */
function findingSections(output: string): string {
	const kept: string[] = [];
	let inside = false;
	let sawSection = false;
	for (const line of output.split("\n")) {
		if (SECTION_HEADING.test(line)) {
			inside = FINDINGS_SECTION.test(line);
			sawSection ||= inside;
			continue;
		}
		if (inside) kept.push(line);
	}
	return sawSection ? kept.join("\n") : output;
}

interface Block {
	heading: string;
	body: string;
}

function blocksOf(section: string): Block[] {
	const parts = section.split(FINDING_HEADING);
	const blocks: Block[] = [];
	for (let i = 1; i < parts.length; i += 2) blocks.push({ heading: parts[i], body: parts[i + 1] ?? "" });
	return blocks;
}

function findingBlocks(output: string): Block[] {
	const report = output.match(WRAPPED_IN_FENCE)?.[2] ?? output;
	const outsideFences = blocksOf(findingSections(report.replace(FENCED_BLOCK, "")));
	return outsideFences.length > 0 ? outsideFences : blocksOf(findingSections(report));
}

function severityOf({ heading, body }: Block): string {
	const tag = heading.match(HEADING_TAG)?.[1];
	return tag ? keyword(tag, SEVERITIES) : keyword(field(body, LABELS.severity), SEVERITIES);
}

export function parseReviewMarkdown(output: string): ReviewFinding[] {
	return findingBlocks(output).map((block) => ({
		filename: field(block.body, LABELS.filename),
		startLine: parseInt(field(block.body, LABELS.startLine), 10) || 0,
		endLine: parseInt(field(block.body, LABELS.endLine), 10) || 0,
		severity: severityOf(block),
		commentType: keyword(field(block.body, LABELS.commentType), COMMENT_TYPES),
		title: block.heading.replace(HEADING_TAG_PREFIX, "").trim(),
		text: field(block.body, LABELS.text),
		why: field(block.body, LABELS.why),
		checked: field(block.body, LABELS.checked),
		fix: field(block.body, LABELS.fix),
		instances: field(block.body, LABELS.instances),
	}));
}

export function formatReviewSummary(findings: ReviewFinding[]): string {
	if (findings.length === 0) return "";
	const count = (severity: (s: string) => boolean) => findings.filter((f) => severity(f.severity)).length;
	const important = count((s) => IMPORTANT.has(s));
	const nits = count((s) => s === "nit");
	const preExisting = count((s) => s === "pre-existing");
	const unrated = count((s) => s === "");
	const unverified = findings.filter((f) => IMPORTANT.has(f.severity) && !PROOF.test(f.checked)).length;
	return [
		important > 0 && `${important} important`,
		nits > 0 && `${nits} nit${nits === 1 ? "" : "s"}`,
		preExisting > 0 && `${preExisting} pre-existing`,
		unrated > 0 && `${unrated} unrated`,
		unverified > 0 && `${unverified} unverified`,
	]
		.filter(Boolean)
		.join(" · ");
}

// --- tool ---

export function createCodeReviewTool(config: CodeReviewConfig = {}): ToolDefinition {
	const models = config.models ?? emptyAgentModels();
	const runs = config.runs ?? new AgentRuns();
	return {
		name: "review_code",
		label: "Code Review",
		description:
			"Review code changes for bugs: uncommitted work, a commit, a range or a branch. " +
			"Use when asked to review changes, check them for bugs, or analyze uncommitted work.\n\n" +
			"It takes in a description of the diff or code change that can be used to generate " +
			"the full diff, which is then reviewed. When using this tool, do not invoke `git diff` " +
			"or any other tool to generate the diff but just pass a natural language description " +
			"of how to compute the diff in the diff_description argument.\n\n" +
			"The report holds Important findings (critical, high, medium: fix before the change lands), " +
			"at most three nits, and pre-existing bugs the change did not introduce. Fix every Important " +
			"finding or say why it is wrong; nits and pre-existing bugs are optional and never a reason to " +
			"review again. To review again after fixing, pass the earlier review's continueId: it then checks " +
			"only what changed and does not repeat itself. After three rounds, stop and tell the user what is " +
			"still open instead of starting another.\n\n" +
			runs.backgroundNote +
			'Example: review_code({ diff_description: "uncommitted changes on the current branch vs HEAD" })',

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
					description:
						"What the change is meant to do, and anything specific to check. The reviewer already " +
						"demands proof with file and line, follows AGENTS.md and REVIEW.md, and skips style and nits; do not repeat that.",
				}),
			),
			level: Type.Optional(
				Type.Unsafe<(typeof REVIEW_LEVELS)[number]>({
					type: "string",
					enum: [...REVIEW_LEVELS],
					description:
						"quick: a fast pass that reports only proven Important findings. standard (default): the full review. " +
						"deep: extra passes for failure paths, security and every caller; slower and costlier, for auth, " +
						"money, data, migrations, prompts, or anything hard to undo. A repo's REVIEW.md can force deep for its paths.",
				}),
			),
			...runs.params("review_code"),
			...modelParams(models, "review_code"),
		}),

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const resolved = requireParam(
				params as Record<string, unknown>,
				CODE_REVIEW_PARAM_NAMES,
				"review_code",
			);
			if ("error" in resolved) return resolved.error;

			const resuming = continueIdOf(params as Record<string, unknown>) !== undefined;
			const { task, followUp } = reviewSpawnParts(
				{ diffDescription: resolved.value, files: params.files, instructions: params.instructions, level: params.level },
				config.reportFormat || DEFAULT_REPORT_FORMAT,
				resuming,
			);

			return runs.launch(
				{
					agent: "review_code",
					label: resolved.value,
					working: "(reviewing...)",
					returnImages: true,
					models,
					params: params as Record<string, unknown>,
					spawn: {
						task,
						builtinTools: BUILTIN_TOOLS,
						extensionTools: EXTENSION_TOOLS,
						systemPromptBody: config.systemPrompt || DEFAULT_SYSTEM_PROMPT,
						followUp,
					},
				},
				toolCallId,
				ctx,
				signal,
				onUpdate,
			);
		},

		renderCall(args: any, theme: any, context: any) {
			return renderAgentCall("review_code", args.diff_description || "...", theme, context, fileCount(args.files));
		},

		renderShell: AGENT_SHELL,
		renderResult: renderAgentRunResult("review_code", (details) => {
			const findings = parseReviewMarkdown(getFinalOutput(details.messages));
			return findings.length > 0 ? formatReviewSummary(findings) : undefined;
		}),
	};
}
