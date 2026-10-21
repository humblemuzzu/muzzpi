import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	addIdea,
	agentDir,
	ideasHere,
	lastUserPrompt,
	loadAll,
	localIso,
	openCount,
	parseInput,
	projectFile,
	resolveWhere,
	sessionNameFrom,
	setScope,
	setStatus,
	type Where,
} from "./store";

const temps: string[] = [];
function temp(prefix: string): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	temps.push(dir);
	return dir;
}
afterAll(() => {
	for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function gitRepo(name: string, harness = false): string {
	const root = join(temp("ideas-repo-"), name);
	mkdirSync(join(root, "src"), { recursive: true });
	const run = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
	run("init", "-q", "-b", "main");
	run("config", "user.email", "t@example.com");
	run("config", "user.name", "t");
	writeFileSync(join(root, "README.md"), "x\n");
	if (harness) {
		mkdirSync(join(root, "pi-setup", "extensions", "ideas"), { recursive: true });
		writeFileSync(join(root, "pi-setup", "extensions", "ideas", "index.ts"), "");
	}
	run("add", ".");
	run("commit", "-q", "-m", "init");
	return root;
}

const place = (root: string, project: string, isHarness = false): Where => ({ cwd: root, root, project, isHarness });

describe("parseInput", () => {
	test("leading tags set the kind and the harness, in any order and case", () => {
		expect(parseInput("pi: bug: the dock flickers")).toEqual({ text: "the dock flickers", kind: "bug", toHarness: true });
		expect(parseInput("Bug: PI: x")).toEqual({ text: "x", kind: "bug", toHarness: true });
		expect(parseInput("fix:crop is off")).toEqual({ text: "crop is off", kind: "bug", toHarness: false });
		expect(parseInput("meh: too many popups")).toEqual({ text: "too many popups", kind: "dislike", toHarness: false });
		expect(parseInput("  plain idea  ")).toEqual({ text: "plain idea", kind: "idea", toHarness: false });
	});

	test("a word that is not a tag stays part of the idea", () => {
		expect(parseInput("note: call the bank").text).toBe("note: call the bank");
		expect(parseInput("https://x.dev is down").text).toBe("https://x.dev is down");
		expect(parseInput("use pi: in the readme").text).toBe("use pi: in the readme");
	});

	test("tags alone leave nothing to save", () => {
		expect(parseInput("pi: bug:").text).toBe("");
	});
});

describe("resolveWhere", () => {
	test("finds the repo root, branch, commit and dirty state from a subfolder", async () => {
		const root = gitRepo("photos");
		const where = await resolveWhere(join(root, "src"));
		expect(where).toMatchObject({ cwd: join(root, "src"), root, project: "photos", isHarness: false, branch: "main", dirty: false });
		expect(where.commit).toMatch(/^[0-9a-f]{7,}$/);
		appendFileSync(join(root, "README.md"), "y\n");
		expect((await resolveWhere(root)).dirty).toBe(true);
	});

	test("without code details it runs one git call and reports only the place", async () => {
		const root = gitRepo("photos");
		const where = await resolveWhere(root, false);
		expect(where).toEqual({ cwd: root, root, project: "photos", isHarness: false });
	});

	test("the harness is the repo that holds this extension's source", async () => {
		const root = gitRepo("ghosttyyy", true);
		expect((await resolveWhere(join(root, "src"))).isHarness).toBe(true);
	});

	test("a folder outside git is its own project", async () => {
		const dir = temp("ideas-plain-");
		expect(await resolveWhere(dir)).toEqual({ cwd: dir, root: dir, project: dir.split("/").pop()!, isHarness: false });
	});
});

describe("saving and folding", () => {
	test("an idea is filed under its project and starts open", () => {
		const dir = temp("ideas-store-");
		const idea = addIdea(dir, place("/p/photos", "photos"), parseInput("bug: crop is off"), { source: "pi", agentBusy: true });
		expect(idea).toMatchObject({ scope: "project", kind: "bug", text: "crop is off", status: "open", file: "photos.jsonl" });
		const [line] = readFileSync(join(dir, "photos.jsonl"), "utf8").trim().split("\n");
		expect(JSON.parse(line!)).toMatchObject({ v: 1, op: "add", id: idea.id, at: { root: "/p/photos" }, agentBusy: true, source: "pi" });
	});

	test("pi: from a project files it under the harness; inside the harness everything is", () => {
		const dir = temp("ideas-store-");
		expect(addIdea(dir, place("/p/photos", "photos"), parseInput("pi: dock flickers"), { source: "pi" }).scope).toBe("harness");
		expect(addIdea(dir, place("/h/ghosttyyy", "ghosttyyy", true), parseInput("dock flickers"), { source: "pi" }).scope).toBe("harness");
		expect(openCount(loadAll(dir), { root: "", isHarness: true })).toBe(2);
		expect(openCount(loadAll(dir), place("/p/photos", "photos"))).toBe(0);
	});

	test("status and scope changes are appended and replayed in order", () => {
		const dir = temp("ideas-store-");
		const photos = place("/p/photos", "photos");
		const a = addIdea(dir, photos, parseInput("a"), { source: "pi" });
		const b = addIdea(dir, photos, parseInput("b"), { source: "pi" });
		setStatus(dir, a, "done");
		setScope(dir, b, "harness");
		setStatus(dir, a, "open");
		setStatus(dir, a, "dropped");
		const all = loadAll(dir);
		expect(all.find((idea) => idea.id === a.id)?.status).toBe("dropped");
		expect(all.find((idea) => idea.id === b.id)?.scope).toBe("harness");
		expect(readFileSync(join(dir, "photos.jsonl"), "utf8").trim().split("\n")).toHaveLength(6);
	});

	test("a line cut short by a crash does not hide the others", () => {
		const dir = temp("ideas-store-");
		const photos = place("/p/photos", "photos");
		addIdea(dir, photos, parseInput("first"), { source: "pi" });
		appendFileSync(join(dir, "photos.jsonl"), '{"v":1,"op":"add","id":"zz');
		addIdea(dir, photos, parseInput("second"), { source: "pi" });
		addIdea(dir, photos, parseInput("third"), { source: "pi" });
		expect(loadAll(dir).map((idea) => idea.text)).toEqual(["first", "second", "third"]);
	});

	test("two projects with the same folder name share a file but never each other's ideas", () => {
		const dir = temp("ideas-store-");
		const work = place("/work/app", "app");
		const home = place("/home/app", "app");
		addIdea(dir, work, parseInput("work idea"), { source: "pi" });
		addIdea(dir, home, parseInput("home idea"), { source: "pi" });
		expect(ideasHere(loadAll(dir), work).map((idea) => idea.text)).toEqual(["work idea"]);
		expect(ideasHere(loadAll(dir), home).map((idea) => idea.text)).toEqual(["home idea"]);
	});

	test("ids stay unique across files", () => {
		const dir = temp("ideas-store-");
		for (let i = 0; i < 400; i++) addIdea(dir, place(`/p/${i % 7}`, `p${i % 7}`), parseInput(`idea ${i}`), { source: "pi" });
		const ids = loadAll(dir).map((idea) => idea.id);
		expect(new Set(ids).size).toBe(400);
	});

	test("an empty idea is refused before anything is written", () => {
		const dir = temp("ideas-store-");
		expect(() => addIdea(dir, place("/p/photos", "photos"), parseInput("pi:"), { source: "pi" })).toThrow("empty");
		expect(loadAll(dir)).toEqual([]);
	});

	test("file names are safe, and a project called harness keeps clear of the harness view", () => {
		expect(projectFile({ project: "Humanize AI" })).toBe("humanize-ai.jsonl");
		expect(projectFile({ project: "harness" })).toBe("harness-project.jsonl");
		expect(projectFile({ project: "///" })).toBe("project.jsonl");
	});
});

describe("markdown views", () => {
	test("each project gets its view and harness.md gathers harness ideas from every project", () => {
		const dir = temp("ideas-store-");
		const photos = place("/p/photos", "photos");
		const done = addIdea(dir, photos, parseInput("ship the crop fix"), { source: "pi", lastPrompt: "fix the upload flow" });
		addIdea(dir, photos, parseInput("dislike: slow tests"), { source: "pi" });
		addIdea(dir, photos, parseInput("pi: dock flickers"), { source: "pi" });
		setStatus(dir, done, "done");

		const project = readFileSync(join(dir, "photos.md"), "utf8");
		expect(project).toContain("# photos ideas");
		expect(project).toContain("## Open (1)");
		expect(project).toContain("**dislike** slow tests");
		expect(project).toContain("## Done (1)");
		expect(project).toContain("- [x] ship the crop fix");
		expect(project).toContain("  - while: fix the upload flow");
		expect(project).not.toContain("dock flickers");

		const harness = readFileSync(join(dir, "harness.md"), "utf8");
		expect(harness).toContain("- [ ] dock flickers");
		expect(harness).toContain("from photos");
	});

	test("moving the last project idea away rewrites the view instead of leaving it stale", () => {
		const dir = temp("ideas-store-");
		const idea = addIdea(dir, place("/p/photos", "photos"), parseInput("only one"), { source: "pi" });
		setScope(dir, idea, "harness");
		expect(readFileSync(join(dir, "photos.md"), "utf8")).toContain("Nothing open.");
	});
});

describe("session context", () => {
	const entries = [
		{ type: "message", message: { role: "user", content: "first prompt" } },
		{ type: "session_info", name: "crop work" },
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "answer" }] } },
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "second\nprompt" }, { type: "image" }] } },
		{ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "out" }] } },
	];

	test("the last user prompt is flattened to one line", () => {
		expect(lastUserPrompt(entries)).toBe("second prompt");
		expect(lastUserPrompt([])).toBeUndefined();
	});

	test("a long prompt is cut to 200 characters", () => {
		const long = lastUserPrompt([{ type: "message", message: { role: "user", content: "x".repeat(500) } }])!;
		expect(long).toHaveLength(200);
		expect(long.endsWith("…")).toBe(true);
	});

	test("the session name is the newest session_info entry", () => {
		expect(sessionNameFrom(entries)).toBe("crop work");
		expect(sessionNameFrom([...entries, { type: "session_info", name: "renamed" }])).toBe("renamed");
	});
});

describe("time and paths", () => {
	test("timestamps are local, carry their offset and parse back to the same instant", () => {
		const now = new Date();
		const iso = localIso(now);
		expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
		expect(Math.abs(Date.parse(iso) - now.getTime())).toBeLessThan(1000);
	});

	test("the agent dir follows PI_CODING_AGENT_DIR like pi does", () => {
		const saved = process.env.PI_CODING_AGENT_DIR;
		try {
			process.env.PI_CODING_AGENT_DIR = "/x/agent";
			expect(agentDir()).toBe("/x/agent");
			process.env.PI_CODING_AGENT_DIR = "~/custom";
			expect(agentDir()).toBe(join(process.env.HOME!, "custom"));
			delete process.env.PI_CODING_AGENT_DIR;
			expect(agentDir()).toBe(join(process.env.HOME!, ".pi", "agent"));
		} finally {
			if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = saved;
		}
	});
});
