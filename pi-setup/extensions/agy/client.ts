import { execFile } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const TOKEN_URL = "https://oauth2.googleapis.com/token";

export interface AgyClient {
	clientId: string;
	clientSecret: string;
}

const CLIENT_ID = /[0-9]{6,}-[a-z0-9]{20,}\.apps\.googleusercontent\.com/g;
const CLIENT_SECRET = /GOCSPX-[A-Za-z0-9_-]{28}/g;
const SCAN_PATTERN = "GOCSPX-[A-Za-z0-9_-]{28}|[0-9]{6,}-[a-z0-9]{20,}\\.apps\\.googleusercontent\\.com";

const CANDIDATE_PATHS = [join(homedir(), ".local", "bin", "agy"), "/opt/homebrew/bin/agy", "/usr/local/bin/agy"];

export function extractClients(text: string): AgyClient[] {
	const ids = [...new Set(text.match(CLIENT_ID) ?? [])];
	const secrets = [...new Set(text.match(CLIENT_SECRET) ?? [])];
	const clients: AgyClient[] = [];
	for (const clientSecret of secrets) {
		for (const clientId of ids) clients.push({ clientId, clientSecret });
	}
	return clients;
}

function run(command: string, args: string[]): Promise<string | undefined> {
	return new Promise((resolve) => {
		execFile(command, args, { timeout: 30_000, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" }, (error, stdout) => {
			resolve(error ? undefined : stdout);
		});
	});
}

async function exists(path: string): Promise<boolean> {
	return access(path).then(
		() => true,
		() => false,
	);
}

export async function findAgyBinary(): Promise<string | undefined> {
	const configured = process.env.AGY_BINARY;
	if (configured) return (await exists(configured)) ? configured : undefined;
	const located = (await run("which", ["agy"]))?.trim();
	if (located) return located;
	for (const path of CANDIDATE_PATHS) {
		if (await exists(path)) return path;
	}
	return undefined;
}

/** agy ships its own OAuth client; the installed binary is where it lives. */
export async function clientsFromAgy(): Promise<AgyClient[]> {
	const binary = await findAgyBinary();
	if (!binary) return [];
	const found = await run("grep", ["-a", "-Eo", SCAN_PATTERN, binary]);
	return found ? extractClients(found) : [];
}

export function clientCachePath(): string {
	return process.env.PI_AGY_CLIENT_FILE ?? join(homedir(), ".pi", "agent", "agy-client.json");
}

export async function readCachedClient(): Promise<AgyClient | undefined> {
	try {
		const parsed = JSON.parse(await readFile(clientCachePath(), "utf8")) as Partial<AgyClient>;
		if (typeof parsed.clientId === "string" && typeof parsed.clientSecret === "string" && parsed.clientId && parsed.clientSecret) {
			return { clientId: parsed.clientId, clientSecret: parsed.clientSecret };
		}
	} catch {
		// no cache yet, or unreadable: fall back to the binary
	}
	return undefined;
}

export async function rememberClient(client: AgyClient): Promise<void> {
	try {
		const path = clientCachePath();
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, `${JSON.stringify(client, null, 2)}\n`, { mode: 0o600 });
	} catch {
		// a cache miss only costs another scan later
	}
}

/** "invalid_client" means this pair is wrong; any other failure is about the refresh token and is reported as-is. */
type Validation = { ok: true } | { ok: false; reason: "invalid_client" };

async function validate(client: AgyClient, refresh: string, signal?: AbortSignal): Promise<Validation> {
	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: client.clientId,
			client_secret: client.clientSecret,
			refresh_token: refresh,
			grant_type: "refresh_token",
		}),
		signal,
	});
	const text = await response.text();
	let body: { access_token?: unknown; error?: unknown; error_description?: unknown } = {};
	try {
		body = JSON.parse(text) as typeof body;
	} catch {
		body = {};
	}
	if (response.ok && typeof body.access_token === "string" && body.access_token) return { ok: true };
	// Google may reject a wrong pair with JSON invalid_client or with a bare 401/403.
	if (body.error === "invalid_client" || response.status === 401 || response.status === 403) {
		return { ok: false, reason: "invalid_client" };
	}
	const detail = typeof body.error_description === "string" ? body.error_description : typeof body.error === "string" ? body.error : text.slice(0, 300);
	throw new Error(`Antigravity token request failed (${response.status}): ${detail}`);
}

/** The pair that actually refreshes this account, cached after the first success. */
export async function resolveClient(refresh: string, signal?: AbortSignal): Promise<AgyClient> {
	const cached = await readCachedClient();
	if (cached) {
		const result = await validate(cached, refresh, signal);
		if (result.ok) return cached;
	}

	for (const candidate of await clientsFromAgy()) {
		if (cached && candidate.clientId === cached.clientId && candidate.clientSecret === cached.clientSecret) continue;
		if (signal?.aborted) throw new Error("Request was aborted");
		const result = await validate(candidate, refresh, signal);
		if (result.ok) {
			await rememberClient(candidate);
			return candidate;
		}
	}
	throw new Error("No working Antigravity OAuth client found. Install agy (its client lives in the binary) or set AGY_BINARY.");
}

/** Candidates for a browser sign-in, where no refresh token exists yet to test them against. */
export async function loginClients(): Promise<AgyClient[]> {
	const cached = await readCachedClient();
	const fromBinary = await clientsFromAgy();
	return cached ? [cached, ...fromBinary] : fromBinary;
}
