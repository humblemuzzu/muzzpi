/**
 * The window path's focus rules, run through the tool's own execute with the
 * macOS calls scripted. Each test states one promise the tool makes about
 * when it may move focus, and checks it against the calls it actually made.
 */

import { describe, expect, test } from "bun:test";
import { CaptureError, type Rect, type WindowInfo } from "./lib/capture";
import { save } from "./lib/image";
import { createScreenshotTool, type WindowOps } from "./screenshot";

const ctx = { model: { id: "claude-opus-5-5" } };

const discord = (over: Partial<WindowInfo> = {}): WindowInfo => ({
	id: 1,
	app: "Discord",
	pid: 20,
	title: "#general",
	layer: 0,
	onScreen: true,
	x: 0,
	y: 0,
	width: 400,
	height: 300,
	...over,
});
const ghostty: WindowInfo = { ...discord(), id: 2, app: "Ghostty", pid: 99, title: "~/code" };
const FORWARD: Rect = { x: 0, y: 0, width: 800, height: 600 };

interface Script {
	windows: WindowInfo[];
	frontmostPid?: number;
	/** Capture outcomes in order: false fails the way an off-Space Chromium window does. */
	captures?: boolean[];
	/** Whether the window reaches the screen after its app is activated. */
	arrives?: boolean;
	/** What returnFocus reports: false when the user moved to another app meanwhile. */
	handedBack?: boolean;
	granted?: boolean;
}

function fakeMac(script: Script): { ops: WindowOps; calls: string[] } {
	const calls: string[] = [];
	const outcomes = [...(script.captures ?? [true])];
	let forward: Rect | undefined;
	const ops: WindowOps = {
		readWindowServer: async () => ({ windows: script.windows, frontmostPid: script.frontmostPid ?? ghostty.pid }),
		captureWindow: async (out, id) => {
			calls.push(`capture ${id}`);
			if (outcomes.shift() === false) throw new CaptureError("could not create image from window");
			const { width, height } = forward ?? script.windows.find((w) => w.id === id)!;
			save({ width: width * 2, height: height * 2, rgb: new Uint8Array(width * height * 12) }, out);
		},
		bringForward: async (w) => {
			calls.push(`bringForward ${w.app}`);
			forward = script.arrives === false ? undefined : FORWARD;
			return forward;
		},
		returnFocus: async (borrowed, previous) => {
			calls.push(`returnFocus ${borrowed}->${previous}`);
			return script.handedBack ?? true;
		},
		screenRecordingGranted: async () => script.granted ?? true,
		permissionAdvice: async () => (script.granted === false ? "Screen Recording permission is NOT granted." : ""),
	};
	return { ops, calls };
}

async function run(script: Script, args: Record<string, unknown> = { target: "discord" }) {
	const { ops, calls } = fakeMac(script);
	const tool = createScreenshotTool(ops) as any;
	const result = await tool.execute("call", tool.prepareArguments(args), undefined, undefined, ctx);
	const text: string = result.content
		.filter((c: any) => c.type === "text")
		.map((c: any) => c.text)
		.join("\n");
	return { calls, text, isError: result.isError === true };
}

describe("focus moves only when the capture needs it", () => {
	test("a window that captures where it is never moves focus", async () => {
		const r = await run({ windows: [discord(), ghostty] });
		expect(r.isError).toBe(false);
		expect(r.calls).toEqual(["capture 1"]);
		expect(r.text).toContain("400×300 pt");
	});

	test("a failed capture brings the app forward, retries, and hands focus back to the app you were in", async () => {
		const r = await run({ windows: [discord({ onScreen: false }), ghostty], captures: [false, true] });
		expect(r.isError).toBe(false);
		expect(r.calls).toEqual(["capture 1", "bringForward Discord", "capture 1", "returnFocus 20->99"]);
		expect(r.text).toContain("handed focus back to Ghostty");
	});

	test("the size reported is the window's size after it came forward", async () => {
		const r = await run({ windows: [discord({ onScreen: false }), ghostty], captures: [false, true] });
		expect(r.text).toContain("800×600 pt");
	});

	test("activate:true brings the app forward before the first capture", async () => {
		const r = await run({ windows: [discord(), ghostty] }, { target: "discord", activate: true });
		expect(r.calls).toEqual(["bringForward Discord", "capture 1", "returnFocus 20->99"]);
	});

	test("activate:false never moves focus, and says how to allow it", async () => {
		const r = await run({ windows: [discord({ onScreen: false }), ghostty], captures: [false] }, {
			target: "discord",
			activate: false,
		});
		expect(r.isError).toBe(true);
		expect(r.calls).toEqual(["capture 1"]);
		expect(r.text).toContain("activate:false");
	});

	test("a missing permission is reported instead of stealing focus that cannot fix it", async () => {
		const r = await run({ windows: [discord(), ghostty], captures: [false], granted: false });
		expect(r.isError).toBe(true);
		expect(r.calls).toEqual(["capture 1"]);
		expect(r.text).toContain("NOT granted");
	});
});

describe("focus is always handed back, and only to someone still waiting for it", () => {
	test("even when the capture still fails after coming forward", async () => {
		const r = await run({ windows: [discord({ onScreen: false }), ghostty], captures: [false, false] });
		expect(r.isError).toBe(true);
		expect(r.calls.at(-1)).toBe("returnFocus 20->99");
		expect(r.text).toContain("handed focus back to Ghostty");
	});

	test("when the user moved to another app meanwhile, the result says focus was left alone", async () => {
		const r = await run({
			windows: [discord({ onScreen: false }), ghostty],
			captures: [false, true],
			handedBack: false,
		});
		expect(r.text).toContain("was not handed back");
	});

	test("when the target app was already in front there is nothing to hand back", async () => {
		const r = await run({
			windows: [discord({ onScreen: false }), ghostty],
			captures: [false, true],
			frontmostPid: 20,
		});
		expect(r.calls).not.toContain("returnFocus 20->20");
		expect(r.text).toContain("already the active app");
	});
});

describe("a Stage Manager thumbnail is never returned as the capture", () => {
	const thumbnail = discord({ width: 139, height: 138, inStageStrip: true });

	test("the app is brought forward before anything is captured", async () => {
		const r = await run({ windows: [thumbnail, ghostty] });
		expect(r.calls).toEqual(["bringForward Discord", "capture 1", "returnFocus 20->99"]);
		expect(r.text).toContain("800×600 pt");
	});

	test("a thumbnail that never grows fails rather than returning the preview, and focus still comes back", async () => {
		const r = await run({ windows: [thumbnail, ghostty], arrives: false });
		expect(r.isError).toBe(true);
		expect(r.calls).toEqual(["bringForward Discord", "returnFocus 20->99"]);
		expect(r.text).toContain("thumbnail");
	});

	test("with activate:false it refuses instead of capturing the preview", async () => {
		const r = await run({ windows: [thumbnail, ghostty] }, { target: "discord", activate: false });
		expect(r.isError).toBe(true);
		expect(r.calls).toEqual([]);
		expect(r.text).toMatch(/Stage Manager thumbnail/);
	});
});

describe("the result a model reads", () => {
	test("one headline with points and pixels, then where the file is", async () => {
		const [headline, saved] = (await run({ windows: [discord(), ghostty] })).text.split("\n");
		expect(headline).toMatch(/^Discord — "#general" \[id 1\] · 400×300 pt → 800×600 px image · [\d,]+ tokens$/);
		expect(saved).toMatch(/^saved \S+\/shot-\d+\.png$/);
	});

	test("old parameter names reach the same window", async () => {
		const r = await run({ windows: [discord(), ghostty] }, { app: "Discord", window_title: "general" });
		expect(r.isError).toBe(false);
		expect(r.calls).toEqual(["capture 1"]);
	});
});
