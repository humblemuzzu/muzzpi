/**
 * editor extension — box-drawn prompt editor with label slots in its borders.
 *
 * other extensions add labels over the shared EventBus:
 *   pi.events.emit("editor:set-label", { key: "handoff", text: "↳ handed off", position: "top", align: "left" })
 *   pi.events.emit("editor:remove-label", { key: "handoff" })
 * optional `priority` (default 50): a narrow terminal drops the lowest first.
 * optional `when`: "idle" hides the label while a run is on, "detail" shows it
 * only in the detail view (/hud, ctrl+shift+i).
 */

import type { ExtensionAPI, ExtensionContext, ReadonlyFooterDataProvider, SessionEntry } from "@mariozechner/pi-coding-agent";
import { CustomEditor, Theme, estimateTokens, getAgentDir } from "@mariozechner/pi-coding-agent";
import type { TUI, EditorTheme, TuiMouseEvent } from "@mariozechner/pi-tui";
import { Image } from "@mariozechner/pi-tui";
import type { KeybindingsManager } from "@mariozechner/pi-coding-agent";
import type { AssistantMessage, ImageContent, TextContent } from "@mariozechner/pi-ai";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { hasToolCost } from "../tools/lib/tool-cost";
import { clipboardImageModule } from "../tools/lib/pi-package-dir";
import { completeWords, findWord, splitArgs, type Word } from "../tools/lib/command-args";
import { contributeHelp } from "../tools/lib/help-channel";
import {
	SPINNER_INTERVAL_MS,
	activityLabel,
	advanceSpinner,
	createActivityState,
	describeToolCall,
	endActivity,
	runDetail,
	startActivity,
} from "./activity";
import { type BorderSegment, layoutBorder } from "./border";
import { type CacheStats, type CacheView, collectCacheStats, formatCompact } from "./cache-line";
import { type DiffSummary, formatChanges, readDiffSummary } from "./changes";
import { type Alert, ink } from "./ink";
import { MetaRow } from "./meta-row";

// clipboard image paste → compact "[image #N]" placeholder
//
// pi's core paste handler writes the clipboard image to a temp file and inserts
// its raw path into the editor. We show a short "[image #N]" token instead and
// attach the image inline (base64) through the "input" hook on submit.
//
// core wires its default paste handler only when ours is unset, so if pi's
// clipboard-image module is missing we leave onPasteImage unset and pi's
// path-insert takes over. It loads on the first paste: under our bundle that
// pulls in a second pi-tui (~36 ms), which startup must not pay.

interface PastedImage {
	/** bare base64 (no data: prefix) — matches pi's ImageContent.data shape */
	data: string;
	mime: string;
}

/** visible token in the editor -> image payload. shared by editor + input hook. */
const pastedImages = new Map<string, PastedImage>();
let pasteCounter = 0;

const IMAGE_TOKEN = /\[image #\d+\]/g;
let showPeek: ((token: string | undefined) => void) | undefined;

// Escape gate — a running agent takes THREE escapes, not one
//
// pi's default onEscape aborts a streaming turn on the FIRST press, which makes
// a stray Esc destroy an in-flight session. This requires three presses inside
// a 5s window; miss the window and the count resets to zero (so a partial
// double-tap can never leave the gate "primed" for a later accidental press).
//
// Deliberately scoped to the ABORT case only. When the agent is idle the press
// is forwarded untouched, so bash-mode exit, autocomplete cancel and the
// double-Escape /tree action all keep their normal single/double-press feel.

/** how many escapes are needed to abort a running agent */
const ESCAPE_HITS_REQUIRED = 3;
/** all required presses must land inside this window, measured from the first */
const ESCAPE_WINDOW_MS = 5000;
/** label slot used for the "esc 2/3" countdown hint */
const ESCAPE_LABEL_KEY = "esc-gate";

/**
 * True while a turn is in flight — the only state in which Escape would abort.
 * Maintained by the agent_start/agent_end hooks below; module-scoped because
 * the editor class and the extension factory live in this same module (they
 * would NOT share state across pi's per-file jiti instances otherwise).
 */
let agentRunning = false;

type ClipboardImage = { bytes: Uint8Array; mimeType: string };

type ClipboardModule = { readClipboardImage?: () => Promise<ClipboardImage | null> };

function loadClipboardImageReader(): (() => Promise<ClipboardImage | null>) | null {
	const file = clipboardImageModule();
	if (!file) return null;
	let mod: ClipboardModule | undefined;
	return async () => {
		mod ??= createRequire(file)(file) as ClipboardModule;
		return typeof mod.readClipboardImage === "function" ? mod.readClipboardImage() : null;
	};
}

type LabelWhen = "idle" | "detail";

interface LabelOptions {
	/** higher survives longer when the border is too narrow */
	priority?: number;
	/** "idle": hidden while a run is on; "detail": only in the detail view */
	when?: LabelWhen;
}

interface Label {
	key: string;
	text: string;
	position: "top" | "bottom";
	align: "left" | "right";
	priority: number;
	when?: LabelWhen;
}

interface SetLabelPayload extends LabelOptions {
	key: string;
	text: string;
	position?: "top" | "bottom";
	align?: "left" | "right";
}

interface RemoveLabelPayload {
	key: string;
}

const DEFAULT_LABEL_PRIORITY = 50;

/** What the border reads from the extension on every render. */
interface HudState {
	running(): boolean;
	detail(): boolean;
	/** the run's bottom-left label, empty while idle */
	activity(): string;
}

/**
 * make a string safe to embed in a single border/status line: collapse
 * newlines/tabs/control chars (width-0 to every width check, but they move
 * the real cursor — the TUI desync class) into single spaces.
 */
export function flattenLabelText(text: string): string {
	return text
		.replace(/[\r\n\t\v\f]+/g, " ")              // cursor-moving whitespace → space
		.replace(/[\x00-\x08\x0e-\x1a\x1c-\x1f\x7f]+/g, "") // other C0/DEL (keeps \x1b: ANSI colors stay intact)
		.replace(/ {2,}/g, " ");
}
/** Border labels. The extension owns them, so a label sent before the editor mounts is kept. */
export class LabelBoard {
	private labels = new Map<string, Label>();

	/** @returns true if the stored label actually changed, so a poller resending the same text costs no repaint. */
	set(key: string, text: string, position: "top" | "bottom" = "top", align: "left" | "right" = "left", options: LabelOptions = {}): boolean {
		// SINK GUARD: labels are embedded into single border lines. An embedded
		// \n renders as an extra terminal row the TUI doesn't account for —
		// visibleWidth counts it as 0, so no width check catches it — and the
		// differential renderer desyncs (screen smear). Flatten ALL control
		// chars here so no label source (incl. other extensions via the
		// editor-set-label event) can ever inject one.
		const flat = flattenLabelText(text);
		const priority = options.priority ?? DEFAULT_LABEL_PRIORITY;
		const prev = this.labels.get(key);
		if (prev && prev.text === flat && prev.position === position && prev.align === align && prev.priority === priority && prev.when === options.when) {
			return false;
		}
		this.labels.set(key, { key, text: flat, position, align, priority, when: options.when });
		return true;
	}

	remove(key: string): boolean {
		return this.labels.delete(key);
	}

	visible(position: "top" | "bottom", align: "left" | "right", running: boolean, detail: boolean): BorderSegment[] {
		const shown = (label: Label) => label.when === undefined || (label.when === "idle" ? !running || detail : detail);
		return [...this.labels.values()]
			.filter((label) => label.position === position && label.align === align && shown(label))
			.map((label) => ({ text: label.text, priority: label.priority }));
	}
}

const CORNER_TL = "╭";
const CORNER_TR = "╮";
const CORNER_BL = "╰";
const CORNER_BR = "╯";
const HORIZONTAL = "─";
const VERTICAL = "│";

class LabeledEditor extends CustomEditor {
	private labels: LabelBoard;
	private appTheme: Theme;
	private tuiRef: TUI;
	private hud: HudState;
	private borderCache: Record<"top" | "bottom", { key: string; line: string } | null> = {
		top: null,
		bottom: null,
	};

	constructor(tui: TUI, editorTheme: EditorTheme, keybindings: KeybindingsManager, appTheme: Theme, hud: HudState, labels: LabelBoard) {
		super(tui, editorTheme, keybindings, { embedWorkingStatus: true });
		this.appTheme = appTheme;
		this.tuiRef = tui;
		this.hud = hud;
		this.labels = labels;
		this.setupImagePaste();
		this.setupEscapeGate();
	}

	// --- escape gate ------------------------------------------------------

	/** whatever pi core assigned to onEscape — the real abort/tree handler */
	private coreEscape?: () => void;
	private escapeHits = 0;
	private escapeTimer: ReturnType<typeof setTimeout> | undefined;

	/**
	 * Interpose on `onEscape` so a running agent needs THREE presses.
	 *
	 * `super()` has already installed `onEscape` as an OWN data property (a bare
	 * class field), which would shadow a prototype accessor, so the own property
	 * is redefined as an accessor. The getter reports `undefined` until core has
	 * assigned, because core wires its default with `if (!customEditor.onEscape)`:
	 * answering early would leave nothing to delegate to.
	 */
	private setupEscapeGate(): void {
		Object.defineProperty(this, "onEscape", {
			configurable: true,
			enumerable: true,
			get: () => (this.coreEscape ? this.escapeGate : undefined),
			set: (fn: (() => void) | undefined) => {
				this.coreEscape = fn;
			},
		});
	}

	private escapeGate = (): void => {
		// Idle: nothing to abort — forward untouched so double-Escape /tree,
		// bash-mode exit and friends keep their normal behaviour.
		if (!agentRunning) {
			this.resetEscapeGate();
			this.coreEscape?.();
			return;
		}

		this.escapeHits += 1;

		if (this.escapeHits === 1) {
			// Window runs from the FIRST press and is never extended: "press
			// all three within 5s" rather than "keep tapping to stay alive".
			this.escapeTimer = setTimeout(() => {
				this.escapeHits = 0;
				this.escapeTimer = undefined;
				this.labels.remove(ESCAPE_LABEL_KEY);
				this.tuiRef.requestRender();
			}, ESCAPE_WINDOW_MS);
		}

		if (this.escapeHits >= ESCAPE_HITS_REQUIRED) {
			this.resetEscapeGate();
			this.coreEscape?.();
			return;
		}

		const left = ESCAPE_HITS_REQUIRED - this.escapeHits;
		this.labels.set(ESCAPE_LABEL_KEY, this.appTheme.fg("warning", `esc ×${left} more to stop`), "bottom", "left", { priority: 100 });
		this.tuiRef.requestRender();
	};

	/** drop any in-progress escape count and its hint (also called on agent_end) */
	resetEscapeGate(): void {
		if (this.escapeTimer) {
			clearTimeout(this.escapeTimer);
			this.escapeTimer = undefined;
		}
		if (this.escapeHits > 0) {
			this.escapeHits = 0;
			this.labels.remove(ESCAPE_LABEL_KEY);
		}
	}

	/**
	 * Override clipboard image paste to insert a compact "[image #N]" token
	 * instead of the raw temp-file path. The real image is registered in
	 * `pastedImages` and attached inline by the "input" hook on submit.
	 *
	 * Only installed when the native clipboard module is available; otherwise
	 * `onPasteImage` is left unset and pi core wires its default handler.
	 */
	private setupImagePaste(): void {
		const readImage = loadClipboardImageReader();
		if (!readImage) return;
		this.onPasteImage = async () => {
			try {
				const image = await readImage();
				if (!image?.bytes?.length) return;
				const data = Buffer.from(image.bytes).toString("base64");
				if (!data) return;
				if (pastedImages.size === 0) pasteCounter = 0;
				const token = `[image #${++pasteCounter}]`;
				pastedImages.set(token, { data, mime: image.mimeType || "image/png" });
				this.insertTextAtCursor(`${token} `);
				showPeek?.(token);
				this.tuiRef.requestRender();
			} catch {
				// clipboard read failed — leave the editor untouched
			}
		};
	}

	private peekToken(): string | undefined {
		if (pastedImages.size === 0) return undefined;
		const { line, col } = this.getCursor();
		const text = this.getText().split("\n")[line] ?? "";
		for (const match of text.matchAll(IMAGE_TOKEN)) {
			const start = match.index ?? 0;
			if (col >= start && col <= start + match[0].length && pastedImages.has(match[0])) return match[0];
		}
		return undefined;
	}

	handleInput(data: string): void {
		super.handleInput(data);
		showPeek?.(this.peekToken());
	}

	handleMouse(event: TuiMouseEvent) {
		const result = super.handleMouse(event);
		showPeek?.(this.peekToken());
		return result;
	}

	/** always-dim color for box chrome (corners, lines, rails) */
	private dim(str: string): string {
		return this.appTheme.fg("dim", str);
	}

	private labelsFor(position: "top" | "bottom", align: "left" | "right"): BorderSegment[] {
		return this.labels.visible(position, align, this.hud.running(), this.hud.detail());
	}

	private extractScrollIndicator(originalLine: string): string {
		if (!originalLine.includes("↑") && !originalLine.includes("↓")) return "";
		const match = originalLine.match(/[↑↓]\s+\d+\s+more/);
		return match ? match[0] : "";
	}

	/** pi's own indicator, only for what we do not draw: retry countdown, compaction, branch summary. */
	private piStatusText(budget: number): string {
		if (!this.embedWorkingStatus || budget < 3) return "";
		const indicator = (
			this as unknown as {
				workingStatusIndicator?: { kind?: string; renderInBorder: (width: number) => string };
			}
		).workingStatusIndicator;
		if (!indicator || indicator.kind === "working") return "";
		return flattenLabelText(indicator.renderInBorder(budget));
	}

	/**
	 * build a border line like: ╭─ left · labels ─────── right · labels ─╮
	 *
	 * originalLine is the border super.render() produced — we check it for
	 * scroll indicators (↑/↓) and keep that text as a right-hand label.
	 */
	private buildBorderLine(
		outerWidth: number,
		cornerLeft: string,
		cornerRight: string,
		position: "top" | "bottom",
		originalLine: string,
	): string {
		const left = this.labelsFor(position, "left");
		const right = this.labelsFor(position, "right");
		if (position === "bottom") {
			const activity = this.hud.activity();
			if (activity) left.unshift({ text: flattenLabelText(activity), priority: 100 });
		} else {
			const status = this.piStatusText(Math.max(8, outerWidth - 8));
			if (status) right.push({ text: status, priority: 95 });
		}
		const scroll = this.extractScrollIndicator(originalLine);
		if (scroll) right.push({ text: this.dim(scroll), priority: 99 });

		const serialize = (segments: BorderSegment[]) => segments.map((s) => `${s.priority}:${s.text}`).join("\u0000");
		const cacheKey = `${outerWidth}\u0001${serialize(left)}\u0001${serialize(right)}`;
		const cached = this.borderCache[position];
		if (cached?.key === cacheKey) return cached.line;

		const line = layoutBorder(
			outerWidth,
			{ left: cornerLeft, right: cornerRight, horizontal: HORIZONTAL, chrome: (text) => this.dim(text) },
			left,
			right,
		);
		this.borderCache[position] = { key: cacheKey, line };
		return line;
	}

	/**
	 * find the bottom border index in the lines array from super.render().
	 * the bottom border is a full-width line of ─ characters (possibly with a scroll indicator).
	 * autocomplete lines appear after it and contain mixed content (not all ─).
	 *
	 * strategy: walk backward from the end, looking for a line whose stripped content
	 * is predominantly ─ characters. the first such line (from the end) is the bottom border.
	 */
	private findBottomBorderIndex(lines: string[]): number {
		for (let i = lines.length - 1; i >= 1; i--) {
			const stripped = lines[i]
				.replace(/\x1b\[[0-9;]*[mGKHJ]/g, "")
				.replace(/\x1b_[^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
				.replace(/\x1b\]8;;[^\x07]*\x07/g, "");
			if (stripped.length > 0 && stripped[0] === HORIZONTAL) {
				return i;
			}
		}
		return lines.length - 1;
	}

	render(width: number): string[] {
		// render the base editor at (width - 2) to leave room for │ side rails
		const innerWidth = width - 2;
		if (innerWidth < 4) return super.render(width); // too narrow, bail

		const lines = super.render(innerWidth);
		if (lines.length < 2) return lines;

		const bottomIdx = this.findBottomBorderIndex(lines);
		const result: string[] = [];

		// top border — replace line 0
		result.push(this.buildBorderLine(width, CORNER_TL, CORNER_TR, "top", lines[0]));

		// content lines — wrap with dim │ side rails
		for (let i = 1; i < bottomIdx; i++) {
			result.push(this.dim(VERTICAL) + lines[i] + this.dim(VERTICAL));
		}

		// pad to minimum height (bigger prompt box — matches nmwcode's layout)
		const MIN_CONTENT_LINES = 4;
		const contentCount = bottomIdx - 1; // lines between top and bottom border
		for (let pad = contentCount; pad < MIN_CONTENT_LINES; pad++) {
			const emptyLine = " ".repeat(Math.max(0, innerWidth));
			result.push(this.dim(VERTICAL) + emptyLine + this.dim(VERTICAL));
		}

		// bottom border
		result.push(this.buildBorderLine(width, CORNER_BL, CORNER_BR, "bottom", lines[bottomIdx]));

		// autocomplete lines (if any) — pass through, offset to align with inner content
		for (let i = bottomIdx + 1; i < lines.length; i++) {
			result.push(" " + lines[i] + " ");
		}

		return result;
	}
}

function shortenPath(cwd: string): string {
	const home = process.env.HOME || process.env.USERPROFILE || "";
	if (home && cwd.startsWith(home)) return "~" + cwd.slice(home.length);
	return cwd;
}

/**
 * estimate context tokens from session entries using chars/4 heuristic.
 * fallback when provider hasn't reported usage yet (e.g., after compaction).
 */
function estimateContextFromEntries(entries: SessionEntry[]): number {
	let total = 0;
	for (const entry of entries) {
		switch (entry.type) {
			case "message":
				total += estimateTokens(entry.message);
				break;
			case "custom_message": {
				const content = entry.content;
				const text = typeof content === "string"
					? content
					: content
						.filter((c): c is TextContent => c.type === "text")
						.map((c) => c.text)
						.join("");
				total += Math.ceil(text.length / 4);
				break;
			}
			case "branch_summary":
				// branch summaries have a `summary` field
				if (entry.summary) {
					total += Math.ceil(entry.summary.length / 4);
				}
				break;
			case "compaction":
				// compaction entries also have a `summary` field
				if (entry.summary) {
					total += Math.ceil(entry.summary.length / 4);
				}
				break;
		}
	}
	return total;
}

/** Plain until the context is worth watching; pi compacts Claude at 85%. */
function contextAlert(percent: number): Alert {
	return percent >= 85 ? "error" : percent >= 70 ? "warning" : undefined;
}

/** Tools that can change the working tree, so the diff summary refreshes after them. */
const WRITING_TOOLS = new Set(["edit", "write", "bash", "undo_edit", "redo_edit", "format_file"]);
const CHANGES_DEBOUNCE_MS = 1500;

const HUD_SHORTCUT = "ctrl+shift+i";
const HUD_WORDS: Word[] = [
	{ name: "on", description: "show the detail row" },
	{ name: "off", description: "hide the detail row" },
];
const hudFile = () => join(getAgentDir(), "cache", "editor-hud.json");

function readDetailSetting(): boolean {
	try {
		return JSON.parse(readFileSync(hudFile(), "utf8"))?.detail === true;
	} catch {
		return false;
	}
}

function writeDetailSetting(detail: boolean): void {
	mkdirSync(dirname(hudFile()), { recursive: true });
	writeFileSync(hudFile(), JSON.stringify({ detail }));
}

export default function (pi: ExtensionAPI) {
	let editor: LabeledEditor | null = null;
	let tuiRef: TUI | null = null;
	let theme: Theme | null = null;
	let labelsBranchLength = -1;
	let gitBranch: string | null = null;
	let branchUnsub: (() => void) | null = null;
	let footerData: ReadonlyFooterDataProvider | null = null;
	let metaRow: MetaRow | null = null;
	let cacheView: CacheView | undefined;
	let changes: DiffSummary | undefined;
	let changesTimer: ReturnType<typeof setTimeout> | undefined;
	let changesGeneration = 0;
	let changesTicket = 0;
	const labels = new LabelBoard();
	let spinner: ReturnType<typeof setInterval> | undefined;
	let detail = readDetailSetting();
	let contextDetail = "";
	let providerDetail = "";
	let cwd = "";
	let requestStartedAt: number | undefined;
	let lastResponseAt: number | undefined;
	const activity = createActivityState();

	const repaint = (): void => tuiRef?.requestRender();

	const hud: HudState = {
		running: () => agentRunning,
		detail: () => detail,
		activity: () => (theme ? activityLabel(activity, Date.now(), theme) : ""),
	};

	/**
	 * Only a model whose catalog declares cache lifetimes gets a countdown, so a
	 * provider without `promptCache` gets no fake zero. The latest write's tier
	 * wins over the catalog: a forced 5m or an overage spell shows as it is.
	 */
	const cacheTtlMs = (ctx: ExtensionContext, stats: CacheStats): number | undefined => {
		const catalog = ctx.model?.promptCache;
		if (!catalog) return undefined;
		if (stats.lastWriteTtlMs !== undefined) return stats.lastWriteTtlMs;
		const seconds = catalog[process.env.PI_CACHE_RETENTION === "long" ? "long" : "short"];
		return seconds === undefined ? undefined : seconds * 1000;
	};

	const syncCache = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI) return;
		const stats = collectCacheStats(ctx.sessionManager.getEntries(), lastResponseAt);
		const ttlMs = cacheTtlMs(ctx, stats);
		// Without a declared lifetime, the cache figure waits until the provider
		// has reported cache activity: most report reads, only Anthropic a lifetime.
		const reportsActivity = stats.cacheRead > 0 || stats.cacheWrite > 0;
		cacheView = ttlMs === undefined && !reportsActivity ? undefined : { stats, ttlMs };
		metaRow?.sync();
	};

	const statusesText = (): string => {
		const statuses = footerData?.getExtensionStatuses();
		if (!theme || !statuses || statuses.size === 0) return "";
		const painter = theme;
		return [...statuses.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([, text]) => painter.fg("muted", flattenLabelText(text)))
			.join(painter.fg("dim", " · "));
	};

	const placeText = (): string => (cwd ? `${shortenPath(cwd)}${gitBranch ? ` (${gitBranch})` : ""}` : "");

	const sessionText = (): string => {
		if (!theme) return "";
		const parts = [contextDetail, providerDetail, runDetail(activity, Date.now())].filter(Boolean);
		return parts.join(theme.fg("dim", " · "));
	};

	/** `force` for a change the branch length cannot show: a new session, model or thinking level. */
	function updateSessionLabels(ctx: ExtensionContext, force = false): void {
		// skip recomputation if branch length unchanged (cheap proxy for "nothing new happened")
		const branch = ctx.sessionManager.getBranch();
		if (!force && branch.length === labelsBranchLength) return;
		labelsBranchLength = branch.length;

		const paint = ctx.ui.theme;
		const usage = ctx.getContextUsage();
		const model = ctx.model;

		let cost = 0;
		for (const entry of branch) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role === "assistant") {
				cost += (msg as AssistantMessage).usage?.cost?.total ?? 0;
			} else if (msg.role === "toolResult") {
				const details = (msg as { details?: unknown }).details;
				if (hasToolCost(details)) cost += details.cost;
			}
		}

		// provider-reported usage when there is any, otherwise a chars/4 estimate
		let context: { tokens: number; window: number; estimated: boolean } | undefined;
		if (usage?.percent != null && usage.tokens != null && usage.tokens > 0) {
			context = { tokens: usage.tokens, window: usage.contextWindow, estimated: false };
		} else if (model?.contextWindow) {
			context = { tokens: estimateContextFromEntries(branch), window: model.contextWindow, estimated: true };
		}

		if (context) {
			const percent = (context.tokens / context.window) * 100;
			const mark = context.estimated ? "~" : "";
			labels.set("context", ink(paint, contextAlert(percent), `${mark}${Math.round(percent)}%`), "top", "left", { priority: 100 });
			contextDetail = `context ${mark}${formatCompact(context.tokens)} of ${formatCompact(context.window)}`;
		} else {
			labels.remove("context");
			contextDetail = "";
		}

		if (cost > 0) labels.set("cost", `$${cost.toFixed(2)}`, "top", "left", { priority: 60 });
		else labels.remove("cost");

		if (model) labels.set("model", model.id, "top", "right", { priority: 90 });
		else labels.remove("model");
		providerDetail = model?.provider ?? "";

		const thinkingLevel = pi.getThinkingLevel();
		if (thinkingLevel && thinkingLevel !== "off") {
			labels.set("thinking", thinkingLevel, "top", "right", { priority: 70 });
		} else {
			labels.remove("thinking");
		}
	}

	function updatePlaceLabel(): void {
		if (!cwd) return;
		const branchText = gitBranch ? ` (${gitBranch})` : "";
		labels.set("cwd", `${basename(cwd)}${branchText}`, "bottom", "right", { priority: 35 });
	}

	/** Two refreshes can overlap (debounce 1.5s, git timeout 3s); only the newest may land. */
	const refreshChanges = async (): Promise<void> => {
		const generation = changesGeneration;
		const ticket = ++changesTicket;
		const next = await readDiffSummary(cwd);
		if (generation !== changesGeneration || ticket !== changesTicket) return;
		changes = next;
		repaint();
	};

	const scheduleChanges = (delayMs: number): void => {
		if (changesTimer) clearTimeout(changesTimer);
		changesTimer = setTimeout(() => {
			changesTimer = undefined;
			refreshChanges().catch(() => undefined);
		}, delayMs);
		changesTimer.unref?.();
	};

	const stopSpinner = (): void => {
		if (!spinner) return;
		clearInterval(spinner);
		spinner = undefined;
	};

	const startSpinner = (): void => {
		if (spinner) return;
		spinner = setInterval(() => {
			try {
				advanceSpinner(activity);
				repaint();
			} catch {
				stopSpinner();
			}
		}, SPINNER_INTERVAL_MS);
	};

	const setDetail = (ctx: ExtensionContext, next: boolean): void => {
		detail = next;
		try {
			writeDetailSetting(next);
		} catch (err) {
			ctx.ui.notify(`detail view not saved: ${err instanceof Error ? err.message : String(err)}`, "warning");
		}
		metaRow?.sync();
		repaint();
	};

	// expand "[image #N]" paste tokens into inline image attachments at submit.
	// the token text stays in the message (readable transcript); the matching
	// base64 image is attached so vision models receive it directly, with no
	// temp file and no `read` round-trip.
	pi.on("input", (event) => {
		if (pastedImages.size === 0) return { action: "continue" } as const;
		const images: ImageContent[] = [...(event.images ?? [])];
		let matched = false;
		for (const [token, img] of pastedImages) {
			if (event.text.includes(token)) {
				images.push({ type: "image", data: img.data, mimeType: img.mime });
				matched = true;
			}
		}
		// a submit resets the editor, so any unreferenced tokens are gone for good
		pastedImages.clear();
		pasteCounter = 0;
		showPeek?.(undefined);
		return matched
			? ({ action: "transform", text: event.text, images } as const)
			: ({ action: "continue" } as const);
	});

	function mountUi(ctx: ExtensionContext): void {
		// make tool call backgrounds transparent — removes the colored box
		// chrome that ToolExecutionComponent forces via Box(1,1,bgFn).
		// the Box padding (1char/1row) remains but is invisible against
		// the terminal's default background.
		const themeAny = ctx.ui.theme as any;
		if (themeAny.bgColors instanceof Map) {
			const transparent = "\x1b[49m"; // ANSI bg reset = terminal default
			themeAny.bgColors.set("toolPendingBg", transparent);
			themeAny.bgColors.set("toolSuccessBg", transparent);
			themeAny.bgColors.set("toolErrorBg", transparent);
		}

		let peeked: string | undefined;
		showPeek = (token) => {
			if (token === peeked) return;
			const image = token ? pastedImages.get(token) : undefined;
			peeked = image ? token : undefined;
			if (!token || !image) {
				ctx.ui.setWidget("image-peek", undefined);
				return;
			}
			ctx.ui.setWidget(
				"image-peek",
				() =>
					new Image(
						image.data,
						image.mime,
						{ fallbackColor: (text: string) => ctx.ui.theme.fg("dim", text) },
						{ maxWidthCells: 48, maxHeightCells: 14, filename: token },
					),
				{ placement: "aboveEditor" },
			);
		};

		ctx.ui.setEditorComponent((tui: TUI, editorTheme: EditorTheme, keybindings: KeybindingsManager) => {
			tuiRef = tui;
			editor = new LabeledEditor(tui, editorTheme, keybindings, ctx.ui.theme, hud, labels);
			return editor;
		});

		// the footer itself draws nothing: its data lives in the borders and the meta row
		ctx.ui.setFooter((tui: TUI, _theme: Theme, data) => {
			footerData = data;
			gitBranch = data.getGitBranch();
			branchUnsub = data.onBranchChange(() => {
				gitBranch = data.getGitBranch();
				updatePlaceLabel();
				tui.requestRender();
			});
			updatePlaceLabel();
			return {
				dispose: () => {
					branchUnsub?.();
					branchUnsub = null;
					footerData = null;
				},
				invalidate() {},
				render(_width: number): string[] {
					return [];
				},
			};
		});

		ctx.ui.setWidget(
			"meta-row",
			(tui, widgetTheme) => {
				tuiRef = tui;
				metaRow = new MetaRow(
					{
						detail: () => detail,
						running: () => agentRunning,
						cache: () => cacheView,
						changes: () => formatChanges(changes, widgetTheme),
						statuses: statusesText,
						session: sessionText,
						place: placeText,
					},
					widgetTheme,
					tui,
				);
				return metaRow;
			},
			{ placement: "belowEditor" },
		);
	}

	// pi resets every extension UI before a session is replaced, so each
	// session_start (new, resume, fork, reload) mounts it again.
	pi.on("session_start", async (_event, ctx) => {
		requestStartedAt = undefined;
		lastResponseAt = undefined;
		if (!ctx.hasUI) return;
		theme = ctx.ui.theme;
		cwd = ctx.cwd;

		// pi's working loader would be a second spinner beside ours; its retry,
		// compaction and branch-summary indicators still show in the top border.
		ctx.ui.setWorkingVisible(false);

		stopSpinner();
		agentRunning = false;
		endActivity(activity, Date.now());
		activity.lastRun = undefined;
		mountUi(ctx);

		updateSessionLabels(ctx, true);
		updatePlaceLabel();
		syncCache(ctx);
		changesGeneration++;
		changes = undefined;
		scheduleChanges(0);
	});

	pi.on("agent_start", async () => {
		// Escape now aborts — arm the 3-press gate.
		agentRunning = true;
		editor?.resetEscapeGate();
		startActivity(activity, Date.now());
		startSpinner();
		metaRow?.sync();
	});

	pi.on("turn_start", async (event) => {
		activity.turnIndex = event.turnIndex;
		activity.phase = activity.activeTools.size > 0 ? "tool" : "thinking";
	});

	pi.on("tool_execution_start", async (event) => {
		activity.phase = "tool";
		activity.activeTools.set(event.toolCallId, describeToolCall(event.toolName, event.args));
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		activity.activeTools.delete(event.toolCallId);
		activity.phase = activity.activeTools.size > 0 ? "tool" : "thinking";
		updateSessionLabels(ctx);
		syncCache(ctx);
		if (WRITING_TOOLS.has(event.toolName)) scheduleChanges(CHANGES_DEBOUNCE_MS);
	});

	pi.on("message_end", async (event, ctx) => {
		// fires before pi persists the message, so this lands one turn behind;
		// tool_execution_end and agent_end are the post-append syncs.
		if ((event.message as { role?: string }).role === "assistant") syncCache(ctx);
	});

	pi.on("message_start", async (event) => {
		if ((event.message as { role?: string }).role === "assistant") {
			activity.phase = activity.activeTools.size > 0 ? "tool" : "streaming";
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
		stopSpinner();
		// Nothing left to abort — disarm, and clear any half-finished count so
		// a stale "esc ×2 more to stop" hint can't linger over an idle editor.
		agentRunning = false;
		editor?.resetEscapeGate();
		endActivity(activity, Date.now());
		updateSessionLabels(ctx);
		syncCache(ctx);
		scheduleChanges(0);
	});

	// A label set from another extension must also trigger the repaint — the
	// editor only re-renders on its own input/agent events otherwise, so a
	// time-based label (e.g. deepseek-peak) would sit stale until the next
	// keystroke. Repaint ONLY on a real change, so a poller emitting the same
	// text every tick costs nothing.
	pi.events.on("editor:set-label", (data: unknown) => {
		const payload = data as SetLabelPayload;
		if (!payload.key || !payload.text) return;
		const options = { priority: payload.priority, when: payload.when };
		if (labels.set(payload.key, payload.text, payload.position ?? "top", payload.align ?? "left", options)) repaint();
	});

	pi.events.on("editor:remove-label", (data: unknown) => {
		const payload = data as RemoveLabelPayload;
		if (!payload.key) return;
		if (labels.remove(payload.key)) repaint();
	});

	pi.on("model_select", async (_event, ctx) => {
		updateSessionLabels(ctx, true);
		syncCache(ctx);
	});

	pi.on("thinking_level_select", async (_event, ctx) => {
		updateSessionLabels(ctx, true);
		repaint();
	});

	// A cache warm during a long tool touches the cache without a message, and its usage
	// entry is saved only after the reply; the response is the earliest sign of it.
	pi.on("before_provider_request", () => {
		requestStartedAt = Date.now();
		return undefined;
	});

	pi.on("after_provider_response", (event, ctx) => {
		if (event.status < 200 || event.status >= 300 || requestStartedAt === undefined) return;
		lastResponseAt = requestStartedAt;
		syncCache(ctx);
	});

	pi.registerShortcut(HUD_SHORTCUT, {
		description: "Toggle the prompt bar's detail view",
		handler: async (ctx) => setDetail(ctx, !detail),
	});

	pi.registerCommand("hud", {
		description: "Show or hide more detail under the prompt: cache, context, model and timings",
		getArgumentCompletions: (prefix) => completeWords(HUD_WORDS, prefix),
		handler: async (args, ctx) => {
			const { word } = splitArgs(args);
			if (word && !findWord(HUD_WORDS, word)) {
				ctx.ui.notify(`/hud has no "${word}". Use /hud on, /hud off, or /hud on its own to switch.`, "error");
				return;
			}
			const next = word ? word === "on" : !detail;
			const already = next === detail;
			setDetail(ctx, next);
			const state = next ? "on: cache, context, model and timings show under the prompt" : "off";
			ctx.ui.notify(`Detail row ${already ? "already " : ""}${state}. ${HUD_SHORTCUT} switches it; remembered across sessions.`, "info");
		},
	});
	contributeHelp(pi, (help) => help.shortcut({ command: "hud", key: HUD_SHORTCUT }));

	// pi emits this before invalidating. Afterwards every ctx call throws, and an
	// uncaught throw inside a live timer is process.exit(1).
	pi.on("session_shutdown", async () => {
		stopSpinner();
		if (changesTimer) clearTimeout(changesTimer);
		changesTimer = undefined;
		changesGeneration++;
		metaRow?.dispose();
		metaRow = null;
	});
}
