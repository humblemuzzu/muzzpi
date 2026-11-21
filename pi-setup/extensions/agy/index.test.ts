import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AGENT_RUNS_CHANNEL } from "../tools/lib/agent-channel";
import createExtension from "./index";
import { BASE_URL, MODELS, PROVIDER_ID } from "./catalog";

function fakePi() {
	const commands: string[] = [];
	const events: string[] = [];
	const channels: string[] = [];
	const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
	const channelHandlers = new Map<string, Array<(payload: unknown) => void>>();
	let registered: Record<string, unknown> | undefined;
	const pi = {
		registerProvider: (provider: Record<string, unknown>) => {
			registered = provider;
		},
		registerCommand: (name: string) => {
			commands.push(name);
		},
		on: (event: string, handler: (...args: unknown[]) => unknown) => {
			events.push(event);
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {};
		},
		events: {
			on: (channel: string, handler: (payload: unknown) => void) => {
				channels.push(channel);
				const list = channelHandlers.get(channel) ?? [];
				list.push(handler);
				channelHandlers.set(channel, list);
				return () => {};
			},
			emit: () => {},
		},
		appendEntry: () => {},
	} as unknown as ExtensionAPI;
	const fire = (event: string, ...args: unknown[]) => {
		for (const handler of handlers.get(event) ?? []) handler(...args);
	};
	const broadcast = (channel: string, payload: unknown) => {
		for (const handler of channelHandlers.get(channel) ?? []) handler(payload);
	};
	return { pi, commands, events, channels, fire, broadcast, provider: () => registered };
}

describe("extension registration", () => {
	test("registers the agy provider with every model and the quota command", () => {
		const harness = fakePi();
		createExtension(harness.pi);
		const provider = harness.provider() as {
			id: string;
			name: string;
			baseUrl: string;
			getModels: () => Array<{ id: string }>;
			stream: unknown;
			streamSimple: unknown;
			auth: { oauth?: { name: string } };
		};

		expect(provider.id).toBe(PROVIDER_ID);
		expect(provider.name).toBe("Antigravity");
		expect(provider.baseUrl).toBe(BASE_URL);
		expect(provider.getModels().map((model) => model.id)).toEqual(MODELS.map((model) => model.id));
		expect(provider.getModels()).toHaveLength(8);
		expect(typeof provider.stream).toBe("function");
		expect(typeof provider.streamSimple).toBe("function");
		expect(provider.auth.oauth?.name).toBe("Antigravity");
		expect(harness.commands).toEqual(["agy-quota"]);
		expect(harness.events).toEqual([
			"session_start",
			"session_shutdown",
			"session_compact",
			"session_tree",
			"model_select",
			"thinking_level_select",
			"agent_start",
			"agent_settled",
			"context",
			"before_provider_request",
			"message_end",
		]);
		expect(harness.channels).toEqual([AGENT_RUNS_CHANNEL]);
	});

	test("the registered models carry the provider id and the custom api", () => {
		const harness = fakePi();
		createExtension(harness.pi);
		const provider = harness.provider() as { getModels: () => Array<{ provider: string; api: string }> };
		for (const model of provider.getModels()) {
			expect(model.provider).toBe(PROVIDER_ID);
			expect(model.api).toBe("agy-cloudcode");
		}
	});

	test("a side-call request on another model does not steal the conversation marker from the agy turn", () => {
		const harness = fakePi();
		const scheduled: number[] = [];
		const origSetTimeout = globalThis.setTimeout;
		const origClearTimeout = globalThis.clearTimeout;
		globalThis.setTimeout = ((_fn: unknown, ms?: number) => {
			scheduled.push(ms ?? 0);
			return { unref() {} } as unknown as ReturnType<typeof setTimeout>;
		}) as typeof setTimeout;
		globalThis.clearTimeout = (() => {}) as typeof clearTimeout;
		try {
			createExtension(harness.pi);
			const ctx = { model: { provider: PROVIDER_ID, id: "gemini-4-neon" } };
			harness.fire("session_start", {}, ctx);
			harness.fire("agent_start", {}, ctx);
			harness.fire("context", { messages: [] }, ctx);
			// Side call (e.g. session-name on deepseek-flash) runs before the main agy request:
			harness.fire("before_provider_request", { payload: { model: "deepseek-flash" } }, ctx);
			// Real agy conversation request carries the wire tier slug (`gemini-4-neon-high`) for family `gemini-4-neon`:
			harness.fire("before_provider_request", { payload: { model: "gemini-4-neon-high", requestId: "agent/c/1/t/1", request: { labels: {}, generationConfig: {} } } }, ctx);
			harness.fire("message_end", { message: { role: "assistant", provider: PROVIDER_ID, usage: { input: 20_000, cacheRead: 0 } } }, ctx);
			expect(scheduled).toHaveLength(1);
			// Settling with no live runs cancels cleanly; a live bash job or sub-agent re-arms it:
			harness.fire("agent_settled", {}, ctx);
			harness.broadcast(AGENT_RUNS_CHANNEL, [{ id: "bash-1", status: "running" }]);
			expect(scheduled).toHaveLength(2);
			harness.fire("session_shutdown", {}, ctx);
		} finally {
			globalThis.setTimeout = origSetTimeout;
			globalThis.clearTimeout = origClearTimeout;
		}
	});
});
