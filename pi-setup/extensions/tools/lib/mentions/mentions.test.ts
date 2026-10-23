import { describe, expect, test } from "bun:test";
import mentionsExtension from "../../../mentions";
import { collectHelp } from "../help-channel";

type Handler = (event: any, ctx: any) => any;

const ORACLE_DIRECTIVE =
	"AGENT DIRECTIVE: Call the `oracle` tool for this request. The user explicitly tagged @oracle. Do not substitute another tool.";

function loadExtension() {
	const handlers = new Map<string, Handler>();
	const sent: { message: any; options: any }[] = [];
	mentionsExtension({
		on: (name: string, handler: Handler) => handlers.set(name, handler),
		events: { on: () => () => {}, emit() {} },
		sendMessage: (message: any, options: any) => sent.push({ message, options }),
	} as any);
	const ctx = { cwd: process.cwd(), hasUI: false };
	const call = (name: string, event: any) => handlers.get(name)!(event, ctx);
	const input = (text: string, extra: Record<string, unknown> = {}) =>
		call("input", { type: "input", text, source: "interactive", ...extra });
	const start = (messageType: "user" | "custom" = "user") =>
		call("before_agent_start", { type: "before_agent_start", messageType, prompt: "" });
	return { handlers, sent, call, input, start };
}

const mentionMessage = { message: { customType: "mentions:resolved", content: ORACLE_DIRECTIVE, display: false } };

describe("mentions extension", () => {
	test("never rewrites the context", () => {
		expect(loadExtension().handlers.has("context")).toBe(false);
	});

	test("an idle prompt's mentions start its run once", async () => {
		const ext = loadExtension();
		expect(await ext.input("ask @oracle about this")).toEqual({ action: "continue" });
		expect(await ext.start()).toEqual(mentionMessage);
		expect(await ext.start()).toBeUndefined();
		expect(ext.sent).toEqual([]);
	});

	test("a prompt without mentions adds nothing and drops an unused block", async () => {
		const ext = loadExtension();
		await ext.input("ask @oracle about this");
		await ext.input("no mentions here");
		expect(await ext.start()).toBeUndefined();
	});

	test("a run started by a custom message leaves the block for the user's run", async () => {
		const ext = loadExtension();
		await ext.input("ask @oracle about this");
		expect(await ext.start("custom")).toBeUndefined();
		expect(await ext.start()).toEqual(mentionMessage);
	});

	test("input from an extension is not resolved and clears the block", async () => {
		const ext = loadExtension();
		await ext.input("ask @oracle about this");
		await ext.input("ask @oracle again", { source: "extension" });
		expect(await ext.start()).toBeUndefined();
		expect(ext.sent).toEqual([]);
	});

	test("agent_end and session_start clear the block", async () => {
		for (const event of ["agent_end", "session_start"]) {
			const ext = loadExtension();
			await ext.input("ask @oracle about this");
			await ext.call(event, { type: event });
			expect(await ext.start()).toBeUndefined();
		}
	});

	test("input while streaming queues the block with the user's delivery mode", async () => {
		for (const streamingBehavior of ["steer", "followUp"]) {
			const ext = loadExtension();
			await ext.input("ask @oracle about this", { streamingBehavior });
			expect(ext.sent).toEqual([{ ...mentionMessage, options: { deliverAs: streamingBehavior } }]);
			expect(await ext.start()).toBeUndefined();
		}
	});

	test("/help lists exactly the mentions that resolve", () => {
		const listeners: ((data: unknown) => void)[] = [];
		const events = { on: (_channel: string, handler: (data: unknown) => void) => (listeners.push(handler), () => {}), emit: (_channel: string, data: unknown) => listeners.forEach((h) => h(data)) };
		mentionsExtension({ on() {}, events, sendMessage() {} } as any);
		const texts = collectHelp(events).mentions.map((m) => m.text);
		expect(texts.sort()).toEqual(["@chad", "@codereview", "@commit/", "@finder", "@oracle", "@task"]);
		expect(collectHelp(events).mentions.find((m) => m.text === "@oracle")!.description).toStartWith("the oracle sub-agent: ");
	});
});
