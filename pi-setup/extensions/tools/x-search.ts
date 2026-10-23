/**
 * x_search — X posts, users and threads through Grok's own X tools, on the
 * user's Grok CLI login (lib/x/grok-login.ts, lib/x/grok-proxy.ts). Grok runs
 * exactly one X tool and lists the post ids; the server's citations say which
 * ids the tool really returned, and the posts themselves load straight from
 * FxTwitter or X's embed endpoint (lib/x/hydrate.ts). Grok never retypes a
 * post: on grok-4.6 its copy ran ~94 tokens/s, so two long posts took 90s.
 *
 * Grok copies the result itself (checked against the citations) only for
 * account searches, and when no post source can load the posts.
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
import { hydratePosts, POST_SOURCES, type HydrateOptions, type PostSource } from "./lib/x/hydrate";
import { allPostIds, parsePosts, parseUsers, type XPost, type XUser } from "./lib/x/parse";

export type XSearchExtConfig = {
	model: string;
	effort: string;
	baseUrl: string;
	/** sent when neither an installed Grok CLI nor a 426 has named a newer version. */
	clientVersion: string;
	timeoutSecs: number;
	/** where posts load from, in order; empty makes Grok copy every result (slow on long posts). */
	postSources: PostSource[];
};

export const X_CONFIG_DEFAULTS: XSearchExtConfig = {
	model: "grok-4.6",
	effort: "low",
	baseUrl: GROK_PROXY_URL,
	clientVersion: "1.0.67",
	timeoutSecs: 90,
	postSources: [...POST_SOURCES],
};

const LOAD_TIMEOUT_MS = 20_000;
const COPY_CONTENT_CHARS = 1500;
const SOURCE_NAMES: Record<PostSource, string> = { fxtwitter: "FxTwitter", syndication: "X's embed endpoint" };

function isXSearchConfig(v: Record<string, unknown>): v is XSearchExtConfig {
	return (
		typeof v.model === "string" && v.model.length > 0 &&
		typeof v.effort === "string" && v.effort.length > 0 &&
		typeof v.baseUrl === "string" && /^https?:\/\//.test(v.baseUrl) &&
		typeof v.clientVersion === "string" && /^\d+(\.\d+){1,3}$/.test(v.clientVersion) &&
		typeof v.timeoutSecs === "number" && Number.isInteger(v.timeoutSecs) && v.timeoutSecs >= 5 &&
		Array.isArray(v.postSources) && v.postSources.every((s) => (POST_SOURCES as readonly unknown[]).includes(s))
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
	/** ids: Grok listed ids and the posts were loaded; copy: Grok copied the result. */
	via: "ids" | "copy";
	loadedFrom?: Partial<Record<PostSource, number>>;
	missingReason?: string;
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
		'Copy every "- Content:" value character for character: never summarise, translate or correct it.',
		`If a "- Content:" value is longer than ${COPY_CONTENT_CHARS} characters, copy its first ${COPY_CONTENT_CHARS} characters and end it with " […]".`,
		`No preamble, no commentary, no code fences. If the tool returned nothing, output exactly: ${NO_RESULTS}`,
	].join("\n");
}

export function idsInstructions(req: XRequest): string {
	const which = req.kind === "thread"
		? "the ID of every post in the result: the requested post, its parent when shown, and every reply"
		: "the ID of every post the tool returned, in the order it returned them";
	return [
		"You are a retrieval relay, not an assistant.",
		`Make exactly one call: ${req.tool} with the arguments ${JSON.stringify(req.args)}. Call no other tool and do not change the arguments.`,
		`Then output ${which}, one per line, digits only. Leave out the IDs of quoted posts.`,
		`No other words, no code fences. If the tool returned nothing, output exactly: ${NO_RESULTS}`,
	].join("\n");
}

const listedIds = (text: string) => [...new Set(text.match(/\b\d{5,20}\b/g) ?? [])];

/**
 * A thread is every loaded post linked by replies to a post known to be in
 * it (the one asked for, or one X cited): a listed id that links to none of
 * them is not part of the thread, whatever Grok wrote.
 */
export function buildThread(requested: string, anchors: Set<string>, loaded: Map<string, XPost>): { roots: XPost[]; unlinked: string[] } {
	const keep = new Set([...anchors].filter((id) => loaded.has(id)));
	for (let grew = true; grew; ) {
		grew = false;
		for (const [id, post] of loaded) {
			if (keep.has(id)) continue;
			const linked = (post.replyTo && keep.has(post.replyTo)) || [...keep].some((k) => loaded.get(k)?.replyTo === id);
			if (linked) {
				keep.add(id);
				grew = true;
			}
		}
	}
	const ancestors = new Set<string>();
	for (let at = loaded.get(requested)?.replyTo; at && keep.has(at) && !ancestors.has(at); at = loaded.get(at)?.replyTo) ancestors.add(at);

	const ordered = [...keep].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
	const nodes = new Map(ordered.map((id) => [id, { ...loaded.get(id)!, replies: [] as XPost[] }]));
	const roots: XPost[] = [];
	for (const id of ordered) {
		const node = nodes.get(id)!;
		if (id === requested) node.role = "requested";
		else if (ancestors.has(id)) node.role = "parent";
		const parent = node.replyTo ? nodes.get(node.replyTo) : undefined;
		if (parent) {
			node.role ??= "reply";
			parent.replies.push(node);
		} else roots.push(node);
	}
	return { roots, unlinked: [...loaded.keys()].filter((id) => !keep.has(id)) };
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
	const walk = (p: XPost, prefix: string): BoxSection[] => [section(p, prefix), ...p.replies.flatMap((r) => walk(r, "↳ "))];
	return posts.flatMap((p) => walk(p, ""));
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
	const replies = posts.filter((p) => p.replyTo || (p.conversationId && p.conversationId !== p.id)).length;
	const counts = ([["likes", "likes"], ["views", "views"], ["reposts", "reposts"], ["replies", "replies received"]] as const)
		.filter(([key]) => posts.some((p) => p.engagement[key] !== undefined))
		.map(([key, label]) => `${posts.reduce((n, p) => n + (p.engagement[key] ?? 0), 0).toLocaleString("en-US")} ${label}`);
	return `these ${posts.length} posts (${posts.length - replies} original, ${replies} replies): ${counts.join(", ")}`;
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
	const from = Object.entries(details.loadedFrom ?? {}).map(([s, n]) => `${SOURCE_NAMES[s as PostSource]} (${n})`);
	const source = from.length ? ` · posts loaded from ${from.join(", ")}` : "";
	const lines = [`ran ${ran} · ${details.model} · ${(details.ms / 1000).toFixed(1)}s${source}`];
	const totals = totalsLine(details.posts ?? []);
	if (totals) lines.push(totals);
	const next = nextPageLine(details, details.query);
	if (next) lines.push(next);
	const links = (ids: string[]) => ids.slice(0, 10).map((id) => `https://x.com/i/status/${id}`).join(" ");
	if (details.dropped.length && details.via === "ids") {
		const why = details.kind === "thread" ? "are not part of this thread" : "X's results do not include";
		lines.push(`ignored ${details.dropped.length} id(s) Grok listed that ${why}: ${details.dropped.join(", ")}`);
	} else if (details.dropped.length) {
		lines.push(`dropped ${details.dropped.length} post(s) X did not return — Grok mis-copied them: ${details.dropped.join(", ")}`);
	}
	if (details.missing.length && details.via === "ids") {
		lines.push(`could not load ${details.missing.length} post(s) (${details.missingReason ?? "unknown reason"}): ${links(details.missing)}`);
	} else if (details.missing.length) {
		lines.push(`Grok's copy left out ${details.missing.length} of the ${details.fetched} posts X returned: ${links(details.missing)}`);
	}
	return [...lines, ...details.notes];
}

function errorResult(text: string) {
	return { content: [{ type: "text" as const, text }], isError: true } as any;
}

export interface XSearchDeps {
	tokens?: TokenSource[];
	version?: ClientVersion;
	posts?: Pick<HydrateOptions, "fxtwitterUrl" | "syndicationUrl">;
}

function newDetails(req: XRequest, res: ProxyResult, query: string, via: XSearchDetails["via"]): XSearchDetails {
	const sourceIds = req.kind === "users" ? res.sourceUserIds : res.sourcePostIds;
	return {
		cost: 0,
		kind: req.kind,
		query,
		limit: Number(req.args.limit ?? req.args.count ?? MAX_LIMIT),
		executed: res.calls,
		fetched: sourceIds.size,
		dropped: [],
		missing: [],
		notes: [...req.notes, ...(res.incomplete ? [`Grok's answer was cut short (${res.incomplete}); posts may be missing`] : [])],
		usage: res.usage,
		model: res.model,
		tokenSource: res.tokenSource,
		clientVersion: res.clientVersion,
		ms: 0,
		via,
	};
}

function postsBody(posts: XPost[], details: XSearchDetails): string {
	details.posts = posts;
	details.resultSections = postSections(posts);
	return posts.length ? formatPosts(posts) : "";
}

/**
 * The posts Grok listed, loaded from the post sources. The ids that count are
 * the ones X cited (Grok's list only orders them); for a thread, the ones
 * linked by replies to the requested post. Undefined when no source could
 * load any of them, so the caller can have Grok copy the result instead.
 */
async function loadedBody(req: XRequest, res: ProxyResult, details: XSearchDetails, opts: HydrateOptions): Promise<string | undefined> {
	const listed = listedIds(res.text);
	const cited = res.sourcePostIds;
	const fetched = res.usage.postsFetched;
	const requested = req.kind === "thread" ? String(req.args.post_id) : "";
	let wanted: string[];
	if (req.kind === "thread") wanted = [...new Set([requested, ...cited, ...listed])];
	else if (cited.size) {
		wanted = [...new Set([...listed.filter((id) => cited.has(id)), ...cited])];
		details.dropped = listed.filter((id) => !cited.has(id));
	} else if (fetched === 0) {
		details.dropped = listed;
		wanted = [];
	} else {
		wanted = listed.slice(0, fetched ?? details.limit);
		if (wanted.length) details.notes.push("X sent no source list, so these are the posts Grok listed, not checked against the search");
	}
	if (!wanted.length) return "";

	const got = await hydratePosts(wanted, opts);
	if (!got.posts.size) {
		details.missingReason = [...got.failed.values()][0];
		return undefined;
	}
	const from: Partial<Record<PostSource, number>> = {};
	for (const source of got.from.values()) from[source] = (from[source] ?? 0) + 1;
	details.loadedFrom = from;
	details.missing = [...got.failed.keys()];
	details.missingReason = [...got.failed.values()][0];

	if (req.kind !== "thread") return postsBody(wanted.flatMap((id) => got.posts.get(id) ?? []), details);
	const thread = buildThread(requested, new Set([requested, ...cited]), got.posts);
	details.dropped = thread.unlinked;
	return postsBody(thread.roots, details);
}

/** Grok's own copy of the result, every post or account checked against the ids X cited. */
function copiedBody(req: XRequest, res: ProxyResult, details: XSearchDetails): string {
	const users = req.kind === "users";
	const sourceIds = users ? res.sourceUserIds : res.sourcePostIds;
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
		body = postsBody(found, details);
	}

	if (body && !sourceIds.size) {
		details.notes.push("Grok sent no source list, so these results could not be checked against what X returned");
	}
	if (body) return body;
	if (details.dropped.length) return "(none of what Grok copied matches what X returned, so none of it is shown)";
	if (details.missing.length) return "(Grok returned none of the posts X found; links below)";
	if (!raw || raw === NO_RESULTS) return "";
	details.notes.push("Grok's output did not match the X result format; shown as Grok returned it");
	return raw;
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
			const query = String((params as Record<string, unknown>).query ?? "");
			const ask = async (instructions: string): Promise<ProxyResult | undefined> => {
				const once = () =>
					callGrokProxy(
						{
							model: config.model,
							effort: config.effort,
							input: `${instructions}\n\n${req.tool} ${JSON.stringify(req.args)}`,
							tool: req.toolConfig,
							timeoutMs: config.timeoutSecs * 1000,
							signal,
						},
						{ baseUrl: config.baseUrl, tokens, version: version! },
					);
				const first = await once();
				if (first.calls.length) return first;
				const second = await once();
				return second.calls.length ? second : undefined;
			};
			const noToolCall = () =>
				errorResult(
					"x_search failed: twice, Grok answered without running an X tool, so nothing it wrote came from X and none of it is shown. " +
						"Try again, or set a different model under \"x-search\" in ext-config.json.",
				);

			let details: XSearchDetails;
			let body: string | undefined;
			try {
				let unloaded: string | undefined;
				if (req.kind !== "users" && config.postSources.length) {
					const res = await ask(idsInstructions(req));
					if (!res) return noToolCall();
					details = newDetails(req, res, query, "ids");
					body = await loadedBody(req, res, details, {
						sources: config.postSources,
						timeoutMs: LOAD_TIMEOUT_MS,
						signal,
						...deps.posts,
					});
					if (body === undefined) unloaded = details.missingReason ?? "no reason given";
				}
				if (body === undefined) {
					const res = await ask(relayInstructions(req));
					if (!res) return noToolCall();
					details = newDetails(req, res, query, "copy");
					if (unloaded) details.notes.push(`no post source could load these posts (${unloaded}), so Grok copied them; posts over ${COPY_CONTENT_CHARS} characters end in […]`);
					body = copiedBody(req, res, details);
				}
			} catch (err) {
				const message = err instanceof ProviderError ? err.message : String((err as Error)?.message ?? err);
				const status = err instanceof ProviderError && err.status ? ` (HTTP ${err.status})` : "";
				return errorResult(`x_search failed${status}: ${message}`);
			}

			details!.ms = Date.now() - started;
			if (!body) {
				if (details!.missing.length) body = "(none of the posts X returned could be loaded; links below)";
				else body = req.kind === "users" ? "(no accounts found)" : "(no posts found)";
			}
			return { content: [{ type: "text" as const, text: `${body}\n\n${trailer(details!).map((l) => `[${l}]`).join("\n")}` }], details: details! };
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
