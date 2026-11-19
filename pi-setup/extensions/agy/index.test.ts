import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import createExtension from "./index";
import { BASE_URL, MODELS, PROVIDER_ID } from "./catalog";

function fakePi() {
	const commands: string[] = [];
	const events: string[] = [];
	let registered: Record<string, unknown> | undefined;
	const pi = {
		registerProvider: (provider: Record<string, unknown>) => {
			registered = provider;
		},
		registerCommand: (name: string) => {
			commands.push(name);
		},
		on: (event: string) => {
			events.push(event);
			return () => {};
		},
	} as unknown as ExtensionAPI;
	return { pi, commands, events, provider: () => registered };
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
		expect(provider.getModels()).toHaveLength(12);
		expect(typeof provider.stream).toBe("function");
		expect(typeof provider.streamSimple).toBe("function");
		expect(provider.auth.oauth?.name).toBe("Antigravity");
		expect(harness.commands).toEqual(["agy-quota"]);
		expect(harness.events).toEqual(["session_start"]);
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
});
