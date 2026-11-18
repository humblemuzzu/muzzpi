import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeKeyringPayload, refreshAccessToken } from "./auth";

const FAKE_ID = ["123456789012-faketestclientfaketest", "apps.googleusercontent.com"].join(".");
const FAKE_SECRET = ["GOCSPX", "F".repeat(28)].join("-");

const originalFetch = globalThis.fetch;
const originalCache = process.env.PI_AGY_CLIENT_FILE;
const originalBinary = process.env.AGY_BINARY;

beforeEach(() => {
	const dir = mkdtempSync(join(tmpdir(), "agy-auth-"));
	const cache = join(dir, "client.json");
	writeFileSync(cache, JSON.stringify({ clientId: FAKE_ID, clientSecret: FAKE_SECRET }), { mode: 0o600 });
	process.env.PI_AGY_CLIENT_FILE = cache;
	process.env.AGY_BINARY = join(dir, "no-such-binary");
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	if (originalCache === undefined) delete process.env.PI_AGY_CLIENT_FILE;
	else process.env.PI_AGY_CLIENT_FILE = originalCache;
	if (originalBinary === undefined) delete process.env.AGY_BINARY;
	else process.env.AGY_BINARY = originalBinary;
});

function keyringJson(access: string, refresh: string, expiry: string): string {
	return JSON.stringify({ token: { access_token: access, token_type: "Bearer", refresh_token: refresh, expiry }, auth_method: "consumer" });
}

function base64(value: string): string {
	return `go-keyring-base64:${Buffer.from(value).toString("base64")}`;
}

describe("keychain payload", () => {
	const json = keyringJson("ya29.access", "1//refresh", "2026-11-18T15:25:57.899234+05:30");

	test("go-keyring-base64, the form agy 1.5.11 writes", () => {
		expect(decodeKeyringPayload(base64(json))).toEqual({
			access: "ya29.access",
			refresh: "1//refresh",
			expires: Date.parse("2026-11-18T15:25:57.899234+05:30"),
		});
	});

	test("go-keyring-encoded holds hex", () => {
		expect(decodeKeyringPayload(`go-keyring-encoded:${Buffer.from(json).toString("hex")}`)?.access).toBe("ya29.access");
	});

	test("go-keyring-raw and a bare JSON string are read as-is", () => {
		expect(decodeKeyringPayload(`go-keyring-raw:${json}`)?.refresh).toBe("1//refresh");
		expect(decodeKeyringPayload(json)?.refresh).toBe("1//refresh");
	});

	test("anything that is not a stored token yields nothing", () => {
		expect(decodeKeyringPayload("not json")).toBeUndefined();
		expect(decodeKeyringPayload(base64("{}"))).toBeUndefined();
		expect(decodeKeyringPayload(base64(JSON.stringify({ token: { access_token: "a" } })))).toBeUndefined();
	});

	test("expiry is accepted as ISO text, seconds or milliseconds", () => {
		expect(decodeKeyringPayload(base64(keyringJson("a", "r", "2026-11-18T10:00:00Z")))?.expires).toBe(Date.parse("2026-11-18T10:00:00Z"));
		expect(
			decodeKeyringPayload(base64(JSON.stringify({ token: { access_token: "a", refresh_token: "r", expiry: 1763450400 } })))?.expires,
		).toBe(1763450400000);
	});
});

describe("token refresh", () => {
	test("uses the cached client and returns the new access token", async () => {
		const bodies: URLSearchParams[] = [];
		globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
			bodies.push(new URLSearchParams(init?.body as URLSearchParams));
			return new Response(JSON.stringify({ access_token: "new-access", expires_in: 3599, token_type: "Bearer" }), { status: 200 });
		}) as typeof fetch;

		const token = await refreshAccessToken("1//refresh");
		const last = bodies.at(-1)!;
		expect(last.get("client_id")).toBe(FAKE_ID);
		expect(last.get("client_secret")).toBe(FAKE_SECRET);
		expect(last.get("grant_type")).toBe("refresh_token");
		expect(last.get("refresh_token")).toBe("1//refresh");
		expect(token.access).toBe("new-access");
		expect(token.refresh).toBe("1//refresh");
		expect(token.expires).toBeGreaterThan(Date.now() + 3500_000);
	});

	test("a revoked login is reported as such, not as a missing client", async () => {
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ error: "invalid_grant", error_description: "Token has been expired or revoked." }), {
				status: 400,
			})) as typeof fetch;
		await expect(refreshAccessToken("1//refresh")).rejects.toThrow("Token has been expired or revoked.");
	});

	test("an aborted refresh rejects instead of hanging", async () => {
		let started = false;
		globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
			new Promise((_resolve, reject) => {
				started = true;
				const abort = (): void => reject(new Error("Request aborted"));
				if (init?.signal?.aborted) {
					abort();
					return;
				}
				init?.signal?.addEventListener("abort", abort, { once: true });
			})) as typeof fetch;
		const controller = new AbortController();
		const pending = refreshAccessToken("1//refresh", controller.signal);
		while (!started) await new Promise((resolve) => setTimeout(resolve, 1));
		controller.abort();
		await expect(pending).rejects.toThrow("Request aborted");
	});
});
