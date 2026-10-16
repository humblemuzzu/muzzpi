import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
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

function audit(home: string): string[] {
	const run = spawnSync("bash", [SCRIPT], { env: { ...process.env, HOME: home }, encoding: "utf-8" });
	return run.stdout.replace(/\x1b\[[0-9;]*m/g, "").split("\n");
}

function verdict(lines: string[], label: string): string | undefined {
	return lines.find((l) => /^(PASS|FAIL) {2}/.test(l) && l.includes(label));
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
