import { describe, expect, test } from "bun:test";
import localModelExtension from "./local-model";

function load() {
	let command: any;
	const notes: [string, string | undefined][] = [];
	localModelExtension({ registerCommand: (_n: string, o: unknown) => (command = o), on() {} } as any);
	const ctx = { hasUI: false, mode: "rpc", ui: { notify: (text: string, level?: string) => notes.push([text, level]), setStatus() {} } };
	return { run: (args: string) => command.handler(args, ctx), complete: command.getArgumentCompletions, notes };
}

describe("/local", () => {
	test("an unknown word is an error listing the real ones", async () => {
		const local = load();
		await local.run("strat");
		expect(local.notes).toEqual([['/local has no "strat". Try: start, stop, restart, load, unload, status, logs, or /local on its own for the menu.', "error"]]);
	});

	test("suggestions say what each word does", () => {
		const items = load().complete("s");
		expect(items.map((i: any) => i.value)).toEqual(["start", "stop", "status"]);
		expect(items[1].description).toBe("shut the server down and free its memory");
	});

	test("on its own it gives the menu, which without a screen is text", async () => {
		const local = load();
		await local.run("");
		expect(local.notes.at(-1)![0]).toContain("Local model · llama.cpp");
		expect(local.notes.at(-1)![0]).toContain("/local start");
	});
});
