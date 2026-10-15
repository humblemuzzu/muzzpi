/**
 * screenshot: capture a window, the screen, a region or a web page, and return
 * it already inside the model's image limits (lib/image-fit.ts), so neither pi
 * nor the API resamples it again.
 */

import fs from "node:fs";
import path from "node:path";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
	bringForward,
	captureDisplay,
	captureRegion,
	captureWindow,
	CaptureError,
	type CaptureOptions,
	describeWindow,
	frameKey,
	groupLikelyTabs,
	MAX_WAIT_MS,
	permissionAdvice,
	primaryScreenPoints,
	readWindowServer,
	type Rect,
	returnFocus,
	screenRecordingGranted,
	titlesVisible,
	type WindowInfo,
	type WindowServerState,
	withoutGhosts,
} from "./lib/capture";
import { defaultOutDir, type FitResult, fitImageFile, imageSize, pruneOutDir } from "./lib/image-fit";
import { planToolImages, recordReturnedImages, sessionNote } from "./lib/image-budget";
import { crop, load, save } from "./lib/image";
import { captureWebPage } from "./lib/web-capture";
import { boxRendererWindowed, textSection, type Excerpt } from "./lib/box-format";
import { getContainer, getText } from "./lib/tui";

const COLLAPSED_EXCERPTS: Excerpt[] = [{ focus: "head" as const, context: 6 }];

/** Caps that keep a list or an ambiguity note from flooding the context. */
const MAX_LISTED_FRAMES = 25;
const MAX_ALSO_MATCHED = 5;

export interface ScreenshotArgs {
	target?: string;
	region?: unknown;
	list?: boolean;
	activate?: boolean;
	wait_ms?: number;
	selector?: string;
	viewport_width?: number;
}

const RETIRED_KEYS = new Set([
	"app",
	"window_title",
	"window_id",
	"display",
	"url",
	"delay_ms",
	"cursor",
	"shadow",
	"tier",
	"full_page",
]);

/**
 * Folds the retired targeting parameters into `target` (with the old
 * precedence: url, window_id, app + window_title, display) and `delay_ms` into
 * `wait_ms`, so sessions and sub-agents that learned the old schema still work.
 */
export function prepareScreenshotArguments(input: unknown): unknown {
	if (!input || typeof input !== "object" || Array.isArray(input)) return input;
	const args = input as Record<string, unknown>;
	const keys = Object.keys(args);
	if (typeof args.target !== "number" && !keys.some((key) => RETIRED_KEYS.has(key))) return input;

	const out: Record<string, unknown> = {};
	for (const key of keys) if (!RETIRED_KEYS.has(key)) out[key] = args[key];
	const named = [args.app, args.window_title].filter((v) => v !== undefined && v !== null && v !== "").join(" ");
	const target =
		args.target ??
		args.url ??
		args.window_id ??
		(named || undefined) ??
		(args.display !== undefined ? `screen ${args.display}` : undefined);
	if (target !== undefined) out.target = String(target);
	if (out.wait_ms === undefined && args.delay_ms !== undefined) out.wait_ms = args.delay_ms;
	return out;
}

export type Target =
	| { kind: "screen"; display?: number }
	| { kind: "url"; url: string }
	| { kind: "windowId"; id: number }
	| { kind: "windowQuery"; query: string };

type WindowTarget = Extract<Target, { kind: "windowId" | "windowQuery" }>;

export function parseTarget(raw: string | undefined): Target {
	const text = (raw ?? "").trim();
	if (!text) return { kind: "screen" };
	const screen = /^(?:screen|display|desktop)(?:\s*[:#]?\s*(\d+))?$/i.exec(text);
	if (screen) return screen[1] ? { kind: "screen", display: Number(screen[1]) } : { kind: "screen" };
	if (/^(?:https?|file):\/\//i.test(text)) return { kind: "url", url: text };
	if (/^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(text)) {
		return { kind: "url", url: `http://${text}` };
	}
	const id = /^(?:id\s*[:#]?\s*)?(\d+)$/i.exec(text);
	if (id) return { kind: "windowId", id: Number(id[1]) };
	return { kind: "windowQuery", query: text };
}

/** Accepts the shapes models actually send: an array, a JSON or "x,y,w,h" string, or an object. */
export function normalizeRegion(value: unknown): Rect | undefined {
	if (value === undefined || value === null) return undefined;

	let parts: unknown[] | undefined;
	if (Array.isArray(value)) {
		parts = value;
	} else if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed.startsWith("[")) {
			try {
				const parsed = JSON.parse(trimmed);
				if (Array.isArray(parsed)) parts = parsed;
			} catch {
				/* fall through to the comma split */
			}
		}
		if (!parts) parts = trimmed.split(/[,\s]+/).filter(Boolean);
	} else if (typeof value === "object") {
		const o = value as Record<string, unknown>;
		const got = [o.x, o.y, o.width ?? o.w, o.height ?? o.h];
		if (got.every((n) => n !== undefined)) parts = got;
	}

	if (!parts || parts.length !== 4) {
		throw new Error(`region needs exactly four numbers as [x, y, width, height], got ${JSON.stringify(value)}`);
	}
	const [x, y, width, height] = parts.map((n) => Number(n)) as [number, number, number, number];
	if (![x, y, width, height].every((n) => Number.isFinite(n))) {
		throw new Error(`region values must all be numbers, got ${JSON.stringify(value)}`);
	}
	if (width <= 0 || height <= 0) {
		throw new Error(`region needs a positive width and height, got ${width}×${height}`);
	}
	return { x, y, width, height };
}

/** Lower-case, without the invisible marks some apps put in their names (WhatsApp's starts with U+200E). */
function fold(text: string): string {
	return text.replace(/[\u200b-\u200f\u2060\ufeff]/g, "").toLowerCase();
}

/** 0 = no match. Every word must appear in the app name or title; the app name itself ranks highest. */
function matchScore(w: WindowInfo, query: string, words: string[]): number {
	const app = fold(w.app);
	const haystack = `${app} ${fold(w.title)}`;
	if (!words.every((word) => haystack.includes(word))) return 0;
	if (app === query) return 3;
	if (app.startsWith(query)) return 2;
	return 1;
}

/** Capturable where it is, without moving focus. */
function inPlace(w: WindowInfo): number {
	return w.onScreen && !w.inStageStrip ? 1 : 0;
}

export interface WindowChoice {
	window: WindowInfo;
	/** The other matching windows, one per frame, best first. */
	alsoMatched: WindowInfo[];
}

/**
 * Never refuses for ambiguity: a capture plus the names of the alternatives
 * costs one call, a refusal costs two. Ties go to on-screen windows (no focus
 * change needed), then to the most recently used.
 */
export function resolveWindow(target: WindowTarget, windows: WindowInfo[]): WindowChoice {
	if (target.kind === "windowId") {
		const window = windows.find((w) => w.id === target.id);
		if (!window) {
			throw new CaptureError(
				`no window with id ${target.id}; ids change when an app relaunches.\n\n${renderOpenWindows(windows)}`,
			);
		}
		return { window, alsoMatched: [] };
	}

	const query = fold(target.query.trim());
	const words = query.split(/\s+/).filter(Boolean);
	const ranked = withoutGhosts(windows)
		.map((window, order) => ({ window, order, score: matchScore(window, query, words) }))
		.filter((c) => c.score > 0)
		.sort(
			(a, b) =>
				b.score - a.score || inPlace(b.window) - inPlace(a.window) || a.order - b.order,
		)
		.map((c) => c.window);

	const [window, ...rest] = ranked;
	if (!window) {
		const hint = titlesVisible(windows)
			? ""
			: "\n\nEvery window title is blank: Screen Recording is probably not granted to the terminal running pi.";
		throw new CaptureError(`no window matches "${target.query}".\n\n${renderOpenWindows(windows)}${hint}`);
	}
	const frames = new Set([frameKey(window)]);
	const alsoMatched: WindowInfo[] = [];
	for (const w of rest) {
		if (frames.has(frameKey(w))) continue;
		frames.add(frameKey(w));
		alsoMatched.push(w);
	}
	return { window, alsoMatched };
}

/** Windows of regular apps, on-screen first, native tabs folded into their frame. */
export function renderOpenWindows(windows: WindowInfo[]): string {
	const shown = withoutGhosts(windows)
		.filter((w) => w.regularApp !== false)
		.sort(
			(a, b) =>
				Number(b.onScreen) - Number(a.onScreen) || a.app.localeCompare(b.app) || a.title.localeCompare(b.title),
		);
	const groups = groupLikelyTabs(shown);
	const lines = [
		shown.length === 0
			? "no app windows found."
			: groups.length === shown.length
				? `${shown.length} open windows:`
				: `${shown.length} open windows in ${groups.length} frames (native tabs folded):`,
	];
	for (const group of groups.slice(0, MAX_LISTED_FRAMES)) {
		const lead = group.find((w) => w.onScreen) ?? group[0]!;
		lines.push(describeWindow(lead));
		if (group.length > 1) {
			const tabs = group.filter((w) => w !== lead).map((w) => w.id);
			lines.push(`      + ${tabs.length} more tab(s): ${tabs.join(", ")}`);
		}
	}
	if (groups.length > MAX_LISTED_FRAMES) lines.push(`  … and ${groups.length - MAX_LISTED_FRAMES} more`);
	const unlisted = windows.length - shown.length;
	if (unlisted > 0) lines.push(`(${unlisted} helper or never-shown window(s) not listed)`);
	return lines.join("\n");
}

/**
 * The on-screen window sharing `target`'s app and exact frame: its tab group
 * as currently displayed. Undefined when `target` is itself on screen.
 */
export function displayedSibling(target: WindowInfo, pool: WindowInfo[]): WindowInfo | undefined {
	if (target.onScreen) return undefined;
	return pool.find((w) => w.id !== target.id && w.onScreen && frameKey(w) === frameKey(target));
}

/**
 * Background tabs often do capture, so this is only offered after a real
 * failure, and the sibling is never captured in its place: it shows the
 * active tab's content, not the one asked for.
 */
export function tabRescueAdvice(target: WindowInfo, sibling: WindowInfo): string {
	return (
		`\n\nid ${target.id} looks like a background tab of a window that IS on screen as id ${sibling.id}` +
		`${sibling.title ? ` ("${sibling.title}")` : ""}. Capturing ${sibling.id} will succeed, but it shows the ` +
		`ACTIVE tab's content, not id ${target.id}'s. To get id ${target.id}'s own content, switch to that tab ` +
		`first, then retry.`
	);
}

/** The macOS calls the window path makes, injectable so the focus logic can be tested. */
export interface WindowOps {
	readWindowServer: typeof readWindowServer;
	captureWindow: typeof captureWindow;
	bringForward: typeof bringForward;
	returnFocus: typeof returnFocus;
	screenRecordingGranted: typeof screenRecordingGranted;
	permissionAdvice: typeof permissionAdvice;
}

const macOS: WindowOps = {
	readWindowServer,
	captureWindow,
	bringForward,
	returnFocus,
	screenRecordingGranted,
	permissionAdvice,
};

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

interface Shot {
	label: string;
	/** The captured area in the units `region` and pages use; set only when exact. */
	extent?: { width: number; height: number; unit: "pt" | "css px" };
	notes: string[];
}

async function shootScreen(out: string, target: { display?: number }, region: Rect | undefined, opts: CaptureOptions): Promise<Shot> {
	if (region) {
		await captureRegion(out, region, opts);
		return {
			label: `screen region at ${region.x},${region.y}`,
			extent: { width: region.width, height: region.height, unit: "pt" },
			notes: [],
		};
	}
	const primary = target.display === undefined || target.display === 1;
	const [points] = await Promise.all([
		primary ? primaryScreenPoints() : undefined,
		captureDisplay(out, target.display, opts),
	]);
	const shot: Shot = { label: primary ? "main display" : `display ${target.display}`, notes: [] };
	if (points) {
		const size = imageSize(out);
		const scale = size.width / points.width;
		if (Number.isInteger(scale) && size.height === points.height * scale) shot.extent = { ...points, unit: "pt" };
	}
	return shot;
}

async function shootUrl(out: string, url: string, args: ScreenshotArgs, opts: CaptureOptions): Promise<Shot> {
	const web = await captureWebPage(out, {
		url,
		width: args.viewport_width,
		selector: args.selector,
		waitMs: opts.waitMs,
		signal: opts.signal,
	});
	const notes: string[] = [];
	if (web.clipped) {
		const captured = web.clipped.capturedHeight.toLocaleString("en-US");
		notes.push(
			`CLIPPED BY THE BROWSER: the page is ${web.clipped.documentHeight.toLocaleString("en-US")}px tall, but ` +
				`Chromium renders blank pixels past ${captured}px instead of failing, so only the top ${captured}px is ` +
				`real. Use selector to reach a section further down.`,
		);
	}
	if (web.overflow > 0) {
		notes.push(`the page scrolls sideways by ${web.overflow}px at this width; content on the right may be cut off`);
	}
	if (web.pageErrors.length) {
		notes.push(`${web.pageErrors.length} JavaScript error(s) on the page: ${web.pageErrors.slice(0, 3).join(" | ")}`);
	}
	const size = imageSize(out);
	return {
		label: `${web.finalUrl}${web.title ? ` — ${web.title}` : ""}${args.selector ? ` [${args.selector}]` : ""}`,
		extent: { ...size, unit: "css px" },
		notes,
	};
}

async function explainWindowFailure(
	ops: WindowOps,
	err: unknown,
	window: WindowInfo,
	windows: WindowInfo[],
	broughtForward: boolean,
): Promise<string> {
	const reason = err instanceof Error ? err.message : String(err);
	const name = `${window.app} window ${window.id}${window.title ? ` ("${window.title}")` : ""}`;
	let text: string;
	if (broughtForward) {
		text =
			`${name} could not be captured even after bringing ${window.app} forward: ${reason}. ` +
			`It may be minimised, hidden, or a background tab.`;
	} else {
		const advice = await ops.permissionAdvice(windows);
		const likely = window.inStageStrip ? "" : " (another Space, minimised, hidden, or a Stage Manager side window)";
		text = advice
			? `${reason}\n\n${advice}`
			: `${name} could not be captured where it is${likely}: ${reason}. Retry without activate:false to ` +
				`bring it forward briefly; focus is handed back after.`;
	}
	const sibling = displayedSibling(window, windows);
	return sibling ? text + tabRescueAdvice(window, sibling) : text;
}

async function handBackFocus(
	ops: WindowOps,
	window: WindowInfo,
	state: WindowServerState,
	since: number,
): Promise<string> {
	const held = `${((Date.now() - since) / 1000).toFixed(1)}s`;
	const previous = state.frontmostPid;
	if (previous === undefined || previous === window.pid) {
		return `brought ${window.app} forward (${held}); it was already the active app.`;
	}
	const name = state.windows.find((w) => w.pid === previous)?.app ?? "the previous app";
	return (await ops.returnFocus(window.pid, previous))
		? `brought ${window.app} forward for ${held} to capture it, then handed focus back to ${name}.`
		: `brought ${window.app} forward for ${held}; focus was not handed back to ${name}, because another ` +
			`app became active meanwhile or ${name} quit.`;
}

async function shootWindow(
	ops: WindowOps,
	out: string,
	target: WindowTarget,
	region: Rect | undefined,
	activate: boolean | undefined,
	opts: CaptureOptions,
): Promise<Shot> {
	const state = await ops.readWindowServer(opts.signal);
	const { window: chosen, alsoMatched } = resolveWindow(target, state.windows);
	let window = chosen;
	let borrowedAt: number | undefined;
	const borrowFocus = async () => {
		borrowedAt = Date.now();
		const bounds = await ops.bringForward(window, opts.signal);
		if (bounds) window = { ...window, ...bounds, onScreen: true, inStageStrip: false };
		else if (window.inStageStrip) throw new CaptureError("it never grew out of its Stage Manager thumbnail");
	};

	let failure: unknown;
	try {
		if (activate === true || (window.inStageStrip && activate !== false)) await borrowFocus();
		else if (window.inStageStrip) {
			throw new CaptureError("it is shown only as a Stage Manager thumbnail, which captures as a tiny skewed preview");
		}
		try {
			await ops.captureWindow(out, window.id, opts);
		} catch (err) {
			// A Stage Manager side window is "on screen" yet uncapturable, so on-screen
			// is no reason to give up; only a missing permission is, and focus cannot fix that.
			if (borrowedAt !== undefined || activate === false || (await ops.screenRecordingGranted()) === false) {
				throw err;
			}
			await borrowFocus();
			await ops.captureWindow(out, window.id, { signal: opts.signal });
		}
	} catch (err) {
		failure = err;
	}
	const focusNote = borrowedAt === undefined ? undefined : await handBackFocus(ops, window, state, borrowedAt);
	if (failure !== undefined) {
		const why = await explainWindowFailure(ops, failure, window, state.windows, borrowedAt !== undefined);
		throw new CaptureError(focusNote ? `${why}\n${focusNote}` : why);
	}

	const notes = focusNote ? [focusNote] : [];
	const size = imageSize(out);
	const scale = Math.max(1, Math.round(size.width / window.width));
	const shot: Shot = {
		label: `${window.app} — ${window.title ? `"${window.title}"` : "(untitled)"} [id ${window.id}]`,
		extent: { width: Math.round(size.width / scale), height: Math.round(size.height / scale), unit: "pt" },
		notes,
	};

	// Cropping the capture, not capturing a screen rect, stays right if the
	// window moves and keeps the native tab bar that window bounds leave out.
	if (region) {
		const box = { x: region.x * scale, y: region.y * scale, width: region.width * scale, height: region.height * scale };
		const x = Math.max(0, Math.min(box.x, size.width - 1));
		const y = Math.max(0, Math.min(box.y, size.height - 1));
		const clamped = {
			x,
			y,
			width: Math.max(1, Math.min(box.width, size.width - x)),
			height: Math.max(1, Math.min(box.height, size.height - y)),
		};
		save(crop(load(out), clamped), out);
		shot.label += ` region at ${region.x},${region.y}`;
		shot.extent = { width: clamped.width / scale, height: clamped.height / scale, unit: "pt" };
		if (clamped.width !== box.width || clamped.height !== box.height) {
			notes.push(
				`the region ran past the window edge and was clamped to ${shot.extent.width}×${shot.extent.height} pt.`,
			);
		}
	}

	if (alsoMatched.length) {
		const named = alsoMatched
			.slice(0, MAX_ALSO_MATCHED)
			.map((w) => `${w.id} ${w.app}${w.title ? ` "${clip(w.title, 40)}"` : ""}`);
		const more = alsoMatched.length > MAX_ALSO_MATCHED ? ` and ${alsoMatched.length - MAX_ALSO_MATCHED} more` : "";
		notes.push(`also matched: ${named.join(", ")}${more}. Pass one of those ids as target to capture it instead.`);
	}
	return shot;
}

function headline(shot: Shot, fit: FitResult): string {
	const first = fit.outputs[0]!;
	const image =
		fit.outputs.length === 1
			? `${first.width}×${first.height} px image`
			: `${fit.outputs.length} slices of ${first.width}×${first.height} px, top to bottom`;
	const from = shot.extent ? `${shot.extent.width}×${shot.extent.height} ${shot.extent.unit} → ` : "";
	return `${shot.label} · ${from}${image} · ${fit.totalTokens.toLocaleString("en-US")} tokens`;
}

function savedLine(fit: FitResult): string {
	const paths = fit.outputs.map((o) => o.path);
	const dir = path.dirname(paths[0]!);
	if (paths.length > 1 && paths.every((p) => path.dirname(p) === dir)) {
		return `saved in ${dir}: ${paths.map((p) => path.basename(p)).join(", ")}`;
	}
	return `saved ${paths.join(", ")}`;
}

function textResult(text: string, isError = false): any {
	return { content: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) };
}

export function createScreenshotTool(ops: WindowOps = macOS): ToolDefinition {
	return {
		name: "screenshot",
		label: "Screenshot",
		description:
			"Capture a window, the screen, a region, or a web page, sized for your vision limits.\n\n" +
			"A window behind others is captured without moving focus; one on another Space is brought forward " +
			"briefly and focus is handed back. If several windows match, the best is captured and the rest named.\n\n" +
			"The result gives the captured size in points beside the image size; to read small text, capture a " +
			"region. A URL renders the whole page in a fresh logged-out headless browser as ordered slices; a very " +
			"long page is truncated, so use selector for a section.\n\n" +
			'Example: screenshot({ target: "Safari" })',

		parameters: Type.Object({
			target: Type.Optional(
				Type.String({
					description:
						'App name or window-title words ("Discord", "Instagram"), a window id from list, "screen" ' +
						'(default) or "screen 2", or an http(s)/localhost URL.',
				}),
			),
			region: Type.Optional(
				Type.Array(Type.Number(), {
					description:
						"[x, y, width, height] in points; relative to the window for a window target, else screen coordinates.",
				}),
			),
			list: Type.Optional(
				Type.Boolean({ description: "List open windows with ids and titles instead of capturing." }),
			),
			activate: Type.Optional(
				Type.Boolean({
					description:
						"Window targets: unset brings the app forward only if needed, true always, false never. " +
						"Focus is handed back.",
				}),
			),
			wait_ms: Type.Optional(
				Type.Number({
					description: `Delay before capturing, for animations or loading, in ms (max ${MAX_WAIT_MS}).`,
				}),
			),
			selector: Type.Optional(
				Type.String({ description: "URL only: capture just the element matching this CSS selector." }),
			),
			viewport_width: Type.Optional(
				Type.Number({
					description: "URL only: browser width in CSS px, which sets the responsive layout (default 1440).",
				}),
			),
		}),

		prepareArguments: prepareScreenshotArguments as any,

		renderCall(args: any, theme: any, context: any) {
			const Text = getText();
			const text = context?.lastComponent ?? new Text("", 0, 0);
			const a = (prepareScreenshotArguments(args ?? {}) ?? {}) as ScreenshotArgs;
			let what = a.list ? "list windows" : String(a.target ?? "").trim() || "main display";
			if (!a.list && a.region !== undefined) what += ` region ${JSON.stringify(a.region)}`;
			// Single-line sink: a newline is width-0 to pi-tui and still moves the cursor.
			what = what.replace(/[\r\n\t\v\f]+/g, " ").slice(0, 60);
			text.setText(theme.fg("toolTitle", theme.bold("Screenshot ")) + theme.fg("dim", what));
			return text;
		},

		renderResult(result: any, _opts: { expanded: boolean }, _theme: any, context: any) {
			const Container = getContainer();
			const container = context?.lastComponent ?? new Container();
			container.clear();
			// pi renders the image blocks itself; this shows the text audit trail.
			const textBlock = [...(result.content ?? [])].reverse().find((c: any) => c.type === "text");
			const body = textBlock?.text ?? "(no output)";
			container.addChild(
				boxRendererWindowed(() => [textSection(undefined, body)], {
					collapsed: { excerpts: COLLAPSED_EXCERPTS },
					expanded: {},
				}),
			);
			return container;
		},

		async execute(toolCallId, params: ScreenshotArgs, signal, _onUpdate, ctx) {
			try {
				if (params.list) {
					const { windows } = await ops.readWindowServer(signal);
					const advice = titlesVisible(windows) ? "" : await ops.permissionAdvice(windows);
					return textResult(advice ? `${renderOpenWindows(windows)}\n\n${advice}` : renderOpenWindows(windows));
				}

				const images = planToolImages(ctx);
				if (!images.ok) return textResult(images.reason, true);

				const target = parseTarget(params.target);
				const region = normalizeRegion(params.region);
				if (target.kind !== "url" && (params.selector !== undefined || params.viewport_width !== undefined)) {
					return textResult("selector and viewport_width apply only to a URL target.", true);
				}
				if (target.kind === "url" && region) {
					return textResult("region does not apply to a URL target; use selector to capture one element.", true);
				}

				const outDir = defaultOutDir();
				fs.mkdirSync(outDir, { recursive: true });
				pruneOutDir(outDir);
				const stamp = `shot-${Date.now()}`;
				const rawPath = path.join(outDir, `${stamp}.raw.png`);
				const opts: CaptureOptions = {
					waitMs: params.wait_ms === undefined ? undefined : Math.min(Number(params.wait_ms), MAX_WAIT_MS),
					signal,
				};

				const shot =
					target.kind === "url"
						? await shootUrl(rawPath, target.url, params, opts)
						: target.kind === "screen"
							? await shootScreen(rawPath, target, region, opts)
							: await shootWindow(ops, rawPath, target, region, params.activate, opts);

				const fit = fitImageFile(rawPath, {
					tier: images.tier,
					limits: images.limits,
					budget: images.budget,
					outDir,
					basename: stamp,
				});
				recordReturnedImages(ctx, toolCallId, fit.totalBase64, fit.outputs.length);
				// An image that needed no resizing is returned as the capture file itself.
				const untouched = fit.outputs.find((o) => o.path === rawPath);
				if (untouched) {
					untouched.path = path.join(outDir, `${stamp}.png`);
					fs.renameSync(rawPath, untouched.path);
				} else {
					fs.rmSync(rawPath, { force: true });
				}

				const lines = [headline(shot, fit), savedLine(fit), ...shot.notes, ...fit.notes];
				const session = sessionNote(images.limits, images.usage, fit.totalBase64);
				if (session) lines.push(session);

				return {
					content: [
						...fit.outputs.map((o) => ({ type: "image" as const, data: o.base64, mimeType: o.mimeType })),
						{ type: "text" as const, text: lines.join("\n") },
					],
					details: {
						header: shot.label,
						plan: fit.plan,
						tier: images.tier,
						resamples: fit.resamples,
						totalTokens: fit.totalTokens,
						totalBase64: fit.totalBase64,
						source: fit.source,
						outputs: fit.outputs.map(({ base64: _base64, ...rest }) => rest),
					},
				} as any;
			} catch (err: any) {
				return textResult(err?.message ?? String(err), true);
			}
		},
	};
}
