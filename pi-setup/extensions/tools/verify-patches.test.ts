import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PI_SETUP = join(import.meta.dir, "..", "..");
const SCRIPT = join(PI_SETUP, "verify-patches.sh");
const homes: string[] = [];

afterEach(() => {
	for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

/** a HOME in which every check this file covers passes. */
function healthyHome(): string {
	const home = mkdtempSync(join(tmpdir(), "verify-patches-"));
	homes.push(home);
	const agent = join(home, ".pi", "agent");

	mkdirSync(join(agent, "agents"), { recursive: true });
	for (const f of readdirSync(join(PI_SETUP, "agents"))) {
		copyFileSync(join(PI_SETUP, "agents", f), join(agent, "agents", f));
	}

	writeFileSync(join(agent, "settings.json"), JSON.stringify({ packages: ["npm:pi-some-allowed-pkg@1.0.0"] }));
	copyFileSync(join(PI_SETUP, "mcp.json"), join(agent, "mcp.json"));
	return home;
}

function audit(home: string, binDir?: string): string[] {
	const PATH = binDir ? `${binDir}:${process.env.PATH}` : process.env.PATH;
	const run = spawnSync("bash", [SCRIPT], { env: { ...process.env, HOME: home, PATH }, encoding: "utf-8" });
	return run.stdout.replace(/\x1b\[[0-9;]*m/g, "").split("\n");
}

function verdict(lines: string[], label: string): string | undefined {
	return lines.find((l) => /^(PASS|FAIL|WARN) {2}/.test(l) && l.includes(label));
}

const sha16 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex").slice(0, 16);

/** a pi package with all three entrypoints and a current build of ours; `pi` on PATH is bin/pi. */
function fakePi(entry: string) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "verify-entry-")));
	homes.push(root);
	const pkg = join(root, "pkg");
	const write = (file: string, text: string, mode = 0o644) => {
		mkdirSync(join(pkg, file, ".."), { recursive: true });
		writeFileSync(join(pkg, file), text, { mode });
	};
	write("package.json", JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "1.3.0" }));
	for (const cli of ["dist/cli.js", "dist/bundle/cli.js", "dist/muzzpi-bundle/cli.js"]) write(cli, "#!/usr/bin/env node\n", 0o755);
	write("dist/core/keybindings.js", "patched");
	const builder = readFileSync(join(PI_SETUP, "pi-bundle", "build-pi-bundle.mjs"));
	write(
		"dist/muzzpi-bundle/.muzzpi-build.json",
		JSON.stringify({ piVersion: "1.3.0", builder: sha16(builder), files: ["cli.js"], inputs: { "dist/core/keybindings.js": sha16("patched") } }),
	);
	mkdirSync(join(root, "bin"));
	symlinkSync(join(pkg, entry), join(root, "bin", "pi"));
	return { pkg, bin: join(root, "bin"), write };
}

/** the audit with pi-setup/agent-models.json deployed and a `pi --list-models` that prints `rows`. */
function modelsAudit(rows: string[]): string[] {
	const pi = fakePi("dist/muzzpi-bundle/cli.js");
	const table = ["provider model context max-out thinking images", ...rows.map((r) => `${r} 1M 64K yes yes`)].join("\n");
	pi.write("dist/muzzpi-bundle/cli.js", `#!/usr/bin/env node\nif (process.argv.includes("--list-models")) console.log(${JSON.stringify(table)});\n`, 0o755);
	const home = healthyHome();
	copyFileSync(join(PI_SETUP, "agent-models.json"), join(home, ".pi", "agent", "agent-models.json"));
	return audit(home, pi.bin);
}

function entrypoint(bin: string): { line?: string; fix?: string } {
	const lines = audit(healthyHome(), bin);
	const at = lines.findIndex((l) => /^(PASS|FAIL|WARN) {2}pi entrypoint/.test(l));
	return { line: lines[at], fix: lines[at + 1] };
}

describe("verify-patches.sh", () => {
	test("a healthy home passes every covered check", () => {
		const lines = audit(healthyHome());
		for (const label of ["agent prompts", "removed packages", "MCP:"]) {
			expect(verdict(lines, label)).toStartWith("PASS");
		}
	}, 60_000);

	test("the adapter's MCP config fails and every problem is named", () => {
		const home = healthyHome();
		const agent = join(home, ".pi", "agent");
		writeFileSync(join(agent, "settings.json"), JSON.stringify({ extensions: ["-builtin:mcp"] }));
		writeFileSync(join(agent, "mcp.json"), JSON.stringify({ mcpServers: { a: { url: "http://x", auth: "oauth" }, b: { url: "http://y", description: "ok", auth: { provider: "github" } } } }));
		const line = verdict(audit(home), "MCP:");
		expect(line).toStartWith("FAIL");
		expect(line).toContain("a has no description");
		expect(line).toContain("a has the adapter's auth key");
		expect(line).not.toContain("b has");
		expect(line).toContain("settings.json disables builtin:mcp");
	}, 60_000);

	test("unreadable MCP files fail instead of passing", () => {
		const home = healthyHome();
		unlinkSync(join(home, ".pi", "agent", "settings.json"));
		writeFileSync(join(home, ".pi", "agent", "mcp.json"), "{ not json");
		expect(verdict(audit(home), "MCP:")).toStartWith("FAIL");
	}, 60_000);

	test("a missing agent prompt fails and is named", () => {
		const home = healthyHome();
		unlinkSync(join(home, ".pi", "agent", "agents", "agent.amp.chad.md"));
		const line = verdict(audit(home), "agent prompts");
		expect(line).toStartWith("FAIL");
		expect(line).toContain("agent.amp.chad.md");
	}, 60_000);

	test("a package that only shares a name with a removed one is not flagged", () => {
		const home = healthyHome();
		writeFileSync(
			join(home, ".pi", "agent", "settings.json"),
			JSON.stringify({ packages: ["npm:@someone/pi-ask", "npm:pi-ask-better@1.0.0"] }),
		);
		expect(verdict(audit(home), "removed packages")).toStartWith("PASS");
	}, 60_000);

	test("a removed package that comes back fails, wherever it lands", () => {
		const home = healthyHome();
		const agent = join(home, ".pi", "agent");
		mkdirSync(join(agent, "git", "github.com", "davebcn87", "pi-autoresearch"), { recursive: true });
		writeFileSync(join(agent, "settings.json"), JSON.stringify({ packages: ["npm:pi-web-access@1.0.0"] }));
		mkdirSync(join(agent, "extensions"), { recursive: true });
		writeFileSync(join(agent, "extensions", "todos.ts"), "");
		const line = verdict(audit(home), "removed packages");
		expect(line).toStartWith("FAIL");
		expect(line).toContain("pi-autoresearch");
		expect(line).toContain("extensions/todos.ts");
		expect(line).toContain("settings.json→pi-web-access");
	}, 60_000);
});

describe("verify-patches.sh: pi entrypoint", () => {
	const REBUILD = /fix: node pi-setup\/pi-bundle\/build-pi-bundle\.mjs --pkg '.+' --link '.+\/bin\/pi'/;

	test("our bundle, current with the patched files, passes", () => {
		expect(entrypoint(fakePi("dist/muzzpi-bundle/cli.js").bin).line).toStartWith("PASS  pi entrypoint: our bundle");
	}, 60_000);

	test("our bundle fails once a patched file changes, naming the file", () => {
		const pi = fakePi("dist/muzzpi-bundle/cli.js");
		pi.write("dist/core/keybindings.js", "patched, then edited");
		const { line, fix } = entrypoint(pi.bin);
		expect(line).toStartWith("FAIL");
		expect(line).toContain("dist/core/keybindings.js");
		expect(fix).toMatch(REBUILD);
	}, 60_000);

	test("our bundle fails after a pi update it was not rebuilt for", () => {
		const pi = fakePi("dist/muzzpi-bundle/cli.js");
		pi.write("package.json", JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "1.3.1" }));
		expect(entrypoint(pi.bin).line).toContain("built from pi 1.3.0, installed is 1.3.1");
	}, 60_000);

	test("our bundle fails when its build record is gone", () => {
		const pi = fakePi("dist/muzzpi-bundle/cli.js");
		unlinkSync(join(pi.pkg, "dist", "muzzpi-bundle", ".muzzpi-build.json"));
		expect(entrypoint(pi.bin).line).toStartWith("FAIL");
	}, 60_000);

	test("pi's own bundle fails and sends you to the installer, which re-applies the patches before building", () => {
		const { line, fix } = entrypoint(fakePi("dist/bundle/cli.js").bin);
		expect(line).toStartWith("FAIL  pi entrypoint: pi's own bundle");
		expect(fix).toBe("    fix: bash pi-setup/install.sh");
	}, 60_000);

	test("the modular CLI warns without failing the audit", () => {
		const { line, fix } = entrypoint(fakePi("dist/cli.js").bin);
		expect(line).toStartWith("WARN  pi entrypoint: modular CLI");
		expect(fix).toMatch(REBUILD);
	}, 60_000);
});

describe("verify-patches.sh: sub-agent models", () => {
	test("a provider you have not logged in to yet warns, naming it, and the check still passes", () => {
		const lines = modelsAudit(["deepseek deepseek-flash", "deepseek deepseek-v4-pro", "river deepseek-ai/DeepSeek-V4.1-Flash", "openrouter z-ai/glm-5.3-flash"]);
		expect(verdict(lines, "sub-agents: agent-models.json")).toStartWith("PASS");
		const warn = verdict(lines, "not logged in");
		expect(warn).toStartWith("WARN");
		expect(warn).toContain("not logged in to anthropic yet");
	}, 60_000);

	test("a model its logged-in provider does not have fails", () => {
		const lines = modelsAudit([
			"anthropic claude-opus-5-5",
			"anthropic claude-sonnet-5-5",
			"deepseek deepseek-flash",
			"deepseek deepseek-v4-pro",
			"river deepseek-ai/DeepSeek-V4.1-Flash",
			"openrouter z-ai/glm-5.3-flash",
		]);
		const line = verdict(lines, "sub-agents: agent-models.json");
		expect(line).toStartWith("FAIL");
		expect(line).toContain("haiku → anthropic/claude-haiku-5-5: pi has no such model");
		expect(verdict(lines, "not logged in")).toBeUndefined();
	}, 60_000);
});
