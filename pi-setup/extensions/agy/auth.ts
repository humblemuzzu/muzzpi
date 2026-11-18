import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import type { OAuthAuth, OAuthCredential, ProviderAuth } from "@earendil-works/pi-ai";
import { loginClients, rememberClient, resolveClient, TOKEN_URL, type AgyClient } from "./client";
import { errorText } from "./retry";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const REDIRECT_URI = "https://antigravity.google/oauth-callback";
const SCOPES = [
	"openid",
	"email",
	"profile",
	"https://www.googleapis.com/auth/aicode",
	"https://www.googleapis.com/auth/cclog",
	"https://www.googleapis.com/auth/cloud-platform",
	"https://www.googleapis.com/auth/experimentsandconfigs",
	"https://www.googleapis.com/auth/userinfo.email",
	"https://www.googleapis.com/auth/userinfo.profile",
];

export interface AntigravityToken {
	access: string;
	refresh: string;
	expires: number;
}

const BASE64_PREFIX = "go-keyring-base64:";
const HEX_PREFIX = "go-keyring-encoded:";
const RAW_PREFIX = "go-keyring-raw:";

function parseExpiry(value: unknown): number {
	if (typeof value === "number" && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		if (!Number.isNaN(parsed)) return parsed;
		const numeric = Number(value);
		if (Number.isFinite(numeric)) return numeric < 1e12 ? numeric * 1000 : numeric;
	}
	return 0;
}

export function decodeKeyringPayload(raw: string): AntigravityToken | undefined {
	let json = raw;
	if (raw.startsWith(BASE64_PREFIX)) json = Buffer.from(raw.slice(BASE64_PREFIX.length), "base64").toString("utf8");
	else if (raw.startsWith(HEX_PREFIX)) json = Buffer.from(raw.slice(HEX_PREFIX.length), "hex").toString("utf8");
	else if (raw.startsWith(RAW_PREFIX)) json = raw.slice(RAW_PREFIX.length);

	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return undefined;
	}
	const token = (parsed as { token?: Record<string, unknown> } | null)?.token;
	if (!token) return undefined;
	const access = token.access_token;
	const refresh = token.refresh_token;
	if (typeof access !== "string" || !access || typeof refresh !== "string" || !refresh) return undefined;
	return { access, refresh, expires: parseExpiry(token.expiry) };
}

function readKeychain(): Promise<string | undefined> {
	return new Promise((resolve) => {
		execFile(
			"security",
			["find-generic-password", "-s", "gemini", "-a", "antigravity", "-w"],
			{ timeout: 10_000, encoding: "utf8" },
			(error, stdout) => {
				if (error) {
					resolve(undefined);
					return;
				}
				const value = stdout.trim();
				resolve(value || undefined);
			},
		);
	});
}

export async function readKeyringToken(): Promise<AntigravityToken | undefined> {
	const payload = await readKeychain();
	return payload ? decodeKeyringPayload(payload) : undefined;
}

interface TokenResponse {
	access_token?: unknown;
	refresh_token?: unknown;
	expires_in?: unknown;
	error?: unknown;
	error_description?: unknown;
}

async function requestToken(body: Record<string, string>, signal?: AbortSignal): Promise<TokenResponse> {
	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(body),
		signal,
	});
	const text = await response.text();
	let parsed: TokenResponse = {};
	try {
		parsed = JSON.parse(text) as TokenResponse;
	} catch {
		parsed = {};
	}
	if (!response.ok || typeof parsed.access_token !== "string" || !parsed.access_token) {
		const detail =
			typeof parsed.error_description === "string"
				? parsed.error_description
				: typeof parsed.error === "string"
					? parsed.error
					: text.slice(0, 300);
		throw new Error(`Antigravity token request failed (${response.status}): ${detail}`);
	}
	return parsed;
}

export async function refreshAccessToken(refresh: string, signal?: AbortSignal): Promise<AntigravityToken> {
	const client = await resolveClient(refresh, signal);
	const parsed = await requestToken(
		{ client_id: client.clientId, client_secret: client.clientSecret, refresh_token: refresh, grant_type: "refresh_token" },
		signal,
	);
	const expiresIn = typeof parsed.expires_in === "number" && Number.isFinite(parsed.expires_in) ? parsed.expires_in : 3600;
	return {
		access: parsed.access_token as string,
		refresh: typeof parsed.refresh_token === "string" && parsed.refresh_token ? parsed.refresh_token : refresh,
		expires: Date.now() + expiresIn * 1000,
	};
}

function credentialOf(token: AntigravityToken): OAuthCredential {
	return { type: "oauth", access: token.access, refresh: token.refresh, expires: token.expires };
}

export async function importFromAgy(signal?: AbortSignal): Promise<OAuthCredential | undefined> {
	const token = await readKeyringToken();
	if (!token) return undefined;
	return credentialOf(await refreshAccessToken(token.refresh, signal));
}

function base64url(bytes: Buffer): string {
	return bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function exchangeCode(code: string, verifier: string, clients: readonly AgyClient[], signal: AbortSignal): Promise<OAuthCredential> {
	let rejected: Error | undefined;
	for (const client of clients) {
		try {
			const parsed = await requestToken(
				{
					client_id: client.clientId,
					client_secret: client.clientSecret,
					code,
					code_verifier: verifier,
					redirect_uri: REDIRECT_URI,
					grant_type: "authorization_code",
				},
				signal,
			);
			const refresh = typeof parsed.refresh_token === "string" ? parsed.refresh_token : "";
			if (!refresh) throw new Error("Antigravity did not return a refresh token; sign in again and grant offline access.");
			await rememberClient(client);
			const expiresIn = typeof parsed.expires_in === "number" && Number.isFinite(parsed.expires_in) ? parsed.expires_in : 3600;
			return { type: "oauth", access: parsed.access_token as string, refresh, expires: Date.now() + expiresIn * 1000 };
		} catch (error) {
			if (signal.aborted) throw error;
			const message = errorText(error);
			if (!message.includes("invalid_client")) throw error;
			rejected = error instanceof Error ? error : new Error(message);
		}
	}
	throw rejected ?? new Error("Antigravity sign-in failed: no usable OAuth client");
}

const oauth: OAuthAuth = {
	name: "Antigravity",
	async login(interaction) {
		interaction.notify({ type: "info", message: "Reading the Antigravity login from this Mac's keychain…" });
		const imported = await importFromAgy(interaction.signal).catch((error: unknown) => {
			if (interaction.signal.aborted) throw error;
			interaction.notify({
				type: "info",
				message: `The keychain login could not be used (${errorText(error)}). Signing in with the browser instead.`,
			});
			return undefined;
		});
		if (imported) {
			interaction.notify({ type: "info", message: "Using the Google account already signed in to Antigravity on this Mac." });
			return imported;
		}

		const clients = await loginClients();
		if (clients.length === 0) {
			throw new Error("Could not find Antigravity's OAuth client. Install agy, or point AGY_BINARY at its binary.");
		}
		const verifier = base64url(randomBytes(32));
		const challenge = base64url(createHash("sha256").update(verifier).digest());
		const url = `${AUTH_URL}?${new URLSearchParams({
			client_id: clients[0]!.clientId,
			redirect_uri: REDIRECT_URI,
			response_type: "code",
			scope: SCOPES.join(" "),
			code_challenge: challenge,
			code_challenge_method: "S256",
			access_type: "offline",
			prompt: "consent",
		}).toString()}`;
		interaction.notify({
			type: "auth_url",
			url,
			instructions: "Sign in with the Google account that holds Antigravity, then copy the code from the page you land on.",
		});
		const code = (await interaction.prompt({ type: "manual_code", message: "Antigravity authorization code" })).trim();
		if (!code) throw new Error("No authorization code entered.");
		return exchangeCode(code, verifier, clients, interaction.signal);
	},
	async refresh(credential, signal) {
		const next = await refreshAccessToken(String(credential.refresh), signal);
		return { ...credential, access: next.access, expires: next.expires };
	},
	async toAuth(credential) {
		return { apiKey: String(credential.access) };
	},
};

export const agyAuth: ProviderAuth = { oauth };
