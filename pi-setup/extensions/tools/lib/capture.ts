/**
 * macOS screen capture and window discovery, via `screencapture` and
 * `osascript -l JavaScript` only. Every call is async: a synchronous spawn
 * freezes pi's TUI for as long as the capture takes.
 *
 * `CGWindowListCopyWindowInfo` works from JXA only through
 * `ObjC.castRefToObject`, and needs option 0: option 1 omits every window on
 * another Space. `kCGWindowName` is blank without Screen Recording, which makes
 * it a free permission probe.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface WindowInfo {
	id: number;
	app: string;
	pid: number;
	title: string;
	layer: number;
	onScreen: boolean;
	x: number;
	y: number;
	width: number;
	height: number;
	/** false when the owner is an agent, helper or system overlay rather than a regular (Dock) app */
	regularApp?: boolean;
	/** Shown only as a Stage Manager thumbnail, which captures as a tiny skewed preview. */
	inStageStrip?: boolean;
}

export interface WindowServerState {
	/** App-sized windows, front to back: the window server's own order, so earlier means more recently used. */
	windows: WindowInfo[];
	frontmostPid?: number;
}

export class CaptureError extends Error {}

const LIST_WINDOWS_JXA = `
ObjC.import("CoreGraphics");
ObjC.import("AppKit");
var workspace = $.NSWorkspace.sharedWorkspace;
var policy = {};
var apps = workspace.runningApplications;
for (var i = 0; i < apps.count; i++) {
  var a = apps.objectAtIndex(i);
  policy[a.processIdentifier] = Number(a.activationPolicy);
}
var front = workspace.frontmostApplication;
var stage = $.NSUserDefaults.alloc.initWithSuiteName("com.apple.WindowManager");
var raw = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(0, 0))) || [];
JSON.stringify({
  frontmostPid: front.isNil() ? null : front.processIdentifier,
  stageManager: !!stage.boolForKey("GloballyEnabled"),
  windows: raw.map(function (w) {
    var b = w.kCGWindowBounds || {};
    return {
      id: w.kCGWindowNumber,
      app: w.kCGWindowOwnerName || "",
      pid: w.kCGWindowOwnerPID,
      title: w.kCGWindowName || "",
      layer: w.kCGWindowLayer,
      onScreen: !!w.kCGWindowIsOnscreen,
      x: b.X, y: b.Y, width: b.Width, height: b.Height,
      regularApp: policy[w.kCGWindowOwnerPID] === 0
    };
  })
});
`;

async function osascriptJs(source: string, signal?: AbortSignal): Promise<string> {
	const { stdout } = await execFileAsync("osascript", ["-l", "JavaScript", "-e", source], {
		encoding: "utf8",
		timeout: 10_000,
		signal,
	});
	return stdout;
}

/**
 * Layer 0 drops the menu bar, Dock, wallpaper and overlays; the size floor
 * drops tab bars and the 1×1 tracking windows apps leave lying around. Under
 * Stage Manager a titled window may be a thumbnail smaller than the floor.
 */
function isAppSized(w: WindowInfo, stageManager: boolean): boolean {
	if (w.layer !== 0) return false;
	if (w.width >= 100 && w.height >= 100) return true;
	return stageManager && w.title !== "" && w.width >= 40 && w.height >= 40;
}

/**
 * Strip thumbnails measured 139–163 pt on a 1728×1117 pt display. A real
 * window this small is misread as one, which costs only a brief bring-forward;
 * a thumbnail misread as a window would be returned as the capture.
 */
const STAGE_THUMBNAIL_MAX_PT = 260;

/** The windows worth matching and listing, with Stage Manager thumbnails marked. */
export function appWindows(raw: WindowInfo[], stageManager: boolean): WindowInfo[] {
	return raw
		.filter((w) => isAppSized(w, stageManager))
		.map((w) => ({
			...w,
			inStageStrip: stageManager && w.width <= STAGE_THUMBNAIL_MAX_PT && w.height <= STAGE_THUMBNAIL_MAX_PT,
		}));
}

/** Every window on every Space, plus the app that has focus, in one osascript run. */
export async function readWindowServer(signal?: AbortSignal): Promise<WindowServerState> {
	let out: string;
	try {
		out = await osascriptJs(LIST_WINDOWS_JXA, signal);
	} catch (err: any) {
		throw new CaptureError(`could not enumerate windows: ${err.message ?? err}`);
	}
	let parsed: { frontmostPid: number | null; stageManager: boolean; windows: WindowInfo[] };
	try {
		parsed = JSON.parse(out);
	} catch {
		throw new CaptureError(`window list was not valid JSON: ${out.slice(0, 200)}`);
	}
	return {
		windows: appWindows(parsed.windows, parsed.stageManager),
		frontmostPid: parsed.frontmostPid ?? undefined,
	};
}

/**
 * Apps keep untitled windows they never show: Dia, Discord, Ghostty and
 * WhatsApp each hold a 500×500 one off screen. Such a window is noise unless
 * its app has no titled window at all, which is also what every window looks
 * like without Screen Recording.
 */
export function withoutGhosts(windows: WindowInfo[]): WindowInfo[] {
	const titled = new Set(windows.filter((w) => w.title).map((w) => w.pid));
	return windows.filter((w) => w.title || w.onScreen || !titled.has(w.pid));
}

/** Native tabs of one window share an app and an exact frame. */
export function frameKey(w: WindowInfo): string {
	return `${w.app}|${w.width}x${w.height}@${w.x},${w.y}`;
}

/**
 * One window, with its position: apps that left-truncate a path in the title
 * give several windows byte-identical titles, and the coordinates are then the
 * only way to tell them apart.
 */
export function describeWindow(w: WindowInfo): string {
	// "not on screen" covers another Space, minimised, hidden, and (most often)
	// an inactive native tab; macOS does not say which.
	const where = w.inStageStrip ? "  [Stage Manager thumbnail]" : w.onScreen ? "" : "  [not on screen]";
	const title = w.title ? `"${w.title}"` : "(untitled)";
	const geom = `${w.width}×${w.height} @${w.x},${w.y}`;
	return `  id ${String(w.id).padEnd(7)} ${w.app.padEnd(18)} ${title} — ${geom}${where}`;
}

/** Windows grouped by frame: under macOS native tabbing each tab is its own window. */
export function groupLikelyTabs(windows: WindowInfo[]): WindowInfo[][] {
	const groups = new Map<string, WindowInfo[]>();
	for (const w of windows) {
		const key = frameKey(w);
		const group = groups.get(key);
		if (group) group.push(w);
		else groups.set(key, [w]);
	}
	return [...groups.values()];
}

/** Free permission probe: without Screen Recording, macOS blanks every title this process does not own. */
export function titlesVisible(windows: WindowInfo[]): boolean {
	const others = windows.filter((w) => w.app !== "pi" && w.app !== "osascript");
	return others.length === 0 || others.some((w) => w.title.length > 0);
}

let screenRecordingProbe: Promise<boolean | undefined> | undefined;

/**
 * Authoritative Screen Recording check via Swift. JXA cannot call
 * `CGPreflightScreenCaptureAccess` (its BridgeSupport entry has no
 * signature). Cached for the process: macOS applies a new grant only after
 * the terminal restarts, which restarts pi too.
 */
export function screenRecordingGranted(): Promise<boolean | undefined> {
	screenRecordingProbe ??= execFileAsync(
		"swift",
		["-e", 'import CoreGraphics; print(CGPreflightScreenCaptureAccess() ? "granted" : "denied")'],
		{ encoding: "utf8", timeout: 20_000 },
	).then(
		({ stdout }) => stdout.trim() === "granted",
		() => undefined, // no Swift toolchain: callers fall back to the title heuristic
	);
	return screenRecordingProbe;
}

const GRANT_STEPS =
	"Grant it to the terminal running pi: System Settings → Privacy & Security → " +
	"Screen & System Audio Recording, then restart the terminal.";

export async function permissionAdvice(windows: WindowInfo[]): Promise<string> {
	const granted = await screenRecordingGranted();
	if (granted === false) {
		return (
			"Screen Recording permission is NOT granted. macOS returns a picture of the desktop " +
			`with no windows in it rather than failing. ${GRANT_STEPS}`
		);
	}
	if (granted === undefined && !titlesVisible(windows)) {
		return `Every window title is blank, which is what macOS does when Screen Recording is denied. ${GRANT_STEPS}`;
	}
	return "";
}

export interface CaptureOptions {
	/** Milliseconds to wait before the shutter, for animations to settle. */
	waitMs?: number;
	signal?: AbortSignal;
}

export const MAX_WAIT_MS = 10_000;

async function settle(ms: number | undefined): Promise<void> {
	if (!ms || ms <= 0) return;
	await new Promise((resolve) => setTimeout(resolve, Math.min(ms, MAX_WAIT_MS)));
}

async function screencapture(args: string[], out: string, opts: CaptureOptions): Promise<void> {
	await settle(opts.waitMs);
	try {
		// -x: no shutter sound on every agent capture.
		await execFileAsync("screencapture", ["-x", ...args, out], { timeout: 30_000, signal: opts.signal });
	} catch (err: any) {
		const stderr = String(err.stderr ?? "").trim();
		throw new CaptureError(stderr || err.message || "screencapture failed");
	}
	if (!fs.existsSync(out) || fs.statSync(out).size === 0) {
		const advice = await permissionAdvice([]);
		throw new CaptureError(`screencapture reported success but wrote nothing.${advice ? `\n\n${advice}` : ""}`);
	}
}

export function captureDisplay(out: string, display: number | undefined, opts: CaptureOptions = {}): Promise<void> {
	return screencapture(display === undefined ? [] : ["-D", String(display)], out, opts);
}

export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export function captureRegion(out: string, region: Rect, opts: CaptureOptions = {}): Promise<void> {
	return screencapture(["-R", `${region.x},${region.y},${region.width},${region.height}`], out, opts);
}

export function captureWindow(out: string, windowId: number, opts: CaptureOptions = {}): Promise<void> {
	// -o: no drop shadow, which is wasted pixels.
	return screencapture(["-o", "-l", String(windowId)], out, opts);
}

/** The primary display's size in points; `screencapture` with no -D captures that display. */
export async function primaryScreenPoints(): Promise<{ width: number; height: number } | undefined> {
	try {
		const out = await osascriptJs(
			'ObjC.import("AppKit"); var f = $.NSScreen.screens.objectAtIndex(0).frame; JSON.stringify([f.size.width, f.size.height])',
		);
		const [width, height] = JSON.parse(out) as number[];
		return width && height ? { width, height } : undefined;
	} catch {
		return undefined;
	}
}

/**
 * How long a window may take to reach the current Space after its app is
 * activated. It is polled, so a fast switch costs only what it takes.
 */
const BRING_FORWARD_TIMEOUT_MS = 2_000;

/**
 * A window that just came on screen may not have painted yet: Chromium apps
 * drop their pixels while on another Space and need a frame to redraw.
 */
const REPAINT_MS = 150;

/** How long a window whose bounds have not moved is given to start animating. */
const MIN_ANIMATION_MS = 400;

/**
 * Activation by pid needs no Automation permission and survives app names
 * with invisible characters (WhatsApp's starts with U+200E). The Apple Event
 * by bundle id is the fallback when the window has not moved halfway through.
 * Option 8 (`kCGWindowListOptionIncludingWindow`) reads just the one window.
 *
 * A window counts as on screen while Stage Manager is still growing it from
 * its thumbnail, so it is done only when its bounds hold for three reads, and
 * have either left their starting rect (the thumbnail's, before the animation
 * starts) or had MIN_ANIMATION_MS to do so.
 */
function bringForwardJxa(window: WindowInfo): string {
	const { pid, id: windowId } = window;
	const origin = JSON.stringify({ X: window.x, Y: window.y, Width: window.width, Height: window.height });
	return `
ObjC.import("AppKit");
ObjC.import("CoreGraphics");
function current() {
  var list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(8, ${windowId}))) || [];
  return list[0] && list[0].kCGWindowIsOnscreen ? list[0] : null;
}
var app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid});
if (app.isNil()) throw new Error("process ${pid} has exited");
app.activateWithOptions(0);
function same(a, b) {
  return a && b && a.X === b.X && a.Y === b.Y && a.Width === b.Width && a.Height === b.Height;
}
var origin = ${origin}, start = Date.now(), fallback = false, last = null, steady = 0;
while (Date.now() - start < ${BRING_FORWARD_TIMEOUT_MS}) {
  var w = current();
  var b = w ? w.kCGWindowBounds : null;
  steady = same(b, last) ? steady + 1 : 0;
  last = b;
  if (steady >= 2 && (!same(b, origin) || Date.now() - start > ${MIN_ANIMATION_MS})) break;
  if (!b && !fallback && Date.now() - start > ${BRING_FORWARD_TIMEOUT_MS / 2} && !app.bundleIdentifier.isNil()) {
    fallback = true;
    Application(app.bundleIdentifier.js).activate();
  }
  delay(0.05);
}
JSON.stringify(last ? { x: last.X, y: last.Y, width: last.Width, height: last.Height } : null);
`;
}

/**
 * Activate the window's app and wait until the window is on screen. Returns its
 * bounds there (it may move or resize coming forward), or undefined if it never
 * arrived: minimised, hidden, or a background tab.
 */
export async function bringForward(window: WindowInfo, signal?: AbortSignal): Promise<Rect | undefined> {
	let out: string;
	try {
		out = await osascriptJs(bringForwardJxa(window), signal);
	} catch (err: any) {
		const stderr = String(err.stderr ?? "").trim();
		throw new CaptureError(`could not bring ${window.app} forward: ${stderr || err.message}`);
	}
	let bounds: Rect | null;
	try {
		bounds = JSON.parse(out);
	} catch {
		throw new CaptureError(`bringing ${window.app} forward returned no window bounds: ${out.slice(0, 200)}`);
	}
	if (!bounds) return undefined;
	await settle(REPAINT_MS);
	return bounds;
}

/**
 * Hand focus back to `previousPid`, but only if `borrowedPid` still has it: if
 * the user moved on in the meantime, pulling them back would be the same theft
 * twice. Resolves whether focus was handed back.
 */
export async function returnFocus(borrowedPid: number, previousPid: number): Promise<boolean> {
	const source = `
ObjC.import("AppKit");
var front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
var ours = !front.isNil() && front.processIdentifier === ${borrowedPid};
var previous = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${previousPid});
if (ours && !previous.isNil()) previous.activateWithOptions(0);
JSON.stringify(ours && !previous.isNil());
`;
	try {
		return JSON.parse(await osascriptJs(source)) === true;
	} catch {
		return false;
	}
}
