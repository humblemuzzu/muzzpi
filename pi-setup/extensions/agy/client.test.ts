import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clientCachePath, extractClients, readCachedClient, rememberClient, resolveClient } from "./client";

const ID_A = ["1071006060591-faketestclientfaketest", "apps.googleusercontent.com"].join(".");
const ID_B = ["884354919052-othertestclientother", "apps.googleusercontent.com"].join(".");
const SECRET_A = ["GOCSPX", "A".repeat(28)].join("-");
const SECRET_B = ["GOCSPX", "B".repeat(28)].join("-");

const originalFetch = globalThis.fetch;
const originalCache = process.env.PI_AGY_CLIENT_FILE;
const originalBinary = process.env.AGY_BINARY;
let dir = "";

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "agy-client-"));
	process.env.PI_AGY_CLIENT_FILE = join(dir, "client.json");
	process.env.AGY_BINARY = join(dir, "no-such-binary");
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	if (originalCache === undefined) delete process.env.PI_AGY_CLIENT_FILE;
	else process.env.PI_AGY_CLIENT_FILE = originalCache;
	if (originalBinary === undefined) delete process.env.AGY_BINARY;
	else process.env.AGY_BINARY = originalBinary;
});

describe("reading agy's OAuth client", () => {
	test("extracts every id and secret, paired and de-duplicated", () => {
		const text = `${SECRET_A}\n${ID_A}\n${SECRET_A}\n${ID_B}\n${SECRET_B}`;
		const clients = extractClients(text);
		expect(clients).toHaveLength(4);
		expect(new Set(clients.map((client) => `${client.clientId}|${client.clientSecret}`)).size).toBe(4);
		expect(clients.every((client) => client.clientId.startsWith("1") || client.clientId.startsWith("8"))).toBe(true);
	});

	test("a file without the patterns yields nothing", () => {
		expect(extractClients("nothing to see here")).toEqual([]);
	});
});

describe("the client cache", () => {
	test("round-trips and stays private", async () => {
		await rememberClient({ clientId: ID_A, clientSecret: SECRET_A });
		expect(await readCachedClient()).toEqual({ clientId: ID_A, clientSecret: SECRET_A });
		expect(statSync(clientCachePath()).mode & 0o777).toBe(0o600);
		expect(readFileSync(clientCachePath(), "utf8")).toContain(ID_A);
	});

	test("a half-written cache is ignored", async () => {
		writeFileSync(clientCachePath(), JSON.stringify({ clientId: ID_A }));
		expect(await readCachedClient()).toBeUndefined();
	});
});

describe("picking a client that works", () => {
	test("uses the cache without needing the binary", async () => {
		await rememberClient({ clientId: ID_A, clientSecret: SECRET_A });
		globalThis.fetch = (async () => new Response(JSON.stringify({ access_token: "ok" }), { status: 200 })) as typeof fetch;
		expect(await resolveClient("1//refresh")).toEqual({ clientId: ID_A, clientSecret: SECRET_A });
	});

	test("falls back to the binary and keeps the pair that works", async () => {
		const fakeBinary = join(dir, "fake-agy");
		writeFileSync(fakeBinary, `${SECRET_A}\n${ID_A}\n${SECRET_B}\n`);
		process.env.AGY_BINARY = fakeBinary;
		const tried: string[] = [];
		globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
			const form = new URLSearchParams(init?.body as URLSearchParams);
			tried.push(String(form.get("client_secret")));
			if (form.get("client_secret") === SECRET_A) {
				return new Response(JSON.stringify({ error: "invalid_client", error_description: "invalid" }), { status: 401 });
			}
			return new Response(JSON.stringify({ access_token: "ok" }), { status: 200 });
		}) as typeof fetch;

		const client = await resolveClient("1//refresh");
		expect(client.clientSecret).toBe(SECRET_B);
		expect(tried[0]).toBe(SECRET_A);
		expect((await readCachedClient())?.clientSecret).toBe(SECRET_B);
	});

	test("a bare 401 from a wrong pair moves on instead of failing", async () => {
		const fakeBinary = join(dir, "fake-agy-401");
		writeFileSync(fakeBinary, `${SECRET_A}\n${ID_A}\n${SECRET_B}\n`);
		process.env.AGY_BINARY = fakeBinary;
		globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
			const form = new URLSearchParams(init?.body as URLSearchParams);
			if (form.get("client_secret") === SECRET_A) return new Response("Unauthorized", { status: 401 });
			return new Response(JSON.stringify({ access_token: "ok" }), { status: 200 });
		}) as typeof fetch;

		expect((await resolveClient("1//refresh")).clientSecret).toBe(SECRET_B);
	});

	test("no cache and no agy says so plainly", async () => {
		await expect(resolveClient("1//refresh")).rejects.toThrow("No working Antigravity OAuth client found");
	});

	test("a dead refresh token is not reported as a missing client", async () => {
		await rememberClient({ clientId: ID_A, clientSecret: SECRET_A });
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ error: "invalid_grant", error_description: "Token has been expired or revoked." }), {
				status: 400,
			})) as typeof fetch;
		await expect(resolveClient("1//refresh")).rejects.toThrow("Token has been expired or revoked.");
	});
});
