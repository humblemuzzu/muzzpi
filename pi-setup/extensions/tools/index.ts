/**
 * tools extension — custom tool implementations for pi.
 *
 * replaces pi's built-in tools with versions that add:
 * - file mutex locking (edit, write, bash, format_file, undo_edit)
 * - file change tracking for undo_edit (disk-persisted, branch-aware)
 *
 * file changes persist to ~/.pi/file-changes/{sessionId}/ as JSON files
 * keyed by tool call ID. branch awareness comes from the conversation
 * tree — tool call IDs in assistant messages are inherently branch-scoped.
 *
 * PI_READ_COMPACT=1 switches read/ls to tighter limits for sub-agents.
 * shared infrastructure lives in ./lib/.
 */

import type { ExtensionAPI, Skill } from "@mariozechner/pi-coding-agent";
import { matchesKey } from "@mariozechner/pi-tui";
import { createReadTool, NORMAL_LIMITS, COMPACT_LIMITS } from "./read";
import { createLsTool } from "./ls";
import { createEditTool, createWriteTool } from "./edit-write";
import { createGrepTool } from "./grep";
import { createGlobTool } from "./glob";
import { createBashTool } from "./bash";
import { createRedoEditTool, createUndoEditTool } from "./undo-edit";
import { createFormatFileTool } from "./format-file";
import { createSkillTool } from "./skill";
import { createScreenshotTool } from "./screenshot";
import { createFinderTool } from "./finder";
import { createOracleTool } from "./oracle";
import { createDelegateTool } from "./delegate";
import { createChadTool } from "./chad";
import { createLibrarianTool } from "./librarian";
import { createCodeReviewTool } from "./code-review";
import { createReadWebPageTool } from "./read-web-page";
import { createConfiguredWebSearchTool } from "./web-search";
import { createSearchSessionsTool } from "./search-sessions";
import { createReadSessionTool } from "./read-session";
import { createAskTool } from "./ask";
import { createAgentsTool, renderAgentResult } from "./agents";
import { AGENT_RESULT_TYPE, AGENT_RUNS_CHANNEL } from "./lib/agent-channel";
import { AGENT_RUN_ENTRY, AgentRuns } from "./lib/agent-runs";
import { SUB_AGENT_TOOLS_ENV } from "./lib/sub-agent-prompt";
import { readAgentPrompt } from "./lib/pi-spawn";
import { AGENT_MODELS_FILE, auditAgentModels, loadAgentModels } from "./lib/agent-models";
import {
	createReadGithubTool,
	createSearchGithubTool,
	createListDirectoryGithubTool,
	createListRepositoriesTool,
	createGlobGithubTool,
	createCommitSearchTool,
	createDiffTool,
} from "./github";
import {
	loadSecrets,
	hasScrubbableContent,
	makeScrubber,
	scrubToolResult,
	setActiveTags,
	getActiveTags,
	saveSecret,
	type SecretEntry,
} from "./lib/psst";
import { requestApproval } from "./lib/approval";
import { setBlockedReporter } from "./lib/choice-dialog";
import { describeMcpCall, destructiveMcpReason, mcpCallOf } from "./lib/destructive-mcp";

export default function (pi: ExtensionAPI) {
	const limits = process.env.PI_READ_COMPACT ? COMPACT_LIMITS : NORMAL_LIMITS;
	// read once: the schema enums and the resolver must agree for the whole session.
	const models = loadAgentModels();
	const runs = new AgentRuns({
		notify: (content, details, wake) =>
			pi.sendMessage({ customType: AGENT_RESULT_TYPE, content, display: true, details }, wake ? { triggerTurn: true, deliverAs: "steer" } : {}),
		broadcast: (snapshot) => pi.events.emit(AGENT_RUNS_CHANNEL, snapshot),
		record: (entry) => pi.appendEntry(AGENT_RUN_ENTRY, entry),
	});

	pi.registerTool(createReadTool(limits));
	pi.registerTool(createLsTool(limits));
	// same names as pi's built-ins, so these replace them.
	pi.registerTool(createEditTool());
	pi.registerTool(createWriteTool());
	pi.registerTool(createGrepTool());
	pi.registerTool(createGlobTool());
	pi.registerTool(createBashTool());
	pi.registerTool(createUndoEditTool());
	// redo is only safe because it refuses when the file moved on since the
	// undo; see the invalidation check in undo-edit.ts.
	pi.registerTool(createRedoEditTool());
	pi.registerTool(createFormatFileTool());
	let skills: readonly Skill[] = [];
	pi.on("before_agent_start", (event) => {
		skills = event.systemPromptOptions.skills ?? [];
	});
	pi.registerTool(createSkillTool(() => skills));
	// screenshot owns the ONLY sanctioned path from screen pixels to a vision
	// model. permissions.json rejects `screencapture`/`sips -Z` in bash so this
	// cannot be routed around by hand — see lib/vision.ts for why that matters.
	pi.registerTool(createScreenshotTool());
	pi.registerTool(createFinderTool({
		systemPrompt: readAgentPrompt("agent.amp.finder.md"),
		models,
		runs,
	}));
	pi.registerTool(createOracleTool({
		systemPrompt: readAgentPrompt("agent.amp.oracle.md"),
		models,
		runs,
	}));
	pi.registerTool(createDelegateTool({ models, runs }));
	// chad is delegate's read-only counterpart: no edit/write, and its bash
	// runs under the read-only policy in lib/read-only-bash.ts.
	pi.registerTool(createChadTool({
		systemPrompt: readAgentPrompt("agent.amp.chad.md"),
		models,
		runs,
	}));
	pi.registerTool(createLibrarianTool({
		systemPrompt: readAgentPrompt("agent.amp.librarian.md"),
		models,
		runs,
	}));
	pi.registerTool(createCodeReviewTool({
		systemPrompt: readAgentPrompt("prompt.amp.code-review-system.md"),
		reportFormat: readAgentPrompt("prompt.amp.code-review-report.md"),
		models,
		runs,
	}));
	pi.registerTool(createAgentsTool(runs));
	pi.registerMessageRenderer(AGENT_RESULT_TYPE, renderAgentResult);
	pi.registerTool(createReadWebPageTool({
		systemPrompt: readAgentPrompt("prompt.amp.read-web-page.md"),
		models,
	}));
	// web_search resolves its own config and may be disabled there, in which case
	// we register nothing rather than advertising a tool that cannot run.
	const webSearchTool = createConfiguredWebSearchTool();
	if (webSearchTool) pi.registerTool(webSearchTool);

	pi.registerTool(createSearchSessionsTool());
	pi.registerTool(createReadSessionTool({ models }));
	pi.registerTool(createAskTool());
	// herdr's own pi extension listens for this; without herdr nobody does.
	setBlockedReporter((active, label) => pi.events.emit("herdr:blocked", { active, label }));

	let stopDetachKey: (() => void) | undefined;
	pi.on("session_start", (event, ctx) => {
		runs.restore(ctx.sessionManager.getBranch());
		const handoff = event.reason === "reload" ? AgentRuns.takeReloadHandoff() : undefined;
		if (handoff) runs.adoptReload(handoff);
		if (ctx.mode === "tui") {
			// not a registered shortcut: Ctrl+B stays the editor's cursor-left unless a blocking agent runs
			stopDetachKey = ctx.ui.onTerminalInput((data) => (matchesKey(data, "ctrl+b") && runs.detachForeground() ? { consume: true } : undefined));
		}
		if (!ctx.hasUI || process.env[SUB_AGENT_TOOLS_ENV]?.trim()) return;
		try {
			const problems = auditAgentModels(models, ctx.modelRegistry);
			if (problems.length > 0) {
				ctx.ui.notify(`agent-models (${AGENT_MODELS_FILE}):\n${problems.map((p) => `  • ${p}`).join("\n")}`, "warning");
			}
		} catch {}
	});

	pi.on("session_shutdown", async (event) => {
		stopDetachKey?.();
		stopDetachKey = undefined;
		await runs.shutdown(event.reason === "reload");
	});

	// github tools — used by librarian sub-agent, also available to main agent
	pi.registerTool(createReadGithubTool());
	pi.registerTool(createSearchGithubTool());
	pi.registerTool(createListDirectoryGithubTool());
	pi.registerTool(createListRepositoriesTool());
	pi.registerTool(createGlobGithubTool());
	pi.registerTool(createCommitSearchTool());
	pi.registerTool(createDiffTool());

	// bash asks in its own execute; MCP calls are someone else's tool, so they are asked here.
	pi.on("tool_call", async (event, ctx) => {
		const call = mcpCallOf(event.toolName, event.input);
		const reason = call && destructiveMcpReason(call);
		if (!call || !reason) return;
		const answer = await requestApproval(
			ctx,
			{ tool: "mcp", command: describeMcpCall(call), reasons: [reason], hosts: [], where: `through MCP (${call.server}/${call.tool})` },
			ctx.signal,
		);
		return answer.approved ? undefined : { block: true, reason: answer.message, terminate: answer.stop };
	});

	// ── psst secret management hooks ──────────────────────────

	// scrub ALL sensitive values from tool output — vault secrets, auth.json tokens, env var keys
	pi.on("tool_result", async (event) =>
		hasScrubbableContent(event) ? scrubToolResult(event, await makeScrubber()) : undefined,
	);

	pi.on("before_agent_start", async (event, ctx) => {
		if (ctx.model?.provider === "llama-local" || ctx.model?.provider === "llama.cpp") return;

		const secrets = await loadSecrets();
		if (secrets.length === 0) return;

		const names = secrets.map((s: SecretEntry) => s.name).join(", ");
		const tagNote = getActiveTags().length > 0
			? ` (filtered by tags: ${getActiveTags().join(", ")})`
			: "";
		const instruction = [
			"\n## psst — Secret Management",
			`Available secrets (injected as env vars in bash)${tagNote}: ${names}`,
			"Use $SECRET_NAME in bash commands to reference secrets. Never ask the user for secret values.",
			"Secret values are automatically scrubbed from command output.",
		].join("\n");

		event.systemPromptOptions.sections.psst = instruction.trim();
	});

	// /psst — list loaded secret names (never values)
	pi.registerCommand("psst", {
		description: "Show psst vault secret names and tags",
		handler: async (_args, ctx) => {
			const secrets = await loadSecrets();
			if (secrets.length === 0) {
				const hint = getActiveTags().length > 0
					? `No secrets matching tags: ${getActiveTags().join(", ")}`
					: "No psst secrets found. Run 'psst set <NAME>' to add secrets.";
				ctx.ui.notify(hint, "info");
				return;
			}

			const tagNote = getActiveTags().length > 0
				? ` (filtered by: ${getActiveTags().join(", ")})`
				: "";
			const formatLine = (s: SecretEntry) => {
				const tagStr = s.tags.length > 0 ? ` [${s.tags.join(", ")}]` : "";
				return `  • ${s.name}${tagStr}`;
			};
			const list = secrets.map(formatLine).join("\n");
			ctx.ui.notify(`Vault secrets${tagNote}:\n${list}`, "info");
		},
	});

	// /psst-set — add or update a secret in the vault
	pi.registerCommand("psst-set", {
		description: "Set a secret: /psst-set NAME [value] [tag1,tag2,...]",
		handler: async (args, ctx) => {
			const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
			let name = parts[0];
			let value = parts[1];
			let tagsRaw = parts[2];

			if (!name) {
				name = (await ctx.ui.input("Secret name (e.g. API_KEY):")) ?? "";
				if (!name) return ctx.ui.notify("Cancelled", "info");
			}

			if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
				return ctx.ui.notify(`Invalid name: ${name}. Must match [A-Z][A-Z0-9_]*`, "error");
			}

			if (!value) {
				value = (await ctx.ui.input(`Value for ${name}:`)) ?? "";
				if (!value) return ctx.ui.notify("Cancelled", "info");
			}

			if (tagsRaw === undefined) {
				tagsRaw = (await ctx.ui.input("Tags (comma-separated, optional):")) ?? "";
			}

			const tags = tagsRaw.split(",").map((t: string) => t.trim()).filter(Boolean);
			const badTag = tags.find((t) => t.startsWith("-"));
			if (badTag) return ctx.ui.notify(`Invalid tag: ${badTag}. Tags cannot start with "-"`, "error");

			const failure = await saveSecret(name, value, tags);
			if (failure) return ctx.ui.notify(`Failed to set secret: ${failure}`, "error");
			const tagSuffix = tags.length > 0 ? ` [${tags.join(", ")}]` : "";
			ctx.ui.notify(`Secret ${name} saved${tagSuffix}`, "success");
		},
	});

	// /psst-tag — filter which secrets are loaded by tag
	pi.registerCommand("psst-tag", {
		description: "Filter secrets by tag: /psst-tag [tag1,tag2] (no args = clear filter)",
		handler: async (args, ctx) => {
			const raw = (args ?? "").trim();

			if (!raw) {
				setActiveTags([]);
				ctx.ui.notify("psst: tag filter cleared — all vault secrets available", "info");
				return;
			}

			const tags = raw.split(",").map((t: string) => t.trim()).filter(Boolean);
			setActiveTags(tags);

			const matched = await loadSecrets();
			ctx.ui.notify(
				`psst: filtering by [${tags.join(", ")}] — ${matched.length} secret(s) match`,
				matched.length > 0 ? "success" : "info",
			);
		},
	});
}
