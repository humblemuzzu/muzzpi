import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SUB_AGENT_TOOLS_ENV } from "../tools/lib/sub-agent-prompt";
import ideasExtension from "./index";
import { loadAll } from "./store";

const base = realpathSync(mkdtempSync(join(tmpdir(), "ideas-ext-")));
const savedEnv = { agentDir: process.env.PI_CODING_AGENT_DIR, subAgent: process.env[SUB_AGENT_TOOLS_ENV] };
afterAll(() => {
	rmSync(base, { recursive: true, force: true });
	if (savedEnv.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = savedEnv.agentDir;
	if (savedEnv.subAgent === undefined) delete process.env[SUB_AGENT_TOOLS_ENV];
	else process.env[SUB_AGENT_TOOLS_ENV] = savedEnv.subAgent;
});

function repo(name: string): string {
	const root = join(base, name);
	mkdirSync(root, { recursive: true });
	execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
	return root;
}
const photos = repo("photos");

type Handler = (event: unknown, ctx: unknown) => unknown;
interface Label {
	key: string;
	text?: string;
}

function makeHarness(options: { busy?: boolean; tui?: boolean; keys?: string[]; draft?: string } = {}) {
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const labels: Label[] = [];
	const notices: { text: string; level?: string }[] = [];
	let editor = options.draft ?? "";
	const pi = {
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, command),
		events: {
			emit: (channel: string, data: Label) => {
				if (channel === "editor:set-label") labels.push(data);
				if (channel === "editor:remove-label") labels.push({ key: data.key });
			},
		},
	};
	const ctx = {
		cwd: photos,
		mode: options.tui ? "tui" : "rpc",
		hasUI: true,
		isIdle: () => !options.busy,
		sessionManager: {
			getSessionId: () => "sess-1",
			getSessionFile: () => "/sessions/sess-1.jsonl",
			getSessionName: () => "crop work",
			getBranch: () => [{ type: "message", message: { role: "user", content: "fix the uploads" } }],
		},
		ui: {
			notify: (text: string, level?: string) => notices.push({ text, level }),
			getEditorText: () => editor,
			setEditorText: (text: string) => {
				editor = text;
			},
			custom: <T>(factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (value: T) => void) => { handleInput(data: string): void }) =>
				new Promise<T>((resolve) => {
					const theme = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s };
					const component = factory({ requestRender: () => undefined }, theme, undefined, resolve);
					for (const key of options.keys ?? []) component.handleInput(key);
				}),
		},
	};
	ideasExtension(pi as never);
	const run = (args: string) => commands.get("idea")!.handler(args, ctx);
	return { run, handlers, commands, labels, notices, editor: () => editor, ctx };
}

let agentDir: string;
beforeEach(() => {
	agentDir = mkdtempSync(join(base, "agent-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	delete process.env[SUB_AGENT_TOOLS_ENV];
});

describe("/idea <text>", () => {
	test("saves for this project with the session it came from, and shows the count", async () => {
		const h = makeHarness({ busy: true });
		await h.run("bug: crop is off");
		const [idea] = loadAll(join(agentDir, "ideas"));
		expect(idea).toMatchObject({
			scope: "project",
			kind: "bug",
			text: "crop is off",
			at: { root: photos, project: "photos", isHarness: false },
			session: { id: "sess-1", file: "/sessions/sess-1.jsonl", name: "crop work" },
			lastPrompt: "fix the uploads",
			agentBusy: true,
			source: "pi",
		});
		expect(h.notices.at(-1)).toEqual({ text: "Saved to photos · 1 open", level: "info" });
		expect(h.labels.at(-1)).toMatchObject({ key: "ideas", text: "1 idea" });
	});

	test("pi: parks it under the harness and points you back to the project", async () => {
		const h = makeHarness();
		await h.run("pi: the dock flickers");
		expect(loadAll(join(agentDir, "ideas"))[0]).toMatchObject({ scope: "harness", text: "the dock flickers" });
		expect(h.notices.at(-1)?.text).toBe("Saved to harness · 1 open · back to photos");
		expect(h.labels.at(-1)).toEqual({ key: "ideas" });
	});

	test("tags with no idea after them save nothing", async () => {
		const h = makeHarness();
		await h.run("pi: bug:");
		expect(loadAll(join(agentDir, "ideas"))).toEqual([]);
		expect(h.notices.at(-1)?.level).toBe("warning");
	});

	test("a disk error is reported, not thrown into pi", async () => {
		writeFileSync(join(agentDir, "ideas"), "a file where the folder should be");
		const h = makeHarness();
		await h.run("anything");
		expect(h.notices.at(-1)?.level).toBe("error");
		expect(h.notices.at(-1)?.text).toStartWith("/idea failed:");
	});
});

describe("/idea", () => {
	test("enter puts the idea in the prompt, after any draft", async () => {
		await makeHarness().run("try webp thumbnails");
		const h = makeHarness({ tui: true, keys: ["\r"], draft: "half-typed thought" });
		await h.run("");
		expect(h.editor()).toBe("half-typed thought\n\ntry webp thumbnails");
	});

	test("d marks it done for good and the count goes away", async () => {
		await makeHarness().run("try webp thumbnails");
		const h = makeHarness({ tui: true, keys: ["d", "\x1b"] });
		await h.run("");
		expect(loadAll(join(agentDir, "ideas"))[0]?.status).toBe("done");
		expect(h.labels.at(-1)).toEqual({ key: "ideas" });
		expect(h.editor()).toBe("");
	});

	test("without the full TUI it lists the open ideas as text", async () => {
		await makeHarness().run("try webp thumbnails");
		const h = makeHarness();
		await h.run("");
		expect(h.notices.at(-1)?.text).toMatch(/^[0-9a-z]{4} {2}try webp thumbnails$/);
	});
});

describe("lifecycle", () => {
	test("session start paints this project's count", async () => {
		await makeHarness().run("one");
		await makeHarness().run("two");
		const h = makeHarness();
		h.handlers.get("session_start")!({}, h.ctx);
		for (let i = 0; i < 50 && !h.labels.length; i++) await Bun.sleep(10);
		expect(h.labels.at(-1)).toMatchObject({ key: "ideas", text: "2 ideas" });
	});

	test("sub-agents get no /idea", () => {
		process.env[SUB_AGENT_TOOLS_ENV] = "read,grep";
		const h = makeHarness();
		expect(h.commands.size).toBe(0);
		expect(h.handlers.size).toBe(0);
	});
});

test("the saved record is one JSON line per change", async () => {
	await makeHarness().run("a");
	const lines = readFileSync(join(agentDir, "ideas", "photos.jsonl"), "utf8").trim().split("\n");
	expect(lines).toHaveLength(1);
	expect(() => JSON.parse(lines[0]!)).not.toThrow();
});
