import { describe, expect, test } from "bun:test";
import { crc32 } from "node:zlib";
import { addedLines, blockMessage, findSecrets, type Added, type KnownSecret } from "./secret-scan";

const line = (text: string, file = "src/app.ts", n = 1): Added => ({ file, oldFile: file, line: n, text });
const scan = (texts: string[], known: KnownSecret[] = []) => findSecrets(texts.map((text, i) => line(text, "f.txt", i + 1)), known);

/** a Stripe-format key built here, so the source holds no literal key for GitHub's push protection to refuse */
const stripeLive = (body: string) => ["sk", "live", body].join("_");

/** a classic GitHub token whose checksum holds, built the way GitHub builds them */
function githubToken(random: string): string {
	const digits = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
	let n = crc32(random);
	let check = "";
	do {
		check = digits[n % 62] + check;
		n = Math.floor(n / 62);
	} while (n > 0);
	return `ghp_${random}${check.padStart(6, "0")}`;
}

describe("the lines that blocked real overnight commits now pass", () => {
	// each one stopped a crawlapi-v2 commit in November 2026; none was a secret
	const falseAlarms = [
		String.raw`_DSN = re.compile(r"^postgresql://([a-z_][a-z0-9_]*):[A-Za-z0-9_.~-]+@postgres:5432/crawlapi$")`,
		"| `API_DATABASE_URL` | `postgresql://crawlapi_api:<password>@postgres:5432/crawlapi` |",
		`"DATABASE_URL": "postgresql://crawlapi:ci-password-not-real@postgres:5432/crawlapi",`,
		`"CHROME_EXITS": "us=http://exit-login:exit-password@203.0.113.9:18443",`,
		`chrome_exits=("us=http://exit-login:pass-word@203.0.113.9:18443",)`,
		`    assert local.renders[0][0] == "Bearer worker-token-for-tests"`,
		`["content-security-policy", "report-uri https://browser-intake-datadoghq.com/api/v2/logs?dd-api-key=pub8a1c40f6b0e2d9a73e5b1c8f04d6a2e9"]`,
		`  "pages/CONTENT/none/secretberryspa-facial-rendered": "9f3a1c0b7e2d4a65",`,
	];

	test("none of them blocks", () => {
		expect(scan(falseAlarms).blocked).toEqual([]);
	});

	test("the ones the screen scrubber would hide are listed as warnings instead", () => {
		expect(scan(falseAlarms).warned.length).toBeGreaterThan(0);
	});
});

describe("what blocks", () => {
	test("a value of the user's own secrets, named by its source", () => {
		const known = [{ value: "s3cr3t-Vault-Value-9f2k", label: "your psst secret DB_PASSWORD" }];
		const { blocked } = scan(["const url = `postgres://app:s3cr3t-Vault-Value-9f2k@db/app`;"], known);
		expect(blocked).toMatchObject([{ file: "f.txt", line: 1, what: "your psst secret DB_PASSWORD", own: true }]);
	});

	test("an allow marker never clears the user's own secret", () => {
		const known = [{ value: "s3cr3t-Vault-Value-9f2k", label: "your psst secret DB_PASSWORD" }];
		expect(scan(["pw = 's3cr3t-Vault-Value-9f2k' # pi:allow-secret"], known).blocked).toHaveLength(1);
	});

	test("a GitHub token whose checksum holds; a look-alike that fails it does not", () => {
		const real = githubToken("Q7wE3rT9yU1iO5pA8sD2fG6hJ4kL0z");
		const forged = `${real.slice(0, -1)}${real.endsWith("A") ? "B" : "A"}`;
		expect(scan([`token: ${real}`]).blocked).toMatchObject([{ what: "a GitHub token" }]);
		expect(scan([`token: ${forged}`]).blocked).toEqual([]);
	});

	test("a provider key with a random body; the same format filled with a made-up body does not", () => {
		expect(scan([`STRIPE=${stripeLive("51NzQ8rKfP2xW7vLm3TbY9cHd")}`]).blocked).toMatchObject([{ what: "a Stripe live key" }]);
		for (const fake of [stripeLive("x".repeat(24)), stripeLive("testkeyfortheunitsuite01"), "AKIAIOSFODNN7EXAMPLE"]) {
			expect(scan([`key = "${fake}"`]).blocked).toEqual([]);
		}
	});

	test("a made-up key in a test can be allowed on its line", () => {
		const key = stripeLive("51NzQ8rKfP2xW7vLm3TbY9cHd");
		expect(scan([`fixture = "${key}"  # pi:allow-secret`]).blocked).toEqual([]);
		expect(scan([`fixture = "${key}"  // gitleaks:allow`]).blocked).toEqual([]);
	});

	test("a private key with a real body; a shortened placeholder does not", () => {
		const body = ["MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj", "MZR4fHq1Ls2nX0vB6tYwPq9KcR3uE8dGh5JmNx7LbVfWzS2oA4iDy1TeQjU6pHg"];
		const lines = ["-----BEGIN PRIVATE KEY-----", ...body, "-----END PRIVATE KEY-----"];
		expect(scan(lines).blocked).toMatchObject([{ line: 1, what: "a private key" }]);
		expect(scan(["-----BEGIN RSA PRIVATE KEY-----", "MIIEpAIBAAKCAQEA...", "-----END RSA PRIVATE KEY-----"]).blocked).toEqual([]);
	});
});

describe("addedLines reads git's diff exactly", () => {
	test("new-side line numbers, a removed line that starts with `--`, and the old path of a rename", () => {
		const diff = [
			"diff --git a/old.ts b/new.ts",
			"similarity index 90%",
			"rename from old.ts",
			"rename to new.ts",
			"--- a/old.ts",
			"+++ b/new.ts",
			"@@ -3,2 +3,2 @@",
			"--- a dashed comment line",
			"-gone",
			"+kept",
			"+added",
			"@@ -10 +10,0 @@",
			"-only removed",
			"diff --git a/b.ts b/b.ts",
			"--- a/b.ts",
			"+++ b/b.ts",
			"@@ -0,0 +1 @@",
			"+first",
		].join("\n");
		expect(addedLines(diff)).toEqual([
			{ file: "new.ts", oldFile: "old.ts", line: 3, text: "kept", commit: undefined },
			{ file: "new.ts", oldFile: "old.ts", line: 4, text: "added", commit: undefined },
			{ file: "b.ts", oldFile: "b.ts", line: 1, text: "first", commit: undefined },
		]);
	});

	test("a quoted path with non-ASCII bytes and a new file", () => {
		const diff = ['--- /dev/null', '+++ "b/caf\\303\\251 menu.txt"', "@@ -0,0 +1 @@", "+x"].join("\n");
		expect(addedLines(diff)).toMatchObject([{ file: "café menu.txt", line: 1 }]);
	});
});

describe("the block message", () => {
	test("tells the agent to fix it itself, names the env var, and never prints the value", () => {
		const message = blockMessage([{ file: "a.ts", line: 3, what: "your psst secret STRIPE_KEY", own: true, match: "sk_123" }], "commit");
		expect(message).toContain("a.ts:3  your psst secret STRIPE_KEY");
		expect(message).toContain("no need to ask the user");
		expect(message).toContain("process.env.STRIPE_KEY");
		expect(message).not.toContain("sk_123");
		expect(message).not.toMatch(/STOP|Do NOT retry/);
	});
});
