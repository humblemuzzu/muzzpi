import { execFile } from "node:child_process";
import {
	appendFileSync,
	closeSync,
	existsSync,
	fstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export type Scope = "project" | "harness";
export type Kind = "idea" | "bug" | "dislike";
export type Status = "open" | "done" | "dropped";

export interface Where {
	cwd: string;
	root: string;
	project: string;
	isHarness: boolean;
	branch?: string;
	commit?: string;
	dirty?: boolean;
}

export interface SessionRef {
	id: string;
	file?: string;
	name?: string;
}

export interface Capture {
	session?: SessionRef;
	lastPrompt?: string;
	agentBusy?: boolean;
	source: "pi" | "herdr";
}

interface AddRecord extends Capture {
	v: 1;
	op: "add";
	id: string;
	ts: string;
	scope: Scope;
	kind: Kind;
	text: string;
	at: Where;
}

interface StatusRecord {
	v: 1;
	op: "status";
	id: string;
	ts: string;
	status: Status;
}

interface ScopeRecord {
	v: 1;
	op: "scope";
	id: string;
	ts: string;
	scope: Scope;
}

type IdeaRecord = AddRecord | StatusRecord | ScopeRecord;

export interface Idea extends Omit<AddRecord, "op" | "v"> {
	file: string;
	status: Status;
	changed?: string;
}

export interface ParsedInput {
	text: string;
	kind: Kind;
	toHarness: boolean;
}

export const HARNESS_VIEW = "harness.md";
const HARNESS_MARKER = join("pi-setup", "extensions", "ideas", "index.ts");
const LAST_PROMPT_CHARS = 200;
const GIT_TIMEOUT_MS = 3000;

const TAGS: Record<string, { kind?: Kind; harness?: true }> = {
	pi: { harness: true },
	harness: { harness: true },
	idea: { kind: "idea" },
	bug: { kind: "bug" },
	fix: { kind: "bug" },
	dislike: { kind: "dislike" },
	hate: { kind: "dislike" },
	meh: { kind: "dislike" },
};

export function agentDir(): string {
	const fromEnv = process.env.PI_CODING_AGENT_DIR;
	if (!fromEnv) return join(homedir(), ".pi", "agent");
	if (fromEnv === "~") return homedir();
	return fromEnv.startsWith("~/") ? join(homedir(), fromEnv.slice(2)) : fromEnv;
}

export function ideasDir(base = agentDir()): string {
	return join(base, "ideas");
}

export function parseInput(raw: string): ParsedInput {
	let rest = raw.trim();
	let kind: Kind = "idea";
	let toHarness = false;
	for (;;) {
		const match = /^([a-z]+):\s*/i.exec(rest);
		const tag = match && TAGS[match[1]!.toLowerCase()];
		if (!match || !tag) break;
		if (tag.kind) kind = tag.kind;
		if (tag.harness) toHarness = true;
		rest = rest.slice(match[0].length);
	}
	return { text: rest.trim(), kind, toHarness };
}

function git(cwd: string, args: string[]): Promise<string | undefined> {
	return new Promise((resolve) => {
		execFile("git", args, { cwd, timeout: GIT_TIMEOUT_MS }, (error, stdout) => {
			resolve(error ? undefined : stdout.trim());
		});
	});
}

export async function resolveWhere(cwd: string, withCode = true): Promise<Where> {
	const top = await git(cwd, ["rev-parse", "--show-toplevel"]);
	const root = top || cwd;
	const where: Where = { cwd, root, project: basename(root) || root, isHarness: existsSync(join(root, HARNESS_MARKER)) };
	if (!top || !withCode) return where;
	const [branch, commit, status] = await Promise.all([
		git(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
		git(root, ["rev-parse", "--short", "HEAD"]),
		git(root, ["status", "--porcelain", "--untracked-files=no"]),
	]);
	if (branch) where.branch = branch;
	if (commit) where.commit = commit;
	if (status !== undefined) where.dirty = status.length > 0;
	return where;
}

export function projectFile(where: Pick<Where, "project">): string {
	const slug = where.project.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
	return `${slug === "harness" ? "harness-project" : slug}.jsonl`;
}

export function localIso(date = new Date()): string {
	const pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, "0");
	const offset = -date.getTimezoneOffset();
	return (
		`${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
		`T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
		`${offset >= 0 ? "+" : "-"}${pad(offset / 60)}:${pad(offset % 60)}`
	);
}

function readRecords(path: string): IdeaRecord[] {
	if (!existsSync(path)) return [];
	const records: IdeaRecord[] = [];
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const record = JSON.parse(line) as IdeaRecord;
			if (record && typeof record.id === "string" && typeof record.op === "string") records.push(record);
		} catch {
			// a line cut short by a crash mid-append: the rest of the file still counts
		}
	}
	return records;
}

export function loadAll(dir: string): Idea[] {
	if (!existsSync(dir)) return [];
	const ideas = new Map<string, Idea>();
	for (const file of readdirSync(dir).sort()) {
		if (!file.endsWith(".jsonl")) continue;
		for (const record of readRecords(join(dir, file))) {
			if (record.op === "add") {
				const { v: _v, op: _op, ...rest } = record;
				ideas.set(record.id, { ...rest, file, status: "open" });
				continue;
			}
			const idea = ideas.get(record.id);
			if (!idea) continue;
			if (record.op === "status") idea.status = record.status;
			else if (record.op === "scope") idea.scope = record.scope;
			idea.changed = record.ts;
		}
	}
	return [...ideas.values()];
}

export function ideasHere(all: Idea[], where: Pick<Where, "root" | "isHarness">): Idea[] {
	return where.isHarness
		? all.filter((idea) => idea.scope === "harness")
		: all.filter((idea) => idea.scope === "project" && idea.at.root === where.root);
}

export function openCount(all: Idea[], where: Pick<Where, "root" | "isHarness">): number {
	return ideasHere(all, where).filter((idea) => idea.status === "open").length;
}

function newId(taken: Set<string>): string {
	for (;;) {
		const id = Math.floor(Math.random() * 36 ** 4)
			.toString(36)
			.padStart(4, "0");
		if (!taken.has(id)) return id;
	}
}

function endsWithNewline(path: string): boolean {
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		const size = fstatSync(fd).size;
		if (size === 0) return true;
		const last = Buffer.alloc(1);
		readSync(fd, last, 0, 1, size - 1);
		return last[0] === 0x0a;
	} catch {
		return true;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function append(dir: string, file: string, record: IdeaRecord): void {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, file);
	const line = `${JSON.stringify(record)}\n`;
	appendFileSync(path, endsWithNewline(path) ? line : `\n${line}`);
}

export function addIdea(dir: string, where: Where, input: ParsedInput, capture: Capture, now = new Date()): Idea {
	if (!input.text) throw new Error("nothing to save: the idea is empty");
	const all = loadAll(dir);
	const record: AddRecord = {
		v: 1,
		op: "add",
		id: newId(new Set(all.map((idea) => idea.id))),
		ts: localIso(now),
		scope: where.isHarness || input.toHarness ? "harness" : "project",
		kind: input.kind,
		text: input.text,
		at: where,
		...capture,
	};
	const file = projectFile(where);
	append(dir, file, record);
	const { v: _v, op: _op, ...rest } = record;
	const idea: Idea = { ...rest, file, status: "open" };
	writeViews(dir, [...all, idea]);
	return idea;
}

export function setStatus(dir: string, idea: Idea, status: Status, now = new Date()): void {
	append(dir, idea.file, { v: 1, op: "status", id: idea.id, ts: localIso(now), status });
	writeViews(dir, loadAll(dir));
}

export function setScope(dir: string, idea: Idea, scope: Scope, now = new Date()): void {
	append(dir, idea.file, { v: 1, op: "scope", id: idea.id, ts: localIso(now), scope });
	writeViews(dir, loadAll(dir));
}

export function flatten(text: string): string {
	return text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim();
}

export function age(ts: string, now = new Date()): string {
	const seconds = Math.max(0, (now.getTime() - new Date(ts).getTime()) / 1000);
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
	if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
	if (seconds < 1209600) return `${Math.floor(seconds / 86400)}d`;
	return `${Math.floor(seconds / 604800)}w`;
}

function markdownLine(idea: Idea, withOrigin: boolean): string {
	const box = idea.status === "done" ? "[x]" : "[ ]";
	const kind = idea.kind === "idea" ? "" : `**${idea.kind}** `;
	const code = idea.at.commit ? ` · ${idea.at.branch ?? "?"}@${idea.at.commit}${idea.at.dirty ? "*" : ""}` : "";
	const origin = withOrigin ? ` · from ${idea.at.project}` : "";
	const lines = [`- ${box} ${kind}${flatten(idea.text)} · ${idea.ts.slice(0, 16).replace("T", " ")}${origin}${code} · \`${idea.id}\``];
	if (idea.lastPrompt) lines.push(`  - while: ${flatten(idea.lastPrompt)}`);
	return lines.join("\n");
}

export function renderMarkdown(title: string, ideas: Idea[], withOrigin: boolean): string {
	const open = ideas.filter((idea) => idea.status === "open");
	const done = ideas.filter((idea) => idea.status === "done");
	const parts = [`# ${title}`, "", "Generated by /idea from the .jsonl files next to it; edits here are overwritten.", ""];
	parts.push(`## Open (${open.length})`, "", ...(open.length ? open.map((idea) => markdownLine(idea, withOrigin)) : ["Nothing open."]), "");
	if (done.length) parts.push(`## Done (${done.length})`, "", ...done.map((idea) => markdownLine(idea, withOrigin)), "");
	return parts.join("\n");
}

function writeAtomic(path: string, text: string): void {
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, text);
	renameSync(tmp, path);
}

export function writeViews(dir: string, all: Idea[]): void {
	mkdirSync(dir, { recursive: true });
	const harness = all.filter((idea) => idea.scope === "harness");
	if (harness.length || existsSync(join(dir, HARNESS_VIEW))) {
		writeAtomic(join(dir, HARNESS_VIEW), renderMarkdown("Harness ideas", harness, true));
	}
	const byFile = new Map<string, Idea[]>();
	for (const idea of all) {
		const list = byFile.get(idea.file) ?? [];
		list.push(idea);
		byFile.set(idea.file, list);
	}
	for (const [file, ideas] of byFile) {
		const view = join(dir, file.replace(/\.jsonl$/, ".md"));
		const project = ideas.filter((idea) => idea.scope === "project");
		if (!project.length && !existsSync(view)) continue;
		const roots = new Set(project.map((idea) => idea.at.root));
		const title = `${ideas[0]!.at.project} ideas`;
		writeAtomic(view, renderMarkdown(roots.size > 1 ? `${title} (${[...roots].join(", ")})` : title, project, false));
	}
}

type ContentBlock = { type?: string; text?: string };
type EntryLike = { type?: string; name?: string; message?: { role?: string; content?: unknown } };

export function lastUserPrompt(entries: readonly EntryLike[]): string | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const message = entries[i]?.type === "message" ? entries[i]!.message : undefined;
		if (message?.role !== "user") continue;
		const content = message.content;
		const text =
			typeof content === "string"
				? content
				: Array.isArray(content)
					? (content as ContentBlock[])
							.filter((block) => block?.type === "text" && typeof block.text === "string")
							.map((block) => block.text)
							.join(" ")
					: "";
		const flat = flatten(text);
		if (flat) return flat.length > LAST_PROMPT_CHARS ? `${flat.slice(0, LAST_PROMPT_CHARS - 1)}…` : flat;
	}
	return undefined;
}

export function sessionNameFrom(entries: readonly EntryLike[]): string | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i]?.type === "session_info" && typeof entries[i]!.name === "string") return entries[i]!.name;
	}
	return undefined;
}
