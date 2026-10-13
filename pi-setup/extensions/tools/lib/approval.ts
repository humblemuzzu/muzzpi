/**
 * Asks the user before a command that destroys data runs. Without a UI (a
 * sub-agent, `pi -p`) nobody can answer, so the call is refused and the agent
 * is told to hand the exact command back. Every decision is appended to
 * approvals.jsonl, so "what did the agent delete?" has an answer.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { makeScrubber } from "./psst";

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

export type ApprovalAnswer = { approved: true } | { approved: false; message: string };

interface UiContext {
	hasUI?: boolean;
	ui?: { confirm(title: string, message: string, opts?: { signal?: AbortSignal }): Promise<boolean> };
	cwd?: string;
	sessionManager?: { getSessionId(): string };
}

function approvalLogPath(): string {
	return process.env.PI_APPROVALS_LOG || path.join(os.homedir(), ".pi", "agent", "approvals.jsonl");
}

/** The command is scrubbed like any tool output: a `psql postgres://user:pass@…` must not land on disk in clear. */
async function record(ctx: UiContext, request: ApprovalRequest, decision: "approved" | "denied" | "no-ui"): Promise<void> {
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

export async function requestApproval(
	ctx: UiContext | undefined,
	request: ApprovalRequest,
	signal?: AbortSignal,
): Promise<ApprovalAnswer> {
	const context = ctx ?? {};
	if (!context.hasUI || !context.ui) {
		await record(context, request, "no-ui");
		return {
			approved: false,
			message:
				`not run: this needs the user's approval (${request.reasons.join("; ")}), and this session cannot ask them ` +
				"(a sub-agent or a non-interactive run). Do not try another way to do it. Finish the rest of the task, " +
				`then report this exact command so the user can approve it:\n${request.command}`,
		};
	}
	const message = [...request.reasons.map((reason) => `- ${reason}`), "", `Runs ${where(request)}:`, request.command].join("\n");
	let approved = false;
	try {
		approved = await context.ui.confirm("Allow this command? It destroys data.", message, { signal });
	} catch {
		approved = false;
	}
	await record(context, request, approved ? "approved" : "denied");
	if (approved) return { approved: true };
	return {
		approved: false,
		message:
			"not run: the user denied this command. Do not retry it or find another way to do the same thing; " +
			"ask the user what they want instead.",
	};
}
