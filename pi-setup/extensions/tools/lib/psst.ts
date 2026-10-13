/**
 * psst vault integration — loads secrets from the global psst vault,
 * injects them into bash subprocess env vars, scrubs them from output.
 *
 * vault resolution order:
 *   1. local vault (cwd/.psst/) — for per-project secrets
 *   2. global vault (~/.psst/) — for cross-project secrets
 *
 * tags filter which secrets are loaded. set PSST_TAGS env var or
 * use /psst-tag command. cleared = all secrets loaded.
 *
 * the agent never sees secret values — only names in the system prompt,
 * and $NAME references in bash commands that resolve at spawn time.
 *
 * scrubbing covers THREE sources (not just vault):
 *   1. psst vault secrets (user-managed, injected into bash via $NAME)
 *   2. auth.json tokens (pi's OAuth/API keys — read tool blocks the file,
 *      but bash/cat/etc could still leak them)
 *   3. env var values matching sensitive patterns (*KEY*, *TOKEN*, *SECRET*,
 *      *PASSWORD*) — these come from the shell and could be dumped via `env`
 */

import { Vault } from "psst-cli";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REDACTED_PREFIX = "[REDACTED";

export interface SecretEntry {
	name: string;
	value: string;
	tags: string[];
}

// --- vault resolution ---

/**
 * find the best vault path: local first, then global.
 * matches psst-cli's own resolution logic.
 */
function findVaultPath(): string | null {
	// local vault: <cwd>/.psst/
	const localPath = Vault.findVaultPath({ global: false });
	if (localPath) return localPath;

	// global vault: ~/.psst/
	const globalPath = Vault.findVaultPath({ global: true });
	if (globalPath) return globalPath;

	return null;
}

// --- loading ---

let cachedSecrets: SecretEntry[] | null = null;
let cacheExpiry = 0;
const CACHE_TTL_MS = 30_000; // 30 seconds — balance between freshness and vault I/O

/** active tag filter. empty = load all secrets. */
let activeTags: string[] = [];

export function setActiveTags(tags: string[]): void {
	activeTags = tags;
	invalidateCache();
}

export function getActiveTags(): string[] {
	return [...activeTags];
}

export function invalidateCache(): void {
	cachedSecrets = null;
	cacheExpiry = 0;
}

/**
 * load vault secrets — only secrets the agent can USE (via $NAME in bash).
 * used for: bash env injection, system prompt (names only).
 */
export async function loadSecrets(): Promise<SecretEntry[]> {
	const now = Date.now();
	if (cachedSecrets && now < cacheExpiry) return cachedSecrets;

	const vaultPath = findVaultPath();
	if (!vaultPath) return [];

	try {
		const vault = new Vault(vaultPath);
		const unlocked = await vault.unlock();
		if (!unlocked) {
			vault.close();
			return [];
		}

		const filterTags = activeTags.length > 0 ? activeTags : undefined;
		const list = await vault.listSecrets(filterTags);
		const secrets: SecretEntry[] = [];

		for (const entry of list) {
			const value = await vault.getSecret(entry.name);
			if (value) {
				secrets.push({
					name: entry.name,
					value,
					tags: entry.tags ?? [],
				});
			}
		}

		vault.close();
		cachedSecrets = secrets;
		cacheExpiry = now + CACHE_TTL_MS;
		return secrets;
	} catch {
		return [];
	}
}

// --- comprehensive scrubbing values ---

/**
 * load ALL sensitive string values for output scrubbing.
 * covers vault secrets + auth.json tokens + sensitive env vars.
 * names are NOT included — only values to redact.
 */
export async function loadAllScrubValues(): Promise<string[]> {
	const values: string[] = [];

	// 1. vault secrets
	const vaultSecrets = await loadSecrets();
	for (const s of vaultSecrets) {
		if (s.value.length >= 4) values.push(s.value);
	}

	// 2. auth.json tokens
	try {
		const authPath = path.join(os.homedir(), ".pi", "agent", "auth.json");
		if (fs.existsSync(authPath)) {
			const raw = fs.readFileSync(authPath, "utf-8");
			const auth = JSON.parse(raw);
			for (const provider of Object.values(auth) as any[]) {
				for (const field of ["key", "refresh", "access"] as const) {
					const val = provider[field];
					if (typeof val === "string" && val.length >= 8) {
						values.push(val);
					}
				}
			}
		}
	} catch { /* ignore */ }

	// 3. sensitive env vars
	const sensitiveEnvPatterns = [
		/KEY$/i, /API_KEY$/i, /_TOKEN$/i, /_SECRET$/i, /PASSWORD$/i,
	];
	const env = process.env;
	for (const [key, val] of Object.entries(env)) {
		if (typeof val !== "string" || val.length < 8) continue;
		if (sensitiveEnvPatterns.some((p) => p.test(key))) {
			values.push(val);
		}
	}

	return values;
}

// --- scrubbing ---

/**
 * replace secret values in text with named redaction marker.
 * sorts by value length (longest first) to prevent partial replacement.
 * skips secrets shorter than 4 chars — too likely to cause false positives.
 */
export function scrubOutput(text: string, secrets: SecretEntry[]): string {
	if (secrets.length === 0) return text;

	let result = text;
	const sorted = [...secrets].sort((a, b) => b.value.length - a.value.length);

	for (const secret of sorted) {
		if (secret.value.length < 4) continue;
		result = result.replaceAll(secret.value, `${REDACTED_PREFIX}:${secret.name}]`);
	}
	return result;
}

/**
 * scrub raw string values from text (anonymous redaction).
 * used for auth.json tokens and env var keys where we don't want to
 * reveal which provider/env var was redacted.
 */
export function scrubValues(text: string, values: string[]): string {
	if (values.length === 0) return text;

	let result = text;
	const sorted = [...values].sort((a, b) => b.length - a.length);

	for (const val of sorted) {
		result = result.replaceAll(val, `${REDACTED_PREFIX}]`);
	}
	return result;
}

// --- pattern redaction: secrets nobody registered ---

/** formats that are a secret by their shape alone. */
const SECRET_SHAPES: [RegExp, string][] = [
	[/-----BEGIN [A-Z ]{0,20}PRIVATE KEY-----[\s\S]{0,12000}?-----END [A-Z ]{0,20}PRIVATE KEY-----/g, "[REDACTED private key]"],
	[/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[REDACTED jwt]"],
	[/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}/g, "[REDACTED]"],
	[/\bwhsec_[A-Za-z0-9+/=]{10,}/g, "[REDACTED]"],
	[/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g, "[REDACTED]"],
	[/\bgh[opusr]_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}/g, "[REDACTED]"],
	[/\bglpat-[A-Za-z0-9_-]{20,}|\bnpm_[A-Za-z0-9]{36}\b/g, "[REDACTED]"],
	[/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, "[REDACTED]"],
	[/\bAKIA[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{35}\b/g, "[REDACTED]"],
	[/\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, "[REDACTED]"],
	// a Telegram bot token: `<bot id>:AA<33 chars>`
	[/\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/g, "[REDACTED]"],
	[/\bhooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9_/-]{20,200}/g, "hooks.slack.com/[REDACTED]"],
	[/\bdiscord(?:app)?\.com\/api\/webhooks\/\d{5,30}\/[A-Za-z0-9_-]{20,200}/g, "discord.com/api/webhooks/[REDACTED]"],
];

// every open-ended part is capped: this runs on every tool result, and an uncapped
// `[\w.-]*token[\w.-]*` backtracks quadratically through one long word.
const SECRET_NAME = String.raw`[A-Za-z0-9_.-]{0,48}(?:password|passwd|passphrase|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|auth[_-]?key|credentials?)[A-Za-z0-9_.-]{0,48}`;

/** names that only sound secret: an id, an endpoint, an expiry, a public or cache key. */
const NOT_SECRET_NAME =
	/(?:_?ids?|type|name|url|uri|path|file|endpoint|expir\w*|ttl|count|length|limit|size|mode|header|prefix|suffix|format|hash|fingerprint)$|(?:^|[_.-])(?:cache|primary|foreign|sort|partition|idempotency|public|storage|object|row|lookup|map|dedupe|unique|sign(?:ing)?)[_-]?key$/i;
const nameIn = (head: string) => (head.match(/[A-Za-z0-9_.-]+/g) ?? []).pop() ?? "";

const isPlaceholder = (value: string) =>
	/^(?:changeme|pass(?:word)?|secret|placeholder|redacted|x+|\*+|your[_-].*|test|dummy|\[REDACTED\])$/i.test(value) ||
	/(?:^|[^a-z])example(?:[^a-z]|$)/i.test(value);

/** `SecretKeyV2Provider`, `getOAuth2TokenFromCache`: mostly real words, so code, not a key. */
function looksLikeIdentifier(value: string): boolean {
	const words = value.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])|\d+/g) ?? [];
	const wordy = words.filter((word) => /^[A-Za-z]{3,}$/.test(word)).length;
	return wordy >= 2 && wordy / words.length >= 0.5;
}

/**
 * Generated secrets switch between lowercase, uppercase, digits and symbols
 * constantly and always contain a digit or symbol; names (`tokenSet.refreshToken`,
 * `test-only-secret`, `api_key_v2`) do not. `_`, `-` and `.` only join words,
 * so they do not count.
 */
function looksRandom(value: string): boolean {
	const chars = value.replace(/[_.-]/g, "");
	if (!/[^A-Za-z]/.test(chars)) return false;
	const kind = (ch: string) => (/[a-z]/.test(ch) ? 0 : /[A-Z]/.test(ch) ? 1 : /\d/.test(ch) ? 2 : 3);
	let changes = 0;
	for (let i = 1; i < chars.length; i++) if (kind(chars[i]!) !== kind(chars[i - 1]!)) changes++;
	return changes >= 5;
}

/**
 * Whether a value next to a secret-sounding name is the secret itself, rather
 * than code (`secrets;`, `base64Token`, `req.headers.authorization`), a
 * reference (`$DB_PASSWORD`, `${{ secrets.X }}`) or a placeholder. Redacting
 * code would make the file impossible to edit, so only random-looking values count.
 */
function looksLikeSecretValue(value: string): boolean {
	if (value.length < 8 || /[(){}[\]<>,$%;:]/.test(value) || /^[/~]/.test(value)) return false;
	// `process.env.X` is code; a long random value with a dot in it is a key.
	if (value.includes(".") && !value.split(".").every((part) => part.length >= 8 && /^[A-Za-z0-9_+/=-]+$/.test(part))) {
		return false;
	}
	if (isPlaceholder(value)) return false;
	if (/^[A-Z][A-Z0-9_]*$/.test(value) || looksLikeIdentifier(value)) return false;
	return looksRandom(value);
}

/** `DB_PASSWORD=x` / `?api_key=x`, then `"password": "x"` / `token: x`, then a markdown row `| DB password | \`x\` |`. */
const ASSIGNMENTS: RegExp[] = [
	new RegExp(String.raw`(\b${SECRET_NAME}\s*=\s*)(["']?)([^\s"'\x60&#]{1,500})\2`, "gi"),
	new RegExp(String.raw`(["']?\b${SECRET_NAME}["']?\s*:\s*)(["'\x60]?)([^\s"'\x60,}]{1,500})\2`, "gi"),
	new RegExp(String.raw`(\|[^|\n]{0,200}?(?:password|passwd|secret|token|api[ _-]?key|private[ _-]?key|access[ _-]?key)[^|\n]{0,200}\|\s*)(\x60?)([^|\x60\s]{1,500})\2`, "gi"),
	// names that are only sometimes secret (`cache_key`, `ownaeo_gate`): only a long random value counts.
	new RegExp(String.raw`(\b[A-Za-z0-9_.-]{0,48}(?:key|gate)\s*[=:]\s*)(["'\x60]?)([A-Za-z0-9_+/=-]{24,500})\2`, "gi"),
];

/** `Bearer <token>`, `Basic <base64 of user:password>` and `scheme://user:password@host` (user may be empty). */
const BEARER = /\b(Bearer\s+)([A-Za-z0-9._~+/=-]{16,})/g;
const BASIC = /\b(Basic\s+)([A-Za-z0-9+/]{8,500}={0,2})(?![A-Za-z0-9+/=])/g;
const URL_PASSWORD = /\b([a-z][a-z0-9+.-]{0,30}:\/\/[^\s:@/]{0,200}:)([^\s@/]{1,500})(@)(?!(?:localhost|127\.\d+\.\d+\.\d+|\[::1\])[:/\s"'`]|(?:localhost|127\.\d+\.\d+\.\d+)$)/gi;

/**
 * Redacts secrets by their look: known key formats, private keys, JWTs, bearer
 * tokens, passwords in URLs, and values assigned to secret-sounding names.
 * Catches what the value-based scrubber cannot know about (a playbook, a
 * crontab, a compose file).
 */
export function redactSecretPatterns(text: string): string {
	let out = text;
	for (const [shape, replacement] of SECRET_SHAPES) {
		out = out.replace(shape, (match) => (isPlaceholder(match) ? match : replacement));
	}
	out = out.replace(BEARER, "$1[REDACTED]");
	out = out.replace(BASIC, (match, head, encoded) =>
		/^[\x20-\x7e]{1,200}:[\x20-\x7e]{1,200}$/.test(Buffer.from(encoded, "base64").toString("latin1")) ? `${head}[REDACTED]` : match,
	);
	out = out.replace(URL_PASSWORD, (match, head, password, at) =>
		password.startsWith("$") || isPlaceholder(password) ? match : `${head}[REDACTED]${at}`,
	);
	for (const assignment of ASSIGNMENTS) {
		out = out.replace(assignment, (match, head, quote, value) =>
			!NOT_SECRET_NAME.test(nameIn(head)) && looksLikeSecretValue(value) ? `${head}${quote}[REDACTED]${quote}` : match,
		);
	}
	return out;
}

/**
 * comprehensive scrubber: vault secrets (named) + all other sensitive values +
 * secret-shaped text. built once per tool result, so every string in it is
 * scrubbed against the same secrets without re-reading them.
 */
export async function makeScrubber(): Promise<(text: string) => string> {
	const vaultSecrets = await loadSecrets();
	const vaultValues = new Set(vaultSecrets.map((s) => s.value));
	const extraValues = (await loadAllScrubValues()).filter((v) => !vaultValues.has(v));
	return (text) => redactSecretPatterns(scrubValues(scrubOutput(text, vaultSecrets), extraValues));
}

function scrubJson(value: unknown, scrub: (text: string) => string): unknown {
	if (typeof value === "string") return scrub(value);
	if (Array.isArray(value)) return value.map((v) => scrubJson(v, scrub));
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubJson(v, scrub)]));
	}
	return value;
}

type ToolResultLike = { content: Array<{ type: string; text?: string }>; structuredContent?: unknown };

/** whether a result carries text or structuredContent that scrubbing could change. */
export function hasScrubbableContent(result: ToolResultLike): boolean {
	return result.structuredContent !== undefined || result.content.some((c) => c.type === "text" && c.text);
}

/**
 * scrub a tool result's text and its structuredContent. pi drops
 * structuredContent when a tool_result handler replaces only `content`, so
 * both go back together. undefined when there is nothing to scrub.
 */
export function scrubToolResult<T extends ToolResultLike>(
	result: T,
	scrub: (text: string) => string,
): Pick<T, "content" | "structuredContent"> | undefined {
	if (!hasScrubbableContent(result)) return undefined;
	const content = result.content.map((c) => (c.type === "text" && c.text ? { ...c, text: scrub(c.text) } : c));
	if (result.structuredContent === undefined) return { content } as Pick<T, "content" | "structuredContent">;
	return { content, structuredContent: scrubJson(result.structuredContent, scrub) } as Pick<T, "content" | "structuredContent">;
}
