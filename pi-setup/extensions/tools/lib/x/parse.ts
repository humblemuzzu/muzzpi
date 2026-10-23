/**
 * Parser for the text Grok's X tools return. It is not JSON: each post is a
 * card of `- Key: value` lines, nested cards (a quoted post, the replies of a
 * fetched thread) are indented two spaces, and Bio/Content values run on over
 * following lines. Observed layouts:
 *
 *   search:   "Main Post:" cards separated by "---"
 *   thread:   "Main Post (Requested Post):" with its replies nested under it, or
 *             the parent as "Main Post:" with the fetched reply nested after a
 *             "(Requested Post):" marker at the end of the parent's Content
 *   users:    "[X User Result N]:" cards with Name / Followers / Verified
 */

export interface XMedia {
	type: string;
	url: string;
	durationMs?: number;
}

export interface XEngagement {
	likes?: number;
	reposts?: number;
	quotes?: number;
	replies?: number;
	bookmarks?: number;
	views?: number;
}

export interface XPost {
	id: string;
	url: string;
	username?: string;
	name?: string;
	conversationId?: string;
	/** the post this one replies to, when the source names it. */
	replyTo?: string;
	createdAt?: string;
	engagement: XEngagement;
	media: XMedia[];
	text: string;
	bio?: string;
	quoted?: XPost;
	/** for a thread: the post that was asked for, and how every other post relates to it. */
	role?: "requested" | "parent" | "reply";
	replies: XPost[];
}

export interface XUser {
	id: string;
	username?: string;
	name?: string;
	url: string;
	bio?: string;
	followers?: number;
	verified?: string;
}

type Relation = "quoted" | "reply" | "requested";

interface Card {
	fields: Map<string, string>;
	media: XMedia[];
	children: { relation: Relation; card: Card }[];
	requested: boolean;
	indent: number;
}

const KEYS = "ID|Conversation ID|Author|Name|Avatar|Bio|Timestamp|Engagement|Media|Quoted Post|Content|Followers|Verified";
const FIELD = new RegExp(`^( *)- (?:\\[post:\\d+\\] )?(${KEYS}):(?: (.*))?$`);
const MEDIA_ITEM = /^( *)- Item \d+: (\w+) - URL: (\S+)(?: \(duration: (\d+) ms\))?/;
const SEPARATOR = /^-{3,}\s*$/;
const TOP_ID = /^- (?:\[post:\d+\] )?ID: /;
const POST_HEADER = /^Main Post( \(Requested Post\))?:\s*$/;
const USER_HEADER = /^\[X User Result \d+\]:\s*$/;
const CITATION_LINE = /^\[post:\d+\]\s*$/;
const REQUESTED_MARKER = /\s*\(Requested Post\):\s*$/;
const AUTHOR = /^(.*?)\s+-\s+@([A-Za-z0-9_]{1,15})\s*$/;
const TWITTER_EPOCH = 1288834974657n;
const MONTHS: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

const newCard = (indent: number, requested = false): Card => ({
	fields: new Map(),
	media: [],
	children: [],
	requested,
	indent,
});

/** cards nest by indentation: depth 0 at column 0, depth 1 at two spaces, depth 2 at four. */
function parseCards(raw: string): Card[] {
	const cards: Card[] = [];
	let stack: Card[] = [];
	let pending: Relation | undefined;
	let last: { card: Card; key: string } | undefined;

	const openTop = (requested = false) => {
		const card = newCard(0, requested);
		cards.push(card);
		stack = [card];
		pending = undefined;
		last = undefined;
		return card;
	};
	const append = (card: Card, key: string, value: string) => {
		let v = value;
		if (REQUESTED_MARKER.test(v)) {
			v = v.replace(REQUESTED_MARKER, "");
			pending = "requested";
		}
		const prev = card.fields.get(key);
		card.fields.set(key, prev === undefined ? v : `${prev}\n${v}`);
	};

	const lines = raw.replace(/\r\n?/g, "\n").split("\n");
	/** a `---` inside a post's text is text: it separates cards only when a card starts after it. */
	const cardFollows = (from: number) => {
		const next = lines.slice(from).find((l) => l.trim());
		return next === undefined || POST_HEADER.test(next) || USER_HEADER.test(next) || CITATION_LINE.test(next) || TOP_ID.test(next);
	};

	for (const [i, line] of lines.entries()) {
		if (SEPARATOR.test(line) && cardFollows(i + 1)) {
			stack = [];
			pending = last = undefined;
			continue;
		}
		const header = line.match(POST_HEADER);
		if (header) {
			openTop(Boolean(header[1]));
			continue;
		}
		if (USER_HEADER.test(line)) {
			openTop();
			continue;
		}
		if (CITATION_LINE.test(line)) continue;

		const item = line.match(MEDIA_ITEM);
		if (item) {
			const depth = Math.min(Math.floor(item[1].length / 2), stack.length - 1);
			stack[depth]?.media.push({ type: item[2], url: item[3], ...(item[4] && { durationMs: Number(item[4]) }) });
			continue;
		}

		const field = line.match(FIELD);
		if (field) {
			const [, spaces, key, value = ""] = field;
			const depth = Math.floor(spaces.length / 2);
			let card: Card;
			if (key === "ID" && depth > 0 && stack.length > 0) {
				stack = stack.slice(0, Math.min(depth, stack.length));
				card = newCard(spaces.length);
				stack[stack.length - 1].children.push({ relation: pending ?? "reply", card });
				stack.push(card);
				pending = undefined;
			} else if (key === "ID" && (stack.length === 0 || stack[0].fields.has("ID"))) {
				card = openTop();
			} else {
				if (stack.length === 0) openTop();
				stack = stack.slice(0, Math.min(depth, stack.length - 1) + 1);
				card = stack[stack.length - 1];
			}
			if (key === "Quoted Post") pending = value.trim() ? undefined : "quoted";
			else {
				if (key !== "ID") pending = undefined;
				append(card, key, value);
			}
			last = { card, key };
			continue;
		}

		if (last) append(last.card, last.key, line.startsWith(" ".repeat(last.card.indent)) ? line.slice(last.card.indent) : line.trimStart());
	}
	return cards.filter((c) => c.fields.has("ID"));
}

function toInt(raw: string | undefined): number | undefined {
	if (!raw) return undefined;
	const n = Number(raw.replace(/,/g, ""));
	return Number.isFinite(n) ? n : undefined;
}

export function snowflakeTime(id: string): string | undefined {
	if (!/^\d{15,20}$/.test(id)) return undefined;
	return new Date(Number((BigInt(id) >> 22n) + TWITTER_EPOCH)).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function parseTimestamp(raw: string | undefined): string | undefined {
	const m = raw?.trim().match(/^\w{3},?\s+(\d{1,2})\s+(\w{3})\s+(\d{4})\s+(\d{2}):(\d{2}):(\d{2})\s+GMT$/);
	if (!m || MONTHS[m[2]] === undefined) return undefined;
	return new Date(Date.UTC(+m[3], MONTHS[m[2]], +m[1], +m[4], +m[5], +m[6])).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function parseEngagement(raw: string | undefined): XEngagement {
	const out: XEngagement = {};
	for (const [, key, value] of (raw ?? "").matchAll(/(\w+)=(\d[\d,]*|N\/A)/g)) {
		const k = key.toLowerCase() as keyof XEngagement;
		if (["likes", "reposts", "quotes", "replies", "bookmarks", "views"].includes(k)) out[k] = toInt(value);
	}
	return out;
}

function parseAuthor(raw: string | undefined): { name?: string; username?: string } {
	const value = raw?.trim();
	if (!value) return {};
	const m = value.match(AUTHOR);
	return m ? { name: m[1].trim(), username: m[2] } : { name: value };
}

const tidy = (text: string | undefined) => (text ?? "").replace(/[ \t]+$/gm, "").replace(/^\n+|\n+$/g, "");

function toPost(card: Card, role?: XPost["role"]): XPost {
	const f = card.fields;
	const id = f.get("ID")!.trim();
	const { name, username } = parseAuthor(f.get("Author"));
	const quotedChild = card.children.find((c) => c.relation === "quoted");
	const bio = tidy(f.get("Bio"));
	return {
		id,
		url: `https://x.com/${username ?? "i"}/status/${id}`,
		username,
		name,
		conversationId: f.get("Conversation ID")?.trim() || undefined,
		createdAt: parseTimestamp(f.get("Timestamp")) ?? snowflakeTime(id),
		engagement: parseEngagement(f.get("Engagement")),
		media: card.media,
		text: tidy(f.get("Content")),
		...(bio && { bio }),
		...(quotedChild && { quoted: toPost(quotedChild.card) }),
		...(role && { role }),
		replies: card.children
			.filter((c) => c.relation !== "quoted")
			.map((c) => toPost(c.card, c.relation === "requested" ? "requested" : "reply")),
	};
}

export function parsePosts(raw: string): XPost[] {
	return parseCards(raw)
		.filter((c) => !c.fields.has("Name"))
		.map((card) => {
			const asked = card.children.some((c) => c.relation === "requested");
			return toPost(card, card.requested ? "requested" : asked ? "parent" : undefined);
		});
}

export function parseUsers(raw: string): XUser[] {
	return parseCards(raw)
		.filter((c) => c.fields.has("Name"))
		.map((card) => {
			const f = card.fields;
			const id = f.get("ID")!.trim();
			const { name, username } = parseAuthor(f.get("Name"));
			const bio = tidy(f.get("Bio"));
			return {
				id,
				username,
				name,
				url: username ? `https://x.com/${username}` : `https://x.com/i/user/${id}`,
				...(bio && { bio }),
				followers: toInt(f.get("Followers")),
				verified: f.get("Verified")?.trim() || undefined,
			};
		});
}

/** every post id in a parse, quoted posts and thread replies included. */
export function allPostIds(posts: XPost[]): Set<string> {
	const ids = new Set<string>();
	const walk = (p: XPost) => {
		ids.add(p.id);
		if (p.quoted) walk(p.quoted);
		p.replies.forEach(walk);
	};
	posts.forEach(walk);
	return ids;
}
