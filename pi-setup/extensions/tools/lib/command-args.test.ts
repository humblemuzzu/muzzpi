import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completeWords, findWord, splitArgs, unknownWord, type Word } from "./command-args";
import { collectHelp, contributeHelp } from "./help-channel";
import { prefsFile, readPrefs, writePrefs } from "./prefs";

const words: Word[] = [
	{ name: "add", description: "add a secret" },
	{ name: "tags", aliases: ["tag"], description: "filter by tag", next: () => [{ value: "off", description: "use every secret" }, { value: "work" }] },
	{ name: "list", description: "show names" },
];

describe("splitArgs", () => {
	test("the first word lowercased, the rest trimmed with its case kept", () => {
		expect(splitArgs("  TAGS  Work,Prod ")).toEqual({ word: "tags", rest: "Work,Prod" });
		expect(splitArgs("add")).toEqual({ word: "add", rest: "" });
		expect(splitArgs(undefined)).toEqual({ word: "", rest: "" });
		expect(splitArgs("strict  fix the\tlogin bug")).toEqual({ word: "strict", rest: "fix the\tlogin bug" });
	});
});

describe("findWord and unknownWord", () => {
	test("names and aliases match in any case", () => {
		expect(findWord(words, "TAG")?.name).toBe("tags");
		expect(findWord(words, "Add")?.name).toBe("add");
		expect(findWord(words, "ad")).toBeUndefined();
	});

	test("an unknown word names the real ones", () => {
		expect(unknownWord("psst", "lst", words)).toBe('/psst has no "lst". Try: add, tags, list, or /psst on its own for the menu.');
	});
});

describe("completeWords", () => {
	test("the first word completes by prefix, with a trailing space when more can follow", () => {
		expect(completeWords(words, "a")).toEqual([{ value: "add", label: "add", description: "add a secret" }]);
		expect(completeWords(words, "t")).toEqual([{ value: "tags ", label: "tags", description: "filter by tag" }]);
		expect(completeWords(words, "")?.map((i) => i.label)).toEqual(["add", "tags", "list"]);
		expect(completeWords(words, "x")).toBeNull();
	});

	test("what is already typed in full is not suggested, so enter sends the command the first time", () => {
		expect(completeWords(words, "add")).toBeNull();
		expect(completeWords(words, "tags")).toBeNull();
		expect(completeWords(words, "TAGS work")).toBeNull();
		expect(completeWords(words, "tags wo")?.map((i) => i.value)).toEqual(["tags work"]);
	});

	test("after a word, its own suggestions, each value carrying the whole argument text", () => {
		expect(completeWords(words, "tags w")).toEqual([{ value: "tags work", label: "work" }]);
		expect(completeWords(words, "TAG ")?.map((i) => i.value)).toEqual(["tags off", "tags work"]);
		expect(completeWords(words, "add x")).toBeNull();
	});
});

describe("prefs", () => {
	test("missing, broken or non-object files read as no settings", () => {
		const dir = mkdtempSync(join(tmpdir(), "prefs-"));
		expect(readPrefs(join(dir, "none.json"))).toEqual({});
		for (const [name, body] of [["bad", "{"], ["list", "[1]"], ["null", "null"]]) {
			writeFileSync(join(dir, `${name}.json`), body!);
			expect(readPrefs(join(dir, `${name}.json`))).toEqual({});
		}
	});

	test("a write lands whole, creates the folder and leaves no temporary file", () => {
		const dir = mkdtempSync(join(tmpdir(), "prefs-"));
		const file = prefsFile("deepseek-peak", dir);
		expect(file).toBe(join(dir, "cache", "deepseek-peak.json"));
		writePrefs(file, { hidden: true });
		expect(readPrefs(file)).toEqual({ hidden: true });
		expect(readdirSync(join(dir, "cache"))).toEqual(["deepseek-peak.json"]);
	});
});

describe("help channel", () => {
	function bus() {
		const handlers = new Map<string, ((data: unknown) => void)[]>();
		return {
			events: {
				emit: (channel: string, data: unknown) => handlers.get(channel)?.forEach((h) => h(data)),
				on: (channel: string, handler: (data: unknown) => void) => {
					handlers.set(channel, [...(handlers.get(channel) ?? []), handler]);
					return () => handlers.set(channel, (handlers.get(channel) ?? []).filter((h) => h !== handler));
				},
			},
		};
	}

	test("every extension's answer is collected; a later answer for the same command wins", () => {
		const pi = bus();
		contributeHelp(pi, (help) => help.shortcut({ command: "stats", key: "ctrl+shift+s" }));
		contributeHelp(pi, (help) => {
			help.mention({ text: "@oracle", description: "expert advisor" });
			help.shortcut({ command: "stats", key: "ctrl+shift+t" });
		});
		const help = collectHelp(pi.events);
		expect([...help.shortcuts]).toEqual([["stats", "ctrl+shift+t"]]);
		expect(help.mentions).toEqual([{ text: "@oracle", description: "expert advisor" }]);
	});

	test("junk on the channel is ignored", () => {
		const pi = bus();
		let asked = 0;
		contributeHelp(pi, () => asked++);
		pi.events.emit("muzzpi:help", { nope: true });
		expect(asked).toBe(0);
		collectHelp(pi.events);
		expect(asked).toBe(1);
	});
});
