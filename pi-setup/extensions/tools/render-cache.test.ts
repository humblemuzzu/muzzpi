import { describe, expect, test } from "bun:test";
import { Container } from "@mariozechner/pi-tui";
import { renderCallLine } from "./lib/box-format";
import { renderChangeResult } from "./lib/change-render";
import { renderAgentTree, type SingleResult } from "./lib/sub-agent-render";

// In fullscreen mode pi-tui renders every component in the transcript on every
// frame, so a row that rebuilds its lines makes each keystroke cost O(session).
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

function rendersFromCache(component: { render(width: number): string[]; invalidate(): void }, width = 120): void {
	const first = component.render(width);
	expect(component.render(width)).toBe(first);
	expect(component.render(width - 10)).not.toBe(first);
	const again = component.render(width);
	component.invalidate();
	expect(component.render(width)).not.toBe(again);
}

describe("transcript rows render once per width", () => {
	test("edit/write diff box", () => {
		const diff = "--- a.ts\n+++ a.ts\n@@ -1,3 +1,3 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n const c = 4;\n";
		const container = renderChangeResult(
			{ details: { changes: [{ path: "/tmp/a.ts", kind: "modified", diff }] } },
			{ expanded: false },
			theme,
			{ cwd: "/tmp" },
		);
		const box = container.children.at(-1);
		rendersFromCache(box);
		expect(box.render(120).some((line: string) => line.includes("+const b = 3;"))).toBe(true);
	});

	test("tool call header", () => {
		rendersFromCache(renderCallLine("Read", "~/a/very/long/path/to/some/file.ts", theme));
	});

	test("sub-agent tool lines", () => {
		const details: SingleResult = {
			agent: "finder",
			task: "find it",
			exitCode: 0,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 } as SingleResult["usage"],
			messages: [
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "1", name: "grep", arguments: { pattern: "x", path: "." } }],
				},
			] as SingleResult["messages"],
		};
		const container = new Container();
		renderAgentTree(details, container, false, theme);
		const toolLine = container.children.find((child) => child.render(120).some((line) => line.includes("Grep")));
		expect(toolLine).toBeDefined();
		rendersFromCache(toolLine!);
	});
});
