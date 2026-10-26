import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CHANGE_RETENTION_MS, pruneOldChanges, saveChange } from "./file-tracker";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "file-tracker-"));
const previous = process.env.PI_FILE_CHANGES_DIR;
beforeAll(() => {
	process.env.PI_FILE_CHANGES_DIR = ROOT;
});
afterAll(() => {
	if (previous === undefined) delete process.env.PI_FILE_CHANGES_DIR;
	else process.env.PI_FILE_CHANGES_DIR = previous;
	fs.rmSync(ROOT, { recursive: true, force: true });
});

const record = (session: string) =>
	saveChange(session, "call-1", { uri: "file:///x.ts", before: "a", after: "b", diff: "", isNewFile: false, timestamp: Date.now() });
const age = (session: string, ms: number) => {
	const when = new Date(Date.now() - ms);
	fs.utimesSync(path.join(ROOT, session), when, when);
};

test("drops sessions whose last edit is past the retention, keeps recent ones and the current one", async () => {
	for (const s of ["old", "recent", "current"]) record(s);
	age("old", CHANGE_RETENTION_MS + 60_000);
	age("current", CHANGE_RETENTION_MS * 3);
	age("recent", CHANGE_RETENTION_MS - 60_000);
	expect(await pruneOldChanges("current")).toBe(1);
	expect(fs.readdirSync(ROOT).sort()).toEqual(["current", "recent"]);
});

test("an old folder holding anything but records is never removed", async () => {
	fs.mkdirSync(path.join(ROOT, "not-records"));
	fs.writeFileSync(path.join(ROOT, "not-records", "notes.txt"), "mine");
	record("mixed");
	fs.writeFileSync(path.join(ROOT, "mixed", "keep.me"), "x");
	for (const s of ["not-records", "mixed"]) age(s, CHANGE_RETENTION_MS * 2);
	expect(await pruneOldChanges("current")).toBe(0);
	expect(fs.existsSync(path.join(ROOT, "not-records", "notes.txt"))).toBe(true);
	expect(fs.existsSync(path.join(ROOT, "mixed", "keep.me"))).toBe(true);
});

test("a missing records folder is nothing to prune", async () => {
	process.env.PI_FILE_CHANGES_DIR = path.join(ROOT, "absent");
	expect(await pruneOldChanges("x")).toBe(0);
	process.env.PI_FILE_CHANGES_DIR = ROOT;
});
