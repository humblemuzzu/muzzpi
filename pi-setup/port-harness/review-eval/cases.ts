/**
 * review_code eval cases. Each is a small repo: one commit, then the change under
 * review on top. Every planted problem is listed with what a good review does
 * with it, so a run is scored on recall and on noise at once.
 */

export interface Issue {
	id: string;
	describe: string;
}

export interface ReviewCase {
	id: string;
	scope: string;
	fixture: { files: Record<string, string>; change: Record<string, string | null> };
	/** must be reported as a finding the author has to fix */
	bugs: Issue[];
	/** may be mentioned, but never as a finding the author has to fix */
	notBlocking: Issue[];
	/** must not be reported at all */
	silent?: Issue[];
	/** every listed name must appear in the findings about that bug */
	instances?: { bug: string; names: string[] };
	/** applied after round one, then reviewed again */
	round2?: { scope: string; change: Record<string, string | null>; bugs: Issue[]; fixed: Issue[] };
}

const PKG = JSON.stringify({ name: "fixture", version: "1.0.0", type: "module", private: true, scripts: { test: "bun test" } }, null, 2) + "\n";

const catalogTs = `export interface Product {
	id: number;
	name: string;
	priceCents: number;
}

const PRODUCTS: Product[] = Array.from({ length: 45 }, (_, i) => ({
	id: i + 1,
	name: \`Product \${i + 1}\`,
	priceCents: 500 + i * 25,
}));

export function listProducts(): Product[] {
	return PRODUCTS;
}
`;

const formatTs = `export function formatPrice(cents: number): string {
	return \`$\${(cents / 100).toFixed(2)}\`;
}
`;

const paginateTs = `export const DEFAULT_PAGE_SIZE = 20;

export function pageCount(total: number, size = DEFAULT_PAGE_SIZE): number {
	return Math.floor(total / size);
}

export function page<T>(items: T[], n: number, size = DEFAULT_PAGE_SIZE): T[] {
	const start = (n - 1) * size;
	return items.slice(start, start + size);
}
`;

const paginateTestTs = `import { expect, test } from "bun:test";
import { page, pageCount } from "./paginate";

test("pageCount counts full pages", () => {
	expect(pageCount(40, 20)).toBe(2);
	expect(pageCount(0, 20)).toBe(0);
});

test("page slices one page", () => {
	const items = Array.from({ length: 40 }, (_, i) => i);
	expect(page(items, 1)).toEqual(items.slice(0, 20));
	expect(page(items, 2)).toEqual(items.slice(20, 40));
});
`;

const apiTs = `import { listProducts } from "./catalog";
import { page, pageCount } from "./paginate";

function formatPrice(cents: number): string {
	return \`$\${(cents / 100).toFixed(2)}\`;
}

export function getProductsPage(requested: number) {
	const n = Math.max(1, Math.floor(requested));
	const all = listProducts();
	const x = page(all, n);
	const pages = pageCount(all.length);
	return {
		items: x.map((p) => ({ id: p.id, name: p.name, price: formatPrice(p.priceCents) })),
		page: n,
		pages,
		hasNext: n < pages,
	};
}
`;

const moneyTs = `export function formatCents(cents: number, currency = "USD"): string {
	return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}
`;

const moneyTestTs = `import { expect, test } from "bun:test";
import { formatCents } from "./money";

test("formats cents as dollars", () => {
	expect(formatCents(1999)).toBe("$19.99");
	expect(formatCents(5)).toBe("$0.05");
});
`;

const moneyChangedTs = `export function formatCents(cents: number, currency = "USD"): string {
	return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}

/** "12", "$12.5" or " 0.05 " to cents; anything else, including negatives and thousands separators, is null. */
export function parseCents(input: string): number | null {
	const match = /^\\s*\\$?(\\d{1,9})(?:\\.(\\d{1,2}))?\\s*$/.exec(input);
	if (match == null) return null;
	const dollars = Number(match[1]);
	const fraction = Number((match[2] ?? "").padEnd(2, "0"));
	return dollars * 100 + fraction;
}
`;

const moneyChangedTestTs = `import { expect, test } from "bun:test";
import { formatCents, parseCents } from "./money";

test("formats cents as dollars", () => {
	expect(formatCents(1999)).toBe("$19.99");
	expect(formatCents(5)).toBe("$0.05");
});

test("parses dollar amounts to cents", () => {
	expect(parseCents("12")).toBe(1200);
	expect(parseCents("$12.5")).toBe(1250);
	expect(parseCents(" 0.05 ")).toBe(5);
	expect(parseCents("999999999.99")).toBe(99999999999);
});

test("rejects what it does not understand", () => {
	for (const bad of ["", "$", ".5", "12.", "12.345", "-5", "1,000", "abc", "1e3"]) {
		expect(parseCents(bad)).toBeNull();
	}
});

test("round-trips through formatCents", () => {
	expect(formatCents(parseCents("$12.50")!)).toBe("$12.50");
});
`;

const usersTs = `export interface User {
	id: number;
	name: string;
	active: boolean;
}

const users: User[] = [
	{ id: 1, name: "Ada", active: true },
	{ id: 2, name: "Grace", active: false },
	{ id: 3, name: "Linus", active: true },
];

export function findUser(id: number): User | undefined {
	return users.find((u) => (u.id = id));
}

export function activeUsers(): User[] {
	return users.filter((u) => u.active);
}
`;

const usersChangedTs = `export interface User {
	id: number;
	name: string;
	active: boolean;
}

const users: User[] = [
	{ id: 1, name: "Ada", active: true },
	{ id: 2, name: "Grace", active: false },
	{ id: 3, name: "Linus", active: true },
];

export function findUser(id: number): User | undefined {
	return users.find((u) => (u.id = id));
}

export function activeUsers(): User[] {
	return users.filter((u) => u.active);
}

/** renames the user with this id; false when there is none or the name is blank. */
export function renameUser(id: number, name: string): boolean {
	const trimmed = name.trim();
	if (trimmed === "") return false;
	const index = users.findIndex((u) => u.id === id);
	if (index === -1) return false;
	users[index] = { ...users[index]!, name: trimmed };
	return true;
}

export function countActive(): number {
	return activeUsers().length;
}
`;

const usersTestTs = `import { expect, test } from "bun:test";
import { activeUsers, countActive, renameUser } from "./users";

test("renameUser renames by id and trims", () => {
	expect(renameUser(3, "  Linus T ")).toBe(true);
	expect(activeUsers().find((u) => u.id === 3)?.name).toBe("Linus T");
});

test("renameUser refuses a blank name or an unknown id", () => {
	expect(renameUser(1, "   ")).toBe(false);
	expect(renameUser(99, "Nobody")).toBe(false);
});

test("countActive counts active users", () => {
	expect(countActive()).toBe(2);
});
`;

const dbTs = `export interface Db {
	/** runs one statement; $1, $2 … in sql are bound to params, never spliced into the text */
	query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;
}
`;

const routesTs = `import type { Db } from "./db";

export async function userById(db: Db, id: number) {
	const rows = await db.query("SELECT id, name FROM users WHERE id = $1", [id]);
	return rows[0] ?? null;
}
`;

const routesChangedTs = `import type { Db } from "./db";

export async function userById(db: Db, id: number) {
	const rows = await db.query("SELECT id, name FROM users WHERE id = $1", [id]);
	return rows[0] ?? null;
}

/** the name comes straight from the search box */
export async function searchUsers(db: Db, name: string) {
	return db.query(\`SELECT id, name FROM users WHERE name ILIKE '%\${name}%' ORDER BY name LIMIT 50\`);
}

/** status comes from the ?status= query parameter */
export async function ordersByStatus(db: Db, status: string) {
	return db.query(\`SELECT id, total_cents FROM orders WHERE status = '\${status}'\`);
}

/** tag comes from the URL path /tags/:tag */
export async function productsByTag(db: Db, tag: string) {
	return db.query(\`SELECT p.id, p.name FROM products p JOIN product_tags t ON t.product_id = p.id WHERE t.tag = '\${tag}'\`);
}
`;

const reviewMd = `# Review instructions

## What Important means here

Money amounts are integer cents everywhere in this repo. Any arithmetic on an amount that can produce a fraction of a cent is Important.

## Do not report

- Anything under \`src/generated/\`: \`bun run gen\` writes it and overwrites any edit.
`;

const cartTs = `export interface Line {
	priceCents: number;
	qty: number;
}

export function totalCents(lines: Line[]): number {
	return lines.reduce((sum, line) => sum + line.priceCents * line.qty, 0);
}
`;

const cartChangedTs = `export interface Line {
	priceCents: number;
	qty: number;
}

export function totalCents(lines: Line[]): number {
	return lines.reduce((sum, line) => sum + line.priceCents * line.qty, 0);
}

/** the price after a percentage discount, e.g. 15 for 15% off */
export function applyDiscount(cents: number, percent: number): number {
	return cents * (1 - percent / 100);
}
`;

const generatedClientTs = `// generated by bun run gen — do not edit
export async function get(url: any): Promise<any> {
	const res = await fetch(url);
	return res.json();
}

export async function post(url: any, body: any): Promise<any> {
	const res = await fetch(url, { method: "POST", body: JSON.stringify(body) });
	return res.json();
}
`;

const sleepTs = `export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
`;

const configTs = `export const config = {
	timeoutMs: parseInt(process.env.TIMEOUT_MS || "5000"),
	retries: Number(process.env.RETRIES) || 3,
	endpoint: process.env.ENDPOINT || "http://localhost:8080",
};
`;

const retryV1 = `import { sleep } from "./sleep";

/** calls fn until it succeeds, at most \`attempts\` times, doubling the delay between tries */
export async function retry<T>(fn: () => Promise<T>, attempts = 3, delayMs = 100): Promise<T> {
	let last: unknown;
	for (let i = 0; i <= attempts; i++) {
		try {
			return await fn();
		} catch (error) {
			last = error;
			await sleep(delayMs * 2 ** i);
		}
	}
	throw last;
}
`;

const retryTestV1 = `import { expect, test } from "bun:test";
import { retry } from "./retry";

test("returns the first success", async () => {
	let calls = 0;
	const value = await retry(async () => {
		calls++;
		if (calls < 2) throw new Error("flaky");
		return "ok";
	}, 3, 1);
	expect(value).toBe("ok");
	expect(calls).toBe(2);
});
`;

const retryV2 = `import { sleep } from "./sleep";

/**
 * calls fn until it succeeds, at most \`attempts\` times, doubling the delay between tries.
 * shouldRetry decides whether an error is worth another try; by default every error is.
 */
export async function retry<T>(
	fn: () => Promise<T>,
	attempts = 3,
	delayMs = 100,
	shouldRetry: (error: unknown) => boolean = () => true,
): Promise<T> {
	let last: unknown;
	for (let i = 0; i < attempts; i++) {
		try {
			return await fn();
		} catch (error) {
			last = error;
			if (shouldRetry(error)) throw error;
			if (i < attempts - 1) await sleep(delayMs * 2 ** i);
		}
	}
	throw last;
}
`;

export const CASES: ReviewCase[] = [
	{
		id: "planted-bug-with-bait",
		scope: "the uncommitted changes in the working tree (git diff HEAD plus untracked files)",
		fixture: {
			files: { "package.json": PKG, "src/catalog.ts": catalogTs, "src/format.ts": formatTs },
			change: { "src/paginate.ts": paginateTs, "src/paginate.test.ts": paginateTestTs, "src/api.ts": apiTs },
		},
		bugs: [
			{
				id: "page-count",
				describe:
					"pageCount uses Math.floor(total / size), so a partial last page is not counted: 45 products at 20 per page give 2 pages, hasNext is false on page 2, and the last 5 products can never be reached (should round up)",
			},
		],
		notBlocking: [
			{ id: "dup-format", describe: "api.ts defines its own formatPrice although src/format.ts already exports the same function" },
			{ id: "naming", describe: "the variable named x in getProductsPage is poorly named" },
			{ id: "no-api-test", describe: "getProductsPage has no test" },
		],
	},
	{
		id: "clean-change",
		scope: "the uncommitted changes in the working tree (git diff HEAD)",
		fixture: {
			files: { "package.json": PKG, "src/money.ts": moneyTs, "src/money.test.ts": moneyTestTs },
			change: { "src/money.ts": moneyChangedTs, "src/money.test.ts": moneyChangedTestTs },
		},
		bugs: [],
		notBlocking: [
			{ id: "loose-null", describe: "parseCents uses == null instead of === null" },
			{ id: "no-negatives", describe: "parseCents rejects negative amounts or thousands separators" },
			{ id: "currency", describe: "parseCents only understands dollars / ignores other currencies" },
		],
	},
	{
		id: "preexisting-nearby",
		scope: "the uncommitted changes in the working tree (git diff HEAD plus untracked files)",
		fixture: {
			files: { "package.json": PKG, "src/users.ts": usersTs },
			change: { "src/users.ts": usersChangedTs, "src/users.test.ts": usersTestTs },
		},
		bugs: [],
		notBlocking: [
			{
				id: "find-assign",
				describe:
					"findUser uses (u.id = id), an assignment instead of a comparison, so it overwrites the first user's id and always returns the first user (this code was there before the change)",
			},
		],
	},
	{
		id: "bug-class",
		scope: "the uncommitted changes in the working tree (git diff HEAD)",
		fixture: {
			files: { "package.json": PKG, "src/db.ts": dbTs, "src/routes.ts": routesTs },
			change: { "src/routes.ts": routesChangedTs },
		},
		bugs: [
			{
				id: "sql-injection",
				describe:
					"searchUsers, ordersByStatus and productsByTag splice user input into SQL text with template strings instead of binding $1 parameters: SQL injection",
			},
		],
		notBlocking: [],
		instances: { bug: "sql-injection", names: ["searchUsers", "ordersByStatus", "productsByTag"] },
	},
	{
		id: "review-md-rules",
		scope: "the uncommitted changes in the working tree (git diff HEAD plus untracked files)",
		fixture: {
			files: { "package.json": PKG, "REVIEW.md": reviewMd, "src/cart.ts": cartTs },
			change: { "src/cart.ts": cartChangedTs, "src/generated/client.ts": generatedClientTs },
		},
		bugs: [
			{
				id: "fractional-cents",
				describe: "applyDiscount returns cents * (1 - percent / 100), which produces fractions of a cent (999 at 15% is 849.15) although amounts must be integer cents",
			},
		],
		notBlocking: [],
		silent: [{ id: "generated", describe: "anything in src/generated/client.ts (any types, no res.ok check, no error handling)" }],
	},
	{
		id: "rereview",
		scope: "the uncommitted changes in the working tree (git diff HEAD plus untracked files)",
		fixture: {
			files: { "package.json": PKG, "src/sleep.ts": sleepTs, "src/config.ts": configTs },
			change: { "src/retry.ts": retryV1, "src/retry.test.ts": retryTestV1 },
		},
		bugs: [
			{
				id: "extra-attempt",
				describe: "retry's loop runs i <= attempts, so fn is called attempts + 1 times (4 instead of 3), and it also sleeps after the final failure",
			},
		],
		notBlocking: [{ id: "config-parse", describe: "config.ts parses env vars loosely (parseInt without radix, NaN not handled); this file was not changed" }],
		round2: {
			scope: "the uncommitted changes again, after the author fixed the previous review's findings (git diff HEAD plus untracked files)",
			change: { "src/retry.ts": retryV2 },
			bugs: [
				{
					id: "inverted-should-retry",
					describe: "the new shouldRetry check is inverted: it rethrows when shouldRetry(error) is true, so with the default () => true retry never retries at all",
				},
			],
			fixed: [{ id: "extra-attempt", describe: "retry calls fn attempts + 1 times / sleeps after the final failure" }],
		},
	},
];
