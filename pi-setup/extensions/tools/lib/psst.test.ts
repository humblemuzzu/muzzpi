import { describe, expect, test } from "bun:test";
import { redactSecretPatterns, scrubToolResult } from "./psst";

/** built at runtime so the source never holds a key-shaped literal a secret scanner would flag. */
const fake = (...parts: string[]) => parts.join("");
const STRIPE_LIVE = fake("sk_", "live_", "51Hx9QkLmN8vR2tY4uW6zA3bC");
const WEBHOOK = fake("whsec_", "Q2xK9mN4pR7sT1vW3yZ5aB8cD");
const GITHUB = fake("ghp_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8");
const ANTHROPIC = fake("sk-ant-", "api03-Zx8Yw7Vu6Ts5Rq4Po3Nm2Lk1Jh0");
const AWS = fake("AKIA", "Z7Q2K9X4M1N8B3V6");
const JWT = fake("eyJhbGciOiJIUzI1NiJ9", ".", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", ".", "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U");
const TELEGRAM = fake("7194830265", ":AA", "Hf3kLm9Qx2Vb7Np4Rs8Tw1Yz6Cd5Eg0Jk");
const PEM = fake("-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\\n", "-----END PRIVATE KEY-----");

const scrub = (text: string) => text.replaceAll("hunter2", "<scrubbed>");

describe("scrubToolResult", () => {
	test("scrubs structuredContent too — returning content alone would drop it", () => {
		const out = scrubToolResult(
			{
				content: [{ type: "text", text: "$ env\n\npw=hunter2" }],
				structuredContent: { output: "pw=hunter2\n", nested: [{ v: "hunter2" }], exit_code: 0, truncated: false },
			},
			scrub,
		);
		expect(out!.content[0].text).toBe("$ env\n\npw=<scrubbed>");
		expect(out!.structuredContent).toEqual({
			output: "pw=<scrubbed>\n",
			nested: [{ v: "<scrubbed>" }],
			exit_code: 0,
			truncated: false,
		});
	});

	test("leaves images untouched and omits structuredContent when the tool had none", () => {
		const image = { type: "image", data: "hunter2", mimeType: "image/png" };
		const out = scrubToolResult({ content: [image, { type: "text", text: "hunter2" }] }, scrub);
		expect(out!.content[0]).toBe(image);
		expect(out!.content[1].text).toBe("<scrubbed>");
		expect("structuredContent" in out!).toBe(false);
	});

	test("a result with nothing to scrub is left alone", () => {
		expect(scrubToolResult({ content: [] }, scrub)).toBeUndefined();
	});
});

describe("redactSecretPatterns: secrets nobody registered", () => {
	test("known key formats, wherever they appear", () => {
		for (const secret of [STRIPE_LIVE, WEBHOOK, GITHUB, ANTHROPIC, AWS, JWT, TELEGRAM]) {
			const out = redactSecretPatterns(`the value is ${secret} ok`);
			expect({ secret, leaked: out.includes(secret) }).toEqual({ secret, leaked: false });
			expect(out).toStartWith("the value is [REDACTED");
		}
	});

	test("a private key inside a service-account JSON", () => {
		const out = redactSecretPatterns(`{"type": "service_account", "private_key": "${PEM}", "client_email": "a@b.iam"}`);
		expect(out).not.toContain("MIIEvQ");
		expect(out).toContain('"client_email": "a@b.iam"');
	});

	test("the crontab line from the 2026-10-12 session", () => {
		const token = "9f8e7d6c5b4a39281706f5e4d3c2b1a0";
		const line = `*/5 * * * * curl -s -H "Authorization: Bearer ${token}" https://staging.example.com/cron/telegram`;
		expect(redactSecretPatterns(line)).toBe(
			'*/5 * * * * curl -s -H "Authorization: Bearer [REDACTED]" https://staging.example.com/cron/telegram',
		);
	});

	test("passwords in connection URLs, but not variable references", () => {
		expect(redactSecretPatterns("DATABASE_URL=postgres://app:Xk29fLp0qZ@db:5432/app")).toBe(
			"DATABASE_URL=postgres://app:[REDACTED]@db:5432/app",
		);
		expect(redactSecretPatterns("https://x:${GH_TOKEN}@github.com/o/r.git")).toBe("https://x:${GH_TOKEN}@github.com/o/r.git");
		expect(redactSecretPatterns("postgres://tube2text:Xk29fLp0qZ@postgres:5432/db")).toBe("postgres://tube2text:[REDACTED]@postgres:5432/db");
		for (const local of ["postgres://u:p4ss@127.0.0.1:5434/app_test", "postgres://ownaeo:ownaeo@localhost:5434/ownaeo_test"]) {
			expect(redactSecretPatterns(local)).toBe(local);
		}
	});

	test("values assigned to secret-sounding names in env, YAML, JSON and markdown", () => {
		const cases: [string, string][] = [
			["DB_PASSWORD=Hn38dkQ0zLm", "DB_PASSWORD=[REDACTED]"],
			['export DODO_API_KEY="dp9Kx2LmQ8vN3rT"', 'export DODO_API_KEY="[REDACTED]"'],
			["  password: s3cr3t-Pa55word", "  password: [REDACTED]"],
			['{"admin_token": "q8Wn2Lk5Zp9Rx4"}', '{"admin_token": "[REDACTED]"}'],
			["| Netcup panel password | `Gh7!kd92@Lq` |", "| Netcup panel password | `[REDACTED]` |"],
			["https://api.example.com/v1?api_key=k4Jd8Qm2Xn7&x=1", "https://api.example.com/v1?api_key=[REDACTED]&x=1"],
		];
		for (const [input, expected] of cases) expect(redactSecretPatterns(input)).toBe(expected);
	});

	test("the shapes the real playbooks use, found by running this over them", () => {
		const hex48 = "4867af0c".repeat(6);
		const cases: [string, string][] = [
			[`| \`POSTGRES_PASSWORD\` | \`${hex48}\` | \`openssl rand -hex 24\` |`, "| `POSTGRES_PASSWORD` | `[REDACTED]` | `openssl rand -hex 24` |"],
			[`| \`WEBHOOK_SIGNING_SECRET\` | \`${hex48}\` |`, "| `WEBHOOK_SIGNING_SECRET` | `[REDACTED]` |"],
			[`| \`DODO_PAYMENTS_API_KEY\` | \`Ktx9QmL2pR7vN4sB.${hex48}\` |`, "| `DODO_PAYMENTS_API_KEY` | `[REDACTED]` |"],
			[`https://ownaeo.com/?ownaeokey=${hex48.slice(0, 32)}`, "https://ownaeo.com/?ownaeokey=[REDACTED]"],
			[`Cookie: \`ownaeo_gate=${hex48.slice(0, 32)}\`, one year`, "Cookie: `ownaeo_gate=[REDACTED]`, one year"],
		];
		for (const [input, expected] of cases) expect(redactSecretPatterns(input)).toBe(expected);
		for (const line of [
			"export CLOUDFLARE_ZONE_ID=3f1c9a7e5b2d4c8f9e0a1b2c3d4e5f60",
			"curl 'https://tube2text.com/v1/transcript?video_id=dQw4w9WgXcQ'",
			"webhook `we_1PqRsTuVwXyZ0123456789ab`",
			"cache_key=user:42",
			"| tokens used | 123456789 |",
		]) {
			expect(redactSecretPatterns(line)).toBe(line);
		}
	});

	test("found in review: shapes that were missed", () => {
		const basic = Buffer.from("deploy:Kd8sL2mQ9xR4").toString("base64");
		const cases: [string, string][] = [
			["REDIS_URL=redis://:Xk29fLp0qZ@redis:6379/0", "REDIS_URL=redis://:[REDACTED]@redis:6379/0"],
			[`Authorization: Basic ${basic}`, "Authorization: Basic [REDACTED]"],
			["GPG_PASSPHRASE=Kd8sL2mQ9xR4", "GPG_PASSPHRASE=[REDACTED]"],
			["db_pwd: Kd8sL2mQ9xR4", "db_pwd: [REDACTED]"],
			[`${fake("https://hooks.slack.com/services/", "T0AAAAAAA/B0BBBBBBB/", "x9Kd8sL2mQ9xR4z7Wv3Np1Qe")}`, "https://hooks.slack.com/[REDACTED]"],
		];
		for (const [input, expected] of cases) expect(redactSecretPatterns(input)).toBe(expected);
	});

	test("found in review: code and identifiers that were redacted", () => {
		for (const line of [
			"secretKey: SecretKeyV2Provider,",
			"apiKey: useApi2KeyFromStorage,",
			"token = getOAuth2TokenFromCache",
			"secret_arn: arn:aws:secretsmanager:eu-west-1:123456789012:secret:prod-db-Ab12Cd",
			"cache_key: 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
			"session_token_id: 3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b",
			"public_key: MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE4k9x2Lm8Qz",
			"token_endpoint: https://oauth2.googleapis.com/token",
			"Use Basic Authentication for the admin panel.",
		]) {
			expect(redactSecretPatterns(line)).toBe(line);
		}
	});

	test("stays fast on input built to make it backtrack (it runs on every tool result)", () => {
		for (const text of ["token_".repeat(200_000), "passwordpassword".repeat(65_000) + "=x", "| token ".repeat(300_000)]) {
			const started = performance.now();
			redactSecretPatterns(text);
			expect(performance.now() - started).toBeLessThan(1000);
		}
	});

	test("code, references and placeholders stay readable, so files can still be edited", () => {
		for (const line of [
			"const token = req.headers.authorization;",
			"password: process.env.DB_PASSWORD",
			"DB_PASSWORD=${DB_PASSWORD}",
			'api_key = os.environ["API_KEY"]',
			"token: ${{ secrets.GITHUB_TOKEN }}",
			"SECRET_KEY=changeme",
			"POSTGRES_PASSWORD=POSTGRES_PASSWORD",
			"TOKEN_FILE=/run/secrets/api_token",
			"max_tokens: 4096",
			"tokens_used = 123456789",
			"| API token | kept in the vault |",
			"git@github.com:humblemuzzu/profilephoto.git",
			"Authorization: Bearer ${TOKEN}",
			"credentials: 'include'",
			"credentialMode: storageDiag.credentialMode,",
			"cachedSecrets = secrets;",
			"peeked = image ? token : textTokenFallback;",
			'const TEST_AUTH_SECRET = "test-only-secret-do-not-use-in-prod";',
			'process.env.R2_SECRET_ACCESS_KEY = "e2e-secret-key";',
			'const TEST_STRIPE_SECRET = "sk_test_e2e_profilephoto";',
			"api_key = api_key_v2_production",
			"rotated_refresh_token: tokenSet.refreshToken !== null,",
			"maxTokens: contextBudget.contextWindowTokens - contextBudget.reserveTokens,",
			'STORAGE_ACCESS_KEY: "AKIAIOSFODNN7EXAMPLE",',
		]) {
			expect(redactSecretPatterns(line)).toBe(line);
		}
	});
});
