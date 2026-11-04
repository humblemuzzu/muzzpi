import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unreadableVaultNote } from "../psst-command";
import { findVault, listVaultEntries, loadSecrets, makeScrubber, saveSecret, setActiveTags, UNREADABLE_VAULT } from "./psst";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
const root = realpathSync(mkdtempSync(join(tmpdir(), "psst-vault-")));
const startCwd = process.cwd();
const startPassword = process.env.PSST_PASSWORD;
const startEnv = process.env.PSST_ENV;
const startPath = process.env.PATH;
const startGlobal = process.env.PSST_GLOBAL;

function restore(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

afterAll(() => {
	process.chdir(startCwd);
	restore("PSST_ENV", startEnv);
	restore("PATH", startPath);
	restore("PSST_GLOBAL", startGlobal);
	if (startPassword === undefined) delete process.env.PSST_PASSWORD;
	else process.env.PSST_PASSWORD = startPassword;
	rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
	setActiveTags([]);
	delete process.env.PSST_ENV;
});

/** encrypted the way psst-cli does it: WebCrypto AES-GCM, tag appended, 12-byte IV. */
async function seal(text: string, key: Buffer): Promise<{ sealed: Uint8Array; iv: Uint8Array }> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const cryptoKey = await crypto.subtle.importKey("raw", new Uint8Array(key), "AES-GCM", false, ["encrypt"]);
	return { sealed: new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cryptoKey, new TextEncoder().encode(text))), iv };
}

/** a project dir with a local vault holding `secrets`, made the current directory. */
async function vaultIn(name: string, key: Buffer, secrets: [string, string, string[]][], environment?: string): Promise<string> {
	const dir = join(root, name, ".psst", ...(environment ? ["envs", environment] : []));
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

function emptyVault(dir: string, files: string[]): string {
	mkdirSync(dir, { recursive: true });
	for (const file of files) writeFileSync(join(dir, file), "");
	return dir;
}

/** a project (made the current directory) and a home directory, both fresh; bun's os.homedir() ignores HOME, so findVault takes the home as an argument. */
function projectAndHome(name: string): { project: string; home: string } {
	const project = join(root, name, "project");
	const home = join(root, name, "home");
	mkdirSync(project, { recursive: true });
	mkdirSync(home, { recursive: true });
	process.chdir(project);
	return { project, home };
}

describe("findVault", () => {
	it("takes the legacy layout before envs/default, and the project before home", () => {
		const { project, home } = projectAndHome("order");
		emptyVault(join(home, ".psst"), ["vault.db"]);
		emptyVault(join(project, ".psst", "envs", "default"), ["vault.db"]);
		expect(findVault(home)).toEqual({
			dir: join(project, ".psst", "envs", "default"),
			global: false,
		});
		const legacy = emptyVault(join(project, ".psst"), ["vault.db"]);
		expect(findVault(home)).toEqual({ dir: legacy, global: false });
	});

	it("with PSST_ENV set looks only in envs/<name>, ignoring the legacy layout and envs/default", () => {
		const { project, home } = projectAndHome("psst-env");
		emptyVault(join(project, ".psst"), ["vault.db"]);
		emptyVault(join(project, ".psst", "envs", "default"), ["vault.db"]);
		process.env.PSST_ENV = "prod";
		expect(findVault(home)).toBeUndefined();
		const prod = emptyVault(join(project, ".psst", "envs", "prod"), ["vault.db"]);
		expect(findVault(home)).toEqual({ dir: prod, global: false });
	});

	it("with PSST_ENV set still tries the project before home", () => {
		const { project, home } = projectAndHome("psst-env-home");
		const globalProd = emptyVault(join(home, ".psst", "envs", "prod"), ["vault.db"]);
		process.env.PSST_ENV = "prod";
		expect(findVault(home)).toEqual({ dir: globalProd, global: true });
		const localProd = emptyVault(join(project, ".psst", "envs", "prod"), ["vault.db"]);
		expect(findVault(home)).toEqual({ dir: localProd, global: false });
	});

	it("treats an empty PSST_ENV as unset", () => {
		const { project, home } = projectAndHome("psst-env-empty");
		const legacy = emptyVault(join(project, ".psst"), ["vault.db"]);
		process.env.PSST_ENV = "";
		expect(findVault(home)).toEqual({ dir: legacy, global: false });
	});

	it("counts a config.json as a vault, flagged as unreadable unless a vault.db sits beside it", () => {
		const { project, home } = projectAndHome("config-marker");
		const dir = emptyVault(join(project, ".psst"), ["config.json"]);
		expect(findVault(home)).toEqual({ dir, global: false, configOnly: true });
		writeFileSync(join(dir, "vault.db"), "");
		expect(findVault(home)).toEqual({ dir, global: false });
	});

	it("lets a config-only vault in the project shadow a SQLite one in home, as psst picks the first marker", () => {
		const { project, home } = projectAndHome("config-shadow");
		emptyVault(join(home, ".psst"), ["vault.db"]);
		const local = emptyVault(join(project, ".psst", "envs", "default"), ["config.json"]);
		expect(findVault(home)).toEqual({
			dir: local,
			global: false,
			configOnly: true,
		});
	});
});

describe("PSST_ENV and config-only vaults in the loaders", () => {
	it("reads the secrets of the environment PSST_ENV names", async () => {
		process.env.PSST_PASSWORD = "envs";
		const key = sha256("envs");
		await vaultIn("envs", key, [["LEGACY", "legacy-value", []]]);
		await vaultIn("envs", key, [["PROD_ONLY", "prod-value", ["live"]]], "prod");
		expect((await loadSecrets()).map((s) => s.name)).toEqual(["LEGACY"]);
		process.env.PSST_ENV = "prod";
		expect(await loadSecrets()).toEqual([{ name: "PROD_ONLY", value: "prod-value", tags: ["live"] }]);
		expect(listVaultEntries()).toEqual([{ name: "PROD_ONLY", tags: ["live"] }]);
	});

	it("reads past a config-only vault to the next SQLite one, so its secrets stay scrubbed", () => {
		const { project, home } = projectAndHome("aws-vault");
		const global = emptyVault(join(home, ".psst"), ["vault.db"]);
		emptyVault(join(project, ".psst"), ["config.json"]);
		expect(findVault(home)?.configOnly).toBe(true);
		expect(findVault(home, { readable: true })).toEqual({ dir: global, global: true });
		const alone = projectAndHome("aws-vault-alone");
		emptyVault(join(alone.project, ".psst"), ["config.json"]);
		expect(findVault(alone.home, { readable: true })).toBeUndefined();
	});

	it("says in /psst why such a vault is empty", () => {
		const note = unreadableVaultNote({
			dir: "/work/app/.psst",
			global: false,
			configOnly: true,
		});
		expect(note).toContain("/work/app/.psst (this project)");
		expect(note).toContain(UNREADABLE_VAULT);
		expect(UNREADABLE_VAULT).toBe("this vault uses psst's AWS backend; only SQLite vaults are read");
	});
});

describe("saveSecret hands the CLI the vault the reader picked", () => {
	let bin: string;
	let out: string;

	beforeEach(() => {
		const dir = mkdtempSync(join(root, "fake-psst-"));
		bin = join(dir, "bin");
		out = join(dir, "out");
		mkdirSync(bin);
		mkdirSync(out);
		const script = join(bin, "psst");
		writeFileSync(
			script,
			[
				"#!/bin/sh",
				'printf \'%s\\n\' "$@" > "$PSST_TEST_OUT/args"',
				'printf \'global=%s env=%s\' "${PSST_GLOBAL-unset}" "${PSST_ENV-unset}" > "$PSST_TEST_OUT/env"',
				'cat > "$PSST_TEST_OUT/stdin"',
				"echo '{\"success\":true}'",
				"",
			].join("\n"),
		);
		chmodSync(script, 0o755);
		process.env.PATH = `${bin}:${startPath}`;
		process.env.PSST_TEST_OUT = out;
	});

	afterEach(() => {
		restore("PATH", startPath);
		restore("PSST_GLOBAL", startGlobal);
		delete process.env.PSST_TEST_OUT;
	});

	const args = () => readFileSync(join(out, "args"), "utf8").trim().split("\n");
	const childEnv = () => readFileSync(join(out, "env"), "utf8");

	it("passes --env when PSST_ENV is set, and still strips PSST_GLOBAL", async () => {
		const { project } = projectAndHome("save-env");
		emptyVault(join(project, ".psst", "envs", "prod"), ["vault.db"]);
		process.env.PSST_ENV = "prod";
		process.env.PSST_GLOBAL = "1";
		expect(await saveSecret("API_KEY", "value-1", ["a", "b"])).toBeUndefined();
		expect(args()).toEqual(["set", "API_KEY", "--stdin", "--json", "--env", "prod", "--tag", "a", "--tag", "b"]);
		expect(childEnv()).toBe("global=unset env=prod");
		expect(readFileSync(join(out, "stdin"), "utf8")).toBe("value-1");
	});

	it("does not run the CLI for a vault it cannot read back", async () => {
		const { project } = projectAndHome("save-aws");
		emptyVault(join(project, ".psst"), ["config.json"]);
		const failure = await saveSecret("API_KEY", "value-3", []);
		expect(failure).toContain(UNREADABLE_VAULT);
		expect(existsSync(join(out, "args"))).toBe(false);
	});
});
