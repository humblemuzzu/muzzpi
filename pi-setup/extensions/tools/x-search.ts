/**
 * x_search — X posts, users and threads through Grok's own X tools, on the
 * user's Grok CLI login (lib/x/grok-login.ts, lib/x/grok-proxy.ts). Grok runs exactly one X tool and
 * relays its raw result; every post it relays is checked against the ids the
 * server says the tool returned, so a mis-copied or invented post is dropped
 * and a skipped one is reported.
 */

import * as path from "node:path";
import { getAgentDir, type ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { boxRendererWindowed, osc8Link, type BoxSection, type Excerpt } from "./lib/box-format";
import { getEnabledExtensionConfig, type ExtensionConfigSchema } from "./lib/config";
import { stringList } from "./lib/params";
import { withPromptPatch } from "./lib/prompt-patch";
import { argumentPreparer } from "./lib/tool-args";
import type { ToolCostDetails } from "./lib/tool-cost";
import { ProviderError } from "./lib/web/http";
import { formatPosts, formatUsers, postHeader } from "./lib/x/format";
import {
	callGrokProxy,
	ClientVersion,
	GROK_PROXY_URL,
	type ProxyResult,
	type ProxyUsage,
	type TokenSource,
	type XSearchToolConfig,
} from "./lib/x/grok-proxy";
import { grokCliLogin, hasGrokLogin } from "./lib/x/grok-login";
import { allPostIds, parsePosts, parseUsers, type XPost, type XUser } from "./lib/x/parse";

export type XSearchExtConfig = {
	model: string;
	effort: string;
	baseUrl: string;
	/** sent when neither an installed Grok CLI nor a 426 has named a newer version. */
	clientVersion: string;
	timeoutSecs: number;
};

export const X_CONFIG_DEFAULTS: XSearchExtConfig = {
	model: "grok-4.6",
	effort: "low",
	baseUrl: GROK_PROXY_URL,
	clientVersion: "1.0.62",
	timeoutSecs: 90,
};

function isXSearchConfig(v: Record<string, unknown>): v is XSearchExtConfig {
	return (
		typeof v.model === "string" && v.model.length > 0 &&
		typeof v.effort === "string" && v.effort.length > 0 &&
		typeof v.baseUrl === "string" && /^https?:\/\//.test(v.baseUrl) &&
		typeof v.clientVersion === "string" && /^\d+(\.\d+){1,3}$/.test(v.clientVersion) &&
		typeof v.timeoutSecs === "number" && Number.isInteger(v.timeoutSecs) && v.timeoutSecs >= 5
	);
}

const X_CONFIG_SCHEMA: ExtensionConfigSchema<XSearchExtConfig> = { validate: isXSearchConfig };

const KINDS = ["posts", "semantic", "users", "thread"] as const;
type XKind = (typeof KINDS)[number];
const SORTS = ["latest", "top"] as const;
const MAX_LIMIT = 10;
const MAX_HANDLES = 20;
const NO_RESULTS = "NO RESULTS";
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const COLLAPSED_EXCERPTS: Excerpt[] = [{ focus: "head", context: 6 }];

const X_EXAMPLE = 'Example: x_search({ query: "from:karpathy", from_date: "2026-09-01", to_date: "2026-10-01" })';

const STATUS_URL = /(?:x|twitter)\.com\/[^/\s]+\/status(?:es)?\/\d{5,20}/i;

export const prepareXArguments = argumentPreparer(
	"x_search",
	{
		query: { aliases: ["q", "search", "text", "term", "terms", "keywords", "url", "post", "post_id", "post_url", "tweet", "tweet_id", "id"] },
		kind: {
			aliases: ["type", "search_type", "tool"],
			values: {
				posts: ["post", "tweet", "tweets", "keyword", "keywords", "search", "keyword_search"],
				semantic: ["meaning", "similar", "related", "vector", "semantic_search"],
				users: ["user", "account", "accounts", "profile", "profiles", "people", "person", "user_search"],
				thread: ["conversation", "replies", "reply", "context", "thread_fetch"],
			},
			valuesHelp: "posts (keyword search, the default), semantic (by meaning), users (find accounts), thread (a post id or URL and its thread)",
		},
		sort: {
			aliases: ["mode", "order", "order_by", "sort_by"],
			values: {
				latest: ["recent", "new", "newest", "chronological", "live", "date"],
				top: ["popular", "best", "engaged", "relevant", "relevance", "trending", "most_liked"],
			},
			valuesHelp: "latest (newest first, the default) or top (most engaged)",
		},
		limit: { number: true, aliases: ["count", "max_results", "num_results", "n", "num", "number", "size", "max"] },
		handles: {
			list: true,
			aliases: ["handle", "username", "usernames", "user", "author", "authors", "account", "accounts", "from_user", "from_users", "allowed_x_handles"],
		},
		exclude_handles: {
			list: true,
			aliases: ["exclude", "exclude_users", "exclude_accounts", "excluded_handles", "excluded_x_handles", "not_from", "block", "mute"],
		},
		from_date: { aliases: ["since", "start", "start_date", "after", "from", "date_from", "begin"] },
		to_date: { aliases: ["until", "end", "end_date", "before", "to", "date_to"] },
	},
	X_EXAMPLE,
	(args) => {
		const handles = (args.handles as string[] | undefined) ?? [];
		if (!args.query && handles.length) args.query = handles.map((h) => `from:${h.replace(/^@/, "")}`).join(" OR ");
		if (!args.kind && typeof args.query === "string" && STATUS_URL.test(args.query)) args.kind = "thread";
		return args;
	},
);

interface XRequest {
	kind: XKind;
	tool: string;
	args: Record<string, unknown>;
	toolConfig: XSearchToolConfig;
	notes: string[];
}

export interface XSearchDetails extends ToolCostDetails {
	kind: XKind;
	query: string;
	limit: number;
	executed: { name: string; input: string }[];
	posts?: XPost[];
	users?: XUser[];
	fetched: number;
	dropped: string[];
	missing: string[];
	notes: string[];
	usage: ProxyUsage;
	model: string;
	tokenSource?: string;
	clientVersion?: string;
	ms: number;
	resultSections?: BoxSection[];
}

const handle = (h: string) => h.trim().replace(/^@/, "").replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, "").split(/[/?#]/)[0];

/** validates the arguments and decides which X tool Grok must run; a string is the reason they are invalid. */
export function buildXRequest(params: Record<string, unknown>): XRequest | string {
	const query = typeof params.query === "string" ? params.query.trim() : "";
	if (!query) return "query is required: search terms, an @handle to look up, or a post URL/id for a thread";
	const kind = (params.kind ?? "posts") as XKind;
	if (!KINDS.includes(kind)) return `kind must be one of ${KINDS.join(", ")}`;
	const sort = params.sort ?? "latest";
	if (!(SORTS as readonly unknown[]).includes(sort)) return `sort must be "latest" or "top"`;
	const limit = Math.round(Number(params.limit ?? MAX_LIMIT));
	if (!Number.isFinite(limit) || limit < 1) return "limit must be a number from 1 to 10";

	const handles = stringList(params.handles).map(handle).filter(Boolean);
	const excluded = stringList(params.exclude_handles).map(handle).filter(Boolean);
	if (handles.length && excluded.length) return "handles and exclude_handles cannot be combined (X search takes one or the other)";
	if (handles.length > MAX_HANDLES || excluded.length > MAX_HANDLES) return `at most ${MAX_HANDLES} handles`;
	const from = typeof params.from_date === "string" ? params.from_date.trim() : "";
	const to = typeof params.to_date === "string" ? params.to_date.trim() : "";
	for (const [name, value] of [["from_date", from], ["to_date", to]] as const) {
		const real = DATE.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
		if (value && !real) return `${name} must be a real date like 2026-09-01`;
	}
	if (from && to && from >= to) return "to_date is exclusive, so it must come after from_date (one day: from 2026-09-01 to 2026-09-02)";

	const notes: string[] = [];
	const toolConfig: XSearchToolConfig = { type: "x_search" };
	const filtered = kind === "posts" || kind === "semantic";
	if (filtered) {
		if (handles.length) toolConfig.allowed_x_handles = handles;
		if (excluded.length) toolConfig.excluded_x_handles = excluded;
		if (from) toolConfig.from_date = from;
		if (to) toolConfig.to_date = to;
	} else if (handles.length || excluded.length || from || to) {
		notes.push(`handles and dates apply to posts and semantic searches; ignored for ${kind}`);
	}
	if (kind !== "posts" && params.sort !== undefined) notes.push("sort applies to posts searches only; ignored");

	const n = Math.min(limit, MAX_LIMIT);
	switch (kind) {
		case "posts":
			return { kind, tool: "x_keyword_search", args: { query, limit: n, mode: sort === "top" ? "Top" : "Latest" }, toolConfig, notes };
		case "semantic":
			return { kind, tool: "x_semantic_search", args: { query, limit: n }, toolConfig, notes };
		case "users":
			return { kind, tool: "x_user_search", args: { query, count: n }, toolConfig, notes };
		case "thread": {
			const id = query.match(/status(?:es)?\/(\d{5,20})/)?.[1] ?? query.match(/^\d{5,20}$/)?.[0];
			if (!id) return "for kind thread, query must be a post id or a post URL like https://x.com/user/status/123";
			return { kind, tool: "x_thread_fetch", args: { post_id: id }, toolConfig, notes };
		}
	}
}

export function relayInstructions(req: XRequest): string {
	const drop = req.kind === "users"
		? ['every "- Avatar:" line']
		: ['every "- Avatar:" line', 'every "- Bio:" line together with the lines that continue it'];
	return [
		"You are a retrieval relay, not an assistant.",
		`Make exactly one call: ${req.tool} with the arguments ${JSON.stringify(req.args)}. Call no other tool and do not change the arguments.`,
		`Then output the tool's result verbatim, line for line, exactly as the tool returned it, leaving out only ${drop.join(" and ")}.`,
		'Copy every "- Content:" value in full, character for character: never shorten, summarise, translate or correct it.',
		`No preamble, no commentary, no code fences. If the tool returned nothing, output exactly: ${NO_RESULTS}`,
	].join("\n");
}

/**
 * The server cites every post a search returns, but for a thread only the
 * post that was fetched (the root, or a reply nested under its parent); the
 * rest are counted in `x_posts_fetched` without a citation. So a search result
 * must be cited itself, a thread must hold a cited post somewhere, and nested
 * posts are checked by count.
 *
 * Post text is free text and can imitate a card, so an id that appears on more
 * than one card is not trusted on any of them.
 */
function verifyPosts(posts: XPost[], sourceIds: Set<string>, postsFetched: number | undefined, details: XSearchDetails): XPost[] {
	const seen = allPostIds(posts);
	details.missing = [...sourceIds].filter((id) => !seen.has(id));

	const occurrences = new Map<string, number>();
	for (const p of posts) for (const id of [p.id, ...p.replies.map((r) => r.id)]) occurrences.set(id, (occurrences.get(id) ?? 0) + 1);
	const repeated = new Set([...occurrences].filter(([, n]) => n > 1).map(([id]) => id));
	if (repeated.size) {
		details.notes.push(`dropped the posts carrying ids that appear twice in Grok's copy (post text can imitate a result): ${[...repeated].join(", ")}`);
	}

	const cited = (p: XPost) => (details.kind === "thread" ? [...allPostIds([p])].some((id) => sourceIds.has(id)) : sourceIds.has(p.id));
	const kept = posts.flatMap((p) => {
		if (repeated.has(p.id) || !cited(p)) {
			if (!repeated.has(p.id)) details.dropped.push(p.id);
			return [];
		}
		return [{ ...p, replies: p.replies.filter((r) => !repeated.has(r.id)) }];
	});
	const copied = kept.reduce((n, p) => n + 1 + p.replies.length, 0);
	if (postsFetched !== undefined && copied > postsFetched) {
		details.notes.push(`Grok's copy holds ${copied} posts but X returned ${postsFetched}; the extra replies may be mis-copied`);
	}
	return kept;
}

function postSections(posts: XPost[]): BoxSection[] {
	const section = (p: XPost, prefix = ""): BoxSection => {
		const lines = [{ text: osc8Link(p.url, p.url), highlight: true }];
		for (const line of p.text.split("\n")) lines.push({ text: line, highlight: false });
		if (p.quoted) lines.push({ text: `> @${p.quoted.username ?? "?"}: ${p.quoted.text.split("\n")[0]}`, highlight: false });
		return { header: `${prefix}${postHeader(p)}`, blocks: [{ lines }] };
	};
	return posts.flatMap((p) => [section(p), ...p.replies.map((r) => section(r, "↳ "))]);
}

function userSections(users: XUser[]): BoxSection[] {
	return users.map((u) => ({
		header: `@${u.username ?? u.id}${u.name ? ` (${u.name})` : ""}${u.followers !== undefined ? ` · ${u.followers.toLocaleString("en-US")} followers` : ""}`,
		blocks: [{ lines: [{ text: osc8Link(u.url, u.url), highlight: true }, ...(u.bio ? u.bio.split("\n").map((t) => ({ text: t, highlight: false })) : [])] }],
	}));
}

/** sums for the posts on this page, so "how many likes did I get" is one call, not arithmetic. */
function totalsLine(posts: XPost[]): string | undefined {
	if (!posts.length) return undefined;
	const sum = (key: keyof XPost["engagement"]) => posts.reduce((n, p) => n + (p.engagement[key] ?? 0), 0);
	const replies = posts.filter((p) => p.conversationId && p.conversationId !== p.id).length;
	const n = (v: number) => v.toLocaleString("en-US");
	return (
		`these ${posts.length} posts (${posts.length - replies} original, ${replies} replies): ` +
		`${n(sum("likes"))} likes, ${n(sum("views"))} views, ${n(sum("reposts"))} reposts, ${n(sum("replies"))} replies received`
	);
}

/** a full page means there may be more: the next page is the same query with max_id just below the oldest post. */
function nextPageLine(details: XSearchDetails, query: string): string | undefined {
	const posts = details.posts ?? [];
	if (details.kind !== "posts" || posts.length < details.limit) return undefined;
	const oldest = posts.map((p) => BigInt(p.id)).reduce((a, b) => (b < a ? b : a));
	const base = query.replace(/\s*\bmax_id:\d+/g, "").trim();
	return `page is full; for the next ${details.limit}, same arguments with query: "${base} max_id:${oldest - 1n}"`;
}

function trailer(details: XSearchDetails): string[] {
	const ran = details.executed.map((c) => `${c.name} ${c.input}`).join("; ") || "no X tool call was reported";
	const lines = [`ran ${ran} · ${details.model} · ${(details.ms / 1000).toFixed(1)}s`];
	const totals = totalsLine(details.posts ?? []);
	if (totals) lines.push(totals);
	const next = nextPageLine(details, details.query);
	if (next) lines.push(next);
	if (details.dropped.length) {
		lines.push(`dropped ${details.dropped.length} post(s) X did not return — Grok mis-copied them: ${details.dropped.join(", ")}`);
	}
	if (details.missing.length) {
		const shown = details.missing.slice(0, 10).map((id) => `https://x.com/i/status/${id}`).join(" ");
		lines.push(`Grok's copy left out ${details.missing.length} of the ${details.fetched} posts X returned: ${shown}`);
	}
	return [...lines, ...details.notes];
}

function errorResult(text: string) {
	return { content: [{ type: "text" as const, text }], isError: true } as any;
}

export interface XSearchDeps {
	tokens?: TokenSource[];
	version?: ClientVersion;
}

export function createXSearchTool(config: XSearchExtConfig = X_CONFIG_DEFAULTS, deps: XSearchDeps = {}): ToolDefinition<any> {
	let version = deps.version;
	const tokens = deps.tokens ?? [grokCliLogin()];

	return {
		name: "x_search",
		label: "X Search",
		prepareArguments: prepareXArguments,
		description:
			"Search X (Twitter) posts, look up accounts, and read threads, through Grok's X tools on your Grok subscription (the Grok CLI's `grok login`).\n\n" +
			"kind 'posts' (default) is a keyword search that takes X operators in the query — from:user, to:user, @user, " +
			'"exact phrase", OR, -word, lang:ja, since:YYYY-MM-DD, until:YYYY-MM-DD (exclusive), max_id:<id> to page back, ' +
			"min_faves:N, filter:replies, -filter:replies, filter:media, url:domain. 'semantic' finds posts by meaning, " +
			"'users' finds accounts, 'thread' takes a post id or URL and returns it with its parent or some replies. " +
			"At most 10 results per call. Each result ends with the page's totals (likes, views, reposts), the exact next-page " +
			"query when the page is full, and the X tool call Grok ran.\n\n" +
			'Example: x_search({ query: "\\"Claude Code\\" lang:en -filter:replies", sort: "latest", limit: 10 })\n' +
			'Example: x_search({ query: "from:karpathy", from_date: "2026-09-01", to_date: "2026-10-01" })',

		parameters: Type.Object({
			query: Type.String({
				description: "Search terms with X operators, an account name for kind 'users', or a post id/URL for kind 'thread'.",
			}),
			kind: Type.Optional(
				Type.Union(KINDS.map((k) => Type.Literal(k)), {
					description: "Optional (default posts): posts = keyword search, semantic = by meaning, users = accounts, thread = one post's thread.",
				}),
			),
			sort: Type.Optional(
				Type.Union(SORTS.map((s) => Type.Literal(s)), {
					description: "Optional, posts only (default latest): latest = newest first, top = most engaged.",
				}),
			),
			limit: Type.Optional(Type.Number({ description: "Optional. Results to return, 1–10 (default 10)." })),
			handles: Type.Optional(
				Type.Array(Type.String(), { description: "Optional, posts/semantic. Only posts by these accounts (max 20), without @." }),
			),
			exclude_handles: Type.Optional(
				Type.Array(Type.String(), { description: "Optional, posts/semantic. Never posts by these accounts (max 20). Not with handles." }),
			),
			from_date: Type.Optional(Type.String({ description: "Optional, posts/semantic. First day to include, YYYY-MM-DD (UTC)." })),
			to_date: Type.Optional(Type.String({ description: "Optional, posts/semantic. Day to stop before (exclusive), YYYY-MM-DD." })),
		}),

		async execute(_toolCallId, params, signal) {
			const req = buildXRequest(params as Record<string, unknown>);
			if (typeof req === "string") return errorResult(req);

			version ??= new ClientVersion(path.join(getAgentDir(), "cache", "x-search.json"), config.clientVersion);
			const started = Date.now();
			const ask = () =>
				callGrokProxy(
					{
						model: config.model,
						effort: config.effort,
						input: `${relayInstructions(req)}\n\n${req.tool} ${JSON.stringify(req.args)}`,
						tool: req.toolConfig,
						timeoutMs: config.timeoutSecs * 1000,
						signal,
					},
					{ baseUrl: config.baseUrl, tokens, version: version! },
				);
			let res: ProxyResult;
			try {
				res = await ask();
				if (!res.calls.length) res = await ask();
			} catch (err) {
				const message = err instanceof ProviderError ? err.message : String((err as Error)?.message ?? err);
				const status = err instanceof ProviderError && err.status ? ` (HTTP ${err.status})` : "";
				return errorResult(`x_search failed${status}: ${message}`);
			}
			if (!res.calls.length) {
				return errorResult(
					"x_search failed: twice, Grok answered without running an X tool, so nothing it wrote came from X and none of it is shown. " +
						"Try again, or set a different model under \"x-search\" in ext-config.json.",
				);
			}

			const users = req.kind === "users";
			const sourceIds = users ? res.sourceUserIds : res.sourcePostIds;
			const details: XSearchDetails = {
				cost: 0,
				kind: req.kind,
				query: String((params as Record<string, unknown>).query ?? ""),
				limit: Number(req.args.limit ?? req.args.count ?? MAX_LIMIT),
				executed: res.calls,
				fetched: sourceIds.size,
				dropped: [],
				missing: [],
				notes: [...req.notes, ...(res.incomplete ? [`Grok's answer was cut short (${res.incomplete}); posts may be missing`] : [])],
				usage: res.usage,
				model: config.model,
				tokenSource: res.tokenSource,
				clientVersion: res.clientVersion,
				ms: Date.now() - started,
			};
			const raw = res.text.trim();
			let body: string;
			const fetchedCount = users ? res.usage.usersFetched : res.usage.postsFetched;
			const xReturnedNothing = !sourceIds.size && fetchedCount === 0;
			if (users) {
				let found = parseUsers(raw);
				if (sourceIds.size || xReturnedNothing) {
					details.dropped = found.filter((u) => !sourceIds.has(u.id)).map((u) => u.id);
					found = found.filter((u) => sourceIds.has(u.id));
				}
				details.users = found;
				details.resultSections = userSections(found);
				body = found.length ? formatUsers(found) : "";
			} else {
				let found = parsePosts(raw);
				if (sourceIds.size) found = verifyPosts(found, sourceIds, res.usage.postsFetched, details);
				else if (xReturnedNothing) {
					details.dropped = found.map((p) => p.id);
					found = [];
				}
				details.posts = found;
				details.resultSections = postSections(found);
				body = found.length ? formatPosts(found) : "";
			}

			if (body && !sourceIds.size) {
				details.notes.push("Grok sent no source list, so these results could not be checked against what X returned");
			}
			if (!body) {
				const nothing = !raw || raw === NO_RESULTS;
				if (details.dropped.length) body = "(none of what Grok copied matches what X returned, so none of it is shown)";
				else if (details.missing.length) body = "(Grok returned none of the posts X found; links below)";
				else if (nothing) body = users ? "(no accounts found)" : "(no posts found)";
				else {
					body = raw;
					details.notes.push("Grok's output did not match the X result format; shown as Grok returned it");
				}
			}
			return { content: [{ type: "text" as const, text: `${body}\n\n${trailer(details).map((l) => `[${l}]`).join("\n")}` }], details };
		},

		renderCall(args: any, theme: any) {
			const kind = args.kind && args.kind !== "posts" ? `${args.kind} ` : "";
			const query = String(args.query ?? "...");
			let text = theme.fg("toolTitle", theme.bold("x_search ")) + theme.fg("dim", `${kind}${query.length > 70 ? `${query.slice(0, 70)}...` : query}`);
			const filters = [
				...stringList(args.handles).map((h) => `@${handle(h)}`),
				...stringList(args.exclude_handles).map((h) => `-@${handle(h)}`),
				args.from_date && `from ${args.from_date}`,
				args.to_date && `to ${args.to_date}`,
				args.sort === "top" && "top",
			].filter(Boolean);
			if (filters.length) text += theme.fg("muted", ` · ${filters.join(" ")}`);
			return new Text(text, 0, 0);
		},

		renderResult(result: any, { expanded }: { expanded: boolean }) {
			const details = result.details as XSearchDetails | undefined;
			const sections = details?.resultSections;
			if (!details || !sections?.length) {
				const text = result.content?.[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}
			return boxRendererWindowed(
				() => sections,
				{ collapsed: { maxSections: 3, excerpts: COLLAPSED_EXCERPTS }, expanded: {} },
				trailer(details),
				expanded,
			);
		},
	};
}

/** the tool as registered; null when disabled in ext-config or when there is no Grok CLI login to use. */
export function createConfiguredXSearchTool(): ToolDefinition<any> | null {
	const { enabled, config } = getEnabledExtensionConfig("x-search", X_CONFIG_DEFAULTS, { schema: X_CONFIG_SCHEMA });
	if (!enabled || !hasGrokLogin()) return null;
	return withPromptPatch(createXSearchTool(config));
}
