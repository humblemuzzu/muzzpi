import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getActiveTags, setActiveTags } from "./lib/psst";
import { checkTagFilter, normalizeSecretName, parseTagList, psstMenu, registerPsstCommand } from "./psst-command";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
const root = mkdtempSync(join(tmpdir(), "psst-command-"));
const startCwd = process.cwd();

afterAll(() => {
	process.chdir(startCwd);
	rmSync(root, { recursive: true, force: true });
});

beforeEach(() => setActiveTags([]));

const entries = [
	{ name: "A_KEY", tags: ["work"] },
	{ name: "B_KEY", tags: ["home", "work"] },
	{ name: "C_KEY", tags: [] },
];

describe("parsing", () => {
	test("tags split on commas and spaces, duplicates dropped", () => {
		expect(parseTagList(" work, home  work,,x ")).toEqual(["work", "home", "x"]);
		expect(parseTagList("")).toEqual([]);
	});

	test("secret names are raised to capitals; anything else is refused", () => {
		expect(normalizeSecretName(" stripe_key ")).toBe("STRIPE_KEY");
		expect(normalizeSecretName("API2")).toBe("API2");
		expect(normalizeSecretName("2FA")).toBeUndefined();
		expect(normalizeSecretName("api-key")).toBeUndefined();
		expect(normalizeSecretName("TWO WORDS")).toBeUndefined();
	});

	test("a tag no secret has is refused and the real ones are named", () => {
		expect(checkTagFilter(["wrok"], entries)).toEqual({ ok: false, message: 'No secret has the tag "wrok". Tags in your vault: home, work.' });
		expect(checkTagFilter(["work"], entries)).toEqual({ ok: true, tags: ["work"], offered: 2 });
		expect(checkTagFilter(["home"], [{ name: "X", tags: [] }])).toEqual({ ok: false, message: 'No secret has the tag "home". No secret in your vault has a tag yet.' });
	});
});

describe("the menu", () => {
	const vault = { dir: "/v/.psst", global: false };

	test("state first, then what you can do; tag rows only when they apply", () => {
		const spec = psstMenu(vault, entries, []);
		expect(spec.status?.[0]).toBe("3 secrets in /v/.psst (this project)");
		expect(spec.items.map((i) => i.id)).toEqual(["list", "add", "tags"]);
		expect(psstMenu(vault, [{ name: "X", tags: [] }], []).items.map((i) => i.id)).toEqual(["list", "add"]);
		const filtered = psstMenu(vault, entries, ["home"]);
		expect(filtered.items.map((i) => i.id)).toEqual(["list", "add", "tags", "all"]);
		expect(filtered.status?.[2]).toBe("Tag filter: home (this session) · 1 of 3 offered to the agent");
	});
});

describe("the command", () => {
	function vaultIn(name: string, rows: [string, string[]][]): void {
		const dir = join(root, name, ".psst");
		mkdirSync(dir, { recursive: true });
		const db = new DatabaseSync(join(dir, "vault.db"));
		db.exec("CREATE TABLE secrets (name TEXT PRIMARY KEY, encrypted_value BLOB NOT NULL, iv BLOB NOT NULL, tags TEXT DEFAULT '[]')");
		for (const [secret, tags] of rows) db.prepare("INSERT INTO secrets (name, encrypted_value, iv, tags) VALUES (?, x'00', x'00', ?)").run(secret, JSON.stringify(tags));
		db.close();
		process.chdir(join(root, name));
	}

	function command() {
		let registered: any;
		registerPsstCommand({ registerCommand: (_name: string, options: unknown) => (registered = options) } as any);
		const notes: [string, string | undefined][] = [];
		const answers: (string | undefined)[] = [];
		const ctx = (hasUI = true) => ({
			hasUI,
			mode: hasUI ? "tui" : "rpc",
			ui: { notify: (text: string, level?: string) => notes.push([text, level]), input: async () => answers.shift() },
		});
		return { run: (args: string, hasUI = true) => registered.handler(args, ctx(hasUI)), complete: registered.getArgumentCompletions, notes, answers };
	}

	test("an unknown word is an error naming the real ones", async () => {
		vaultIn("unknown", [["A_KEY", []]]);
		const psst = command();
		await psst.run("lst");
		expect(psst.notes).toEqual([['/psst has no "lst". Try: list, add, tags, or /psst on its own for the menu.', "error"]]);
	});

	test("tags: a typo changes nothing; a real tag filters; off clears", async () => {
		vaultIn("tags", [["A_KEY", ["work"]], ["B_KEY", ["home"]]]);
		const psst = command();
		await psst.run("tags wrok");
		expect(psst.notes.at(-1)![1]).toBe("error");
		expect(getActiveTags()).toEqual([]);
		await psst.run("TAGS work");
		expect(getActiveTags()).toEqual(["work"]);
		expect(psst.notes.at(-1)![0]).toContain("(1 of 2)");
		await psst.run("tags off");
		expect(getActiveTags()).toEqual([]);
	});

	test("list shows names and tags and marks what the filter keeps back", async () => {
		vaultIn("list", [["A_KEY", ["work"]], ["B_KEY", []]]);
		const psst = command();
		await psst.run("list");
		const text = psst.notes.at(-1)![0];
		expect(text).toContain("2 secrets in");
		expect(text).toContain("  • A_KEY  [work]");
		expect(text).toContain("  • B_KEY");
	});

	test("add with nothing typed saves nothing; a bad name is refused before any value is asked", async () => {
		vaultIn("add", []);
		const psst = command();
		psst.answers.push("");
		await psst.run("add");
		expect(psst.notes.at(-1)).toEqual(["Nothing saved.", "info"]);
		await psst.run("add 2fa");
		expect(psst.notes.at(-1)![1]).toBe("error");
		expect(psst.answers).toEqual([]);
	});

	test("a value typed after the name is refused without being repeated", async () => {
		vaultIn("value-typed", []);
		const psst = command();
		await psst.run("add STRIPE_KEY sk_live_abc123");
		expect(psst.notes.at(-1)![1]).toBe("error");
		expect(psst.notes.join("")).not.toContain("sk_live_abc123");
	});

	test("without a screen, bare /psst explains itself in text", async () => {
		vaultIn("text", [["A_KEY", ["work"]]]);
		const psst = command();
		await psst.run("", false);
		expect(psst.notes.at(-1)![0]).toContain("/psst add NAME     add or change a secret");
	});

	test("suggestions: the words, tags with their counts, and names to replace", () => {
		vaultIn("complete", [["A_KEY", ["work"]], ["B_KEY", ["work", "home"]]]);
		const psst = command();
		expect(psst.complete("t")).toEqual([{ value: "tags ", label: "tags", description: "offer only some tags to the agent" }]);
		expect(psst.complete("tags ").map((i: any) => i.value)).toEqual(["tags off", "tags home", "tags work"]);
		expect(psst.complete("tags home,w")).toEqual([{ value: "tags home,work", label: "home,work", description: "2 secrets" }]);
		expect(psst.complete("add B").map((i: any) => i.value)).toEqual(["add B_KEY"]);
	});
});
