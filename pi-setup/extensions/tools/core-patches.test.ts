/**
 * The fast /resume patches must change nothing but speed: the list pi builds
 * matches stock's rules line for line, and the search scores match pi-tui's
 * fuzzyMatch. The list runs through the installed pi, so this checks what pi runs.
 */
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { fuzzyMatch } from "@mariozechner/pi-tui";
// @ts-expect-error a dist file of pi's, stored as the patch: no type declarations
import { matchSession, parseSearchQuery } from "../../pi-core-patches/session-selector-search.js";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "core-patches-"));
afterAll(() => fs.rmSync(DIR, { recursive: true, force: true }));

/** stock 1.4.0's buildSessionInfo, over lines split on "\n" */
function stockInfo(file: string) {
	try {
		const stats = fs.statSync(file);
		let header: any = null, messageCount = 0, firstMessage = "", name: string | undefined, last: number | undefined;
		const all: string[] = [];
		for (const line of fs.readFileSync(file, "utf8").split("\n")) {
			if (!line.trim()) continue;
			let entry: any;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			if (!entry) continue;
			if (!header) {
				if (entry.type !== "session") return null;
				header = entry;
				continue;
			}
			if (entry.type === "session_info") name = entry.name?.trim() || undefined;
			if (entry.type !== "message") continue;
			messageCount++;
			const message = entry.message;
			const withContent = typeof message.role === "string" && "content" in message;
			if (withContent && (message.role === "user" || message.role === "assistant")) {
				const t = typeof message.timestamp === "number" ? message.timestamp : new Date(entry.timestamp).getTime();
				if (!Number.isNaN(t)) last = Math.max(last ?? 0, t);
			}
			if (!withContent || (message.role !== "user" && message.role !== "assistant")) continue;
			const text = typeof message.content === "string" ? message.content : message.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join(" ");
			if (!text) continue;
			all.push(text);
			if (!firstMessage && message.role === "user") firstMessage = text;
		}
		if (!header) return null;
		const headerTime = typeof header.timestamp === "string" ? new Date(header.timestamp).getTime() : NaN;
		return {
			path: file, id: header.id, cwd: typeof header.cwd === "string" ? header.cwd : "", name, parentSessionPath: header.parentSession,
			created: new Date(header.timestamp).getTime(),
			modified: (typeof last === "number" && last > 0 ? new Date(last) : !Number.isNaN(headerTime) ? new Date(headerTime) : stats.mtime).getTime(),
			messageCount, firstMessage: firstMessage || "(no messages)", allMessagesText: all.join(" "),
		};
	} catch {
		return null;
	}
}

const at = (n: number) => `2026-10-01T10:${String(n).padStart(2, "0")}:00.000Z`;
const msg = (id: string, parent: string | null, n: number, message: object) => JSON.stringify({ type: "message", id, parentId: parent, timestamp: at(n), message });
const toolResult = (id: string, parent: string, n: number, extra: object = {}) =>
	msg(id, parent, n, { role: "toolResult", toolCallId: "c", toolName: "bash", content: [{ type: "text", text: "x".repeat(9000) }], isError: false, timestamp: 9_999_999_999_999, ...extra });

function write(name: string, lines: string[], trailingNewline = true): string {
	const file = path.join(DIR, `${name}.jsonl`);
	fs.writeFileSync(file, lines.join("\n") + (trailingNewline ? "\n" : ""));
	return file;
}

describe("fast /resume", () => {
	const header = (id: string) => JSON.stringify({ type: "session", version: 3, id, timestamp: at(0), cwd: "/work" });
	const user = (id: string, parent: string | null, n: number, text: string) => msg(id, parent, n, { role: "user", content: [{ type: "text", text }], timestamp: Date.parse(at(n)) });
	write("plain", [header("plain"), user("u1", null, 1, "hello"), toolResult("t1", "u1", 2), JSON.stringify({ type: "session_info", id: "n", parentId: "t1", timestamp: at(3), name: " named " })]);
	write("torn-tail", [header("torn"), user("u1", null, 1, "a"), `${toolResult("t1", "u1", 2).slice(0, 300)}{"a":{}}`], false);
	write("glued", [header("glued"), user("u1", null, 1, "a"), `${toolResult("t1", "u1", 2).slice(0, 300)}${toolResult("t2", "u1", 3)}`, user("u2", "t2", 4, "after")]);
	write("string-content", [header("sc"), msg("u1", null, 1, { role: "user", content: "plain string" }), toolResult("t1", "u1", 2, { content: "string out" })]);
	write("no-message-field", [header("broken"), user("u1", null, 1, "a"), JSON.stringify({ type: "message", id: "x", parentId: "u1", timestamp: at(2) })]);
	write("not-a-session", [user("u1", null, 1, "a")]);
	write("unicode", [header("uni"), user("u1", null, 1, "line\u2028sep नमस्ते"), toolResult("t1", "u1", 2)]);

	test("every session reads exactly as stock reads it", async () => {
		const infos = await SessionManager.listAll(DIR);
		const got = new Map(infos.map((s: any) => [s.path, { ...s, created: s.created.getTime(), modified: s.modified.getTime() }]));
		for (const file of fs.readdirSync(DIR).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(DIR, f))) {
			expect([path.basename(file), got.get(file) ?? null]).toEqual([path.basename(file), stockInfo(file)]);
		}
	});

	test("a query scores as pi-tui's fuzzyMatch scores it", () => {
		let seed = 7;
		const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
		const alphabet = "abcdeiklmnopstuvz0123456789-_./:ÄéİK";
		for (let i = 0; i < 3000; i++) {
			const text = Array.from({ length: 20 + Math.floor(rand() * 200) }, () => alphabet[Math.floor(rand() * alphabet.length)] + (rand() < 0.15 ? " " : "")).join("");
			const query = Array.from({ length: 1 + Math.floor(rand() * 6) }, () => alphabet[Math.floor(rand() * alphabet.length)]).join("");
			const want = fuzzyMatch(query, `  ${text} `);
			const got = matchSession({ id: "", name: "", allMessagesText: text, cwd: "" }, parseSearchQuery(query));
			expect([query, got.matches, got.matches ? got.score : 0]).toEqual([query, want.matches, want.matches ? want.score : 0]);
		}
	});
});
