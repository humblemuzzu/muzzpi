/**
 * edit / write: only what our wrapper adds on top of pi's tools. pi's matcher
 * is upstream's and is tested there. Every call goes prepareArguments →
 * execute, the order pi's agent loop uses, against a real temp directory.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createEditToolDefinition, createWriteToolDefinition } from "@mariozechner/pi-coding-agent";
import { createEditTool, createWriteTool } from "./edit-write";
import { createRedoEditTool, createUndoEditTool } from "./undo-edit";
import * as ft from "./lib/file-tracker";

const editTool = createEditTool() as any;
const writeTool = createWriteTool() as any;
const undoTool = createUndoEditTool() as any;
const redoTool = createRedoEditTool() as any;

const DIR = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "edit-write-")));
process.env.PI_TRASH_DIR = path.join(DIR, ".trash");
const SESSION = `edit-write-${Date.now()}`;
const ctx = { cwd: DIR, sessionManager: { getSessionId: () => SESSION } };

let ids = 0;
let names = 0;
const nextId = (label: string) => `${label}-${ids++}`;

const edit = (args: unknown, id = nextId("edit"), context: unknown = ctx) =>
	editTool.execute(id, editTool.prepareArguments(args), undefined, undefined, context);
const write = (args: unknown, id = nextId("write"), context: unknown = ctx) =>
	writeTool.execute(id, writeTool.prepareArguments(args), undefined, undefined, context);

const abs = (name: string) => path.join(DIR, name);
const read = (name: string) => fs.readFileSync(abs(name), "utf8");
const exists = (name: string) => fs.existsSync(abs(name));

function fixture(content: string, extension = ".ts"): string {
	const name = `f${names++}${extension}`;
	fs.writeFileSync(abs(name), content);
	return name;
}
const freshName = (extension = ".ts") => `n${names++}${extension}`;

async function refusal(run: Promise<unknown>): Promise<string> {
	try {
		await run;
	} catch (error) {
		return (error as Error).message;
	}
	throw new Error("expected the call to be refused");
}

afterAll(() => {
	fs.rmSync(DIR, { recursive: true, force: true });
	fs.rmSync(path.join(os.homedir(), ".pi", "file-changes", SESSION), { recursive: true, force: true });
});

describe("edit", () => {
	test("what the model sees is exactly pi's: schema, description, guidelines, sampling", () => {
		const pi = createEditToolDefinition(DIR) as any;
		expect(editTool.name).toBe(pi.name);
		expect(editTool.parameters).toEqual(pi.parameters);
		expect(editTool.description).toBe(pi.description);
		expect(editTool.promptGuidelines).toEqual(pi.promptGuidelines);
		expect(editTool.constrainedSampling).toEqual(pi.constrainedSampling);
	});

	test("applies pi's edits[] shape", async () => {
		const f = fixture("const size = 28;\n");
		const result = await edit({ path: f, edits: [{ oldText: "28", newText: "32" }] });
		expect(read(f)).toBe("const size = 32;\n");
		expect(result.content[0].text).toContain("Successfully replaced 1 block(s)");
		expect(result.details.changes[0].diff).toContain("+const size = 32;");
	});

	test("accepts Claude's names at the top level and inside edits[]", async () => {
		const f = fixture("alpha\nbeta\n");
		await edit({ file_path: f, old_string: "alpha", new_string: "ALPHA" });
		await edit({ path: f, edits: [{ old_string: "beta", new_string: "BETA" }] });
		await edit({ path: f, edits: JSON.stringify([{ old_str: "ALPHA", new_str: "a" }]) });
		expect(read(f)).toBe("a\nBETA\n");
	});

	test("several edits in one call are matched against the original file", async () => {
		const f = fixture("one\ntwo\nthree\n");
		await edit({ path: f, edits: [{ oldText: "one", newText: "1" }, { oldText: "three", newText: "3" }] });
		expect(read(f)).toBe("1\ntwo\n3\n");
	});

	test("one identical entry does not stop the rest of the call", async () => {
		const f = fixture("a\nb\n");
		await edit({ path: f, edits: [{ oldText: "a", newText: "a" }, { oldText: "b", newText: "B" }] });
		expect(read(f)).toBe("a\nB\n");
	});

	test("two edits to one file at once both land", async () => {
		const f = fixture("first\nsecond\n");
		await Promise.all([
			edit({ path: f, old_string: "first", new_string: "1st" }),
			edit({ path: f, old_string: "second", new_string: "2nd" }),
		]);
		expect(read(f)).toBe("1st\n2nd\n");
	});

	test("keeps CRLF line endings", async () => {
		const f = fixture("a\r\nb\r\n");
		await edit({ path: f, edits: [{ oldText: "a\nb", newText: "a\nc" }] });
		expect(read(f)).toBe("a\r\nc\r\n");
	});

	test("identical oldText and newText says the edit is already done", async () => {
		const f = fixture("same\n");
		const message = await refusal(edit({ path: f, old_string: "same", new_string: "same" }));
		expect(message).toContain("identical");
		expect(message).toContain("the edit is done");
		expect(read(f)).toBe("same\n");
	});

	test("not found shows the closest line, and leaves the file alone", async () => {
		const f = fixture("function main() {\n  return computeTotal(items);\n}\n");
		const message = await refusal(
			edit({ path: f, old_string: "return computeTotals(items);", new_string: "return 0;" }),
		);
		expect(message).toContain("Could not find");
		expect(message).toContain("Closest match:");
		expect(message).toContain("computeTotal(items)");
		expect(read(f)).toContain("computeTotal(items)");
	});

	test("not found finds the near-miss in the middle of a line", async () => {
		const f = fixture("export const size = 28;\n");
		const message = await refusal(edit({ path: f, old_string: "size = 99", new_string: "size = 1" }));
		expect(message).toContain("Closest match:");
		expect(message).toContain("export const size = 28;");
	});

	test("not found because of whitespace says so", async () => {
		const f = fixture("if (a) {\n    go();\n}\n");
		const message = await refusal(edit({ path: f, old_string: "if (a) { go(); }", new_string: "x" }));
		expect(message).toContain("whitespace or line breaks differ");
	});

	test("a duplicate match lists where, and explains there is no replace_all", async () => {
		const f = fixture("x = 1;\ny = 2;\nx = 1;\n");
		const message = await refusal(edit({ path: f, old_string: "x = 1;", new_string: "x = 9;" }));
		expect(message).toContain("Found 2 occurrences");
		expect(message).toContain("line 1:");
		expect(message).toContain("line 3:");
		expect(message).toContain("no replace_all");
	});

	test("a missing file is an error", async () => {
		const message = await refusal(edit({ path: "nope.ts", old_string: "a", new_string: "b" }));
		expect(message).toContain("nope.ts");
	});

	test("refuses a file that is not UTF-8 text, leaving its bytes alone", async () => {
		const name = freshName(".bin");
		const bytes = Buffer.from([0x89, 0x50, 0xff, 0xfe, 0x00, 0x80]);
		fs.writeFileSync(abs(name), bytes);
		expect(await refusal(edit({ path: name, old_string: "P", new_string: "Q" }))).toContain("not a UTF-8 text file");
		expect(fs.readFileSync(abs(name)).equals(bytes)).toBe(true);
	});
});

describe("write", () => {
	test("what the model sees is exactly pi's", () => {
		const pi = createWriteToolDefinition(DIR) as any;
		expect(writeTool.name).toBe(pi.name);
		expect(writeTool.parameters).toEqual(pi.parameters);
		expect(writeTool.description).toBe(pi.description);
		expect(writeTool.promptGuidelines).toEqual(pi.promptGuidelines);
	});

	test("creates a file and its parent directories", async () => {
		const name = `deep/${freshName()}`;
		const result = await write({ path: name, content: "made\n" });
		expect(read(name)).toBe("made\n");
		expect(result.details.changes[0].kind).toBe("added");
	});

	test("replaces an existing file", async () => {
		const f = fixture("old\n");
		const result = await write({ file_path: f, content: "new\n" });
		expect(read(f)).toBe("new\n");
		expect(result.details.changes[0].kind).toBe("modified");
	});

	test("identical content is reported, not written or recorded", async () => {
		const f = fixture("same\n");
		const id = nextId("write-same");
		const result = await write({ path: f, content: "same\n" }, id);
		expect(result.content[0].text).toContain("already has exactly this content");
		expect(ft.loadChanges(SESSION, id)).toHaveLength(0);
	});

	test("refuses to replace a binary file, so undo can never restore mangled bytes", async () => {
		const name = freshName(".png");
		const bytes = Buffer.from([0x89, 0x50, 0xff, 0xfe, 0x00, 0x80]);
		fs.writeFileSync(abs(name), bytes);
		expect(await refusal(write({ path: name, content: "text\n" }))).toContain("not a UTF-8 text file");
		expect(fs.readFileSync(abs(name)).equals(bytes)).toBe(true);
	});
});

describe("permissions.json applies to the path pi really writes", () => {
	const rulesFile = path.join(DIR, "permissions.json");
	beforeEach(() => {
		fs.writeFileSync(
			rulesFile,
			JSON.stringify([
				{ tool: "edit", matches: { path: "*/secret/*" }, action: "reject", message: "no secrets" },
				{ tool: "write", matches: { path: "*/secret/*" }, action: "reject", message: "no secrets" },
				{ tool: "*", action: "allow" },
			]),
		);
		process.env.PI_PERMISSIONS_FILE = rulesFile;
		fs.mkdirSync(abs("secret"), { recursive: true });
	});
	afterEach(() => {
		delete process.env.PI_PERMISSIONS_FILE;
	});

	test("edit is refused and the file is untouched", async () => {
		fs.writeFileSync(abs("secret/key.ts"), "k = 1\n");
		expect(await refusal(edit({ path: "secret/key.ts", old_string: "1", new_string: "2" }))).toContain("no secrets");
		expect(read("secret/key.ts")).toBe("k = 1\n");
	});

	test("write is refused before any directory or file is created", async () => {
		expect(await refusal(write({ path: "secret/deep/new.ts", content: "x\n" }))).toContain("no secrets");
		expect(exists("secret/deep")).toBe(false);
	});

	test("a file:// path or a symlink into the protected folder is refused too", async () => {
		expect(await refusal(write({ path: `file://${abs("secret/url.ts")}`, content: "x\n" }))).toContain("no secrets");
		fs.symlinkSync(abs("secret"), abs("innocent"));
		expect(await refusal(write({ path: "innocent/linked.ts", content: "x\n" }))).toContain("no secrets");
		expect(exists("secret/url.ts") || exists("secret/linked.ts")).toBe(false);
	});
});

describe("a change that cannot be recorded for undo is never made", () => {
	const broken = { cwd: DIR, sessionManager: { getSessionId: () => "bad\0session" } };

	test("write of a new file never creates it", async () => {
		const name = freshName();
		const message = await refusal(write({ path: name, content: "x\n" }, nextId("w"), broken));
		expect(message).toContain("nothing was written");
		expect(exists(name)).toBe(false);
	});

	test("edit leaves the old bytes", async () => {
		const f = fixture("keep\n");
		const message = await refusal(edit({ path: f, old_string: "keep", new_string: "lose" }, nextId("e"), broken));
		expect(message).toContain("nothing was written");
		expect(read(f)).toBe("keep\n");
	});
});

describe("undo_edit / redo_edit through edit and write", () => {
	const branchCtx = (branch: string[]) => ({
		cwd: DIR,
		sessionManager: {
			getSessionId: () => SESSION,
			getBranch: () =>
				branch.map((id) => ({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id }] } })),
		},
	});
	const undo = (branch: string[], args: unknown) => undoTool.execute("undo", args, undefined, undefined, branchCtx(branch));
	const redo = (branch: string[], args: unknown) => redoTool.execute("redo", args, undefined, undefined, branchCtx(branch));

	test("undoing a write that created a file moves it to the Trash, never deletes it", async () => {
		const name = freshName();
		const id = nextId("u");
		await write({ path: name, content: "made\n" }, id);
		await undo([id], { path: abs(name) });
		expect(exists(name)).toBe(false);
		const trashed = fs.readdirSync(process.env.PI_TRASH_DIR!).filter((entry) => entry.endsWith(name));
		expect(trashed).toHaveLength(1);
		expect(fs.readFileSync(path.join(process.env.PI_TRASH_DIR!, trashed[0]!), "utf8")).toBe("made\n");
	});

	test("undoing a write that replaced a file restores the old bytes", async () => {
		const f = fixture("original\n");
		const id = nextId("u");
		await write({ path: f, content: "replaced\n" }, id);
		await undo([id], { path: abs(f) });
		expect(read(f)).toBe("original\n");
	});

	test("undo and redo diffs read in the direction they act", async () => {
		const f = fixture("old-line\n");
		const id = nextId("u");
		await edit({ path: f, old_string: "old-line", new_string: "new-line" }, id);
		const undone = (await undo([id], { path: abs(f) })).content[0].text as string;
		expect(undone).toContain("-new-line");
		expect(undone).toContain("+old-line");
		const redone = (await redo([id], { path: abs(f) })).content[0].text as string;
		expect(redone).toContain("+new-line");
		expect(read(f)).toBe("new-line\n");
	});

	test("a codemode script's edits (ids `<parent>/<n>`) undo and redo as one change", async () => {
		const f = fixture("v1\n");
		const other = fixture("o1\n");
		const parent = nextId("script");
		await edit({ path: f, old_string: "v1", new_string: "v2" }, `${parent}/1`);
		await edit({ path: f, old_string: "v2", new_string: "v3" }, `${parent}/2`);
		await edit({ path: other, old_string: "o1", new_string: "o2" }, `${parent}/3`);
		const undone = await undo([parent], { path: abs(f) });
		expect(undone.isError).toBeFalsy();
		expect(read(f)).toBe("v1\n");
		expect(read(other)).toBe("o1\n");
		await redo([parent], { path: abs(f) });
		expect(read(f)).toBe("v3\n");
		expect(read(other)).toBe("o2\n");
	});

	test("refuses to undo past a newer change to the same file", async () => {
		const a = fixture("a1\n");
		const c = fixture("c1\n");
		const parent = nextId("script");
		await edit({ path: a, old_string: "a1", new_string: "a2" }, `${parent}/1`);
		await edit({ path: c, old_string: "c1", new_string: "c2" }, `${parent}/2`);
		const later = nextId("later");
		await edit({ path: a, old_string: "a2", new_string: "a3" }, later);
		const result = await undo([parent, later], { path: abs(c) });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toMatch(/something newer has since modified/i);
		expect(read(c)).toBe("c2\n");
	});

	test("independent changes are undoable in any order", async () => {
		const first = fixture("first-v1\n");
		const second = fixture("second-v1\n");
		const idA = nextId("a");
		const idB = nextId("b");
		await edit({ path: first, old_string: "first-v1", new_string: "first-v2" }, idA);
		await edit({ path: second, old_string: "second-v1", new_string: "second-v2" }, idB);
		expect((await undo([idA, idB], { path: abs(first) })).isError).toBeFalsy();
		expect(read(first)).toBe("first-v1\n");
		expect(read(second)).toBe("second-v2\n");
	});

	test("two undos then two redos walk back one step at a time", async () => {
		const f = fixture("L1\n");
		const b = nextId("b");
		const c = nextId("c");
		await edit({ path: f, old_string: "L1", new_string: "L2" }, b);
		await edit({ path: f, old_string: "L2", new_string: "L3" }, c);
		await undo([b, c], { path: abs(f) });
		await undo([b, c], { path: abs(f) });
		expect(read(f)).toBe("L1\n");
		await redo([b, c], { path: abs(f) });
		expect(read(f)).toBe("L2\n");
		await redo([b, c], { path: abs(f) });
		expect(read(f)).toBe("L3\n");
		expect((await redo([b, c], { path: abs(f) })).isError).toBe(true);
	});

	test("redo refuses once the file has moved on", async () => {
		const f = fixture("v1\n");
		const first = nextId("first");
		await edit({ path: f, old_string: "v1", new_string: "v2" }, first);
		await undo([first], { path: abs(f) });
		const second = nextId("second");
		await edit({ path: f, old_string: "v1", new_string: "v3" }, second);
		const result = await redo([first, second], { path: abs(f) });
		expect(result.isError).toBe(true);
		expect(read(f)).toBe("v3\n");
	});

	test("refuses to erase an edit made outside the tool, unless forced", async () => {
		const f = fixture("original\n");
		const id = nextId("drift");
		await edit({ path: f, old_string: "original", new_string: "by-tool" }, id);
		fs.writeFileSync(abs(f), "by-tool\nby-hand\n");
		const refused = await undo([id], { path: abs(f) });
		expect(refused.isError).toBe(true);
		expect(read(f)).toBe("by-tool\nby-hand\n");
		const forced = await undo([id], { path: abs(f), force: true });
		expect(forced.isError).toBeFalsy();
		expect(read(f)).toBe("original\n");
		expect(forced.content[0].text).toMatch(/discarded changes made outside this tool/i);
	});

	test("redo refuses to erase an edit made outside the tool", async () => {
		const f = fixture("v1\n");
		const id = nextId("redo-drift");
		await edit({ path: f, old_string: "v1", new_string: "v2" }, id);
		await undo([id], { path: abs(f) });
		fs.writeFileSync(abs(f), "v1-by-hand\n");
		expect((await redo([id], { path: abs(f) })).isError).toBe(true);
		expect(read(f)).toBe("v1-by-hand\n");
	});

	test("a move recorded by an older apply_patch still undoes as one operation", async () => {
		const source = abs(fixture("gold\n"));
		const destination = abs(freshName());
		fs.renameSync(source, destination);
		const id = nextId("legacy-move");
		const base = { diff: "", timestamp: Date.now() };
		ft.saveChange(SESSION, id, {
			...base,
			uri: `file://${source}`,
			before: "gold\n",
			after: "",
			isNewFile: false,
			beforeExists: true,
			afterExists: false,
			movePartnerUri: `file://${destination}`,
		});
		ft.saveChange(SESSION, id, {
			...base,
			uri: `file://${destination}`,
			before: "",
			after: "gold\n",
			isNewFile: true,
			beforeExists: false,
			afterExists: true,
			movePartnerUri: `file://${source}`,
		});
		const result = await undo([id], { path: destination, scope: "file" });
		expect(result.isError).toBeFalsy();
		expect(fs.readFileSync(source, "utf8")).toBe("gold\n");
		expect(fs.existsSync(destination)).toBe(false);
	});
});
