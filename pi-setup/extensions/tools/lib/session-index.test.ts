import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { branchesOf, SessionIndex, summarizeSession } from "./session-index";
import { createSearchSessionsTool } from "../search-sessions";
import { findSessionFile, renderSessionTree } from "../read-session";

const ROOT = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "session-index-")));
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

let seq = 0;
const at = (minute: number) => `2026-10-01T10:${String(minute).padStart(2, "0")}:00.000Z`;
const entry = (type: string, id: string, parentId: string | null, minute: number, rest: object = {}) =>
	JSON.stringify({ type, id, parentId, timestamp: at(minute), ...rest });
const user = (id: string, parentId: string | null, minute: number, text: string) =>
	entry("message", id, parentId, minute, { message: { role: "user", content: [{ type: "text", text }] } });
const assistant = (id: string, parentId: string, minute: number, text: string, args?: object) =>
	entry("message", id, parentId, minute, {
		message: { role: "assistant", content: [{ type: "text", text }, ...(args ? [{ type: "toolCall", id: "c1", name: "edit", arguments: args }] : [])], model: "m" },
	});
const toolResult = (id: string, parentId: string, minute: number, text: string) =>
	entry("message", id, parentId, minute, {
		message: { role: "toolResult", toolCallId: "c1", toolName: "edit", content: [{ type: "text", text }, { type: "image", data: "A".repeat(20_000), mimeType: "image/png" }], isError: false, timestamp: 1 },
	});

function writeSession(dir: string, cwd: string, lines: string[], id = `s${++seq}`): string {
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `2026-10-01T10-00-00-000Z_${id}.jsonl`);
	const header = JSON.stringify({ type: "session", version: 3, id, timestamp: at(0), cwd });
	fs.writeFileSync(file, [header, ...lines].join("\n") + "\n");
	return file;
}

/** user → assistant(edit) → toolResult → { user "left", user "right" }, plus a model change and a name. */
function branchingSession(dir: string, cwd: string, id?: string): string {
	return writeSession(dir, cwd, [
		entry("model_change", "m1", null, 1, { provider: "p", modelId: "model-a" }),
		user("u1", "m1", 2, "fix @src/app.ts and /etc/hosts please"),
		assistant("a1", "u1", 3, "editing now", { path: "/repo/lib/x.ts" }),
		toolResult("t1", "a1", 4, "SECRET-TOOL-OUTPUT"),
		entry("custom", "c1", "t1", 5, { customType: "big", data: "x".repeat(10_000) }),
		user("u2", "c1", 6, "go left"),
		user("u3", "c1", 7, "go right with the rocket"),
		JSON.stringify({ type: "session_info", id: "n1", parentId: "u3", timestamp: at(8), name: "rocket work" }),
		'{"type":"message","id":"broken","parentId":"u3","timestamp":"2026-10-01T10:09:00.000Z","message":{"role":"toolResult","content":[{"type":"te',
	], id);
}

describe("summarizeSession + branchesOf", () => {
	const file = branchingSession(path.join(ROOT, "unit"), "/work/alpha");

	test("one branch per leaf, each with its own chain", async () => {
		const branches = branchesOf(await summarizeSession(file), file);
		expect(branches.map((b) => b.leafId).sort()).toEqual(["n1", "u2"]);
		const right = branches.find((b) => b.leafId === "n1")!;
		expect(right.sessionName).toBe("rocket work");
		expect(right.messageCount).toBe(4);
		expect(right.models).toEqual(["model-a"]);
		expect(right.firstUserMessage).toBe("fix @src/app.ts and /etc/hosts please");
		expect(right.filesTouched).toEqual(["src/app.ts", "/etc/hosts", "/repo/lib/x.ts"]);
		expect(right.timestampStart).toBe(at(1));
		expect(right.timestampEnd).toBe(at(8));
		expect(right.searchableText).toContain("rocket");
		expect(branches.find((b) => b.leafId === "u2")!.searchableText).not.toContain("rocket");
	});

	test("a tool result counts as a message but its output is never searchable; a torn line is skipped", async () => {
		const summary = await summarizeSession(file);
		expect(summary.nodes.find((n) => n.id === "t1")).toEqual({ id: "t1", parentId: "a1", type: "message", ts: at(4), role: "toolResult" });
		expect(summary.nodes.some((n) => n.id === "broken")).toBe(false);
		expect(JSON.stringify(summary)).not.toContain("SECRET-TOOL-OUTPUT");
		expect(JSON.stringify(summary)).not.toContain("AAAA");
	});
});

/** the full parse search_sessions did before the index: every line JSON.parsed, branches rebuilt from all of them */
function referenceBranches(file: string) {
	const entries: any[] = [];
	let header: any = null;
	let name = "";
	for (const line of fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim())) {
		try {
			const e = JSON.parse(line);
			if (e.type === "session") header = e;
			else if (e.type === "session_info" && typeof e.name === "string") name = e.name;
			if (typeof e.id === "string") entries.push(e);
		} catch {}
	}
	if (!header) return [];
	const byId = new Map(entries.map((e) => [e.id, e]));
	const parents = new Set(entries.map((e) => e.parentId).filter(Boolean));
	const up = (e: any) => { const chain: any[] = []; for (let c = e; c && !chain.includes(c); c = c.parentId ? byId.get(c.parentId) : undefined) chain.unshift(c); return chain; };
	const paths = (args: any) => (args ? ["path", "filePath", "file_path"].map((k) => args[k]).filter((v) => typeof v === "string") : []);
	const textPaths = (t: string) => [...[...t.matchAll(/@([\w./-]+\/[\w./-]+)/g)].map((m) => m[1]), ...[...t.matchAll(/(?:^|\s)(\/[\w./-]+)/gm)].map((m) => m[1])];
	return entries.filter((leaf) => !parents.has(leaf.id)).filter((leaf) => !["session", "model_change", "thinking_level_change"].includes(leaf.type) || up(leaf).some((e) => e.type === "message")).map((leaf) => {
		const chain = up(leaf);
		const files = new Set<string>(), models = new Set<string>(), text: string[] = [];
		let messageCount = 0, firstUserMessage = "";
		for (const e of chain) {
			if (e.type === "model_change" && typeof e.modelId === "string") models.add(e.modelId);
			if (e.type !== "message" || !e.message) continue;
			messageCount++;
			for (const p of e.message.content || []) {
				if (e.message.role === "user" && p.type === "text" && typeof p.text === "string" && p.text) {
					if (!firstUserMessage) firstUserMessage = p.text.slice(0, 200);
					text.push(p.text);
					for (const f of textPaths(p.text)) files.add(f!);
				}
				if (e.message.role === "assistant" && p.type === "text" && typeof p.text === "string" && p.text) text.push(p.text);
				if (e.message.role === "assistant" && p.type === "toolCall" && p.arguments) for (const f of paths(p.arguments)) files.add(f);
			}
		}
		const ts = chain.map((e) => e.timestamp).filter(Boolean).sort();
		return {
			sessionId: header.id, sessionName: name, leafId: leaf.id, workspace: header.cwd, filePath: file,
			timestampStart: ts[0] || header.timestamp, timestampEnd: ts.at(-1) || header.timestamp,
			filesTouched: [...files], models: [...models], messageCount, firstUserMessage, searchableText: text.join("\n"), parentSessionPath: header.parentSession,
		};
	});
}

describe("the index reads a session as the full parse did", () => {
	const dir = path.join(ROOT, "fidelity");
	let seed = 11;
	const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
	const pick = <T>(items: T[]) => items[Math.floor(rand() * items.length)]!;

	function randomSession(n: number): string {
		const ids: string[] = [];
		const lines: string[] = [];
		for (let i = 0; i < 40; i++) {
			const id = rand() < 0.05 && ids.length ? pick(ids) : `e${n}-${i}`;
			const parent = ids.length && rand() < 0.9 ? (rand() < 0.2 ? pick(ids) : ids.at(-1)!) : null;
			const kind = rand();
			if (kind < 0.25) lines.push(user(id, parent, i % 60, pick(["fix @src/a.ts", "see /etc/hosts now", "plain", "", "नमस्ते \u2028 text"])));
			else if (kind < 0.45) lines.push(assistant(id, parent ?? "root", i % 60, pick(["ok", "done with it", ""]), rand() < 0.5 ? { path: `/r/${i}.ts` } : undefined));
			else if (kind < 0.7) lines.push(toolResult(id, parent ?? "root", i % 60, pick(["out", "y".repeat(6000)])));
			else if (kind < 0.78) lines.push(entry("custom", id, parent, i % 60, { customType: "big", data: "z".repeat(pick([10, 9000])) }));
			else if (kind < 0.84) lines.push(entry("model_change", id, parent, i % 60, { provider: "p", modelId: pick(["m1", "m2"]) }));
			else if (kind < 0.88) lines.push(entry("thinking_level_change", id, parent, i % 60, { thinkingLevel: "high" }));
			else if (kind < 0.92) lines.push(JSON.stringify({ type: "session_info", id, parentId: parent, timestamp: at(i % 60), name: pick(["n1", "n2"]) }));
			else if (kind < 0.96) lines.push(`${toolResult(id, parent ?? "root", i % 60, "cut").slice(0, 200)}${toolResult(`${id}b`, parent ?? "root", i % 60, "glued")}`);
			else lines.push("{not json}");
			ids.push(id);
		}
		const crlf = n % 3 === 0;
		const torn = n % 4 === 0 ? `\n${toolResult("tail", ids.at(-1)!, 59, "t").slice(0, -3)}}}` : "";
		const text = [JSON.stringify({ type: "session", version: 3, id: `s${n}`, timestamp: at(0), cwd: "/w" }), ...lines].join(crlf ? "\r\n" : "\n") + torn;
		const file = path.join(dir, `f${n}.jsonl`);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(file, text);
		return file;
	}

	test("on 60 generated sessions: forks, duplicate ids, CRLF, big and glued lines, a torn last line", async () => {
		for (let n = 0; n < 60; n++) {
			const file = randomSession(n);
			expect([n, branchesOf(await summarizeSession(file), file)]).toEqual([n, referenceBranches(file)]);
		}
	});
});

describe("SessionIndex", () => {
	const roots = [path.join(ROOT, "idx-main"), path.join(ROOT, "idx-sub")];
	const indexDir = path.join(ROOT, "idx-cache");

	test("re-reads only files that changed and forgets deleted ones", async () => {
		const a = branchingSession(roots[0]!, "/work/alpha");
		const b = writeSession(roots[1]!, "/work/beta", [user("u1", null, 1, "hello beta")]);
		const index = new SessionIndex(roots, indexDir);
		await index.refresh();
		expect(index.rows().map((r) => r.path)).toEqual([a, b]);
		const keyA = index.rows()[0]!.key;
		const summaryFile = path.join(indexDir, "files", `${keyA}.json`);
		const before = fs.statSync(summaryFile).mtimeMs;

		fs.appendFileSync(b, user("u2", "u1", 2, "more beta") + "\n");
		await index.refresh();
		expect(fs.statSync(summaryFile).mtimeMs).toBe(before);
		const rowB = index.rows().find((r) => r.path === b)!;
		expect(rowB.size).toBe(fs.statSync(b).size);
		expect(branchesOf((await index.summary(rowB))!, b)[0]!.searchableText).toContain("more beta");

		fs.rmSync(a);
		await index.refresh();
		expect(index.rows().map((r) => r.path)).toEqual([b]);
		expect(fs.existsSync(summaryFile)).toBe(false);

		const reopened = new SessionIndex(roots, indexDir);
		await reopened.refresh();
		expect(reopened.rows()).toEqual(index.rows());
	});

	test("a manifest of another format is discarded and everything is rebuilt", async () => {
		fs.writeFileSync(path.join(indexDir, "manifest.json"), JSON.stringify({ format: 0, rows: [{ path: "/nope", size: 1, mtimeMs: 1, id: "x", cwd: "", key: "k" }] }));
		const index = new SessionIndex(roots, indexDir);
		await index.refresh();
		expect(index.rows().map((r) => r.path)).not.toContain("/nope");
		expect(index.rows().length).toBe(1);
	});

	test("keysContaining finds summaries by text, and declines a needle JSON would escape", async () => {
		const index = new SessionIndex(roots, indexDir);
		await index.refresh();
		const key = index.rows()[0]!.key;
		expect(await index.keysContaining("MORE BETA")).toEqual(new Set([key]));
		expect(await index.keysContaining("nowhere-at-all")).toEqual(new Set());
		expect(await index.keysContaining('say "hi"')).toBeUndefined();
		expect(await index.keysContaining("ünïcode")).toBeUndefined();
		expect(await index.keysContaining("pi")).toBeUndefined();
		fs.writeFileSync(path.join(indexDir, ".ignore"), "*.json\n");
		fs.writeFileSync(path.join(indexDir, "files", ".ignore"), "*\n");
		expect(await index.keysContaining("MORE BETA")).toEqual(new Set([key]));
	});

	test("never blocks the event loop for long, even on a 40 MB session", async () => {
		const dir = path.join(ROOT, "big");
		const lines: string[] = [];
		let parent: string | null = null;
		for (let i = 0; i < 4000; i++) {
			const id = `e${i}`;
			lines.push(i % 2 ? toolResult(id, parent!, 1, "y".repeat(10_000)) : user(id, parent, 1, `turn ${i} ${"z".repeat(500)}`));
			parent = id;
		}
		writeSession(dir, "/work/big", lines);
		const index = new SessionIndex([dir], path.join(ROOT, "big-cache"));
		let last = performance.now();
		let worst = 0;
		const timer = setInterval(() => {
			const now = performance.now();
			worst = Math.max(worst, now - last);
			last = now;
		}, 2);
		await index.refresh();
		clearInterval(timer);
		expect(worst).toBeLessThan(250);
		expect(index.rows()).toHaveLength(1);
	});
});

describe("search_sessions", () => {
	const roots = [path.join(ROOT, "tool-main"), path.join(ROOT, "tool-sub")];
	const alpha = branchingSession(roots[0]!, "/work/alpha", "alpha-1");
	fs.copyFileSync(alpha, path.join(roots[0]!, "copy-of-alpha.jsonl"));
	writeSession(roots[1]!, "/work/beta", [user("u1", null, 1, "rocket in beta too")], "beta-1");
	const tool = createSearchSessionsTool(new SessionIndex(roots, path.join(ROOT, "tool-cache"))) as any;
	const run = async (params: object, cwd = "/work/alpha") => (await tool.execute("t", params, undefined, undefined, { cwd })).content[0].text as string;

	test("scopes to the current workspace and counts a copied session once", async () => {
		const out = await run({});
		expect(out).toStartWith("found 2 matching branches:");
		expect(out).not.toContain("beta-1");
	});

	test("keyword, file and all_workspaces filters", async () => {
		expect(await run({ keyword: "WITH THE ROCKET" })).toStartWith("found 1 matching branch:");
		expect(await run({ keyword: "rocket work" })).toStartWith("found 2 matching branches:");
		expect(await run({ keyword: "rocket in", all_workspaces: true })).toContain("session: beta-1");
		expect(await run({ keyword: "SECRET-TOOL-OUTPUT" })).toBe("(no matching sessions found)");
		expect(await run({ file: "lib/x.ts" })).toStartWith("found 2 matching branches:");
		expect(await run({ workspace: "beta" })).toContain("session: beta-1");
	});

	test("after uses last activity; a bad date is refused", async () => {
		const old = new Date("2020-01-01");
		for (const f of fs.readdirSync(roots[0]!)) fs.utimesSync(path.join(roots[0]!, f), old, old);
		expect(await run({ after: "7d" })).toBe("(no matching sessions found)");
		const bad = await tool.execute("t", { after: "soon" }, undefined, undefined, { cwd: "/work/alpha" });
		expect(bad.isError).toBe(true);
	});
});

describe("read_session lookups", () => {
	test("by file name first, then by header id; the target branch is marked", async () => {
		const dir = path.join(ROOT, "rs");
		const named = branchingSession(dir, "/work/rs", "rs-named");
		const renamed = path.join(dir, "renamed.jsonl");
		fs.copyFileSync(branchingSession(path.join(ROOT, "rs-src"), "/work/rs", "rs-header"), renamed);
		const roots = [dir];
		expect(await findSessionFile("rs-named", undefined, roots)).toBe(named);
		expect(await findSessionFile("rs-header", undefined, roots)).toBe(renamed);
		expect(await findSessionFile("missing", undefined, roots)).toBeNull();
		const { markdown } = await renderSessionTree(named, "u2");
		expect(markdown).toContain("## user [TARGET BRANCH]\ngo left");
		expect(markdown).toContain("## user\ngo right with the rocket");
	});
});
