import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme } from "@mariozechner/pi-coding-agent";
import { parseAgentModels, readModelSource, writeModelSource } from "../tools/lib/agent-models";
import { runModelsCommand } from "./model-source";
import { strip, theme } from "./test-helpers";

const shipped = parseAgentModels(JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "agent-models.json"), "utf-8")));
const startDir = process.env.PI_CODING_AGENT_DIR;
const agentDir = mkdtempSync(join(tmpdir(), "model-source-"));

beforeAll(() => {
	initTheme("dark");
	process.env.PI_CODING_AGENT_DIR = agentDir;
});
afterAll(() => {
	if (startDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = startDir;
	rmSync(agentDir, { recursive: true, force: true });
});
beforeEach(() => writeModelSource("list"));

function fakeCtx(mode = "tui") {
	const notices: string[] = [];
	const menus: Array<{ component: any; resolve: (value: unknown) => void }> = [];
	const ctx: any = {
		mode,
		hasUI: true,
		model: { provider: "anthropic", id: "claude-opus-5-5" },
		ui: {
			notify: (text: string) => notices.push(text),
			custom: (build: any) =>
				new Promise((resolve) => menus.push({ component: build({ requestRender() {} }, theme, {}, resolve), resolve })),
		},
	};
	return { ctx, notices, menus };
}

describe("/agents models", () => {
	test("the shipped file lets delegate, oracle and review_code follow the main model", async () => {
		const { ctx, notices } = fakeCtx();
		await runModelsCommand("main", ctx, shipped);
		expect(readModelSource()).toBe("main");
		expect(notices[0]).toContain("delegate, oracle and review_code now run on the main session's model (claude-opus-5-5 right now)");
		await runModelsCommand("own", ctx, shipped);
		expect(readModelSource()).toBe("list");
	});

	test("an unknown word is an error that names the right ones, and changes nothing", async () => {
		const { ctx, notices } = fakeCtx();
		await runModelsCommand("opus", ctx, shipped);
		expect(notices[0]).toContain('has no "opus"');
		expect(notices[0]).toContain("list, main");
		expect(readModelSource()).toBe("list");
	});

	test("on its own it opens a menu that marks the current choice and saves a new one", async () => {
		const { ctx, menus } = fakeCtx();
		const done = runModelsCommand("", ctx, shipped);
		const text = menus[0]!.component.render(100).map(strip).join("\n");
		expect(text).toContain("delegate, oracle and review_code run on their own models");
		expect(text).toMatch(/Their own models\s+current/);
		expect(text).toContain("delegate, oracle, review_code → sonnet · high");
		menus[0]!.resolve({ id: "main", values: {} });
		await done;
		expect(readModelSource()).toBe("main");
	});

	test("without a screen the menu is told as text", async () => {
		const { ctx, notices, menus } = fakeCtx("rpc");
		await runModelsCommand("", ctx, shipped);
		expect(menus).toHaveLength(0);
		expect(notices[0]).toContain("/agents models main");
	});

	test("with no agent marked followMain it says so instead of offering a switch", async () => {
		const { ctx, notices } = fakeCtx();
		await runModelsCommand("main", ctx, parseAgentModels({ models: {}, agents: {} }));
		expect(notices[0]).toContain("followMain");
		expect(readModelSource()).toBe("list");
	});
});
