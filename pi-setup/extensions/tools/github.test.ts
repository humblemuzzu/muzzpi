/**
 * tests for github tools — helpers + integration via pi spawn.
 *
 * two layers:
 *
 * 1. unit tests for lib/github.ts (parseRepoUrl, ghApi, etc.)
 *    — no pi deps, no AI, runs directly with bun.
 *
 * 2. integration tests for the 7 github tools via pi spawn.
 *    — spawns `pi --mode json` asking it to call specific tools.
 *    — guarded by PI_E2E=1 (costs real API calls + AI tokens).
 *    — validates the full flow: model → tool call → GitHub API → result.
 *
 * the unit tests prove the plumbing works. the integration tests
 * prove the tools register, execute, and return correct results
 * inside pi's runtime where @mariozechner/pi-tui is available.
 *
 * usage:
 *   bun test user/pi/extensions/tools/github.test.ts          # unit only
 *   PI_E2E=1 bun test user/pi/extensions/tools/github.test.ts # all
 */

import { spawn as nodeSpawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "bun:test";
import {
	parseRepoUrl,
	repoSlug,
	githubApi,
	GithubApiError,
	rateLimitWaitMs,
	decodeBase64Content,
	addLineNumbers,
	truncate,
} from "./lib/github";
import { fetchWindow, matchGlob, searchPathQualifier } from "./github";

describe("fetchWindow", () => {
	const source = Array.from({ length: 250 }, (_, i) => i);
	const pages: number[] = [];
	const fetchPage = async (page: number, perPage: number) => {
		pages.push(page);
		return source.slice((page - 1) * perPage, page * perPage);
	};

	it("offset skips exactly that many items, across a page boundary", async () => {
		pages.length = 0;
		expect(await fetchWindow(95, 10, fetchPage)).toEqual([95, 96, 97, 98, 99, 100, 101, 102, 103, 104]);
		expect(pages).toEqual([1, 2]);
	});

	it("an offset smaller than the limit is not rounded away", async () => {
		expect(await fetchWindow(5, 3, fetchPage)).toEqual([5, 6, 7]);
	});

	it("stops at the end of the results", async () => {
		pages.length = 0;
		expect(await fetchWindow(240, 50, fetchPage)).toEqual(source.slice(240));
		expect(pages).toEqual([3]);
	});
});

describe("searchPathQualifier", () => {
	it("turns a file path into path:<dir> filename:<name>, which GitHub can match", () => {
		expect(searchPathQualifier("pi-setup/verify-patches.sh")).toBe("path:pi-setup filename:verify-patches.sh");
		expect(searchPathQualifier("/src/a/b.ts/")).toBe("path:src/a filename:b.ts");
	});

	it("a bare file name is a filename qualifier", () => {
		expect(searchPathQualifier("install.sh")).toBe("filename:install.sh");
	});

	it("a directory stays a path prefix", () => {
		expect(searchPathQualifier("pi-setup/extensions")).toBe("path:pi-setup/extensions");
	});

	it("a dot-leading directory like .github is a directory, not a file name", () => {
		expect(searchPathQualifier(".github")).toBe("path:.github");
		expect(searchPathQualifier(".github/workflows")).toBe("path:.github/workflows");
	});

	it("an empty or root path adds no qualifier, and spaces are quoted", () => {
		expect(searchPathQualifier("/")).toBe("");
		expect(searchPathQualifier("Code stuff/a.ts")).toBe('path:"Code stuff" filename:a.ts');
	});
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const CWD = process.env.PI_E2E_CWD ?? resolve(__dirname, "../../../..");
const ENABLED = process.env.PI_E2E === "1";

// --- matchGlob ---
// regression coverage for the glob_github matcher. it previously built its regex
// with chained .replace() calls that corrupted each other: "**/" became "(.+/)?"
// and the later "?" -> "[^/]" rule mangled that into "(.+/)[^/]", so "**/*.nix"
// demanded a directory plus an extra char and silently skipped every root-level
// file (93 of 95 matches on bdsqqq/dots). the function had no tests at all.
describe("matchGlob", () => {
	it("'**/' matches zero directories (root-level files)", () => {
		expect(matchGlob("flake.nix", "**/*.nix")).toBe(true);
		expect(matchGlob("zmx.nix", "**/*.nix")).toBe(true);
	});

	it("'**/' matches nested directories at any depth", () => {
		expect(matchGlob("system/nix.nix", "**/*.nix")).toBe(true);
		expect(matchGlob("user/pi/default.nix", "**/*.nix")).toBe(true);
		expect(matchGlob("a/b/c/d.nix", "**/*.nix")).toBe(true);
	});

	it("respects the file extension", () => {
		expect(matchGlob("flake.txt", "**/*.nix")).toBe(false);
	});

	it("'*' does not cross a path separator", () => {
		expect(matchGlob("flake.nix", "*.nix")).toBe(true);
		expect(matchGlob("system/nix.nix", "*.nix")).toBe(false);
	});

	it("honours a directory prefix", () => {
		expect(matchGlob("src/a.ts", "src/**/*.ts")).toBe(true);
		expect(matchGlob("src/a/b.ts", "src/**/*.ts")).toBe(true);
		expect(matchGlob("other/a.ts", "src/**/*.ts")).toBe(false);
	});

	it("'?' matches exactly one non-separator char", () => {
		expect(matchGlob("ab.ts", "?b.ts")).toBe(true);
		expect(matchGlob("a/b.ts", "?b.ts")).toBe(false);
	});

	it("escapes regex metacharacters in literals", () => {
		expect(matchGlob("a+b.ts", "a+b.ts")).toBe(true);
		expect(matchGlob("axb.ts", "a+b.ts")).toBe(false);
	});

	it("trailing '**' matches everything below a prefix", () => {
		expect(matchGlob("src/index.ts", "src/**")).toBe(true);
		expect(matchGlob("src/a/b/c.ts", "src/**")).toBe(true);
	});
});

// --- shared pi runner (same as e2e.test.ts) ---

interface PiEvent { type: string; [key: string]: any; }
interface PiResult { events: PiEvent[]; exitCode: number; stderr: string; }

function runPi(prompt: string, opts?: { timeout?: number }): Promise<PiResult> {
	const timeout = opts?.timeout ?? 120_000;
	return new Promise((resolve, reject) => {
		const events: PiEvent[] = [];
		let stderr = "";
		let buffer = "";
		const proc = nodeSpawn("pi", ["--mode", "json", "-p", "--no-session", prompt], {
			cwd: CWD, shell: false, stdio: ["ignore", "pipe", "pipe"],
		});
		const timer = setTimeout(() => {
			proc.kill("SIGTERM");
			setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 5000);
			reject(new Error(`pi timed out after ${timeout}ms`));
		}, timeout);
		proc.stdout!.on("data", (data: Buffer) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) {
				if (!line.trim()) continue;
				try { events.push(JSON.parse(line)); } catch {}
			}
		});
		proc.stderr!.on("data", (data: Buffer) => { stderr += data.toString(); });
		proc.on("close", (code) => {
			clearTimeout(timer);
			if (buffer.trim()) { try { events.push(JSON.parse(buffer)); } catch {} }
			resolve({ events, exitCode: code ?? 1, stderr });
		});
		proc.on("error", (err) => { clearTimeout(timer); reject(err); });
	});
}

function getToolCalls(events: PiEvent[]) {
	const calls: { name: string; args: any }[] = [];
	for (const e of events) {
		if (e.type === "message_end" && e.message?.role === "assistant") {
			for (const part of e.message.content ?? []) {
				if (part.type === "toolCall") calls.push({ name: part.name, args: part.arguments ?? {} });
			}
		}
	}
	return calls;
}

function getToolResults(events: PiEvent[]) {
	const results: { toolName: string; content: string; isError: boolean }[] = [];
	for (const e of events) {
		if (e.type === "tool_execution_end") {
			const r = e.result ?? {};
			const text = (r.content ?? []).find((c: any) => c.type === "text")?.text ?? "";
			results.push({ toolName: e.toolName, content: text, isError: r.isError === true });
		}
	}
	return results;
}

// ============================================================
// layer 1: unit tests for lib/github.ts — no pi deps, no cost
// ============================================================

describe("lib/github.ts", () => {
	describe("parseRepoUrl", () => {
		it("parses full https URL", () => {
			expect(parseRepoUrl("https://github.com/owner/repo")).toEqual({ owner: "owner", repo: "repo" });
		});

		it("parses URL without protocol", () => {
			expect(parseRepoUrl("github.com/owner/repo")).toEqual({ owner: "owner", repo: "repo" });
		});

		it("parses shorthand owner/repo", () => {
			expect(parseRepoUrl("owner/repo")).toEqual({ owner: "owner", repo: "repo" });
		});

		it("strips trailing .git", () => {
			expect(parseRepoUrl("https://github.com/owner/repo.git")).toEqual({ owner: "owner", repo: "repo" });
		});

		it("strips trailing slash", () => {
			expect(parseRepoUrl("https://github.com/owner/repo/")).toEqual({ owner: "owner", repo: "repo" });
		});

		it("throws on invalid input", () => {
			expect(() => parseRepoUrl("just-a-name")).toThrow(/invalid repository/);
		});
	});

	describe("repoSlug", () => {
		it("returns owner/repo", () => {
			expect(repoSlug({ owner: "a", repo: "b" })).toBe("a/b");
		});
	});

	describe("decodeBase64Content", () => {
		it("decodes base64 with embedded newlines", () => {
			const encoded = Buffer.from("hello world").toString("base64");
			const withNewlines = encoded.slice(0, 4) + "\n" + encoded.slice(4);
			expect(decodeBase64Content(withNewlines)).toBe("hello world");
		});
	});

	describe("addLineNumbers", () => {
		it("numbers from 1 by default", () => {
			expect(addLineNumbers("a\nb\nc")).toBe("1: a\n2: b\n3: c");
		});

		it("numbers from custom start", () => {
			expect(addLineNumbers("x\ny", 10)).toBe("10: x\n11: y");
		});
	});

	describe("truncate", () => {
		it("returns short strings unchanged", () => {
			expect(truncate("hello", 100)).toBe("hello");
		});

		it("truncates with indicator", () => {
			const result = truncate("a".repeat(200), 50);
			expect(result.length).toBeLessThan(200);
			expect(result).toContain("truncated");
			expect(result).toContain("200 total characters");
		});
	});
});

describe("rateLimitWaitMs", () => {
	const headers = (h: Record<string, string>) => new Headers(h);

	it("reads retry-after seconds on a secondary limit", () => {
		expect(rateLimitWaitMs(403, headers({ "retry-after": "7" }), "")).toBe(7000);
		expect(rateLimitWaitMs(429, headers({ "retry-after": "0" }), "")).toBe(0);
	});

	it("waits until x-ratelimit-reset when the primary limit is spent", () => {
		const now = 1_000_000_000_000;
		const h = headers({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(now / 1000 + 42) });
		expect(rateLimitWaitMs(403, h, "API rate limit exceeded", now)).toBe(42_000);
	});

	it("a secondary limit named only in the message waits a minute", () => {
		expect(rateLimitWaitMs(403, headers({}), "You have exceeded a secondary rate limit.")).toBe(60_000);
		expect(rateLimitWaitMs(429, headers({}), "")).toBe(60_000);
	});

	it("a 403 that is not about rate limits is a permission error", () => {
		expect(rateLimitWaitMs(403, headers({ "x-ratelimit-remaining": "12" }), "Resource not accessible")).toBeUndefined();
		expect(rateLimitWaitMs(404, headers({ "retry-after": "5" }), "Not Found")).toBeUndefined();
	});
});

describe("githubApi transport (stubbed fetch)", () => {
	async function withFetch<T>(responses: Response[], run: (urls: string[]) => Promise<T>): Promise<T> {
		const real = globalThis.fetch;
		const urls: string[] = [];
		globalThis.fetch = (async (input: any) => {
			urls.push(String(input));
			const next = responses.shift();
			if (!next) throw new Error("unexpected request");
			return next;
		}) as typeof fetch;
		try {
			return await run(urls);
		} finally {
			globalThis.fetch = real;
		}
	}
	const json = (body: unknown, init?: ResponseInit) =>
		new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, ...init });

	it("retries once after a short rate limit, then returns the data", async () => {
		const data = await withFetch(
			[json({ message: "secondary rate limit" }, { status: 403, headers: { "retry-after": "0" } }), json({ ok: 1 })],
			async (urls) => {
				const out = await githubApi("search/code", { params: { q: "a b", per_page: 3 } });
				expect(urls).toHaveLength(2);
				expect(urls[0]).toBe("https://api.github.com/search/code?q=a+b&per_page=3");
				return out;
			},
		);
		expect(data).toEqual({ ok: 1 });
	});

	it("a rate limit that resets too late fails at once with the reset time", async () => {
		const reset = String(Math.floor(Date.now() / 1000) + 3600);
		await withFetch(
			[json({ message: "API rate limit exceeded" }, { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset } })],
			async () => {
				await expect(githubApi("repos/a/b")).rejects.toThrow(/HTTP 403 rate limited until .*API rate limit exceeded/);
			},
		);
	});

	it("a body cut off by an abort reports the abort, not invalid JSON", async () => {
		const ctrl = new AbortController();
		const body = new ReadableStream({
			start(c) {
				c.enqueue(new TextEncoder().encode('{"partial":'));
				setTimeout(() => {
					ctrl.abort();
					c.error(new DOMException("aborted", "AbortError"));
				}, 20);
			},
		});
		await withFetch([new Response(body)], async () => {
			await expect(githubApi("repos/a/b", { signal: ctrl.signal })).rejects.toThrow("GitHub API repos/a/b: aborted");
		});
	});

	it.skipIf(Boolean(process.env.GH_TOKEN || process.env.GITHUB_TOKEN))("a 401 from a gh token is retried once with a fresh one", async () => {
		const data = await withFetch(
			[json({ message: "Bad credentials" }, { status: 401 }), json({ ok: 2 })],
			async (urls) => {
				const out = await githubApi("repos/a/b");
				expect(urls).toHaveLength(2);
				return out;
			},
		);
		expect(data).toEqual({ ok: 2 });
	});

	it("an HTTP error carries its status and GitHub's message", async () => {
		await withFetch(
			[json({ message: "Validation Failed", errors: [{ message: "bad ref" }] }, { status: 422 })],
			async () => {
				const err: any = await githubApi("repos/a/b/compare/x...y").catch((e) => e);
				expect(err).toBeInstanceOf(GithubApiError);
				expect(err.status).toBe(422);
				expect(err.message).toBe("GitHub API repos/a/b/compare/x...y failed: HTTP 422 Validation Failed — bad ref");
			},
		);
	});

	it("an aborted call stops instead of waiting out a rate limit", async () => {
		const ctrl = new AbortController();
		await withFetch(
			[json({}, { status: 429, headers: { "retry-after": "30" } })],
			async () => {
				const pending = githubApi("repos/a/b", { signal: ctrl.signal });
				setTimeout(() => ctrl.abort(), 20);
				const started = Date.now();
				await expect(pending).rejects.toThrow("GitHub API repos/a/b: aborted");
				expect(Date.now() - started).toBeLessThan(2000);
			},
		);
	});
});

// ============================================================
// layer 1b: GitHub API integration (no pi deps, but hits real API)
// ============================================================

describe("githubApi", () => {
	it("fetches repo info", async () => {
		const data = await githubApi("repos/bdsqqq/dots");
		expect(data.full_name).toBe("bdsqqq/dots");
		expect(data.default_branch).toBeTruthy();
	});

	it("passes query params correctly", async () => {
		const data = await githubApi("repos/bdsqqq/dots/commits", { params: { per_page: 1 } });
		expect(Array.isArray(data)).toBe(true);
		expect(data.length).toBe(1);
	});

	it("reads file contents via contents API", async () => {
		const data = await githubApi("repos/bdsqqq/dots/contents/flake.nix");
		expect(data.type).toBe("file");
		expect(data.content).toBeTruthy();
		const decoded = decodeBase64Content(data.content);
		expect(decoded).toContain("description");
	});

	it("lists directory via contents API", async () => {
		const data = await githubApi("repos/bdsqqq/dots/contents/");
		expect(Array.isArray(data)).toBe(true);
		const names = data.map((e: any) => e.name);
		expect(names).toContain("flake.nix");
	});

	it("searches code", async () => {
		const data = await githubApi("search/code", {
			params: { q: "nixpkgs repo:bdsqqq/dots", per_page: 3 },
			accept: "application/vnd.github.text-match+json",
		});
		expect(data.total_count).toBeGreaterThan(0);
		expect(data.items.length).toBeGreaterThan(0);
	});

	it("fetches the default branch's tree recursively through HEAD", async () => {
		const tree = await githubApi("repos/bdsqqq/dots/git/trees/HEAD?recursive=1");
		expect(tree.tree.length).toBeGreaterThan(10);
		const paths = tree.tree.map((t: any) => t.path);
		expect(paths).toContain("flake.nix");
	});

	it("compares refs", async () => {
		const data = await githubApi("repos/bdsqqq/dots/compare/HEAD~1...HEAD");
		expect(data.status).toBeTruthy();
		expect(data.files).toBeTruthy();
	});

	it("a nonexistent repo is an HTTP 404", async () => {
		const err: any = await githubApi("repos/bdsqqq/nonexistent-repo-12345").catch((e) => e);
		expect(err).toBeInstanceOf(GithubApiError);
		expect(err.status).toBe(404);
	});
});

// ============================================================
// layer 2: tool integration tests via pi spawn (PI_E2E=1 only)
// ============================================================

describe.skipIf(!ENABLED)("github tools via pi", () => {

	it("read_github: reads a file and returns line-numbered content", async () => {
		const { events, exitCode } = await runPi(
			'Use the read_github tool to read the file "flake.nix" from repository "https://github.com/bdsqqq/dots". Just call the tool, nothing else.',
		);
		expect(exitCode).toBe(0);

		const calls = getToolCalls(events);
		const readCalls = calls.filter(c => c.name === "read_github");
		expect(readCalls.length).toBeGreaterThanOrEqual(1);

		const results = getToolResults(events);
		const readResults = results.filter(r => r.toolName === "read_github");
		expect(readResults.length).toBeGreaterThanOrEqual(1);
		expect(readResults[0].isError).toBe(false);
		expect(readResults[0].content).toContain("1:");
		expect(readResults[0].content).toContain("description");
	}, 60_000);

	it("search_github: finds code matching a pattern", async () => {
		const { events, exitCode } = await runPi(
			'Use the search_github tool to search for "nixpkgs" in repository "https://github.com/bdsqqq/dots". Just call the tool, nothing else.',
		);
		expect(exitCode).toBe(0);

		const results = getToolResults(events);
		const searchResults = results.filter(r => r.toolName === "search_github");
		expect(searchResults.length).toBeGreaterThanOrEqual(1);
		expect(searchResults[0].isError).toBe(false);
		expect(searchResults[0].content).toContain("Found");
	}, 60_000);

	it("list_directory_github: lists root directory entries", async () => {
		const { events, exitCode } = await runPi(
			'Use the list_directory_github tool to list the root directory (path "") of repository "https://github.com/bdsqqq/dots". Just call the tool, nothing else.',
		);
		expect(exitCode).toBe(0);

		const results = getToolResults(events);
		const dirResults = results.filter(r => r.toolName === "list_directory_github");
		expect(dirResults.length).toBeGreaterThanOrEqual(1);
		expect(dirResults[0].isError).toBe(false);
		expect(dirResults[0].content).toContain("flake.nix");
	}, 60_000);

	it("commit_search: returns recent commits", async () => {
		const { events, exitCode } = await runPi(
			'Use the commit_search tool to get the 3 most recent commits from repository "https://github.com/bdsqqq/dots". Just call the tool, nothing else.',
		);
		expect(exitCode).toBe(0);

		const results = getToolResults(events);
		const commitResults = results.filter(r => r.toolName === "commit_search");
		expect(commitResults.length).toBeGreaterThanOrEqual(1);
		expect(commitResults[0].isError).toBe(false);
		expect(commitResults[0].content).toContain("Found");
	}, 60_000);

	it("glob_github: finds files by pattern", async () => {
		const { events, exitCode } = await runPi(
			'Use the glob_github tool to find all "*.nix" files in repository "https://github.com/bdsqqq/dots". Just call the tool, nothing else.',
		);
		expect(exitCode).toBe(0);

		const results = getToolResults(events);
		const globResults = results.filter(r => r.toolName === "glob_github");
		expect(globResults.length).toBeGreaterThanOrEqual(1);
		expect(globResults[0].isError).toBe(false);
		expect(globResults[0].content).toContain("flake.nix");
	}, 60_000);

	it("diff: compares two refs", async () => {
		const { events, exitCode } = await runPi(
			'Use the diff tool to compare "HEAD~1" to "HEAD" in repository "https://github.com/bdsqqq/dots". Just call the tool, nothing else.',
		);
		expect(exitCode).toBe(0);

		const results = getToolResults(events);
		const diffResults = results.filter(r => r.toolName === "diff");
		expect(diffResults.length).toBeGreaterThanOrEqual(1);
		expect(diffResults[0].isError).toBe(false);
		expect(diffResults[0].content).toContain("Comparing");
		expect(diffResults[0].content).toContain("Changed files");
	}, 60_000);
});

// ============================================================
// layer 2b: librarian sub-agent e2e (PI_E2E=1 only)
// ============================================================

describe.skipIf(!ENABLED)("librarian e2e", () => {

	it("registration: librarian and github tools visible to model", async () => {
		const { events, exitCode } = await runPi(
			"List every tool you have available. Just the names, one per line.",
		);
		expect(exitCode).toBe(0);

		// extract final assistant text
		let text = "";
		for (let i = events.length - 1; i >= 0; i--) {
			if (events[i].type === "agent_end") {
				for (const msg of (events[i].messages ?? []).reverse()) {
					if (msg.role === "assistant") {
						for (const part of msg.content ?? []) {
							if (part.type === "text") { text = part.text; break; }
						}
					}
					if (text) break;
				}
			}
			if (text) break;
		}

		expect(text).toContain("librarian");
		expect(text).toContain("read_github");
		expect(text).toContain("search_github");
		expect(text).toContain("diff");
	}, 60_000);

	it("librarian: sub-agent explores a repo and answers a question", async () => {
		const { events, exitCode } = await runPi(
			'Use the librarian tool with query "What inputs does the flake.nix define?" and context "Looking at the bdsqqq/dots repository on GitHub." Just call librarian, nothing else.',
		);
		expect(exitCode).toBe(0);

		const calls = getToolCalls(events);
		const librarianCalls = calls.filter(c => c.name === "librarian");
		expect(librarianCalls.length).toBeGreaterThanOrEqual(1);

		const results = getToolResults(events);
		const librarianResults = results.filter(r => r.toolName === "librarian");
		expect(librarianResults.length).toBeGreaterThanOrEqual(1);

		const result = librarianResults[0];
		expect(result.isError).toBe(false);
		// the librarian should have read flake.nix and found inputs
		expect(result.content.toLowerCase()).toContain("nixpkgs");
		expect(result.content.length).toBeGreaterThan(100);
	}, 180_000);
});

// ---------------------------------------------------------------------------
// repository parameter handling (no network, always runs)
//
// observed in a real session: the model called search_github with
// `{"pattern": ""}` and no repository, and pi answered with a bare
// "must have required properties repository". it had reached for a GitHub tool
// while meaning to search the local checkout, and the message told it nothing
// useful. `repository` is now Optional in the schema so execute() can answer
// with the alias list AND the local-tool alternative.
// ---------------------------------------------------------------------------

describe("github tools: repository parameter", () => {
	const withRepo = [
		["read_github", "read"],
		["search_github", "grep"],
		["list_directory_github", "ls"],
		["glob_github", "find"],
		["commit_search", "bash (git log)"],
		["diff", "bash (git diff)"],
	] as const;

	it("does not mark repository as schema-required (so execute can explain)", async () => {
		const mod: any = await import("./github");
		const factories: Record<string, string> = {
			read_github: "createReadGithubTool",
			search_github: "createSearchGithubTool",
			list_directory_github: "createListDirectoryGithubTool",
			glob_github: "createGlobGithubTool",
			commit_search: "createCommitSearchTool",
			diff: "createDiffTool",
		};
		for (const [name] of withRepo) {
			const tool = mod[factories[name]]();
			expect(tool.parameters.required ?? []).not.toContain("repository");
			expect(Object.keys(tool.parameters.properties)).toContain("repository");
		}
	});

	it("explains the miss and names the local alternative", async () => {
		const mod: any = await import("./github");
		const tool = mod.createSearchGithubTool();
		// the exact shape observed in the failing session
		const result = await tool.execute("t", { pattern: "" }, undefined, undefined, { cwd: "/tmp" });
		expect(result.isError).toBe(true);
		const text = String(result.content[0].text);
		expect(text).toContain("repository");
		expect(text).toContain("repo, repo_url, url");
		expect(text).toContain("`grep`");
	});

	it("accepts the `repo` alias models actually reach for", async () => {
		const mod: any = await import("./github");
		const tool = mod.createGlobGithubTool();
		// no network: a bad URL still proves the alias resolved past the guard
		const result = await tool.execute("t", { repo: "not-a-url" }, undefined, undefined, { cwd: "/tmp" });
		const text = String(result.content[0].text);
		expect(text).not.toContain("missing required parameter");
	});
});
