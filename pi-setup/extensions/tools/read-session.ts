/**
 * read_session tool — extract relevant context from a pi session via sub-agent.
 *
 * loads a full session tree (all branches), renders it as structured markdown,
 * then spawns a sub-agent to extract only the information
 * relevant to the stated goal. the agent sees the complete tree — including
 * abandoned branches — so it can understand decision points and context.
 *
 * branch awareness: if a leaf_id is provided, the target branch is annotated
 * in the rendered output so the agent knows which path to focus on.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { PI_SESSIONS_DIR, SUB_AGENT_SESSION_DIR } from "./lib/pi-spawn";
import { emptyAgentModels, mainRoute, modelParams, resolveRoute, type AgentModels } from "./lib/agent-models";
import { runSubAgent, toolError } from "./lib/run-sub-agent";
import { clip, renderSubAgentResult } from "./lib/sub-agent-render";
import { headTailChars } from "./lib/output-buffer";

/** sub-agent sessions are included so a continueId from a delegate result is readable. */
const ALL_SESSION_DIRS = [PI_SESSIONS_DIR, SUB_AGENT_SESSION_DIR];
const MAX_CHARS = 120_000;

const DEFAULT_SYSTEM_PROMPT = `You are analyzing a pi coding agent session transcript. Extract information relevant to the user's goal. Be specific — cite file paths, decisions made, code patterns discussed. If a specific branch is marked as the target, focus on that branch but use other branches for context about what was tried and abandoned.`;

export interface ReadSessionConfig {
	systemPrompt?: string;
	models?: AgentModels;
}

// --- session parsing (shared types with search-sessions) ---

interface SessionEntry {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
	[key: string]: unknown;
}

interface MessageContent {
	role: string;
	content: Array<{
		type: string;
		text?: string;
		thinking?: string;
		name?: string;
		arguments?: Record<string, unknown>;
		[key: string]: unknown;
	}>;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	[key: string]: unknown;
}

// --- session rendering ---

function findSessionFile(sessionId: string): string | null {
	const roots = ALL_SESSION_DIRS.filter((dir) => fs.existsSync(dir));
	if (roots.length === 0) return null;

	const walkDir = (dir: string): string | null => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				const found = walkDir(full);
				if (found) return found;
			} else if (entry.name.endsWith(".jsonl") && entry.name.includes(sessionId)) {
				return full;
			}
		}
		return null;
	};

	// fast path: check filename contains session id
	for (const root of roots) {
		const found = walkDir(root);
		if (found) return found;
	}

	// slow path: parse headers
	const walkAndParse = (dir: string): string | null => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				const f = walkAndParse(full);
				if (f) return f;
			} else if (entry.name.endsWith(".jsonl")) {
				try {
					const firstLine = fs.readFileSync(full, "utf-8").split("\n")[0];
					const header = JSON.parse(firstLine);
					if (header.type === "session" && header.id === sessionId) return full;
				} catch { /* skip */ }
			}
		}
		return null;
	};

	for (const root of roots) {
		const found = walkAndParse(root);
		if (found) return found;
	}
	return null;
}

function renderSessionTree(
	filePath: string,
	targetLeafId?: string,
): { markdown: string; sessionName: string; sessionId: string } {
	const raw = fs.readFileSync(filePath, "utf-8");
	const lines = raw.split("\n").filter((l) => l.trim());

	const entries: SessionEntry[] = [];
	let sessionId = "";
	let sessionName = "";
	let cwd = "";
	let timestamp = "";

	for (const line of lines) {
		try {
			const entry = JSON.parse(line);
			if (entry.type === "session") {
				sessionId = entry.id;
				cwd = entry.cwd || "";
				timestamp = entry.timestamp || "";
			}
			if (entry.type === "session_info" && entry.name) {
				sessionName = entry.name;
			}
			if (entry.id) entries.push(entry);
		} catch { /* skip */ }
	}

	// build tree
	const byId = new Map<string, SessionEntry>();
	const children = new Map<string, string[]>();
	for (const e of entries) {
		byId.set(e.id, e);
		const parent = e.parentId ?? "__root__";
		if (!children.has(parent)) children.set(parent, []);
		children.get(parent)!.push(e.id);
	}

	// find target branch path (leaf → root) for annotation
	const targetPath = new Set<string>();
	if (targetLeafId) {
		let current = targetLeafId;
		while (current) {
			targetPath.add(current);
			const entry = byId.get(current);
			if (!entry?.parentId) break;
			current = entry.parentId;
		}
	}

	// detect branch points (entries with >1 child)
	const branchPoints = new Set<string>();
	for (const [parentId, kids] of children.entries()) {
		if (kids.length > 1) branchPoints.add(parentId);
	}

	// render as markdown via DFS
	const parts: string[] = [];
	parts.push(`# session: ${sessionName || sessionId}`);
	parts.push(`id: ${sessionId}`);
	parts.push(`workspace: ${cwd}`);
	parts.push(`started: ${timestamp}`);
	if (targetLeafId) parts.push(`target branch leaf: ${targetLeafId}`);
	parts.push("");

	let branchCounter = 0;

	const renderEntry = (entryId: string, depth: number) => {
		const entry = byId.get(entryId);
		if (!entry) return;

		const isTarget = targetPath.has(entryId);
		const marker = isTarget ? " [TARGET BRANCH]" : "";

		// check if this is a branch point
		const kids = children.get(entryId) || [];
		if (kids.length > 1) {
			branchCounter++;
			parts.push(`\n--- branch point (${kids.length} paths) ---\n`);
		}

		if (entry.type === "message") {
			const msg = (entry as any).message as MessageContent | undefined;
			if (!msg) return;

			if (msg.role === "user") {
				const textParts = msg.content
					?.filter((p) => p.type === "text")
					.map((p) => p.text)
					.join("\n") || "";
				if (textParts) {
					parts.push(`## user${marker}`);
					parts.push(textParts);
					parts.push("");
				}
			} else if (msg.role === "assistant") {
				const textParts: string[] = [];
				const toolCalls: string[] = [];

				for (const part of msg.content || []) {
					if (part.type === "text" && part.text) {
						textParts.push(part.text);
					} else if (part.type === "toolCall") {
						const args = part.arguments
							? JSON.stringify(part.arguments).slice(0, 200)
							: "";
						toolCalls.push(`${part.name}(${args})`);
					}
					// skip thinking blocks — they're internal
				}

				if (textParts.length > 0 || toolCalls.length > 0) {
					parts.push(`## assistant${marker}`);
					if (textParts.length > 0) parts.push(textParts.join("\n"));
					if (toolCalls.length > 0) {
						parts.push(`\ntool calls: ${toolCalls.join(", ")}`);
					}
					parts.push("");
				}
			} else if (msg.role === "toolResult") {
				const toolName = msg.toolName || "?";
				const textContent = msg.content
					?.filter((p) => p.type === "text")
					.map((p) => p.text)
					.join("\n") || "";
				// truncate tool results to avoid overwhelming the context
				const truncated = textContent.length > 500
					? `${textContent.slice(0, 500)}... (truncated)`
					: textContent;
				if (truncated) {
					parts.push(`### ${toolName} result${msg.isError ? " (ERROR)" : ""}${marker}`);
					parts.push(truncated);
					parts.push("");
				}
			}
		} else if (entry.type === "model_change") {
			parts.push(`*model changed to ${entry.modelId}*\n`);
		}

		// render children
		for (const childId of kids) {
			renderEntry(childId, depth + 1);
		}
	};

	// start from root entries (parentId is null or points to non-existent)
	const rootIds = children.get("__root__") || [];
	// also find entries whose parentId doesn't exist in byId (orphan roots)
	for (const e of entries) {
		if (e.parentId && !byId.has(e.parentId) && !rootIds.includes(e.id)) {
			rootIds.push(e.id);
		}
	}

	for (const rootId of rootIds) {
		renderEntry(rootId, 0);
	}

	let markdown = parts.join("\n");
	const truncated = headTailChars(markdown, MAX_CHARS);
	if (truncated.truncated) {
		markdown = truncated.text;
	}

	return { markdown, sessionName, sessionId };
}

// --- tool ---

export function createReadSessionTool(config: ReadSessionConfig = {}): ToolDefinition {
	const models = config.models ?? emptyAgentModels();
	return {
		name: "read_session",
		label: "Read Session",
		description:
			"Read and extract relevant content from a past pi session.\n\n" +
			"Loads the full session tree (all branches, including abandoned paths), " +
			"then uses AI to extract only the information relevant to your stated goal. " +
			`The AI sees the whole tree up to ${MAX_CHARS.toLocaleString("en-US")} characters; past that it gets the start and end with the middle cut.\n\n` +
			"Use `search_sessions` first to find session IDs and branch leaf IDs.\n\n" +
			"WHEN TO USE:\n" +
			"- Extracting context from a previous session\n" +
			"- Understanding what was tried and decided in a past session\n" +
			"- Continuing work from a prior session\n\n" +
			"WHEN NOT TO USE:\n" +
			"- Current session context (already available)\n" +
			"- Finding sessions (use search_sessions first)",

		parameters: Type.Object({
			session_id: Type.String({
				description: "The session ID to read (from search_sessions results).",
			}),
			goal: Type.String({
				description: "What information you're looking for. Be specific about what to extract.",
			}),
			leaf_id: Type.Optional(
				Type.String({
					description:
						"Optional branch leaf ID to focus on. The AI will see all branches " +
						"but prioritize the target branch.",
				}),
			),
			...modelParams(models, "read_session"),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const route = resolveRoute(models, "read_session", params, ctx.modelRegistry, false, mainRoute(ctx.model));
			if ("error" in route) return toolError(route.error);

			const sessionFile = findSessionFile(params.session_id);
			if (!sessionFile) return toolError(`session not found: ${params.session_id}`);

			const { markdown } = renderSessionTree(sessionFile, params.leaf_id);
			if (!markdown.trim()) {
				return { content: [{ type: "text" as const, text: "(session is empty)" }] } as any;
			}

			return runSubAgent({
				agent: "read_session",
				label: params.goal,
				working: "(reading session...)",
				ctx,
				signal,
				onUpdate,
				spawn: {
					task: `Here is a pi coding agent session transcript:\n\n${markdown}\n\n---\n\nExtract the information relevant to this goal: ${params.goal}`,
					model: route.model,
					thinkingLevel: route.thinking,
					builtinTools: ["read"],
					extensionTools: [],
					systemPromptBody: config.systemPrompt || DEFAULT_SYSTEM_PROMPT,
				},
			});
		},

		renderCall(args: any, theme: any, context: any) {
			const text = context?.lastComponent ?? new Text("", 0, 0);
			let label = theme.fg("toolTitle", theme.bold("read_session ")) + theme.fg("dim", args.goal ? clip(args.goal, 60) : "...");
			if (args.session_id) {
				const shortId = args.session_id.length > 8 ? args.session_id.slice(0, 8) : args.session_id;
				label += theme.fg("muted", ` (${shortId}...)`);
			}
			text.setText(label);
			return text;
		},

		renderResult: renderSubAgentResult("read_session"),
	};
}
