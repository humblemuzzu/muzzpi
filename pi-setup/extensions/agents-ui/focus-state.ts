export interface FocusMessage {
	role: string;
	content?: string | Array<{ type: string; text?: string; [key: string]: unknown }>;
	[key: string]: unknown;
}

export function messageText(message: FocusMessage): string {
	return typeof message.content === "string" ? message.content : (message.content ?? []).filter(block => block.type === "text").map(block => block.text ?? "").join("\n");
}

export class FocusState {
	question = "";
	messages: FocusMessage[] = [];
	running = false;
	version = 0;
	private streaming = false;

	accept(message: FocusMessage, ended: boolean): void {
		if (message.role === "user") {
			this.question = messageText(message) || "[Image prompt]";
			this.messages = [];
			this.streaming = false;
		} else if (message.role === "assistant") {
			const snapshot = structuredClone(message);
			if (this.streaming) this.messages[this.messages.length - 1] = snapshot;
			else this.messages.push(snapshot);
			this.streaming = !ended;
		} else if (message.role === "toolResult" && ended) {
			this.messages.push(structuredClone(message));
		}
		this.version++;
	}

	answer(): string {
		if (this.running) return "Working… Open Process to follow the agent.";
		const last = this.messages.findLast(message => message.role === "assistant");
		if (!last) return "No answer yet.";
		const calls = Array.isArray(last.content) && last.content.some(block => block.type === "toolCall");
		return calls ? "No final answer yet. See Process for the interrupted work." : messageText(last) || "No final answer. See Process for details.";
	}
}
