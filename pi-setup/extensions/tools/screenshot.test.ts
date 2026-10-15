import { describe, expect, test } from "bun:test";
import { appWindows, describeWindow, groupLikelyTabs, type WindowInfo, withoutGhosts } from "./lib/capture";
import fs from "node:fs";
import path from "node:path";
import {
	createScreenshotTool,
	displayedSibling,
	normalizeRegion,
	parseTarget,
	prepareScreenshotArguments,
	renderOpenWindows,
	resolveWindow,
	tabRescueAdvice,
} from "./screenshot";
import { evaluatePermission, type PermissionRule } from "./lib/permissions";

const tool = createScreenshotTool() as any;

describe("the window list shows app windows and counts the rest", () => {
	const w = (id: number, app: string, regularApp: boolean): WindowInfo => ({
		id, app, pid: id, title: "", layer: 0, onScreen: false, x: 0, y: 0, width: 500, height: 500, regularApp,
	});
	const pool = [w(1, "Ghostty", true), w(2, "WindowManager", false), w(3, "WindowManager", false), w(4, "Raycast", false)];

	test("helper and overlay windows are counted, not listed", () => {
		const text = renderOpenWindows(pool);
		expect(text).toStartWith("1 open windows:");
		expect(text).toContain("Ghostty");
		expect(text).not.toContain("WindowManager");
		expect(text).toContain("(3 helper or never-shown window(s) not listed)");
	});

	test("a target still reaches a hidden helper app's window", () => {
		expect(resolveWindow({ kind: "windowQuery", query: "raycast" }, pool).window.id).toBe(4);
	});
});

describe("normalizeRegion tolerates what models actually send", () => {
	const expected = { x: 10, y: 20, width: 300, height: 400 };

	test("a plain array", () => {
		expect(normalizeRegion([10, 20, 300, 400])).toEqual(expected);
	});

	test("a JSON-stringified array — the shape that made pi-tasks unusable", () => {
		expect(normalizeRegion("[10, 20, 300, 400]")).toEqual(expected);
	});

	test("a bare comma string", () => {
		expect(normalizeRegion("10,20,300,400")).toEqual(expected);
	});

	test("a space-separated string", () => {
		expect(normalizeRegion("10 20 300 400")).toEqual(expected);
	});

	test("string numbers inside an array", () => {
		expect(normalizeRegion(["10", "20", "300", "400"])).toEqual(expected);
	});

	test("an object, with either width/height or w/h", () => {
		expect(normalizeRegion({ x: 10, y: 20, width: 300, height: 400 })).toEqual(expected);
		expect(normalizeRegion({ x: 10, y: 20, w: 300, h: 400 })).toEqual(expected);
	});

	test("absent stays absent", () => {
		expect(normalizeRegion(undefined)).toBeUndefined();
		expect(normalizeRegion(null)).toBeUndefined();
	});

	test("the wrong number of values is a clear error, not a silent guess", () => {
		expect(() => normalizeRegion([1, 2, 3])).toThrow(/exactly four numbers/);
		expect(() => normalizeRegion("1,2,3,4,5")).toThrow(/exactly four numbers/);
	});

	test("non-numeric values are rejected rather than becoming NaN", () => {
		expect(() => normalizeRegion(["a", "b", "c", "d"])).toThrow(/must all be numbers/);
	});
});

describe("tool contract", () => {
	test("registers under a name that collides with nothing", () => {
		expect(tool.name).toBe("screenshot");
	});

	test("every parameter is optional — a bare call captures the display", () => {
		expect(tool.parameters.required ?? []).toEqual([]);
	});

	test("no parameter shouts REQUIRED in prose", () => {
		const shouting = Object.entries(tool.parameters.properties ?? {})
			.filter(([, schema]) => /\bREQUIRED\b/.test(String((schema as any)?.description ?? "")))
			.map(([param]) => param);
		expect(shouting).toEqual([]);
	});

	test("every parameter carries a description", () => {
		// Substantive prose, not a placeholder: the model calls this without
		// reading our source, so every knob has to explain itself. Reported as a
		// map so a failure names the offending parameter.
		const tooShort = Object.entries(tool.parameters.properties ?? {})
			.filter(([, schema]) => String((schema as any)?.description ?? "").length < 40)
			.map(([param]) => param);
		expect(tooShort).toEqual([]);
	});

	test("the description ends with a literal example call", () => {
		expect(tool.description).toMatch(/Example: screenshot\(\{.*\}\)/);
	});

	test("one target plus what refines it, and nothing else", () => {
		expect(Object.keys(tool.parameters.properties ?? {}).sort()).toEqual([
			"activate",
			"list",
			"region",
			"selector",
			"target",
			"viewport_width",
			"wait_ms",
		]);
	});

	test("nothing in the spec nudges the model to economise", () => {
		// The tool used to advertise high as "~3x the cost", which is a reason to
		// avoid it. Cost is the caller's business; the tool's business is not
		// handing back a degraded picture.
		const surface = [
			tool.description,
			...Object.values(tool.parameters.properties ?? {}).map(
				(s: any) => String(s?.description ?? ""),
			),
		].join(" ");
		expect(surface).not.toMatch(/token cost|cheaper|\dx the cost|expensive/i);
	});

	test("the description warns that a very long page is truncated", () => {
		expect(tool.description).toMatch(/truncat/i);
		expect(tool.description).toContain("selector");
	});
});

describe("renderCall never emits a control character into a single-line sink", () => {
	const theme = { fg: (_k: string, s: string) => s, bold: (s: string) => s };

	function lastText(args: any): string {
		let captured = "";
		const stub = { setText: (s: string) => { captured = s; } };
		tool.renderCall(args, theme, { lastComponent: stub });
		return captured;
	}

	test("a multi-line app name is flattened", () => {
		// A newline is width-0 to every width check and still advances the real
		// terminal cursor a row — the TUI smear class documented in AGENTS.md.
		expect(lastText({ app: "Fo\no\tBar\r\nBaz" })).not.toMatch(/[\r\n\t\v\f]/);
	});

	test("an absurdly long title is capped", () => {
		const text = lastText({ app: "x".repeat(500) });
		expect(text.length).toBeLessThan(120);
	});

	test("a bare call describes the default target", () => {
		expect(lastText({})).toContain("display");
	});

	test("list mode is labelled distinctly", () => {
		expect(lastText({ list: true })).toContain("list windows");
	});
});

/**
 * These assert the rules that actually ship, read off disk. A test that
 * hard-codes its own copy of the rules only proves the copy is self-consistent.
 */
describe("permissions.json routes the shell workaround to this tool", () => {
	const rules: PermissionRule[] = JSON.parse(
		fs.readFileSync(path.join(__dirname, "..", "..", "permissions.json"), "utf-8"),
	);
	const verdict = (cmd: string) => evaluatePermission("Bash", { cmd }, rules);

	test("the exact command a sub-agent ran is rejected", () => {
		const v = verdict(
			"screencapture -x -o -l 12237 /tmp/shot.png && sips -Z 1400 /tmp/shot.png >/dev/null && echo ok",
		);
		expect(v.action).toBe("reject");
		expect(v.message).toContain("screenshot tool");
	});

	test("bare screencapture is rejected", () => {
		expect(verdict("screencapture /tmp/a.png").action).toBe("reject");
	});

	test("screencapture after a separator is rejected", () => {
		expect(verdict("cd /tmp; screencapture a.png").action).toBe("reject");
		expect(verdict("true && screencapture a.png").action).toBe("reject");
		expect(verdict("nohup screencapture a.png &").action).toBe("reject");
	});

	test("resizing with sips is NOT blocked — it was only ever collateral", () => {
		// The rule used to match `sips -Z` too, and that pattern produced three
		// false positives in one session: a git commit message describing the old
		// pattern, and two files written through a shell heredoc that merely
		// QUOTED it. The guard exists to stop an agent TAKING a screenshot by
		// hand, not to stop anyone writing about it. With the capture binary
		// blocked there is no fresh screenshot to badly resize anyway, and `read`
		// now fits any image it opens.
		expect(verdict("sips -Z 1400 a.png").action).toBe("allow");
		expect(verdict("sips -z 900 1400 a.png").action).toBe("allow");
	});

	test("writing ABOUT the old pattern is never blocked", () => {
		const capture = ["screen", "capture"].join("");
		const heredoc = `git commit -q -F - <<'EOT'\n  ${capture} -x -o a.png && sips -Z 1400 a.png\nEOT`;
		expect(verdict(heredoc).action).toBe("allow");
		expect(verdict(`git commit -m 'drop the ${capture} path'`).action).toBe("allow");
		expect(verdict(`grep -rn ${capture} ./docs`).action).toBe("allow");
	});

	test("sips as a codec or a metadata reader is still allowed", () => {
		// The tool itself uses these; blocking them would break the thing we built.
		expect(verdict("sips -g pixelWidth -g pixelHeight a.png").action).toBe("allow");
		expect(verdict("sips -s format png a.jpg --out a.png").action).toBe("allow");
	});

	test("unrelated commands that merely contain the word are not caught", () => {
		expect(verdict("echo 'run screencapture manually'").action).toBe("allow");
		expect(verdict("grep -r screencapture ./docs").action).toBe("allow");
	});

	test("the message names the escape hatch for discovering targets", () => {
		expect(verdict("screencapture x.png").message).toContain("list: true");
	});
});

describe("window listing tells identical-looking windows apart", () => {
	/*
	 * A test run hit five Ghostty windows whose displayed titles were
	 * byte-identical (`…/Documents/Code stuff/my-app`) because Ghostty
	 * left-truncates the path itself — the distinguishing prefix was already
	 * gone before we saw it. Without coordinates the candidate list is five
	 * indistinguishable rows.
	 */
	const w = (over: Partial<WindowInfo>): WindowInfo => ({
		id: 1,
		app: "Ghostty",
		pid: 7,
		title: "…/Documents/Code stuff/my-app",
		layer: 0,
		onScreen: true,
		x: 0,
		y: 0,
		width: 1916,
		height: 1040,
		...over,
	});

	test("position is shown, so identical titles are still separable", () => {
		const a = describeWindow(w({ id: 15251, x: 0, y: 40 }));
		const b = describeWindow(w({ id: 14093, x: 1920, y: 40 }));
		expect(a).not.toBe(b);
		expect(a).toContain("@0,40");
		expect(b).toContain("@1920,40");
	});

	test("the id is always present — it is the only guaranteed selector", () => {
		expect(describeWindow(w({ id: 16303 }))).toContain("16303");
	});

	test("a window on another Space is still marked as such", () => {
		expect(describeWindow(w({ onScreen: false }))).toContain("not on screen");
		expect(describeWindow(w({ onScreen: true }))).not.toContain("not on screen");
	});
});

const query = (text: string) => ({ kind: "windowQuery" as const, query: text });

describe("an ambiguous target captures the best window and names the rest", () => {
	/*
	 * The old tool refused ambiguous matches and asked for a window_id, which
	 * cost a second call every time. A capture plus the alternatives costs one,
	 * and the model can see from the picture whether it got the right window.
	 */
	const w = (over: Partial<WindowInfo>): WindowInfo => ({
		id: 1,
		app: "Ghostty",
		pid: 7,
		title: "…/Documents/Code stuff/my-app",
		layer: 0,
		onScreen: false,
		x: 0,
		y: 40,
		width: 1916,
		height: 1040,
		...over,
	});

	test("identical titles in separate frames: the most recent is captured, the others named by id", () => {
		const pool = [w({ id: 15251 }), w({ id: 14093, x: 100 }), w({ id: 16303, x: 200 })];
		const choice = resolveWindow(query("ghostty my-app"), pool);
		expect(choice.window.id).toBe(15251);
		expect(choice.alsoMatched.map((m) => m.id)).toEqual([14093, 16303]);
	});

	test("an on-screen window beats a more recent one that is not on screen", () => {
		const pool = [w({ id: 1 }), w({ id: 2, x: 900, onScreen: true })];
		expect(resolveWindow(query("ghostty"), pool).window.id).toBe(2);
	});

	test("an unambiguous match names nothing else", () => {
		const choice = resolveWindow(query("ghostty"), [w({ id: 7, onScreen: true })]);
		expect(choice.window.id).toBe(7);
		expect(choice.alsoMatched).toEqual([]);
	});

	test("the app's own name outranks a title that merely mentions it", () => {
		const pool = [
			w({ id: 1, app: "Dia", pid: 3, title: "Discord | Dia", onScreen: true }),
			w({ id: 2, app: "Discord", pid: 4, title: "#general" }),
		];
		expect(resolveWindow(query("discord"), pool).window.id).toBe(2);
	});

	test("no match lists the windows that do exist", () => {
		expect(() => resolveWindow(query("zzz"), [w({ id: 15251 })])).toThrow(/no window matches "zzz"[\s\S]*15251/);
	});
});

describe("tab-heavy apps are counted honestly", () => {
	/*
	 * Real numbers from this machine: 4 visible Ghostty terminals reported as
	 * SIXTEEN matching windows. Under macOS native tabbing every tab is its own
	 * NSWindow, and the tab bar is a further separate window at y=0. The raw
	 * count is accurate and useless.
	 */
	const tab = (id: number, x: number, title: string): WindowInfo => ({
		id,
		app: "Ghostty",
		pid: 7,
		title,
		layer: 0,
		onScreen: false,
		x,
		y: 40,
		width: x === 0 ? 1920 : 1916,
		height: 1040,
	});
	// two real windows: seven tabs at @0,40 and eight at @4,40
	const pool = [
		...[1, 2, 3, 4, 5, 6, 7].map((i) => tab(i, 0, `w1 tab ${i}`)),
		...[8, 9, 10, 11, 12, 13, 14, 15].map((i) => tab(i, 4, `w2 tab ${i}`)),
	];

	test("15 reported windows collapse to the 2 frames a person would count", () => {
		expect(groupLikelyTabs(pool)).toHaveLength(2);
	});

	test("15 tabs in 2 frames name one alternative, not 14", () => {
		expect(resolveWindow(query("ghostty"), pool).alsoMatched).toHaveLength(1);
	});

	test("the list folds each frame into one entry that still exposes every id", () => {
		const text = renderOpenWindows(pool);
		expect(text).toContain("15 open windows in 2 frames");
		for (const id of [1, 7, 8, 15]) expect(text).toContain(String(id));
	});

	test("genuinely separate windows are NOT collapsed", () => {
		const separate = [
			{ ...tab(1, 0, "a"), x: 0, y: 0 },
			{ ...tab(2, 0, "b"), x: 700, y: 300 },
			{ ...tab(3, 0, "c"), x: 100, y: 900 },
		];
		expect(groupLikelyTabs(separate)).toHaveLength(3);
		expect(renderOpenWindows(separate)).not.toContain("frames");
	});

	test("windows of different apps never group together", () => {
		const mixed = [tab(1, 0, "a"), { ...tab(2, 0, "b"), app: "Safari" }];
		expect(groupLikelyTabs(mixed)).toHaveLength(2);
	});

	test("'[not on screen]' does not claim a reason we never checked", () => {
		// It is equally true of another Space, a minimised window, a hidden app
		// and — most often — a background tab. Naming one of those is a guess.
		const line = describeWindow(tab(1, 0, "x"));
		expect(line).toContain("not on screen");
		expect(line).not.toMatch(/other Space|minimi|hidden/i);
	});
});

describe("a background tab that fails to capture gets a next step", () => {
	const tab = (id: number, over: Partial<WindowInfo> = {}): WindowInfo => ({
		id,
		app: "Ghostty",
		pid: 7,
		title: `tab ${id}`,
		layer: 0,
		onScreen: false,
		x: 4,
		y: 40,
		width: 1916,
		height: 1040,
		...over,
	});

	test("the on-screen sibling of a background tab is found", () => {
		const target = tab(13707);
		const pool = [target, tab(16543, { onScreen: true })];
		expect(displayedSibling(target, pool)?.id).toBe(16543);
	});

	test("a window that is already on screen needs no rescue", () => {
		const target = tab(1, { onScreen: true });
		expect(displayedSibling(target, [target, tab(2, { onScreen: true })])).toBeUndefined();
	});

	test("a different frame is not offered as a substitute", () => {
		// same app, different geometry: not the same window, so not a rescue
		const target = tab(1);
		expect(displayedSibling(target, [target, tab(2, { onScreen: true, x: 900 })])).toBeUndefined();
	});

	test("the advice names the id to use and does not pretend it is the same content", () => {
		const msg = tabRescueAdvice(tab(13707), tab(16543, { onScreen: true, title: "live" }));
		expect(msg).toContain("16543");
		expect(msg).toContain("13707");
		expect(msg).toMatch(/switch to that tab/i);
		expect(msg).toMatch(/will succeed/i);
		expect(msg).toMatch(/ACTIVE tab/);
		// Measured: a background tab captured fine at 3840×2080. Absolute claims
		// about macOS behaviour have been wrong every time they were made here.
		expect(msg).not.toMatch(/never|impossible|cannot be captured/i);
	});
});

describe("one target string covers every kind of target", () => {
	test("nothing, or a screen word, is the main display; a number after it picks another", () => {
		for (const raw of [undefined, "", "  ", "screen", "Display", "desktop"]) {
			expect(parseTarget(raw)).toEqual({ kind: "screen" });
		}
		for (const raw of ["screen 2", "display:2", "Screen #2"]) {
			expect(parseTarget(raw)).toEqual({ kind: "screen", display: 2 });
		}
	});

	test("a URL with a scheme is used as written; a bare localhost gets http://", () => {
		expect(parseTarget("https://example.com/a")).toEqual({ kind: "url", url: "https://example.com/a" });
		expect(parseTarget("file:///tmp/a.html")).toEqual({ kind: "url", url: "file:///tmp/a.html" });
		expect(parseTarget("localhost:3000/docs")).toEqual({ kind: "url", url: "http://localhost:3000/docs" });
		expect(parseTarget("127.0.0.1")).toEqual({ kind: "url", url: "http://127.0.0.1" });
	});

	test("digits are a window id, with or without an id prefix", () => {
		for (const raw of ["1446", "id:1446", "id 1446", "ID#1446"]) {
			expect(parseTarget(raw)).toEqual({ kind: "windowId", id: 1446 });
		}
	});

	test("anything else is matched against app names and window titles", () => {
		expect(parseTarget("Dia Instagram")).toEqual({ kind: "windowQuery", query: "Dia Instagram" });
		expect(parseTarget("1Password")).toEqual({ kind: "windowQuery", query: "1Password" });
		expect(parseTarget("localhostess")).toEqual({ kind: "windowQuery", query: "localhostess" });
	});
});

describe("the retired parameters still work", () => {
	test("arguments already in the new shape pass through untouched", () => {
		const args = { target: "Dia", region: [0, 0, 10, 10], wait_ms: 5 };
		expect(prepareScreenshotArguments(args)).toBe(args);
	});

	test("app and window_title become one target", () => {
		expect(prepareScreenshotArguments({ app: "Ghostty", window_title: "my-app" })).toEqual({ target: "Ghostty my-app" });
	});

	test("the old precedence holds: url, then window_id, then app, then display", () => {
		expect(prepareScreenshotArguments({ url: "https://a.b", window_id: 7, app: "Dia" })).toEqual({ target: "https://a.b" });
		expect(prepareScreenshotArguments({ window_id: 7, app: "Dia", display: 2 })).toEqual({ target: "7" });
		expect(prepareScreenshotArguments({ app: "Dia", display: 2 })).toEqual({ target: "Dia" });
		expect(prepareScreenshotArguments({ display: 2 })).toEqual({ target: "screen 2" });
	});

	test("delay_ms becomes wait_ms unless wait_ms was also sent", () => {
		expect(prepareScreenshotArguments({ delay_ms: 500 })).toEqual({ wait_ms: 500 });
		expect(prepareScreenshotArguments({ delay_ms: 500, wait_ms: 100 })).toEqual({ wait_ms: 100 });
	});

	test("options that no longer exist are dropped, not passed to the schema", () => {
		expect(prepareScreenshotArguments({ target: "Dia", tier: "high", cursor: true, shadow: true, full_page: false }))
			.toEqual({ target: "Dia" });
	});

	test("a numeric target, which a model may send for an id, becomes a string", () => {
		expect(prepareScreenshotArguments({ target: 1446 })).toEqual({ target: "1446" });
	});
});

describe("which windows count, and which one a target picks", () => {
	const w = (over: Partial<WindowInfo>): WindowInfo => ({
		id: 1,
		app: "Discord",
		pid: 20,
		title: "#general",
		layer: 0,
		onScreen: false,
		x: 0,
		y: 0,
		width: 1458,
		height: 859,
		...over,
	});

	test("under Stage Manager a thumbnail-sized window is marked, and a full-size one is not", () => {
		const [thumb, full] = appWindows([w({ id: 1, width: 139, height: 138 }), w({ id: 2 })], true);
		expect(thumb!.inStageStrip).toBe(true);
		expect(full!.inStageStrip).toBe(false);
	});

	test("without Stage Manager nothing is a thumbnail", () => {
		expect(appWindows([w({ width: 139, height: 138 })], false)[0]!.inStageStrip).toBe(false);
	});

	test("tab bars, overlays and tiny untitled windows are dropped; a titled small thumbnail is kept", () => {
		const raw = [
			w({ id: 1, width: 1728, height: 33, title: "" }),
			w({ id: 2, layer: 25 }),
			w({ id: 3, width: 60, height: 60, title: "" }),
			w({ id: 4, width: 60, height: 60 }),
		];
		expect(appWindows(raw, true).map((x) => x.id)).toEqual([4]);
		expect(appWindows(raw, false).map((x) => x.id)).toEqual([]);
	});

	test("an untitled off-screen window is a ghost when its app has a titled one", () => {
		const ghost = w({ id: 2, title: "", width: 500, height: 500 });
		expect(withoutGhosts([w({ id: 1 }), ghost]).map((x) => x.id)).toEqual([1]);
	});

	test("without Screen Recording every title is blank, so nothing is dropped as a ghost", () => {
		const blank = [w({ id: 1, title: "" }), w({ id: 2, title: "" })];
		expect(withoutGhosts(blank)).toHaveLength(2);
	});

	test("a window capturable in place beats a thumbnail of the same app", () => {
		const pool = [w({ id: 1, inStageStrip: true, onScreen: true }), w({ id: 2, x: 300, onScreen: true })];
		expect(resolveWindow({ kind: "windowQuery", query: "discord" }, pool).window.id).toBe(2);
	});

	test("an invisible mark in the app name does not stop a match", () => {
		const pool = [w({ app: "\u200eWhatsApp", title: "\u200eWhatsApp" })];
		expect(resolveWindow({ kind: "windowQuery", query: "whatsapp" }, pool).window.id).toBe(1);
	});

	test("an app name beats an app that merely starts with it", () => {
		const pool = [w({ id: 1, app: "Notes Pro", pid: 3, title: "x" }), w({ id: 2, app: "Notes", pid: 4, title: "y" })];
		expect(resolveWindow({ kind: "windowQuery", query: "notes" }, pool).window.id).toBe(2);
	});
});

describe("a region is checked before anything is captured", () => {
	test("zero or negative size is refused for window and screen targets alike", () => {
		expect(() => normalizeRegion([0, 0, 0, 10])).toThrow(/positive width and height/);
		expect(() => normalizeRegion([0, 0, 10, -1])).toThrow(/positive width and height/);
	});
});
