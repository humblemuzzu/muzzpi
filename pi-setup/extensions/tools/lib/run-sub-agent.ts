/**
 * the spawn → stream → result path every sub-agent tool shares. a tool builds
 * its task text and spawn config; this owns progress updates, error mapping
 * and the result shape.
 */

import { describeAnthropicRejection } from "./anthropic-sub";
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

const NEW_SESSION_WARNING = /^Warning: No project session found with id '[^']*'; creating a new session with that id\.[ \t]*\r?\n?/gm;

export function failureText(
	result: Pick<PiSpawnResult, "stopReason" | "errorMessage" | "stderr">,
	output: string,
): string {
	if (result.stopReason === "aborted") return "Stopped by the user before the sub-agent finished.";
	const stderr = result.stderr.replace(NEW_SESSION_WARNING, "").trim();
	return result.errorMessage || stderr || output;
}

export async function runSubAgent(run: SubAgentRun): Promise<any> {
	let sessionId = "";
	try {
		sessionId = run.ctx.sessionManager?.getSessionId?.() ?? "";
	} catch {}

	const details: SingleResult = { agent: run.agent, task: run.label, exitCode: -1, messages: [], usage: zeroUsage() };
	const result = await piSpawn({
		...run.spawn,
		session: run.spawn.session && { agent: run.agent, ...run.spawn.session },
		cwd: run.ctx.cwd,
		signal: run.signal,
		sessionId,
		onUpdate: (partial) => {
			applySpawnResult(details, partial);
			run.onUpdate?.({ content: [{ type: "text", text: getFinalOutput(partial.messages) || run.working }], details });
		},
	});
	details.exitCode = result.exitCode;
	applySpawnResult(details, result);

	const output = getFinalOutput(result.messages) || "(no output)";
	if (result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted") {
		const error = failureText(result, output);
		const hint = describeAnthropicRejection(error, undefined);
		return subAgentResult(hint ? `${error}\n\n${hint}` : error, details, true);
	}
	return subAgentResult(output, details, false, run.returnImages ? collectSubAgentImages(result.messages) : []);
}
