import { describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@mariozechner/pi-tui";
import { loadBuiltinCommands } from "./builtins";
import { buildEntries, describeAction, editorTextFor } from "./entries";
import { HelpView } from "./palette";
import type { HelpEntry } from "./types";

const plain = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
const help = { shortcuts: new Map([["stats", "ctrl+shift+s"]]), mentions: [{ text: "@oracle", description: "expert advisor" }] };
const commands = [
	{ name: "stats", description: "Usage and spend", source: "extension", sourceInfo: { source: "local" } },
	{ name: "help", description: "this list", source: "extension", sourceInfo: { source: "local" } },
	{ name: "mcp", description: "Manage MCP servers", source: "extension", sourceInfo: { source: "builtin" } },
	{ name: "agents", description: "Background agents", source: "extension", sourceInfo: { source: "local" } },
	{ name: "skill:git", description: "git workflows", source: "skill" },
	{ name: "fix-tests", description: "Fix failing tests", source: "prompt" },
];
const builtins = [{ name: "model", description: "Select model" }];

describe("entries", () => {
	const entries = buildEntries(commands, builtins, help);

	test("sections in order, names sorted inside each, /help itself left out", () => {
		expect(entries.map((e) => `${e.section} ${e.name}`)).toEqual([
			"muzzpi /agents",
			"muzzpi /stats",
			"pi /mcp",
			"pi /model",
			"prompts /fix-tests",
			"mentions @oracle",
			"skills /skill:git",
		]);
	});

	test("extension commands run; pi's own are typed; skills and prompts start the message; mentions are added", () => {
		const by = (name: string) => entries.find((e) => e.name === name)!;
		expect(by("/stats")).toMatchObject({ key: "ctrl+shift+s", action: { kind: "run", command: "stats" } });
		expect(by("/mcp").action).toEqual({ kind: "run", command: "mcp" });
		expect(by("/model").action).toEqual({ kind: "type", text: "/model" });
		expect(by("/skill:git").action).toEqual({ kind: "prefix", text: "/skill:git " });
		expect(by("@oracle").action).toEqual({ kind: "append", text: "@oracle " });
	});

	test("a draft is never typed over", () => {
		const by = (name: string) => entries.find((e) => e.name === name)!;
		expect(editorTextFor(by("/model"), "")).toBe("/model");
		expect(editorTextFor(by("/model"), "half a thought")).toBeUndefined();
		expect(editorTextFor(by("/skill:git"), "  commit this")).toBe("/skill:git commit this");
		expect(editorTextFor(by("@oracle"), "review the plan ")).toBe("review the plan @oracle ");
		expect(editorTextFor(by("@oracle"), "")).toBe("@oracle ");
		expect(editorTextFor(by("/stats"), "")).toBeUndefined();
	});

	test("what enter does is said in plain words", () => {
		const by = (name: string) => entries.find((e) => e.name === name)!;
		expect(describeAction(by("/stats"))).toBe("enter runs /stats");
		expect(describeAction(by("/model"))).toBe("enter puts /model in the prompt; press enter again to run it");
		expect(describeAction(by("@oracle"))).toBe("enter adds @oracle to your message");
	});
});

describe("pi's built-in commands", () => {
	test("read from the installed pi; a missing pi gives none instead of throwing", async () => {
		const installed = realpathSync(join(import.meta.dir, "..", "tools", "node_modules", "@mariozechner", "pi-coding-agent"));
		expect(await loadBuiltinCommands(join(tmpdir(), "no-pi-here"))).toEqual([]);
		expect(await loadBuiltinCommands(undefined)).toEqual([]);
		const list = await loadBuiltinCommands(installed);
		expect(list.map((c) => c.name)).toEqual(expect.arrayContaining(["model", "resume", "compact", "tree", "hotkeys"]));
		expect(list.every((c) => typeof c.description === "string")).toBe(true);
	});
});

describe("the view", () => {
	const entries = buildEntries(commands, builtins, help);
	function open(rows = 40, list: readonly HelpEntry[] = entries) {
		let picked: HelpEntry | undefined | "open" = "open";
		const view = new HelpView(list, plain, (entry) => (picked = entry), () => rows);
		return { view, picked: () => picked };
	}

	test("section headers, the highlighted row's details, and the shortcut on its row", () => {
		const lines = open().view.render(80);
		const text = lines.join("\n");
		expect(text).toContain(" muzzpi");
		expect(text).toContain(" @mentions · add one to your message");
		expect(lines.find((l) => l.includes("/stats"))!.trimEnd().endsWith("ctrl+shift+s │")).toBe(true);
		expect(text).toContain("enter runs /agents");
		for (const line of lines) expect(visibleWidth(line)).toBe(80);
	});

	test("typing searches as one list; esc clears the search before it closes", () => {
		const { view, picked } = open();
		for (const ch of "model") view.handleInput(ch);
		const text = view.render(80).join("\n");
		expect(text).not.toContain(" muzzpi");
		expect(text).toContain("› /model");
		view.handleInput("\x1b");
		expect(picked()).toBe("open");
		expect(view.render(80).join("\n")).toContain(" muzzpi");
		view.handleInput("\x1b");
		expect(picked()).toBeUndefined();
	});

	test("kitty-encoded letters reach the search box", () => {
		const { view } = open();
		view.handleInput("\x1b[109u");
		expect(view.render(80)[1]).toContain("❯ m");
	});

	test("enter picks the highlighted entry; moving skips the headers", () => {
		const { view, picked } = open();
		view.handleInput("\x1b[B");
		view.handleInput("\x1b[B");
		view.handleInput("\r");
		expect((picked() as HelpEntry).name).toBe("/mcp");
	});

	test("a short terminal shows fewer rows and scrolls, keeping a section's header with its first row", () => {
		const many = Array.from({ length: 30 }, (_, i): HelpEntry => ({
			section: i < 15 ? "muzzpi" : "pi",
			name: `/c${String(i).padStart(2, "0")}`,
			description: "d",
			action: { kind: "run", command: `c${i}` },
		}));
		const { view } = open(20, many);
		const first = view.render(70);
		expect(first.length).toBeLessThanOrEqual(20);
		for (let i = 0; i < 15; i++) view.handleInput("\x1b[B");
		const text = view.render(70).join("\n");
		expect(text).toContain("› /c15");
		expect(text).toContain(" pi ");
		expect(text).toContain("↑");
	});

	test("nothing found says how to get back", () => {
		const { view } = open();
		for (const ch of "zzzzqq") view.handleInput(ch);
		expect(view.render(80).join("\n")).toContain("nothing matches; backspace or esc to clear");
	});
});
