/**
 * Asks the user before a command that destroys data runs. Without a UI (a
 * sub-agent, `pi -p`) nobody can answer, so the call is refused and the agent
 * is told to hand the exact command back. Every decision is appended to
 * approvals.jsonl, so "what did the agent delete?" has an answer.
 *
 * Off unless ext-config.json has `"approvals": { "enabled": true }`: when off,
 * every request is approved without a picker and logged as "auto".
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { canShowChoiceDialog, openChoiceDialog } from "./choice-dialog";
import { getExtensionConfig } from "./config";
import { makeScrubber } from "./psst";
import { SUB_AGENT_TOOLS_ENV } from "./sub-agent-prompt";

export interface ApprovalRequest {
	tool: string;
	/** what will run, shown verbatim. */
	command: string;
	/** why it needs approval; one line each. */
	reasons: string[];
	/** servers it runs on; empty = this machine. */
	hosts: string[];
	/** replaces the "on <hosts>" wording when the command runs somewhere else, such as an MCP server. */
	where?: string;
}

/** `stop` ends the turn: a plain deny means "wait for me", a deny with instructions lets the agent carry on. */
export type ApprovalAnswer = { approved: true } | { approved: false; message: string; stop: boolean };

interface UiContext {
	hasUI?: boolean;
	mode?: string;
	ui?: {
		confirm(title: string, message: string, opts?: { signal?: AbortSignal }): Promise<boolean>;
		custom?<T>(factory: (tui: any, theme: any, keybindings: any, done: (result: T) => void) => any): Promise<T>;
	};
	cwd?: string;
	sessionManager?: { getSessionId(): string };
}

function approvalsEnabled(): boolean {
	return getExtensionConfig("approvals", { enabled: false }).enabled === true;
}

function approvalLogPath(): string {
	return process.env.PI_APPROVALS_LOG || path.join(os.homedir(), ".pi", "agent", "approvals.jsonl");
}

/** The command is scrubbed like any tool output: a `psql postgres://user:pass@…` must not land on disk in clear. */
async function record(
	ctx: UiContext,
	request: ApprovalRequest,
	decision: "approved" | "denied" | "no-ui" | "auto",
	feedback?: string,
): Promise<void> {
	try {
		const scrub = await makeScrubber();
		const entry = {
			time: new Date().toISOString(),
			session: ctx.sessionManager?.getSessionId(),
			cwd: ctx.cwd,
			tool: request.tool,
			hosts: request.hosts,
			reasons: request.reasons,
			command: scrub(request.command),
			decision,
			...(feedback ? { feedback: scrub(feedback) } : {}),
		};
		fs.mkdirSync(path.dirname(approvalLogPath()), { recursive: true });
		fs.appendFileSync(approvalLogPath(), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
	} catch {
		// the log is a record, not a gate: failing to write it must not change the answer.
	}
}

function where(request: ApprovalRequest): string {
	if (request.where) return request.where;
	return request.hosts.length > 0 ? `on ${request.hosts.join(", ")}` : "on this machine";
}

const TITLE = "Allow this command? It destroys data.";
const ALLOW = "Allow";
const DENY = "Deny";

const DENIED: ApprovalAnswer = {
	approved: false,
	stop: true,
	message:
		"not run: the user denied this command. Do not retry it or find another way to do the same thing. " +
		"Stop and wait for the user's next message.",
};

function redirected(feedback: string): ApprovalAnswer {
	return {
		approved: false,
		stop: false,
		message: `not run: the user denied this command and said what to do instead:\n${feedback}\nDo that. Do not retry the denied command.`,
	};
}

type Decision = { approved: boolean; feedback?: string };

async function ask(ctx: UiContext, request: ApprovalRequest, body: string, signal?: AbortSignal): Promise<Decision> {
	if (canShowChoiceDialog(ctx)) {
		const answers = await openChoiceDialog(
			ctx,
			{
				title: TITLE,
				body,
				questions: [
					{
						question: "",
						options: [{ label: ALLOW }, { label: DENY }],
						typeLabel: "Deny, and tell the agent what to do instead",
					},
				],
				initialRow: 1,
				digitsPick: false,
				notify: `Approval needed: ${request.reasons[0] ?? request.command}`,
			},
			signal,
		);
		const answer = answers?.[0];
		if (answer?.typed) return { approved: false, feedback: answer.typed };
		return { approved: answer?.picked[0] === ALLOW };
	}
	return { approved: await ctx.ui!.confirm(TITLE, body, { signal }) };
}

export async function requestApproval(
	ctx: UiContext | undefined,
	request: ApprovalRequest,
	signal?: AbortSignal,
): Promise<ApprovalAnswer> {
	const context = ctx ?? {};
	if (!approvalsEnabled()) {
		await record(context, request, "auto");
		return { approved: true };
	}
	// a sub-agent runs in RPC mode, whose dialogs reach no person
	if (!context.hasUI || !context.ui || process.env[SUB_AGENT_TOOLS_ENV]?.trim()) {
		await record(context, request, "no-ui");
		return {
			approved: false,
			stop: false,
			message:
				`not run: this needs the user's approval (${request.reasons.join("; ")}), and this session cannot ask them ` +
				"(a sub-agent or a non-interactive run). Do not try another way to do it. Finish the rest of the task, " +
				`then report this exact command so the user can approve it:\n${request.command}`,
		};
	}
	const body = [...request.reasons.map((reason) => `- ${reason}`), "", `Runs ${where(request)}:`, request.command].join("\n");
	let decision: Decision = { approved: false };
	try {
		decision = await ask(context, request, body, signal);
	} catch {}
	await record(context, request, decision.approved ? "approved" : "denied", decision.feedback);
	if (decision.approved) return { approved: true };
	return decision.feedback ? redirected(decision.feedback) : DENIED;
}
