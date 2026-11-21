/**
 * tools extension — custom tool implementations for pi.
 *
 * replaces pi's built-in tools with versions that add:
 * - file mutex locking (edit, write, bash, undo_edit)
 * - file change tracking for undo_edit (disk-persisted, branch-aware)
 *
 * file changes persist to ~/.pi/file-changes/{sessionId}/ as JSON files
 * keyed by tool call ID, for 7 days after the session's last edit (pruned
 * 30 s after start). branch awareness comes from the conversation
 * tree — tool call IDs in assistant messages are inherently branch-scoped.
 *
 * shared infrastructure lives in ./lib/.
 */

import type { ExtensionAPI, Skill } from "@mariozechner/pi-coding-agent";
import { matchesKey } from "@mariozechner/pi-tui";
import { createReadTool, NORMAL_LIMITS } from "./read";
import { createLsTool } from "./ls";
import { createEditTool, createWriteTool } from "./edit-write";
import { createGrepTool } from "./grep";
import { createGlobTool } from "./glob";
import { createBashTool, renderJobResult } from "./bash";
import { createCommitTool } from "./commit";
import { BashJobs, JOB_RESULT_TYPE } from "./lib/bash-jobs";
import { createRedoEditTool, createUndoEditTool } from "./undo-edit";
import { createSkillTool } from "./skill";
import { isLocalProvider } from "./lib/local-providers";
import { createScreenshotTool } from "./screenshot";
import { createMplRenderTool } from "./mpl";
import { createFinderTool } from "./finder";
import { createOracleTool } from "./oracle";
import { createDelegateTool } from "./delegate";
import { createChadTool } from "./chad";
import { createLibrarianTool } from "./librarian";
import { createCodeReviewTool } from "./code-review";
import { configuredUsdPerCredit, createReadWebPageTool } from "./read-web-page";
import { createConfiguredWebSearchTool } from "./web-search";
import { createConfiguredXSearchTool } from "./x-search";
import { createSearchSessionsTool } from "./search-sessions";
import { createReadSessionTool } from "./read-session";
import { createAskTool } from "./ask";
import { createAgentsTool, renderAgentResult } from "./agents";
import { AGENT_CONTROL_CHANNEL, AGENT_RESULT_TYPE, AGENT_RUNS_CHANNEL, JOB_STATUS_KEY, parseControlRequest, type RunSnapshot } from "./lib/agent-channel";
import { AGENT_RUN_ENTRY, AgentRuns } from "./lib/agent-runs";
import { SUB_AGENT_TOOLS_ENV } from "./lib/sub-agent-prompt";
import { readAgentPrompt } from "./lib/pi-spawn";
import { pruneOldChanges } from "./lib/file-tracker";
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
	getActiveTags,
	type SecretEntry,
} from "./lib/psst";
import { registerPsstCommand } from "./psst-command";
import { registerRetiredCommands } from "./retired-commands";
import { requestApproval } from "./lib/approval";
import { setBlockedReporter } from "./lib/choice-dialog";
import { describeMcpCall, destructiveMcpReason, mcpCallOf } from "./lib/destructive-mcp";
import { peakPriced } from "./lib/deepseek-cost";
import { agentActivity, BROSKI_TASKS_CHANNEL, broskiTasks, jobActivity } from "./lib/broski";

/** true once one hold sent news, false once every hold ended without any. */
function firstNews(holds: readonly Promise<boolean>[]): Promise<boolean> {
	return new Promise((resolve) => {
		let left = holds.length;
		if (left === 0) resolve(false);
		for (const hold of holds) {
			void hold.then((sent) => {
				if (sent) resolve(true);
				else if (--left === 0) resolve(false);
			});
		}
	});
}

export default function (pi: ExtensionAPI) {
	// read once: the schema enums and the resolver must agree for the whole session.
	const models = loadAgentModels();
	/* one broadcast carries both, so the agents UI and the prompt cache see every background run. */
	const shown: { agents: RunSnapshot[]; jobs: RunSnapshot[] } = { agents: [], jobs: [] };
	let announced = "[]";
	const broadcast = () => {
		const all = [...shown.agents, ...shown.jobs];
		pi.events.emit(AGENT_RUNS_CHANNEL, all);
		const tasks = broskiTasks(all);
		const text = JSON.stringify(tasks);
		if (text === announced) return;
		announced = text;
		pi.events.emit(BROSKI_TASKS_CHANNEL, tasks);
	};
	const runs = new AgentRuns({
		notify: (content, details, wake) =>
			pi.sendMessage(
				{ customType: AGENT_RESULT_TYPE, content, display: true, details: { ...details, broski: agentActivity(details.runs) } },
				wake ? { triggerTurn: true, deliverAs: "steer" } : {},
			),
		broadcast: (snapshot) => {
			shown.agents = snapshot;
			broadcast();
		},
		record: (entry) => pi.appendEntry(AGENT_RUN_ENTRY, entry),
	});
	/* a job's output is not a tool result, so the tool_result scrubber never sees it: scrub it here. */
	const jobs = new BashJobs({
		notify: (content, details, wake) =>
			makeScrubber().then((scrub) => {
				const scrubbed = details.jobs.map((job) => ({ ...job, command: scrub(job.command), text: scrub(job.text) }));
				pi.sendMessage(
					{ customType: JOB_RESULT_TYPE, content: scrub(content), display: true, details: { jobs: scrubbed, broski: jobActivity(scrubbed) } },
					wake ? { triggerTurn: true, deliverAs: "steer" } : {},
				);
			}).catch(() => {}),
		broadcast: (snapshot) => {
			shown.jobs = snapshot;
			broadcast();
		},
	});

	pi.registerTool(createReadTool(NORMAL_LIMITS));
	pi.registerTool(createLsTool(NORMAL_LIMITS));
	// same names as pi's built-ins, so these replace them.
	pi.registerTool(createEditTool());
	pi.registerTool(createWriteTool());
	pi.registerTool(createGrepTool());
	pi.registerTool(createGlobTool());
	pi.registerTool(createBashTool(jobs));
	pi.registerTool(createCommitTool());
	pi.registerTool(createUndoEditTool());
	// redo is only safe because it refuses when the file moved on since the
	// undo; see the invalidation check in undo-edit.ts.
	pi.registerTool(createRedoEditTool());
	let skills: readonly Skill[] = [];
	pi.on("before_agent_start", (event) => {
		skills = event.systemPromptOptions.skills ?? [];
	});
	pi.registerTool(createSkillTool(() => skills));
	// screenshot owns the ONLY sanctioned path from screen pixels to a vision
	// model. permissions.json rejects `screencapture`/`sips -Z` in bash so this
	// cannot be routed around by hand — see lib/vision.ts for why that matters.
	pi.registerTool(createScreenshotTool());
	pi.registerTool(createMplRenderTool());
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
	pi.registerTool(createDelegateTool({
		systemPrompt: readAgentPrompt("agent.amp.delegate.md"),
		models,
		runs,
	}));
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
	pi.registerTool(createAgentsTool(runs, jobs));
	pi.registerMessageRenderer(AGENT_RESULT_TYPE, renderAgentResult);
	pi.registerMessageRenderer(JOB_RESULT_TYPE, renderJobResult);
	// a session nothing can wake ends its run only once its background jobs and agents have reported
	pi.on("agent_before_settle", async (_event, ctx) => {
		const waits = new Map<string, string>();
		const show = (source: string) => (text: string | undefined) => {
			if (text) waits.set(source, text);
			else waits.delete(source);
			try {
				ctx.ui.setStatus(JOB_STATUS_KEY, waits.size > 0 ? [...waits.values()].join("; ") : undefined);
			} catch {}
		};
		const released = new AbortController();
		const signal = ctx.signal ? AbortSignal.any([ctx.signal, released.signal]) : released.signal;
		const sent = await firstNews([jobs.hold(signal, show("jobs")), runs.hold(signal, show("agents"))]);
		released.abort();
		return sent ? { continue: true } : undefined;
	});
	pi.registerTool(createReadWebPageTool({
		systemPrompt: readAgentPrompt("prompt.amp.read-web-page.md"),
		models,
		usdPerCredit: configuredUsdPerCredit(),
	}));
	// web_search resolves its own config and may be disabled there, in which case
	// we register nothing rather than advertising a tool that cannot run.
	const webSearchTool = createConfiguredWebSearchTool();
	if (webSearchTool) pi.registerTool(webSearchTool);
	const xSearchTool = createConfiguredXSearchTool();
	if (xSearchTool) pi.registerTool(xSearchTool);

	pi.registerTool(createSearchSessionsTool());
	pi.registerTool(createReadSessionTool({
		systemPrompt: readAgentPrompt("prompt.amp.read-session.md"),
		models,
	}));
	pi.registerTool(createAskTool(pi.events));
	// herdr's own pi extension listens for this; without herdr nobody does.
	setBlockedReporter((active, label) => pi.events.emit("herdr:blocked", { active, label }));

	let stopDetachKey: (() => void) | undefined;
	let stopControl: (() => void) | undefined;
	let pruneTimer: ReturnType<typeof setTimeout> | undefined;
	pi.on("session_start", (event, ctx) => {
		stopControl?.();
		stopControl = pi.events.on(AGENT_CONTROL_CHANNEL, (message) => {
			const request = parseControlRequest(message);
			if (!request) return;
			if (request.action === "stopAll" || jobs.has(request.id)) jobs.control(request);
			if (request.action === "stopAll" || !jobs.has(request.id)) void runs.control(request).catch(() => {});
		});
		runs.restore(ctx.sessionManager.getBranch());
		const handoff = event.reason === "reload" ? AgentRuns.takeReloadHandoff() : undefined;
		if (handoff) runs.adoptReload(handoff);
		const jobHandoff = event.reason === "reload" ? BashJobs.takeHandoff() : undefined;
		if (jobHandoff) jobs.adopt(jobHandoff);
		if (ctx.mode === "tui") {
			// not a registered shortcut: Ctrl+B stays the editor's cursor-left unless a bash call is waiting
			stopDetachKey = ctx.ui.onTerminalInput((data) => (matchesKey(data, "ctrl+b") && jobs.detachForeground() ? { consume: true } : undefined));
		}
		if (!ctx.hasUI || process.env[SUB_AGENT_TOOLS_ENV]?.trim()) return;
		const sessionId = ctx.sessionManager.getSessionId();
		clearTimeout(pruneTimer);
		pruneTimer = setTimeout(() => void pruneOldChanges(sessionId).catch(() => {}), 30_000);
		pruneTimer.unref?.();
		try {
			const problems = auditAgentModels(models, ctx.modelRegistry);
			if (problems.length > 0) {
				ctx.ui.notify(`agent-models (${AGENT_MODELS_FILE}):\n${problems.map((p) => `  • ${p}`).join("\n")}`, "warning");
			}
		} catch {}
	});

	pi.on("session_shutdown", async (event) => {
		clearTimeout(pruneTimer);
		pruneTimer = undefined;
		stopDetachKey?.();
		stopDetachKey = undefined;
		stopControl?.();
		stopControl = undefined;
		await Promise.all([runs.shutdown(event.reason === "reload"), jobs.shutdown(event.reason === "reload")]);
		// a closed registry broadcasts nothing more; a reload re-announces what it took over
		announced = "[]";
		pi.events.emit(BROSKI_TASKS_CHANNEL, []);
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

	// children load this extension too, so their replies are priced before the parent sums them
	pi.on("message_end", (event, ctx) => {
		const message = event.message;
		if (message.role !== "assistant") return undefined;
		const priced = peakPriced(message, ctx.modelRegistry.find(message.provider, message.model));
		return priced ? { message: priced } : undefined;
	});

	// ── psst secret management hooks ──────────────────────────

	// scrub ALL sensitive values from tool output — vault secrets, auth.json tokens, env var keys
	pi.on("tool_result", async (event) =>
		hasScrubbableContent(event) ? scrubToolResult(event, await makeScrubber()) : undefined,
	);

	pi.on("before_agent_start", async (event, ctx) => {
		if (isLocalProvider(ctx.model?.provider)) return;

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

	registerPsstCommand(pi);
	registerRetiredCommands(pi);
}
