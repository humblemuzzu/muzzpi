import { afterAll, beforeAll, expect, test } from "bun:test";
import { createBashTool } from "./bash";
import { HOLDER_ENV } from "./lib/file-lock";
import { READ_ONLY_BASH_ENV } from "./lib/read-only-bash";
import { SUB_AGENT_TOOLS_ENV } from "./lib/sub-agent-prompt";

const ROLE = { [SUB_AGENT_TOOLS_ENV]: "read,bash", [HOLDER_ENV]: "chad-role-test", [READ_ONLY_BASH_ENV]: "1" };
const saved = Object.fromEntries(Object.keys(ROLE).map((name) => [name, process.env[name]]));

beforeAll(() => Object.assign(process.env, ROLE));
afterAll(() => {
	for (const [name, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
});

test("a command a sub-agent runs does not inherit its role, so nothing it starts takes itself for a sub-agent", async () => {
	const tool = createBashTool() as any;
	const ctx = { cwd: "/tmp", sessionManager: { getSessionId: () => "bash-role-env-test" } };
	const names = Object.keys(ROLE);
	const cmd = `echo ${names.map((name) => `${name}=\${${name}:-unset}`).join(" ")}`;
	const result = await tool.execute("t", { cmd, timeout: 30 }, undefined, undefined, ctx);
	expect(result.structuredContent.output.trim()).toBe(names.map((name) => `${name}=unset`).join(" "));
	expect(process.env[SUB_AGENT_TOOLS_ENV]).toBe("read,bash");
});
