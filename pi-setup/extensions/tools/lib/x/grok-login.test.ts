import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FILE_LOCK_DIR_ENV } from "../file-lock";
import { grokCliLogin, hasGrokLogin } from "./grok-login";

let home: string;
const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
const writeAuth = (key: string, expiresAt: string) =>
	writeFileSync(join(home, "auth.json"), JSON.stringify({ "https://auth.x.ai::client": { key, expires_at: expiresAt, refresh_token: "r" } }));

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "grok-home-"));
	mkdirSync(join(home, "bin"));
	process.env[FILE_LOCK_DIR_ENV] = mkdtempSync(join(tmpdir(), "locks-"));
});

function login(onRun: (env: NodeJS.ProcessEnv) => void = () => {}) {
	const runs: NodeJS.ProcessEnv[] = [];
	const source = grokCliLogin({
		grokHome: home,
		grokBin: "/fake/grok",
		runGrok: async (_bin, env) => {
			runs.push(env);
			await Bun.sleep(20);
			onRun(env);
		},
	});
	return { source, runs };
}

describe("Grok CLI login", () => {
	test("a token with time left is used as stored, without running the CLI", async () => {
		writeAuth("tok-1", inMinutes(120));
		const { source, runs } = login();
		expect(await source.get()).toBe("tok-1");
		expect(runs).toHaveLength(0);
	});

	test("a token about to expire is renewed by the CLI with a wide refresh window", async () => {
		writeAuth("tok-old", inMinutes(5));
		const { source, runs } = login(() => writeAuth("tok-new", inMinutes(360)));
		expect(await source.get()).toBe("tok-new");
		expect(runs[0].GROK_AUTH_EARLY_INVALIDATION_SECS).toBe("86400");
	});

	test("concurrent callers share one renewal", async () => {
		writeAuth("tok-old", inMinutes(5));
		const { source, runs } = login(() => writeAuth("tok-new", inMinutes(360)));
		const tokens = await Promise.all([source.get(), source.get(), source.get()]);
		expect(tokens).toEqual(["tok-new", "tok-new", "tok-new"]);
		expect(runs).toHaveLength(1);
	});

	test("when renewal changes nothing, a still-valid token is used for its last minutes", async () => {
		writeAuth("tok-old", inMinutes(5));
		const { source } = login();
		expect(await source.get()).toBe("tok-old");
	});

	test("an expired token that cannot be renewed gives no token", async () => {
		writeAuth("tok-dead", inMinutes(-1));
		const { source } = login();
		expect(await source.get()).toBeUndefined();
	});

	test("after a rejection, a token another process already renewed is taken without running the CLI", async () => {
		writeAuth("tok-renewed-elsewhere", inMinutes(360));
		const { source, runs } = login();
		expect(await source.refresh!("tok-rejected")).toBe("tok-renewed-elsewhere");
		expect(runs).toHaveLength(0);
	});

	test("a rejected token is renewed even though its expiry looks fine", async () => {
		writeAuth("tok-rejected", inMinutes(300));
		const { source, runs } = login(() => writeAuth("tok-new", inMinutes(360)));
		expect(await source.refresh!("tok-rejected")).toBe("tok-new");
		expect(runs).toHaveLength(1);
	});

	test("hasGrokLogin reflects whether auth.json holds a key", () => {
		expect(hasGrokLogin(home)).toBe(false);
		writeAuth("k", inMinutes(10));
		expect(hasGrokLogin(home)).toBe(true);
	});
});
