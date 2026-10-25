import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";

export const INTERRUPTED_RESULT = "Interrupted before this finished — check what it did before repeating it.";

/** the saved conversation `--session-dir dir --session-id id` reopens, if one was written. */
export function subAgentSessionFile(dir: string, id: string): string | undefined {
	let names: string[] = [];
	try {
		names = fs.readdirSync(dir).filter((name) => name.endsWith(`_${id}.jsonl`));
	} catch {}
	return names.length > 0 ? path.join(dir, names.sort().at(-1)!) : undefined;
}

/**
 * gives every tool call of the conversation's last assistant message that has no
 * result an error result, so a continuation knows the call never finished. returns
 * how many it added. only for a session no process has open.
 */
export function repairInterrupted(file: string): number {
	const session = SessionManager.open(file);
	const answered = new Set<string>();
	let last: any;
	for (const entry of session.getBranch().reverse() as any[]) {
		if (entry.type !== "message") continue;
		if (entry.message.role !== "toolResult") {
			if (entry.message.role === "assistant") last = entry.message;
			break;
		}
		answered.add(entry.message.toolCallId);
	}
	const open = (last?.content ?? []).filter((part: any) => part.type === "toolCall" && !answered.has(part.id));
	for (const call of open) {
		session.appendMessage({
			role: "toolResult",
			toolCallId: call.id,
			toolName: call.name,
			content: [{ type: "text", text: INTERRUPTED_RESULT }],
			isError: true,
			timestamp: Date.now(),
		} as any);
	}
	return open.length;
}

export function savedSessionModel(dir: string, id: string): string | undefined {
	const file = subAgentSessionFile(dir, id);
	if (!file) return undefined;
	const model = SessionManager.open(file).buildSessionContext().model;
	return model ? `${model.provider}/${model.modelId}` : undefined;
}
