import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listVaultEntries, loadSecrets, makeScrubber, setActiveTags } from "./psst";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
const root = mkdtempSync(join(tmpdir(), "psst-vault-"));
const startCwd = process.cwd();
const startPassword = process.env.PSST_PASSWORD;

afterAll(() => {
	process.chdir(startCwd);
	if (startPassword === undefined) delete process.env.PSST_PASSWORD;
	else process.env.PSST_PASSWORD = startPassword;
	rmSync(root, { recursive: true, force: true });
});

beforeEach(() => setActiveTags([]));

/** encrypted the way psst-cli does it: WebCrypto AES-GCM, tag appended, 12-byte IV. */
async function seal(text: string, key: Buffer): Promise<{ sealed: Uint8Array; iv: Uint8Array }> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const cryptoKey = await crypto.subtle.importKey("raw", new Uint8Array(key), "AES-GCM", false, ["encrypt"]);
	return { sealed: new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cryptoKey, new TextEncoder().encode(text))), iv };
}

/** a project dir with a local vault holding `secrets`, made the current directory. */
async function vaultIn(name: string, key: Buffer, secrets: [string, string, string[]][]): Promise<string> {
	const dir = join(root, name, ".psst");
	mkdirSync(dir, { recursive: true });
	const db = new DatabaseSync(join(dir, "vault.db"));
	db.exec("CREATE TABLE secrets (name TEXT PRIMARY KEY, encrypted_value BLOB NOT NULL, iv BLOB NOT NULL, tags TEXT DEFAULT '[]')");
	for (const [secret, value, tags] of secrets) {
		const { sealed, iv } = await seal(value, key);
		db.prepare("INSERT INTO secrets (name, encrypted_value, iv, tags) VALUES (?, ?, ?, ?)").run(secret, sealed, iv, JSON.stringify(tags));
	}
	db.close();
	process.chdir(join(root, name));
	return join(dir, "vault.db");
}

const sha256 = (text: string) => createHash("sha256").update(text).digest();

describe("loadSecrets reads a psst vault", () => {
	it("decrypts every secret with a password-derived key", async () => {
		process.env.PSST_PASSWORD = "correct horse";
		await vaultIn("password", sha256("correct horse"), [["API_TOKEN", "tok-123456", ["infra"]], ["DB_URL", "postgres://x", []]]);
		expect(await loadSecrets()).toEqual([
			{ name: "API_TOKEN", value: "tok-123456", tags: ["infra"] },
			{ name: "DB_URL", value: "postgres://x", tags: [] },
		]);
	});

	it("uses a base64 32-byte key as is", async () => {
		const raw = randomBytes(32);
		process.env.PSST_PASSWORD = raw.toString("base64");
		await vaultIn("base64", raw, [["KEY_A", "value-a", []]]);
		expect((await loadSecrets()).map((s) => s.value)).toEqual(["value-a"]);
	});

	it("filters by tag", async () => {
		process.env.PSST_PASSWORD = "tags";
		await vaultIn("tags", sha256("tags"), [["A", "aaaa", ["x"]], ["B", "bbbb", ["y"]], ["C", "cccc", ["x", "y"]]]);
		setActiveTags(["x"]);
		expect((await loadSecrets()).map((s) => s.name)).toEqual(["A", "C"]);
	});

	it("sees a write right away", async () => {
		process.env.PSST_PASSWORD = "writes";
		const key = sha256("writes");
		const file = await vaultIn("writes", key, [["FIRST", "one-1111", []]]);
		expect((await loadSecrets()).map((s) => s.name)).toEqual(["FIRST"]);
		const { sealed, iv } = await seal("two-2222", key);
		const db = new DatabaseSync(file);
		db.prepare("INSERT INTO secrets (name, encrypted_value, iv, tags) VALUES (?, ?, ?, '[]')").run("SECOND", sealed, iv);
		db.close();
		expect((await loadSecrets()).map((s) => s.name)).toEqual(["FIRST", "SECOND"]);
	});

	it("does not cache a wrong key, so the right one works next", async () => {
		await vaultIn("wrong-key", sha256("right"), [["S", "secret-value", []]]);
		process.env.PSST_PASSWORD = "wrong";
		expect(await loadSecrets()).toEqual([]);
		process.env.PSST_PASSWORD = "right";
		expect((await loadSecrets()).map((s) => s.value)).toEqual(["secret-value"]);
	});

	it("scrubs every secret, even ones the tag filter keeps from the agent", async () => {
		process.env.PSST_PASSWORD = "scrub";
		await vaultIn("scrub", sha256("scrub"), [["WORK_KEY", "work-value-1", ["work"]], ["HOME_KEY", "home-value-2", ["home"]]]);
		setActiveTags(["work"]);
		expect((await loadSecrets()).map((s) => s.name)).toEqual(["WORK_KEY"]);
		const scrub = await makeScrubber();
		expect(scrub("a work-value-1 b home-value-2 c")).toBe("a [REDACTED:WORK_KEY] b [REDACTED:HOME_KEY] c");
	});

	it("lists names and tags without a key, and sees a write right away", async () => {
		delete process.env.PSST_PASSWORD;
		const file = await vaultIn("entries", sha256("unused"), [["B_KEY", "b", ["y"]], ["A_KEY", "a", ["x", "y"]]]);
		expect(listVaultEntries()).toEqual([{ name: "A_KEY", tags: ["x", "y"] }, { name: "B_KEY", tags: ["y"] }]);
		const db = new DatabaseSync(file);
		db.prepare("INSERT INTO secrets (name, encrypted_value, iv, tags) VALUES (?, ?, ?, ?)").run("C_KEY", randomBytes(20), randomBytes(12), "not json");
		db.close();
		expect(listVaultEntries().map((e) => `${e.name}:${e.tags.join("+")}`)).toEqual(["A_KEY:x+y", "B_KEY:y", "C_KEY:"]);
	});

	it("skips one undecryptable row and keeps the rest", async () => {
		process.env.PSST_PASSWORD = "corrupt";
		const file = await vaultIn("corrupt", sha256("corrupt"), [["GOOD", "good-value", []]]);
		const db = new DatabaseSync(file);
		db.prepare("INSERT INTO secrets (name, encrypted_value, iv, tags) VALUES (?, ?, ?, '[]')").run("BAD", randomBytes(40), randomBytes(12));
		db.close();
		expect((await loadSecrets()).map((s) => s.name)).toEqual(["GOOD"]);
	});
});
