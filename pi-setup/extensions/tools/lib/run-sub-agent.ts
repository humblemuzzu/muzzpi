/**
 * the result shape every sub-agent tool returns, and the blocking spawn that
 * read_web_page and read_session use. the six agent tools go through
 * lib/agent-runs.ts, which can also run them in the background.
 */

import { failureText } from "./agent-notice";
import { piSpawn, zeroUsage, type PiSpawnConfig, type PiSpawnResult } from "./pi-spawn";
import {
	applySpawnResult,
	collectSubAgentImages,
	getFinalOutput,
	subAgentResult,
	type SingleResult,
} from "./sub-agent-render";

export interface SubAgentRun {
	agent: string;
	/** shown in the TUI tree and the inspector. */
	label: string;
	/** progress text while the child has produced no answer yet. */
	working: string;
	/** hand the child's last screenshots back to the caller. */
	returnImages?: boolean;
	ctx: { cwd: string; sessionManager?: { getSessionId?(): string } };
	signal?: AbortSignal;
	onUpdate?: (update: any) => void;
	spawn: Omit<PiSpawnConfig, "cwd" | "signal" | "onUpdate" | "sessionId">;
}

export function toolError(text: string): any {
	return { content: [{ type: "text", text }], isError: true };
}

export function sessionIdOf(ctx: SubAgentRun["ctx"]): string {
	try {
		return ctx.sessionManager?.getSessionId?.() ?? "";
	} catch {
		return "";
	}
}

export function finishedResult(details: SingleResult, result: PiSpawnResult, returnImages = false): any {
	details.exitCode = result.exitCode;
	applySpawnResult(details, result);
	const output = getFinalOutput(result.messages) || "(no output)";
	if (result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted") {
		return subAgentResult(failureText(result, output), details, true);
	}
	return subAgentResult(output, details, false, returnImages ? collectSubAgentImages(result.messages) : []);
}

export function progressUpdate(details: SingleResult, partial: PiSpawnResult, working: string): any {
	applySpawnResult(details, partial);
	return { content: [{ type: "text", text: getFinalOutput(partial.messages) || working }], details };
}

export async function runSubAgent(run: SubAgentRun): Promise<any> {
	const details: SingleResult = { agent: run.agent, task: run.label, exitCode: -1, messages: [], usage: zeroUsage() };
	const result = await piSpawn({
		...run.spawn,
		cwd: run.ctx.cwd,
		signal: run.signal,
		sessionId: sessionIdOf(run.ctx),
		onUpdate: (partial) => run.onUpdate?.(progressUpdate(details, partial, run.working)),
	});
	return finishedResult(details, result, run.returnImages);
}
