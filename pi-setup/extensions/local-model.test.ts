import { describe, expect, test } from "bun:test";
import localModelExtension from "./local-model";

function load() {
	let command: any;
	const notes: [string, string | undefined][] = [];
	localModelExtension({ registerCommand: (_n: string, o: unknown) => (command = o), on() {} } as any);
	const models = [
		{ provider: "anthropic", id: "claude-opus-5-5" },
		{ provider: "ollama", id: "inkling-2-mini:26b-a5b-nvfp4", name: "Inkling 2 Mini" },
	];
	const ctx = {
		hasUI: false,
		mode: "rpc",
		modelRegistry: { getAll: () => models },
		ui: { notify: (text: string, level?: string) => notes.push([text, level]), setStatus() {} },
	};
	return { run: (args: string) => command.handler(args, ctx), complete: command.getArgumentCompletions, notes };
}

describe("/local", () => {
	test("an unknown word is an error listing the real ones", async () => {
		const local = load();
		await local.run("strat");
		expect(local.notes).toEqual([['/local has no "strat". Try: on, off, status, or /local on its own for the menu.', "error"]]);
	});

	test("suggestions say what each word does", () => {
		const items = load().complete("o");
		expect(items.map((i: any) => i.value)).toEqual(["on", "off"]);
		expect(items[1].description).toBe("free the model's memory and switch back");
	});

	test("on its own it gives the menu, which without a screen is text", async () => {
		const local = load();
		await local.run("");
		const menu = local.notes.at(-1)![0];
		expect(menu).toContain("Local model · Ollama");
		expect(menu).toContain("/local on");
	});
});
