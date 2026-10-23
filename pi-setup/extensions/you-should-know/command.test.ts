import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import youShouldKnow from "./index";

const startDir = process.env.PI_CODING_AGENT_DIR;
const agentDir = mkdtempSync(join(tmpdir(), "ysk-state-"));
beforeAll(() => (process.env.PI_CODING_AGENT_DIR = agentDir));
afterAll(() => {
	if (startDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = startDir;
});

function load() {
	let command: any;
	let shortcut: any;
	const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
	const notes: [string, string | undefined][] = [];
	youShouldKnow({
		events: { emit() {}, on: () => () => {} },
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		registerCommand: (_name: string, options: unknown) => (command = options),
		registerShortcut: (_key: string, options: unknown) => (shortcut = options),
	} as any);
	const ctx = { hasUI: false, mode: "rpc", ui: { notify: (text: string, level?: string) => notes.push([text, level]), setWidget() {} } };
	const fire = async (event: string) => {
		for (const handler of handlers.get(event) ?? []) await handler({}, ctx);
	};
	return { run: (args: string) => command.handler(args, ctx), press: () => shortcut.handler(ctx), fire, notes };
}

describe("/ysk", () => {
	test("on and off are kept in the agent dir and survive a new session", async () => {
		const first = load();
		await first.fire("session_start");
		await first.run("on");
		expect(JSON.parse(readFileSync(join(agentDir, "you-should-know", "state.json"), "utf8")).enabled).toBe(true);

		const next = load();
		await next.fire("session_start");
		await next.run("status");
		expect(next.notes.at(-1)![0]).toStartWith("you-should-know: On · 0 checks · 0 notes shown · $0.00 spent");
		await next.run("off");
		expect(JSON.parse(readFileSync(join(agentDir, "you-should-know", "state.json"), "utf8")).enabled).toBe(false);
	});

	test("spend is the sum of the costs in the check log, past checks included; a torn line is skipped", async () => {
		mkdirSync(join(agentDir, "you-should-know"), { recursive: true });
		const log = [{ outcome: "none", cost: 0.0021 }, { outcome: "skipped" }, { outcome: "explained", cost: 0.0004 }];
		writeFileSync(join(agentDir, "you-should-know", "checks.jsonl"), `${log.map((l) => JSON.stringify(l)).join("\n")}\n{"outcome":"sho`);
		const ysk = load();
		await ysk.fire("session_start");
		await ysk.run("status");
		expect(ysk.notes.at(-1)![0]).toContain("$0.003 spent");
	});

	test("the shortcut says it is off instead of acting; a typo is an error", async () => {
		const ysk = load();
		await ysk.fire("session_start");
		await ysk.press();
		expect(ysk.notes.at(-1)).toEqual(["you-should-know is off. /ysk on starts it.", "info"]);
		await ysk.run("stauts");
		expect(ysk.notes.at(-1)![1]).toBe("error");
	});

	test("without a screen, /ysk alone explains itself", async () => {
		const ysk = load();
		await ysk.fire("session_start");
		await ysk.run("");
		expect(ysk.notes.at(-1)![0]).toContain("A side agent that watches the session");
		expect(ysk.notes.at(-1)![0]).toContain("/ysk on       start it");
	});
});
