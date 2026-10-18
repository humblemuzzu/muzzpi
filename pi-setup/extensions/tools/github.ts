/**
 * github tools — 7 tools for reading, searching, and exploring github repos.
 *
 * designed for the librarian sub-agent but registered as top-level extension
 * tools. the librarian spawns a pi process with `--tools <these names>` (see
 * lib/pi-spawn.ts), which gates built-in, extension and custom tools alike.
 *
 * all tools call the GitHub REST API with fetch (lib/github.ts), using gh's token.
 *
 * tool schemas:
 *   read_github, search_github, list_directory_github,
 *   list_repositories, glob_github, commit_search, diff
 */

import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import {
	parseRepoUrl,
	repoSlug,
	canonicalRepoSlug,
	renameNote,
	githubApi,
	decodeBase64Content,
	addLineNumbers,
	truncate,
} from "./lib/github";
import { boxRendererWindowed, osc8Link, COLLAPSED_EXCERPTS, renderBoxedText, type BoxSection, type BoxLine } from "./lib/box-format";
import { getText, getContainer } from "./lib/tui";
import { resolveParam } from "./lib/params";

/*
 * SHARED `repository` PARAMETER.
 *
 * every tool in this file targets a REMOTE repository over the GitHub API, and
 * every one of them needs the repo. two failure modes were observed in real
 * sessions:
 *
 *   1. the model reaches for a github tool when it meant to search the local
 *      checkout, and sends no repository at all (`{"pattern": ""}`)
 *   2. the model calls the parameter `repo`, which is the more natural name
 *
 * declaring it Optional lets both reach execute(), where requireRepository()
 * can say what is actually wrong and which tool to use instead — rather than
 * pi's generic "must have required properties repository".
 */
const REPOSITORY_PARAM = Type.Optional(
	Type.String({
		description:
			"REQUIRED. Remote repository URL or owner/repo, e.g. https://github.com/owner/repo. Never the local working copy.",
	}),
);

/** parameter names models actually use for the repository, canonical first. */
const REPO_PARAMS = ["repository", "repo", "repo_url", "url"] as const;

const API_PAGE_SIZE = 100;

/**
 * items [offset, offset + limit) from a page-numbered API: a true skip, fetching
 * only the pages that cover the window.
 */
export async function fetchWindow<T>(
	offset: number,
	limit: number,
	fetchPage: (page: number, perPage: number) => Promise<T[]>,
): Promise<T[]> {
	const out: T[] = [];
	let page = Math.floor(offset / API_PAGE_SIZE) + 1;
	let skip = offset % API_PAGE_SIZE;
	while (out.length < limit) {
		const items = await fetchPage(page, API_PAGE_SIZE);
		out.push(...items.slice(skip, skip + (limit - out.length)));
		if (items.length < API_PAGE_SIZE) break;
		skip = 0;
		page++;
	}
	return out;
}

/**
 * resolve the repository, or return a result that tells the model precisely
 * what to do instead of guessing again.
 */
function requireRepository(
	params: Record<string, unknown>,
	toolName: string,
	localAlternative: string,
): { value: string } | { error: any } {
	const value = resolveParam(params, REPO_PARAMS);
	if (value) return { value };
	return {
		error: {
			content: [
				{
					type: "text" as const,
					text:
						`${toolName}: missing required parameter "repository" (aliases: repo, repo_url, url).\n\n` +
						`${toolName} queries a REMOTE repository through the GitHub API and cannot run without one, ` +
						`e.g. repository: "https://github.com/owner/repo".\n\n` +
						`If you meant to search the local working copy in this session, use \`${localAlternative}\` instead.`,
				},
			],
			isError: true as const,
		},
	};
}

// --- read_github ---

export function createReadGithubTool(): ToolDefinition {
	return {
		name: "read_github",
		label: "Read GitHub",
		description:
			"Read a file from a remote GitHub repository, with line numbers. For the working copy use `read`.",

		parameters: Type.Object({
			path: Type.String({ description: "File path in the repository" }),
			repository: REPOSITORY_PARAM,
			read_range: Type.Optional(
				Type.Array(Type.Number(), {
					minItems: 2,
					maxItems: 2,
					description: "[start_line, end_line], 1-based and inclusive",
				}),
			),
		}),

		async execute(_id, params, signal) {
			try {
				const repo = requireRepository(params as any, "read_github", "read");
				if ("error" in repo) return repo.error;
				const ref = parseRepoUrl(repo.value);
				const data = await githubApi<any>(`repos/${repoSlug(ref)}/contents/${params.path}`, { signal });

				if (Array.isArray(data)) {
					return { content: [{ type: "text" as const, text: "Path is a directory, not a file. Use list_directory_github instead." }], isError: true };
				}

				if (data.type !== "file" || !data.content) {
					return { content: [{ type: "text" as const, text: `Not a file: ${data.type}` }], isError: true };
				}

				let content = decodeBase64Content(data.content);

				if (params.read_range) {
					const [start, end] = params.read_range;
					const lines = content.split("\n");
					const startIdx = Math.max(0, start - 1);
					const endIdx = Math.min(lines.length, end);
					content = lines.slice(startIdx, endIdx).join("\n");
					return { content: [{ type: "text" as const, text: addLineNumbers(content, start) }], details: { header: `${repoSlug(ref)}/${params.path}` } };
				}

				return { content: [{ type: "text" as const, text: truncate(addLineNumbers(content), 64_000) }], details: { header: `${repoSlug(ref)}/${params.path}` } };
			} catch (e: any) {
				return { content: [{ type: "text" as const, text: e.message }], isError: true };
			}
		},

		renderCall(args: any, theme: any, context: any) {
			const Text = getText();
			const text = context?.lastComponent ?? new Text("", 0, 0);
			const path = args.path || "...";
			const repo = args.repository ? args.repository.replace(/^https?:\/\/github\.com\//, "") : "";
			const display = `${repo}/${path}`;
			const url = args.repository ? `${args.repository.replace(/\/$/, "")}/blob/HEAD/${path}` : "";
			const linked = url ? osc8Link(url, display) : display;
			text.setText(theme.fg("toolTitle", theme.bold("read_github ")) + theme.fg("dim", linked));
			return text;
		},

		renderResult(result: any, _opts: { expanded: boolean }, _theme: any, context: any) {
			const Container = getContainer();
			const container = context?.lastComponent ?? new Container();
			container.clear();
			const content = result.content?.[0];
			if (!content || content.type !== "text") {
				container.addChild(new Text("(no output)", 0, 0));
				return container;
			}

			// parse numbered lines into BoxLine[] with gutters
			const parsed: BoxLine[] = content.text.split("\n").map((line: string) => {
				const m = line.match(/^(\s*\d+): (.*)$/);
				if (m) return { gutter: m[1].trim(), text: m[2], highlight: true };
				return { text: line, highlight: true };
			});

			const section: BoxSection = { blocks: [{ lines: parsed }] };
			const renderer = boxRendererWindowed(
				() => [section],
				{ collapsed: { excerpts: COLLAPSED_EXCERPTS }, expanded: {} },
			);
			container.addChild(renderer);
			return container;
		},
	};
}

// --- search_github ---

/**
 * GitHub code search's `path:` is a directory prefix: `path:dir/file.sh`
 * matches nothing, while `path:dir filename:file.sh` finds the file. A last
 * segment with an extension (a dot not in first position) is taken as a file
 * name, so `.github` stays a directory.
 */
export function searchPathQualifier(p: string): string {
	const trimmed = p.replace(/^\/+|\/+$/g, "");
	if (!trimmed) return "";
	const quote = (v: string) => (/\s/.test(v) ? `"${v}"` : v);
	const slash = trimmed.lastIndexOf("/");
	const base = trimmed.slice(slash + 1);
	if (!/^[^.].*\.[^.]+$/.test(base)) return `path:${quote(trimmed)}`;
	return slash === -1 ? `filename:${quote(base)}` : `path:${quote(trimmed.slice(0, slash))} filename:${quote(base)}`;
}

export function createSearchGithubTool(): ToolDefinition {
	return {
		name: "search_github",
		label: "Search GitHub",
		description:
			"Search code in a remote GitHub repository's default branch (large files are not indexed). " +
			"For the working copy use `grep`.",

		parameters: Type.Object({
			pattern: Type.String({
				description: "Search terms; supports AND/OR/NOT and qualifiers like language: and extension:",
			}),
			repository: REPOSITORY_PARAM,
			path: Type.Optional(Type.String({ description: "Directory or file to limit the search to" })),
			limit: Type.Optional(Type.Number({ description: "Max results (default 30)", minimum: 1, maximum: 100 })),
			offset: Type.Optional(Type.Number({ description: "Results to skip", minimum: 0 })),
		}),

		async execute(_id, params, signal) {
			try {
				const repo = requireRepository(params as any, "search_github", "grep");
				if ("error" in repo) return repo.error;
				const ref = parseRepoUrl(repo.value);
				const slug = await canonicalRepoSlug(ref, signal);
				const note = renameNote(ref, slug);
				const limit = params.limit ?? 30;
				let query = `${params.pattern} repo:${slug}`;
				const pathQualifier = params.path ? searchPathQualifier(params.path) : "";
				if (pathQualifier) query += ` ${pathQualifier}`;

				let total = 0;
				const items = await fetchWindow(params.offset ?? 0, limit, async (page, perPage) => {
					const data = await githubApi<any>("search/code", {
						params: { q: query, per_page: perPage, page },
						accept: "application/vnd.github.text-match+json",
						signal,
					});
					total = data.total_count ?? 0;
					return data.items ?? [];
				});

				if (items.length === 0) {
					return {
						content: [{
							type: "text" as const,
							text:
								note +
								`No results for "${params.pattern}" in ${slug} (query: ${query}). ` +
								"GitHub code search covers only the default branch and skips large files, so a miss " +
								"is not proof of absence — read_github the file to confirm.",
						}],
					};
				}

				const results: string[] = [`${note}Found ${total} results (showing ${items.length}):\n`];

				for (const item of items) {
					results.push(`## ${item.path}`);
					if (item.text_matches) {
						for (const match of item.text_matches) {
							if (match.fragment) {
								results.push("```");
								results.push(match.fragment);
								results.push("```");
							}
						}
					}
					results.push("");
				}

				return { content: [{ type: "text" as const, text: truncate(results.join("\n"), 64_000) }], details: { header: `/${params.pattern}/ in ${slug}` } };
			} catch (e: any) {
				return { content: [{ type: "text" as const, text: e.message }], isError: true };
			}
		},

		renderCall(args: any, theme: any, context: any) {
			const Text = getText();
			const text = context?.lastComponent ?? new Text("", 0, 0);
			const pattern = args.pattern || "...";
			const repo = args.repository ? args.repository.replace(/^https?:\/\/github\.com\//, "") : "";
			const linkedRepo = args.repository ? osc8Link(args.repository, repo) : repo;
			text.setText(theme.fg("toolTitle", theme.bold("search_github ")) + theme.fg("dim", `/${pattern}/ in ${linkedRepo}`));
			return text;
		},

		renderResult: renderBoxedText,
	};
}

// --- list_directory_github ---

export function createListDirectoryGithubTool(): ToolDefinition {
	return {
		name: "list_directory_github",
		label: "List Directory GitHub",
		description:
			"List a directory in a remote GitHub repository; directories end in /. For the working copy use `ls`.",

		parameters: Type.Object({
			path: Type.Optional(Type.String({ description: "Directory (default: repository root)" })),
			repository: REPOSITORY_PARAM,
			limit: Type.Optional(Type.Number({ description: "Max entries (default 100)", minimum: 1, maximum: 1000 })),
		}),

		async execute(_id, params, signal) {
			try {
				const repo = requireRepository(params as any, "list_directory_github", "ls");
				if ("error" in repo) return repo.error;
				const ref = parseRepoUrl(repo.value);
				const limit = params.limit ?? 100;
				const apiPath = !params.path || params.path === "." || params.path === "/" ? "" : params.path;

				const data = await githubApi<any[]>(`repos/${repoSlug(ref)}/contents/${apiPath}`, { signal });

				if (!Array.isArray(data)) {
					return { content: [{ type: "text" as const, text: "Path is a file, not a directory. Use read_github instead." }], isError: true };
				}

				const entries = data.slice(0, limit).map((item: any) => {
					const suffix = item.type === "dir" ? "/" : "";
					const size = item.type === "file" && item.size ? ` (${item.size} bytes)` : "";
					return `${item.name}${suffix}${size}`;
				});

				return { content: [{ type: "text" as const, text: entries.join("\n") }], details: { header: `${repoSlug(ref)}/${apiPath}` } };
			} catch (e: any) {
				return { content: [{ type: "text" as const, text: e.message }], isError: true };
			}
		},

		renderCall(args: any, theme: any, context: any) {
			const Text = getText();
			const text = context?.lastComponent ?? new Text("", 0, 0);
			const path = args.path || "/";
			const repo = args.repository ? args.repository.replace(/^https?:\/\/github\.com\//, "") : "";
			const display = `${repo}/${path}`;
			const url = args.repository ? `${args.repository.replace(/\/$/, "")}/tree/HEAD/${path}` : "";
			const linked = url ? osc8Link(url, display) : display;
			text.setText(theme.fg("toolTitle", theme.bold("list_directory_github ")) + theme.fg("dim", linked));
			return text;
		},

		renderResult: renderBoxedText,
	};
}

// --- list_repositories ---

export function createListRepositoriesTool(): ToolDefinition {
	return {
		name: "list_repositories",
		label: "List Repositories",
		description:
			"Search GitHub repositories, most stars first, with stars, forks and description; includes private " +
			"repositories your gh login can see. With neither `pattern` nor `organization` it lists the most-starred repositories.",

		parameters: Type.Object({
			pattern: Type.Optional(Type.String({ description: "Search terms, matched in name, description and topics; add in:name for names only" })),
			organization: Type.Optional(Type.String({ description: "Organization or user" })),
			language: Type.Optional(Type.String({ description: "Primary language" })),
			limit: Type.Optional(Type.Number({ description: "Max results (default 30)", minimum: 1, maximum: 100 })),
			offset: Type.Optional(Type.Number({ description: "Results to skip", minimum: 0 })),
		}),

		async execute(_id, params, signal) {
			try {
				const limit = params.limit ?? 30;
				const queryParts: string[] = [];
				if (params.pattern) queryParts.push(params.pattern);
				if (params.organization) queryParts.push(`org:${params.organization}`);
				if (params.language) queryParts.push(`language:${params.language}`);
				if (queryParts.length === 0) queryParts.push("stars:>0");

				let total = 0;
				const items = await fetchWindow(params.offset ?? 0, limit, async (page, perPage) => {
					const data = await githubApi<any>("search/repositories", {
						params: { q: queryParts.join(" "), sort: "stars", per_page: perPage, page },
						signal,
					});
					total = data.total_count ?? 0;
					return data.items ?? [];
				});

				if (items.length === 0) {
					return { content: [{ type: "text" as const, text: "No repositories found." }] };
				}

				const lines: string[] = [`Found ${total} repositories (showing ${items.length}):\n`];
				for (const repo of items) {
					lines.push(`## ${repo.full_name}`);
					if (repo.description) lines.push(repo.description);
					const meta = [
						repo.language,
						`★ ${repo.stargazers_count}`,
						`forks: ${repo.forks_count}`,
					].filter(Boolean).join(" · ");
					lines.push(meta);
					lines.push(`${repo.html_url}\n`);
				}

				return { content: [{ type: "text" as const, text: lines.join("\n") }], details: { header: queryParts.join(" ") } };
			} catch (e: any) {
				return { content: [{ type: "text" as const, text: e.message }], isError: true };
			}
		},

		renderCall(args: any, theme: any, context: any) {
			const Text = getText();
			const text = context?.lastComponent ?? new Text("", 0, 0);
			const query = args.pattern || args.organization || "...";
			text.setText(theme.fg("toolTitle", theme.bold("list_repositories ")) + theme.fg("dim", query));
			return text;
		},

		renderResult: renderBoxedText,
	};
}

// --- glob_github ---

export function createGlobGithubTool(): ToolDefinition {
	return {
		name: "glob_github",
		label: "Glob GitHub",
		description:
			"Find files by glob on a remote GitHub repository's default branch. For the working copy use `find`.",

		// `filePattern` is the canonical name, but models overwhelmingly guess
		// `pattern` (matching grep/glob conventions) and then fail schema validation.
		// both are accepted; at least one is required, enforced in execute().
		parameters: Type.Object({
			filePattern: Type.Optional(
				Type.String({ description: 'Required glob, e.g. "src/**/*.test.ts"; `pattern` is an alias' }),
			),
			pattern: Type.Optional(
				Type.String({ description: "Alias for filePattern" }),
			),
			repository: REPOSITORY_PARAM,
			limit: Type.Optional(Type.Number({ description: "Max results (default 100)" })),
			offset: Type.Optional(Type.Number({ description: "Results to skip" })),
		}),

		async execute(_id, params, signal) {
			try {
				const filePattern = params.filePattern ?? params.pattern;
				if (!filePattern) {
					return {
						content: [{ type: "text" as const, text: 'Missing glob pattern: pass "filePattern" (or "pattern").' }],
						isError: true,
					};
				}
				const repo = requireRepository(params as any, "glob_github", "find");
				if ("error" in repo) return repo.error;
				const ref = parseRepoUrl(repo.value);
				const limit = params.limit ?? 100;
				const offset = params.offset ?? 0;

				const tree = await githubApi<any>(`repos/${repoSlug(ref)}/git/trees/HEAD?recursive=1`, { signal });

				if (!tree.tree) {
					return { content: [{ type: "text" as const, text: "Could not read repository tree." }], isError: true };
				}

				const files = tree.tree
					.filter((item: any) => item.type === "blob")
					.map((item: any) => item.path as string)
					.filter((path: string) => matchGlob(path, filePattern));

				const total = files.length;
				const sliced = files.slice(offset, offset + limit);

				const output = [
					`Found ${total} files matching "${filePattern}" (showing ${sliced.length}):`,
					...(tree.truncated ? ["(GitHub truncated this repository's tree, so some files are missing: use search_github or list_directory_github)"] : []),
					"",
					...sliced,
				];

				return { content: [{ type: "text" as const, text: output.join("\n") }], details: { header: `${filePattern} in ${repoSlug(ref)}` } };
			} catch (e: any) {
				return { content: [{ type: "text" as const, text: e.message }], isError: true };
			}
		},

		renderCall(args: any, theme: any, context: any) {
			const Text = getText();
			const text = context?.lastComponent ?? new Text("", 0, 0);
			const pattern = args.filePattern || args.pattern || "...";
			const repo = args.repository ? args.repository.replace(/^https?:\/\/github\.com\//, "") : "";
			const linkedRepo = args.repository ? osc8Link(args.repository, repo) : repo;
			text.setText(theme.fg("toolTitle", theme.bold("glob_github ")) + theme.fg("dim", `${pattern} in ${linkedRepo}`));
			return text;
		},

		renderResult: renderBoxedText,
	};
}

// --- commit_search ---

// commit search returns local offsets with milliseconds, the commits list returns UTC: show one format.
function utcDate(raw: unknown): string {
	if (typeof raw !== "string" || !raw) return "";
	const d = new Date(raw);
	return Number.isNaN(d.getTime()) ? raw : d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function createCommitSearchTool(): ToolDefinition {
	return {
		name: "commit_search",
		label: "Commit Search",
		description:
			"List or search commits in a remote GitHub repository. With `query`, searches commit messages across the " +
			"default branch's history and cannot take `path`. Without it, lists commits newest first, filtered by " +
			"author, dates and path.",

		parameters: Type.Object({
			repository: REPOSITORY_PARAM,
			query: Type.Optional(Type.String({ description: "Text to search for in commit messages" })),
			author: Type.Optional(Type.String({ description: "Author username (or email when listing without query)" })),
			since: Type.Optional(Type.String({ description: 'Earliest commit date, ISO 8601 (e.g. "2024-01-01T00:00:00Z")' })),
			until: Type.Optional(Type.String({ description: "Latest commit date, ISO 8601" })),
			path: Type.Optional(Type.String({ description: "Only commits that changed this file or directory" })),
			limit: Type.Optional(Type.Number({ description: "Max commits (default 50)", minimum: 1, maximum: 100 })),
			offset: Type.Optional(Type.Number({ description: "Commits to skip", minimum: 0 })),
		}),

		async execute(_id, params, signal) {
			try {
				const repo = requireRepository(params as any, "commit_search", "bash (git log)");
				if ("error" in repo) return repo.error;
				const ref = parseRepoUrl(repo.value);
				const limit = params.limit ?? 50;
				const offset = params.offset ?? 0;
				if (params.query && params.path) {
					return {
						content: [{
							type: "text" as const,
							text: "commit_search: `query` searches the whole history but GitHub commit search cannot filter by path. " +
								"Drop `path` to search messages, or drop `query` to list the commits that touched the path.",
						}],
						isError: true,
					};
				}

				let commits: any[];
				let note = "";
				if (params.query) {
					const slug = await canonicalRepoSlug(ref, signal);
					note = renameNote(ref, slug);
					const q = [params.query, `repo:${slug}`];
					if (params.author) q.push(`author:${params.author}`);
					if (params.since) q.push(`committer-date:>=${params.since}`);
					if (params.until) q.push(`committer-date:<=${params.until}`);
					commits = await fetchWindow(offset, limit, async (page, perPage) => {
						const data = await githubApi<any>("search/commits", {
							params: { q: q.join(" "), sort: "committer-date", order: "desc", per_page: perPage, page },
							signal,
						});
						return data.items ?? [];
					});
				} else {
					const filters: Record<string, string> = {};
					if (params.author) filters.author = params.author;
					if (params.since) filters.since = params.since;
					if (params.until) filters.until = params.until;
					if (params.path) filters.path = params.path;
					commits = await fetchWindow(offset, limit, async (page, perPage) => {
						const data = await githubApi<any[]>(`repos/${repoSlug(ref)}/commits`, {
							params: { ...filters, per_page: perPage, page },
							signal,
						});
						return Array.isArray(data) ? data : [];
					});
				}

				if (commits.length === 0) {
					return { content: [{ type: "text" as const, text: `${note}No commits found.` }] };
				}

				const lines: string[] = [`${note}Found ${commits.length} commits:\n`];
				for (const c of commits) {
					const sha = c.sha?.slice(0, 7) ?? "???????";
					const author = c.commit?.author?.name ?? c.author?.login ?? "unknown";
					const date = utcDate(c.commit?.author?.date);
					const msg = c.commit?.message?.split("\n")[0] ?? "";
					lines.push(`${sha} ${date} (${author}) ${msg}`);
				}

				return { content: [{ type: "text" as const, text: lines.join("\n") }], details: { header: repoSlug(ref) } };
			} catch (e: any) {
				return { content: [{ type: "text" as const, text: e.message }], isError: true };
			}
		},

		renderCall(args: any, theme: any, context: any) {
			const Text = getText();
			const text = context?.lastComponent ?? new Text("", 0, 0);
			const repo = args.repository ? args.repository.replace(/^https?:\/\/github\.com\//, "") : "...";
			const linkedRepo = args.repository ? osc8Link(args.repository, repo) : repo;
			const query = args.query || args.author || "";
			text.setText(theme.fg("toolTitle", theme.bold("commit_search ")) + theme.fg("dim", `${linkedRepo} ${query}`.trim()));
			return text;
		},

		renderResult: renderBoxedText,
	};
}

// --- diff ---

export function createDiffTool(): ToolDefinition {
	return {
		name: "diff",
		label: "Diff",
		description:
			"Compare two refs in a remote GitHub repository: ahead/behind counts and changed files, optionally with patches.",

		parameters: Type.Object({
			base: Type.String({ description: 'Ref to compare from: branch, tag or SHA (e.g. "v1.0.0")' }),
			head: Type.String({ description: "Ref to compare to" }),
			repository: REPOSITORY_PARAM,
			includePatches: Type.Optional(Type.Boolean({
				description: "Include each file's unified diff (token heavy; default false)",
			})),
		}),

		async execute(_id, params, signal) {
			try {
				const repo = requireRepository(params as any, "diff", "bash (git diff)");
				if ("error" in repo) return repo.error;
				const ref = parseRepoUrl(repo.value);
				const data = await githubApi<any>(
					`repos/${repoSlug(ref)}/compare/${encodeURIComponent(params.base)}...${encodeURIComponent(params.head)}`,
					{ signal },
				);

				const lines: string[] = [
					`Comparing ${params.base}...${params.head}`,
					`Status: ${data.status}`,
					`Ahead by: ${data.ahead_by} commits`,
					`Behind by: ${data.behind_by} commits`,
					`Changed files: ${data.files?.length ?? 0}`,
					"",
				];

				if (data.files) {
					for (const file of data.files) {
						const stat = `+${file.additions} -${file.deletions}`;
						lines.push(`${file.status} ${file.filename} (${stat})`);

						if (params.includePatches && file.patch) {
							lines.push("```diff");
							lines.push(truncate(file.patch, 4000));
							lines.push("```");
							lines.push("");
						}
					}
				}

				return { content: [{ type: "text" as const, text: truncate(lines.join("\n"), 64_000) }], details: { header: `${params.base}...${params.head}` } };
			} catch (e: any) {
				return { content: [{ type: "text" as const, text: e.message }], isError: true };
			}
		},

		renderCall(args: any, theme: any, context: any) {
			const Text = getText();
			const text = context?.lastComponent ?? new Text("", 0, 0);
			const repo = args.repository ? args.repository.replace(/^https?:\/\/github\.com\//, "") : "...";
			const linkedRepo = args.repository ? osc8Link(args.repository, repo) : repo;
			const range = `${args.base || "?"}...${args.head || "?"}`;
			text.setText(theme.fg("toolTitle", theme.bold("diff ")) + theme.fg("dim", `${linkedRepo} ${range}`));
			return text;
		},

		renderResult: renderBoxedText,
	};
}

// --- glob matching (simple, no external deps) ---

/** must stay one-pass: chained replace() rewrites globstar to a `?` quantifier that the later `?` rule then mangles. */
export function matchGlob(path: string, pattern: string): boolean {
	let regexStr = "";
	for (let i = 0; i < pattern.length; i++) {
		const char = pattern[i];
		if (char === "*") {
			if (pattern[i + 1] === "*") {
				if (pattern[i + 2] === "/") {
					// "**/" matches zero or more directories
					regexStr += "(?:[^/]*/)*";
					i += 2;
				} else {
					regexStr += ".*";
					i += 1;
				}
			} else {
				regexStr += "[^/]*";
			}
		} else if (char === "?") {
			regexStr += "[^/]";
		} else {
			// escape every regex metacharacter literally
			regexStr += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
		}
	}
	try {
		return new RegExp(`^${regexStr}$`).test(path);
	} catch {
		return path.includes(pattern.replace(/[*?]/g, ""));
	}
}
