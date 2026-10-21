/**
 * The Grok CLI's own login (~/.grok/auth.json) as a token source. It is the
 * only xAI login that carries the subscription tier X search needs: pi's
 * `/login xai` token is accepted by the proxy but gets API-tier limits and no
 * X tools, and Grok then answers from memory.
 *
 * The access token lives for hours and the CLI refreshes it only while it
 * runs, so an expiring token is renewed by running the CLI itself with a wide
 * refresh window (`grok models` authenticates, refreshes, exits). The CLI
 * writes its own file under its own lock and rotates its own refresh token;
 * this module only reads the file.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { withProcessLock } from "../file-lock";

export interface TokenSource {
	label: string;
	get(): Promise<string | undefined>;
	/** renew the token after the server rejected it; resolves to the new token, or undefined when renewal failed. */
	refresh?(rejected: string): Promise<string | undefined>;
}

interface StoredToken {
	key: string;
	expiresAt: number;
}

export interface GrokLoginOptions {
	grokHome?: string;
	grokBin?: string;
	/** a token with less time left than this is renewed before use. */
	minValidMs?: number;
	refreshTimeoutMs?: number;
	runGrok?: (bin: string, env: NodeJS.ProcessEnv, timeoutMs: number) => Promise<void>;
}

const DEFAULT_MIN_VALID_MS = 10 * 60_000;
const DEFAULT_REFRESH_TIMEOUT_MS = 45_000;

export const grokHomeDir = () => path.join(os.homedir(), ".grok");

function readToken(authFile: string): StoredToken | undefined {
	try {
		const all = JSON.parse(fs.readFileSync(authFile, "utf-8")) as Record<string, { key?: string; expires_at?: string }>;
		for (const entry of Object.values(all)) {
			if (!entry?.key) continue;
			const expiresAt = entry.expires_at ? Date.parse(entry.expires_at) : Number.NaN;
			return { key: entry.key, expiresAt: Number.isNaN(expiresAt) ? Number.POSITIVE_INFINITY : expiresAt };
		}
	} catch {}
	return undefined;
}

export function findGrokBinary(grokHome = grokHomeDir(), pathEnv = process.env.PATH ?? ""): string | undefined {
	const candidates = [path.join(grokHome, "bin", "grok"), ...pathEnv.split(path.delimiter).filter(Boolean).map((d) => path.join(d, "grok"))];
	return candidates.find((c) => {
		try {
			fs.accessSync(c, fs.constants.X_OK);
			return true;
		} catch {
			return false;
		}
	});
}

const runGrokModels = (bin: string, env: NodeJS.ProcessEnv, timeoutMs: number) =>
	new Promise<void>((resolve) => {
		execFile(bin, ["models"], { env, timeout: timeoutMs, killSignal: "SIGKILL" }, () => resolve());
	});

export function grokCliLogin(opts: GrokLoginOptions = {}): TokenSource {
	const grokHome = opts.grokHome ?? grokHomeDir();
	const authFile = path.join(grokHome, "auth.json");
	const minValidMs = opts.minValidMs ?? DEFAULT_MIN_VALID_MS;
	const runGrok = opts.runGrok ?? runGrokModels;
	let inFlight: Promise<string | undefined> | undefined;

	const fresh = (t: StoredToken | undefined) => (t && t.expiresAt - Date.now() > minValidMs ? t.key : undefined);

	const renew = (rejected?: string): Promise<string | undefined> => {
		inFlight ??= withProcessLock(
			authFile,
			async () => {
				const before = readToken(authFile);
				if (before && before.key !== rejected && fresh(before)) return before.key;
				const bin = opts.grokBin ?? findGrokBinary(grokHome);
				if (!bin) return undefined;
				await runGrok(bin, { ...process.env, GROK_AUTH_EARLY_INVALIDATION_SECS: "86400" }, opts.refreshTimeoutMs ?? DEFAULT_REFRESH_TIMEOUT_MS);
				const after = readToken(authFile);
				return after && after.key !== before?.key ? fresh(after) : undefined;
			},
			{ waitMs: (opts.refreshTimeoutMs ?? DEFAULT_REFRESH_TIMEOUT_MS) + 5000 },
		)
			.catch(() => undefined)
			.finally(() => {
				inFlight = undefined;
			});
		return inFlight;
	};

	return {
		label: "Grok CLI login (~/.grok/auth.json)",
		async get() {
			const stored = readToken(authFile);
			const usable = fresh(stored) ?? (await renew());
			if (usable) return usable;
			return stored && stored.expiresAt - Date.now() > 30_000 ? stored.key : undefined;
		},
		refresh: (rejected: string) => renew(rejected),
	};
}

export function hasGrokLogin(grokHome = grokHomeDir()): boolean {
	return readToken(path.join(grokHome, "auth.json")) !== undefined;
}
