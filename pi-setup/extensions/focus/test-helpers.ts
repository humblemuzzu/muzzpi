import { SessionManager } from "@mariozechner/pi-coding-agent";
import { buildSessionView } from "./session-view";

export { strip, theme } from "../agents-ui/test-helpers";

const USAGE = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** a real pi session in memory, written through pi's own SessionManager */
export function session() {
	const manager = SessionManager.inMemory("/tmp");
	let clock = 1_700_000_000_000;
	const assistant = (content: unknown[], stopReason: string, extra: Record<string, unknown> = {}) =>
		manager.appendMessage({ role: "assistant", content, api: "anthropic-messages", provider: "anthropic", model: "claude-opus-5-5", usage: USAGE, stopReason, timestamp: clock++, ...extra } as never);
	return {
		manager,
		prompt: (text: string) => manager.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: clock++ }),
		reply: (text: string, stopReason = "stop", extra?: Record<string, unknown>) => assistant([{ type: "text", text }], stopReason, extra),
		call: (id: string, name = "read", args: Record<string, unknown> = { path: "a.ts" }) => assistant([{ type: "toolCall", id, name, arguments: args }], "toolUse"),
		result: (id: string, text = "ok", isError = false) =>
			manager.appendMessage({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text }], isError, timestamp: clock++ } as never),
		view: (fold = true) => buildSessionView(manager.getEntries(), manager.getLeafId(), fold),
	};
}
