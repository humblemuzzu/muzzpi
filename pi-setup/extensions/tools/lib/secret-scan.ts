/**
 * The secret check on what git commits and pushes. It blocks only what is
 * certainly a secret: a value of the user's own secrets (psst, pi's logins,
 * secret env vars) or a key in a provider's exact format. What merely looks
 * like one (a password in a URL, `token = "..."`, a JWT) is listed as a
 * warning and goes through: the output scrubber hides those on screen, where
 * a wrong guess costs nothing, but a wrong block stops an agent's whole run.
 *
 * It runs inside git, as a config hook bash adds through the environment
 * (lib/git.ts): `prepare-commit-msg` sees the exact tree being committed,
 * `--no-verify` included, and `pre-push` the commits being pushed.
 */

import { spawn } from "node:child_process";
import { crc32 } from "node:zlib";
import { authJsonValues, loadSecrets, redactSecretPatterns, sensitiveEnvEntries } from "./psst";

export const SECRET_SCAN_OFF_ENV = "PI_SECRET_SCAN_OFF";
export const ALLOW_MARKERS = ["pi:allow-secret", "gitleaks:allow"];

export interface KnownSecret {
	label: string;
	value: string;
}

export interface Added {
	file: string;
	/** the path before a rename; the same as `file` otherwise */
	oldFile: string;
	line: number;
	text: string;
	commit?: string;
}

export interface Finding {
	file: string;
	line: number;
	what: string;
	commit?: string;
	/** a user's own secret: no allow marker clears it */
	own?: boolean;
	match?: string;
	oldFile?: string;
}

export interface ScanResult {
	blocked: Finding[];
	warned: Finding[];
}

// --- reading git's diff ---

const COMMIT_MARK = "\x01";

function unquote(name: string): string {
	if (!name.startsWith('"')) return name;
	const bytes: number[] = [];
	const body = name.slice(1, name.lastIndexOf('"'));
	const escapes: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, "\\": 92, a: 7, b: 8, f: 12, v: 11 };
	for (let i = 0; i < body.length; i++) {
		if (body[i] !== "\\") {
			bytes.push(...Buffer.from(body[i]!, "utf8"));
			continue;
		}
		const octal = /^[0-7]{3}/.exec(body.slice(i + 1));
		if (octal) {
			bytes.push(parseInt(octal[0], 8));
			i += 3;
		} else {
			bytes.push(escapes[body[i + 1]!] ?? body.charCodeAt(i + 1));
			i++;
		}
	}
	return Buffer.from(bytes).toString("utf8");
}

function pathOf(header: string, prefix: string): string | undefined {
	const name = unquote(header.replace(/\t$/, ""));
	if (name === "/dev/null") return undefined;
	return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

/** the added lines of a zero-context unified diff, with their new-side line numbers */
export function addedLines(diff: string): Added[] {
	const added: Added[] = [];
	let commit: string | undefined;
	let oldFile: string | undefined;
	let file: string | undefined;
	let line = 0;
	let oldLeft = 0;
	let newLeft = 0;
	for (const raw of diff.split("\n")) {
		if (oldLeft > 0 || newLeft > 0) {
			if (raw.startsWith("+")) {
				if (file) added.push({ file, oldFile: oldFile ?? file, line, text: raw.slice(1), commit });
				line++;
				newLeft--;
			} else if (raw.startsWith("-")) oldLeft--;
			else if (raw.startsWith(" ")) {
				line++;
				oldLeft--;
				newLeft--;
			}
			continue;
		}
		if (raw.startsWith(COMMIT_MARK)) commit = raw.slice(1).trim();
		else if (raw.startsWith("diff --git ")) oldFile = file = undefined;
		else if (raw.startsWith("--- ")) oldFile = pathOf(raw.slice(4), "a/");
		else if (raw.startsWith("+++ ")) file = pathOf(raw.slice(4), "b/");
		else {
			const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw);
			if (hunk) {
				oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
				line = Number(hunk[2]);
				newLeft = hunk[3] === undefined ? 1 : Number(hunk[3]);
			}
		}
	}
	return added;
}

// --- what counts as a secret ---

/** a multi-line secret (a private key) is found by its long lines; a short value is too common to block on */
function needles(value: string, min: number): string[] {
	if (!value.includes("\n")) return value.length >= min ? [value] : [];
	return value
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length >= 24 && !line.startsWith("-----"));
}

/** an env value that is a key, not a path, a word or a setting that only has a secret-sounding name */
function looksLikeKey(value: string): boolean {
	return value.length >= 12 && !/^[~/.]/.test(value) && !/\s/.test(value) && /\d/.test(value) && new Set(value).size >= 8;
}

export async function knownSecrets(env: NodeJS.ProcessEnv = process.env): Promise<KnownSecret[]> {
	const labels = new Map<string, string>();
	const add = (value: string, min: number, label: string) => {
		for (const needle of needles(value, min)) if (!labels.has(needle)) labels.set(needle, label);
	};
	for (const secret of await loadSecrets([])) add(secret.value, 8, `your psst secret ${secret.name}`);
	for (const value of authJsonValues()) add(value, 8, "a pi login token");
	for (const [name, value] of sensitiveEnvEntries(env)) if (looksLikeKey(value)) add(value, 12, `the value of $${name}`);
	return [...labels].map(([value, label]) => ({ value, label }));
}

const MADE_UP = /example|sample|fake|dummy|placeholder|redacted|your|changeme|notreal|not_real|test|xxxx|0000|1234|abcd/i;

/** the shape of a key with a value nobody would issue: a word, a run, too few distinct characters */
function madeUp(match: string): boolean {
	return MADE_UP.test(match) || /(.)\1{5,}/.test(match) || new Set(match).size < Math.min(12, Math.ceil(match.length / 2));
}

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** GitHub's classic tokens end in a base62 CRC32 of their random part, so a made-up one fails it */
function githubChecksumHolds(token: string): boolean {
	const random = token.slice(4, 34);
	let n = crc32(random);
	let encoded = "";
	do {
		encoded = BASE62[n % 62] + encoded;
		n = Math.floor(n / 62);
	} while (n > 0);
	return encoded.padStart(6, "0") === token.slice(34);
}

interface KeyFormat {
	what: string;
	pattern: RegExp;
	real?: (match: string) => boolean;
}

const KEY_FORMATS: KeyFormat[] = [
	{ what: "a GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36}\b/g, real: githubChecksumHolds },
	{ what: "a GitHub token", pattern: /\bgithub_pat_[A-Za-z0-9]{22}_[A-Za-z0-9]{59}\b/g },
	{ what: "a GitLab token", pattern: /\bglpat-[A-Za-z0-9_-]{20,64}/g },
	{ what: "a Stripe live key", pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,128}/g },
	{ what: "a Stripe webhook secret", pattern: /\bwhsec_[A-Za-z0-9+/=]{32,128}/g },
	{ what: "an Anthropic key", pattern: /\bsk-ant-(?:api|admin|oat|ort)\d{2}-[A-Za-z0-9_-]{80,200}/g },
	{ what: "an OpenAI key", pattern: /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{40,200}|\bsk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}\b/g },
	{ what: "an OpenRouter key", pattern: /\bsk-or-v1-[a-f0-9]{64}\b/g },
	{ what: "an xAI key", pattern: /\bxai-[A-Za-z0-9]{70,100}/g },
	{ what: "a Groq key", pattern: /\bgsk_[A-Za-z0-9]{48,64}/g },
	{ what: "a Hugging Face token", pattern: /\bhf_[A-Za-z]{34}\b/g },
	{ what: "a Slack token", pattern: /\bxox[baprse]-\d{6,20}-[A-Za-z0-9-]{10,100}/g },
	{ what: "a Slack webhook", pattern: /\bhooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9_/-]{20,200}/g },
	{ what: "a Discord webhook", pattern: /\bdiscord(?:app)?\.com\/api\/webhooks\/\d{5,30}\/[A-Za-z0-9_-]{40,200}/g },
	{ what: "an npm token", pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
	{ what: "an AWS access key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
	{ what: "a SendGrid key", pattern: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g },
	{ what: "a Telegram bot token", pattern: /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/g },
	{ what: "a Google OAuth client secret", pattern: /\bGOCSPX-[A-Za-z0-9_-]{28}\b/g },
];

const PRIVATE_KEY_BEGIN = /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY(?: BLOCK)?-----/;
const KEY_BODY = /^[A-Za-z0-9+/=]{40,}$/;

/** a private key: its BEGIN line followed by base64 lines that are not a placeholder */
function privateKeys(lines: Added[]): Finding[] {
	const found: Finding[] = [];
	lines.forEach((start, i) => {
		if (!PRIVATE_KEY_BEGIN.test(start.text)) return;
		const body: string[] = [];
		for (let j = i + 1; j < lines.length; j++) {
			const next = lines[j]!;
			if (next.file !== start.file || next.commit !== start.commit || next.line !== start.line + (j - i)) break;
			const text = next.text.trim();
			if (text.startsWith("-----END")) break;
			if (KEY_BODY.test(text)) body.push(text);
		}
		const joined = body.join("");
		if (body.length >= 2 && !madeUp(joined)) {
			found.push({ file: start.file, oldFile: start.oldFile, line: start.line, commit: start.commit, what: "a private key", match: body[0] });
		}
	});
	return found;
}

const allowed = (text: string) => ALLOW_MARKERS.some((marker) => text.includes(marker));

/** every finding on the added lines, before the check against what the file already held */
export function findSecrets(lines: Added[], known: KnownSecret[]): ScanResult {
	const blocked: Finding[] = privateKeys(lines).filter((finding) => !allowed(lines.find((l) => l.file === finding.file && l.line === finding.line)?.text ?? ""));
	const warned: Finding[] = [];
	for (const added of lines) {
		const at = { file: added.file, oldFile: added.oldFile, line: added.line, commit: added.commit };
		const hits: Finding[] = [];
		for (const secret of known) {
			if (added.text.includes(secret.value)) hits.push({ ...at, what: secret.label, own: true, match: secret.value });
		}
		const mayAllow = allowed(added.text);
		if (!mayAllow) {
			for (const format of KEY_FORMATS) {
				for (const match of added.text.matchAll(format.pattern)) {
					const real = format.real ? format.real(match[0]) : !madeUp(match[0]);
					if (real && !hits.some((hit) => hit.match?.includes(match[0]))) hits.push({ ...at, what: format.what, match: match[0] });
				}
			}
		}
		if (hits.length > 0) blocked.push(...hits);
		else if (!mayAllow && !added.text.includes("[REDACTED") && redactSecretPatterns(added.text) !== added.text) {
			warned.push({ ...at, what: "looks like a secret" });
		}
	}
	return { blocked, warned };
}

/**
 * Blocks what the change newly publishes. A value the file already held before
 * (the commit's parent, or the remote for a push) is not published by this
 * change, so it is only a warning.
 */
export async function scanDiff(
	diff: string,
	known: KnownSecret[],
	before: (finding: Finding) => Promise<string | undefined>,
): Promise<ScanResult> {
	const found = findSecrets(addedLines(diff), known);
	const blocked: Finding[] = [];
	const warned = [...found.warned];
	for (const finding of found.blocked) {
		const old = finding.match ? await before(finding) : undefined;
		if (old !== undefined && old.includes(finding.match!)) warned.push({ ...finding, what: `${finding.what}, already in this file before` });
		else blocked.push(finding);
	}
	return { blocked, warned };
}

// --- running git ---

const GIT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/** stdout of a git command, or undefined when it failed, ran too long or printed too much */
export function git(cwd: string, args: string[], input?: string): Promise<string | undefined> {
	return new Promise((resolve) => {
		const proc = spawn("git", ["-c", "core.quotePath=false", ...args], { cwd, stdio: ["pipe", "pipe", "ignore"] });
		const chunks: Buffer[] = [];
		let size = 0;
		let failed = false;
		const timer = setTimeout(() => {
			failed = true;
			proc.kill("SIGKILL");
		}, GIT_TIMEOUT_MS);
		proc.stdout.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_OUTPUT_BYTES) {
				failed = true;
				proc.kill("SIGKILL");
			} else chunks.push(chunk);
		});
		proc.stdin.on("error", () => {});
		proc.stdin.end(input ?? "");
		proc.on("error", () => {
			clearTimeout(timer);
			resolve(undefined);
		});
		proc.on("close", (code) => {
			clearTimeout(timer);
			resolve(code === 0 && !failed ? Buffer.concat(chunks).toString("utf8") : undefined);
		});
	});
}

const DIFF_OPTIONS = ["-M", "--unified=0", "--no-color", "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/"];
const MAX_PUSH_COMMITS = 500;
export const ZERO_SHA = /^0+$/;

/** the commits a merge, a cherry-pick or a rebase step copies from: what they held is not new either */
const COPIED_FROM = ["MERGE_HEAD", "CHERRY_PICK_HEAD"];

/** what the next commit would hold beyond HEAD: the index git commits from (GIT_INDEX_FILE inside a hook) */
export async function scanStaged(cwd: string, known?: KnownSecret[]): Promise<ScanResult> {
	const diff = await git(cwd, ["diff", "--cached", ...DIFF_OPTIONS]);
	if (diff === undefined) throw new Error("git diff --cached failed");
	const sources = ["HEAD"];
	for (const ref of COPIED_FROM) if ((await git(cwd, ["rev-parse", "--verify", "--quiet", ref])) !== undefined) sources.push(ref);
	return scanDiff(diff, known ?? (await knownSecrets()), async (finding) => {
		const texts = await Promise.all(sources.map((source) => git(cwd, ["cat-file", "blob", `${source}:${finding.oldFile ?? finding.file}`])));
		const held = texts.filter((text): text is string => text !== undefined);
		return held.length > 0 ? held.join("\n") : undefined;
	});
}

/** the commits from `tip` that `base` (a commit) or else every remote-tracking branch lacks */
export async function scanUnpushed(cwd: string, tip: string, base: string | undefined, remote?: string, known?: KnownSecret[]): Promise<ScanResult> {
	const range = base ? [`${base}..${tip}`] : [tip, "--not", remote ? `--remotes=${remote}/*` : "--remotes"];
	const diff = await git(cwd, ["log", "-p", ...DIFF_OPTIONS, `--max-count=${MAX_PUSH_COMMITS}`, `--format=${COMMIT_MARK}%h`, ...range]);
	if (diff === undefined) throw new Error("git log failed");
	return scanDiff(diff, known ?? (await knownSecrets()), (finding) =>
		base ? git(cwd, ["cat-file", "blob", `${base}:${finding.oldFile ?? finding.file}`]) : Promise.resolve(undefined),
	);
}

// --- what the agent reads ---

const SHOWN = 12;
const WARNINGS_SHOWN = 5;

const where = (finding: Finding) => `${finding.commit ? `${finding.commit} ` : ""}${finding.file}:${finding.line}`;

function listed(findings: Finding[], limit: number, withWhat: boolean): string[] {
	const rows = findings.slice(0, limit).map((finding) => `  ${where(finding)}${withWhat ? `  ${finding.what}` : ""}`);
	if (findings.length > limit) rows.push(`  ...and ${findings.length - limit} more`);
	return rows;
}

export type Stopped = "commit" | "push" | "command";

export function blockMessage(blocked: Finding[], stopped: Stopped): string {
	const headline = {
		commit: "git did not commit, because this commit would publish secrets:",
		push: "git did not push, because these commits would publish secrets:",
		command: "this command was not run, because what it commits or pushes would publish secrets:",
	}[stopped];
	const ownSecret = blocked.find((finding) => finding.own);
	const name = ownSecret?.what.match(/psst secret (\S+)|\$(\S+)/)?.slice(1).find(Boolean);
	const reference = name ? ` (in shell \`$${name}\`, in code \`process.env.${name}\`)` : "";
	const lines = [`pi secret scan: ${headline}`, ...listed(blocked, SHOWN, true), ""];
	if (stopped === "push" || blocked.some((finding) => finding.commit)) {
		lines.push(
			"Nothing was pushed. The secret is inside a commit, so it must come out of that commit first: if it is in the last commit, " +
				"replace the value in the file, stage it and run `git commit --amend --no-edit`, then push again. If it is in an older commit, " +
				"stop and tell the user: taking it out rewrites local history.",
		);
	} else {
		lines.push(
			"Nothing was committed. Fix it yourself, there is no need to ask the user: replace each value with a reference to where it is " +
				`kept${reference}, or a placeholder in docs and tests, stage the file again, and commit again.`,
		);
	}
	if (blocked.some((finding) => !finding.own)) {
		lines.push(
			"If a flagged key is made up (a fake value in a test or a doc), you may instead end its line with the comment `pi:allow-secret`." +
				(ownSecret ? " That never clears a value of the user's own secrets." : ""),
		);
	}
	return lines.join("\n");
}

export function warningMessage(warned: Finding[]): string {
	const lines = warned.length === 1 ? "1 added line looks like a secret but matches" : `${warned.length} added lines look like a secret but match`;
	return [
		`pi secret scan: nothing blocks this. ${lines} no known key (fake values in tests and docs are normal); check if one is real:`,
		...listed(warned, WARNINGS_SHOWN, warned.some((finding) => finding.what !== "looks like a secret")),
	].join("\n");
}
