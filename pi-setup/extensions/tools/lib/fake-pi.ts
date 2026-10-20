/**
 * a stand-in for `pi --mode rpc` in tests. it logs its argv and every stdin
 * command to `$FAKE_PI_LOG/<session id>.jsonl` and answers a prompt as the
 * `--model` it was given, with "answer: <message>". a message holding
 * `SLEEP <seconds>` runs that long first; `FAIL` ends the run with a provider
 * error; `TOOL <path>` reports a write; `PREFLIGHT <seconds>` delays the run's
 * start. like pi, a steer joins the running run (before a run starts it starts
 * one of its own) and an abort ends it.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const flag = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const id = flag("--session-id") ?? "ephemeral";
const [provider, ...model] = (flag("--model") ?? "fake/fake-1").split("/");
const logDir = process.env.FAKE_PI_LOG!;
mkdirSync(logDir, { recursive: true });
const log = (record: unknown) => appendFileSync(join(logDir, `${id}.jsonl`), `${JSON.stringify(record)}\n`);
const emit = (event: unknown) => process.stdout.write(`${JSON.stringify(event)}\n`);
log({ argv });

let running: { steers: string[]; finish: (stopReason: string) => void } | undefined;

function assistant(text: string, stopReason: string) {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		provider,
		model: model.join("/"),
		usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0.001 } },
		stopReason,
		...(stopReason === "error" ? { errorMessage: "provider exploded" } : {}),
	};
}

function run(message: string) {
	const preflight = Number(/PREFLIGHT (\d+(?:\.\d+)?)/.exec(message)?.[1] ?? 0);
	if (preflight > 0) setTimeout(() => begin(message), preflight * 1000);
	else begin(message);
}

function begin(message: string) {
	emit({ type: "agent_start" });
	const seconds = Number(/SLEEP (\d+(?:\.\d+)?)/.exec(message)?.[1] ?? 0);
	const tool = /TOOL (\S+)/.exec(message)?.[1];
	if (tool) {
		emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "write", args: { path: tool, content: "x" } });
		emit({ type: "tool_execution_end", toolCallId: "t1", toolName: "write", isError: false });
	}
	const state = {
		steers: [] as string[],
		finish: (stopReason: string) => {
			clearTimeout(timer);
			running = undefined;
			const steered = state.steers.length > 0 ? ` | steered: ${state.steers.join(" / ")}` : "";
			emit({ type: "message_end", message: assistant(`answer: ${message}${steered}`, stopReason) });
			emit({ type: "agent_settled", aborted: stopReason === "aborted" });
		},
	};
	running = state;
	const timer = setTimeout(() => state.finish(message.includes("FAIL") ? "error" : "stop"), seconds * 1000);
}

let buffer = "";
process.stdin.on("data", (chunk) => {
	buffer += chunk.toString();
	const lines = buffer.split("\n");
	buffer = lines.pop() ?? "";
	for (const line of lines) {
		if (!line.trim()) continue;
		const command = JSON.parse(line);
		log(command);
		if (command.type === "abort") {
			running?.finish("aborted");
			emit({ type: "response", id: command.id, command: "abort", success: true });
		} else if (command.type === "prompt" && running && command.streamingBehavior) {
			running.steers.push(command.message);
			emit({ type: "response", id: command.id, command: "prompt", success: true, data: { disposition: "queued" } });
		} else if (command.type === "prompt") {
			emit({ type: "response", id: command.id, command: "prompt", success: true, data: { disposition: "started" } });
			run(command.message);
		}
	}
});
process.stdin.on("end", () => process.exit(0));
