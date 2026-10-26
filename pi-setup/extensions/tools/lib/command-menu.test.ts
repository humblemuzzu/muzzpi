import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@mariozechner/pi-tui";
import { askText, canShowMenu, CommandMenu, type MenuChoice, type MenuSpec, menuAsText } from "./command-menu";

const plain = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
const tui = { requestRender() {} };

const spec: MenuSpec = {
	title: "Secrets",
	status: ["3 secrets · filter: none"],
	items: [
		{ id: "list", label: "See secret names", description: "Names and tags only." },
		{ id: "add", label: "Add or change a secret" },
		{ id: "tools", label: "Tool calls", values: ["off", "on"], description: "Include what the tools did." },
	],
};

function open(menuSpec: MenuSpec = spec) {
	let result: MenuChoice | undefined | "open" = "open";
	const menu = new CommandMenu(menuSpec, tui, plain, (choice) => (result = choice));
	return { menu, result: () => result };
}

describe("rendering", () => {
	test("title, status, numbered rows with descriptions, and the key hint", () => {
		const lines = open().menu.render(60);
		expect(lines[0]).toBe("─".repeat(60));
		expect(lines.slice(1, 4)).toEqual([" Secrets", " 3 secrets · filter: none", " "]);
		expect(lines).toContain(" › 1 See secret names");
		expect(lines).toContain("     Names and tags only.");
		expect(lines.some((line) => line.startsWith("   3 Tool calls") && line.trimEnd().endsWith("off"))).toBe(true);
		expect(lines.at(-2)).toBe(" ↑↓ move · enter choose · esc close");
		expect(lines.at(-1)).toBe("─".repeat(60));
	});

	test("no line is wider than the terminal, however long the text", () => {
		const long: MenuSpec = {
			title: "T".repeat(300),
			status: ["s ".repeat(200)],
			items: [{ id: "a", label: "L".repeat(200), note: "n".repeat(90), description: "d ".repeat(300) }],
		};
		for (const width of [12, 40, 97]) {
			for (const line of open(long).menu.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	test("control characters in user text cannot reach the terminal", () => {
		const lines = open({ title: "a\nb\x1b[2Jc", items: [{ id: "x", label: "one\rtwo" }] }).menu.render(40);
		expect(lines.join("\n")).not.toContain("\x1b[2J");
		expect(lines[1]).toBe(" a b[2Jc");
	});

	test("a render is reused until something changes", () => {
		const { menu } = open();
		const first = menu.render(50);
		expect(menu.render(50)).toBe(first);
		menu.handleInput("\x1b[B");
		expect(menu.render(50)).not.toBe(first);
	});
});

describe("keys", () => {
	test("enter on an action closes with it and every setting's value", () => {
		const { menu, result } = open();
		menu.handleInput("\x1b[B");
		menu.handleInput("\r");
		expect(result()).toEqual({ id: "add", values: { tools: "off" } });
	});

	test("enter on a setting changes it in place; left and right step through it", () => {
		const { menu, result } = open();
		menu.handleInput("3");
		expect(result()).toBe("open");
		expect(menu.render(50).some((line) => line.startsWith(" › 3 Tool calls") && line.trimEnd().endsWith("on"))).toBe(true);
		expect(menu.render(50).at(-2)).toBe(" ↑↓ move · enter or ←→ change · esc close");
		menu.handleInput("\x1b[D");
		menu.handleInput("\x1b[A");
		menu.handleInput("\x1b[A");
		menu.handleInput("\r");
		expect(result()).toEqual({ id: "list", values: { tools: "off" } });
	});

	test("a digit picks its row; the cursor wraps around the ends", () => {
		const { menu, result } = open();
		menu.handleInput("\x1b[A");
		expect(menu.render(50).some((line) => line.startsWith(" › 3 Tool calls") && line.trimEnd().endsWith("off"))).toBe(true);
		menu.handleInput("2");
		expect(result()).toEqual({ id: "add", values: { tools: "off" } });
	});

	test("onChange hears every setting change as it happens, so esc keeps it", () => {
		const changes: Array<[string, string]> = [];
		const { menu, result } = open({ ...spec, onChange: (id, value) => changes.push([id, value]) });
		menu.handleInput("3");
		menu.handleInput("\x1b[C");
		menu.handleInput("\x1b");
		expect(changes).toEqual([["tools", "on"], ["tools", "off"]]);
		expect(result()).toBeUndefined();
	});

	test("esc and ctrl+c close without a choice", () => {
		for (const key of ["\x1b", "\x03"]) {
			const { menu, result } = open();
			menu.handleInput(key);
			expect(result()).toBeUndefined();
		}
	});

	test("the cursor starts on `initial`, and a setting starts at its given value", () => {
		const { menu, result } = open({ ...spec, initial: "tools", items: spec.items.map((i) => (i.id === "tools" ? { ...i, value: "on" } : i)) });
		menu.handleInput("\x1b[A");
		menu.handleInput("\r");
		expect(result()).toEqual({ id: "add", values: { tools: "on" } });
	});

	test("over nine rows there are no numbers, so digits do nothing", () => {
		const many: MenuSpec = { title: "t", items: Array.from({ length: 11 }, (_, i) => ({ id: `i${i}`, label: `row ${i}` })) };
		const { menu, result } = open(many);
		expect(menu.render(40)).toContain(" › row 0");
		menu.handleInput("2");
		expect(result()).toBe("open");
	});
});

describe("outside the TUI", () => {
	test("canShowMenu needs a TUI session with custom()", () => {
		const custom = async () => undefined as never;
		expect(canShowMenu({ hasUI: true, mode: "tui", ui: { custom } })).toBe(true);
		expect(canShowMenu({ hasUI: true, mode: "rpc", ui: { custom } })).toBe(false);
		expect(canShowMenu({ hasUI: false, mode: "tui", ui: { custom } })).toBe(false);
		expect(canShowMenu(undefined)).toBe(false);
	});

	test("askText puts the hint in the title, dimmed in the TUI and in brackets elsewhere", async () => {
		const titles: string[] = [];
		const ui = { input: async (title: string) => (titles.push(title), "typed"), theme: { fg: (c: string, s: string) => `<${c}>${s}` } };
		expect(await askText({ mode: "tui", ui }, "Secret name", "like API_KEY")).toBe("typed");
		await askText({ mode: "rpc", ui }, "Secret name", "like API_KEY");
		await askText({ mode: "tui", ui }, "Secret name");
		expect(titles).toEqual(["Secret name\n<dim>like API_KEY", "Secret name (like API_KEY)", "Secret name"]);
	});

	test("menuAsText gives the state and how to do each thing by typing", () => {
		expect(menuAsText(spec, ["/psst add NAME  add or change a secret"])).toBe(
			"Secrets\n3 secrets · filter: none\n\n/psst add NAME  add or change a secret",
		);
	});
});
