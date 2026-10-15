/**
 * The screenshot tool against the real machine: one capture of every open
 * app's front window, plus the screen and a screen region, each checked
 * against the promises the tool makes. Unit tests script macOS; this is the
 * only check that macOS still behaves the way the script assumes.
 *
 * It MOVES FOCUS: windows on other Spaces and Stage Manager thumbnails are
 * brought forward for about a second each, which is what it verifies.
 *
 *   bun pi-setup/port-harness/screenshot-live.ts
 */

import { execFileSync } from "node:child_process";
import { readWindowServer, withoutGhosts } from "../extensions/tools/lib/capture";
import { createScreenshotTool } from "../extensions/tools/screenshot";

const MAX_APPS = 8;
const tool = createScreenshotTool() as any;
const ctx = { model: { id: "claude-opus-5-5" } };
let failures = 0;

function frontmost(): string {
	return execFileSync(
		"osascript",
		["-l", "JavaScript", "-e", 'ObjC.import("AppKit"); $.NSWorkspace.sharedWorkspace.frontmostApplication.localizedName.js'],
		{ encoding: "utf8" },
	).trim();
}

function check(ok: boolean, label: string): void {
	console.log(`    ${ok ? "ok  " : "FAIL"}  ${label}`);
	if (!ok) failures += 1;
}

async function shoot(label: string, args: Record<string, unknown>): Promise<string> {
	const before = frontmost();
	const started = performance.now();
	const result = await tool.execute("live", tool.prepareArguments(args), undefined, undefined, ctx);
	const ms = Math.round(performance.now() - started);
	const text: string = result.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
	console.log(`\n  ${label} (${ms}ms)\n    ${text.split("\n")[0]}`);
	check(result.isError !== true, "captured without an error");
	const handedBack = /handed focus back/.test(text);
	if (/brought .* forward/.test(text)) check(handedBack, "focus was handed back after bringing the app forward");
	if (!/was not handed back/.test(text)) check(frontmost() === before, `focus is where it was (${before})`);
	return text;
}

const { windows } = await readWindowServer();
const fronts = new Map<number, (typeof windows)[number]>();
for (const w of withoutGhosts(windows)) {
	if (w.regularApp !== false && w.title && !fronts.has(w.pid)) fronts.set(w.pid, w);
}

console.log(`\n=== ${fronts.size} app(s) with a titled window; capturing up to ${MAX_APPS} ===`);
await shoot("main display", { target: "screen" });
await shoot("screen region", { target: "screen", region: [0, 0, 400, 200] });

for (const w of [...fronts.values()].slice(0, MAX_APPS)) {
	const where = w.inStageStrip ? "Stage Manager thumbnail" : w.onScreen ? "on screen" : "not on screen";
	const text = await shoot(`${w.app} [id ${w.id}], ${where}`, { target: String(w.id) });
	if (w.inStageStrip) {
		const width = Number(/· (\d+)×\d+ pt/.exec(text)?.[1] ?? 0);
		check(width > w.width, `the full window came back, not the ${w.width}pt thumbnail (${width}pt)`);
	}
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
