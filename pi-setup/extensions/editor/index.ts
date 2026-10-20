/**
 * editor extension — composable custom editor with box-drawing borders and label slots.
 *
 * replaces pi's default editor with ╭╮╰╯ borders. other extensions can inject
 * labels into the top/bottom border lines via the shared EventBus:
 *
 *   pi.events.emit("editor:set-label", { key: "handoff", text: "↳ handed off", position: "top", align: "left" })
 *   pi.events.emit("editor:remove-label", { key: "handoff" })
 *
 * multiple labels on the same border are separated by " · ". left labels fill
 * from the left edge, right labels from the right edge.
 */

import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@mariozechner/pi-coding-agent";
import { CustomEditor, Theme, estimateTokens } from "@mariozechner/pi-coding-agent";
import type { TUI, EditorTheme, TuiMouseEvent } from "@mariozechner/pi-tui";
import { Image, visibleWidth } from "@mariozechner/pi-tui";
import { HorizontalLineWidget, WidgetRowRegistry } from "./widget-row";
import { type CacheStats, CacheLineWidget, collectCacheStats } from "./cache-line";
import type { KeybindingsManager } from "@mariozechner/pi-coding-agent";
import type { AgentMessage, AssistantMessage, ImageContent, TextContent } from "@mariozechner/pi-ai";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { hasToolCost } from "../tools/lib/tool-cost";
import { clipboardImageModule } from "../tools/lib/pi-package-dir";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// clipboard image paste → compact "[image #N]" placeholder
//
// pi's core paste handler (interactive-mode handleClipboardImagePaste) writes
// the clipboard image to a temp file and dumps the raw path
// (/var/folders/.../pi-clipboard-<uuid>.png) into the editor as literal text —
// that long path is what you end up staring at while composing.
//
// instead we show a short "[image #N]" token in the editor and carry the real
// image inline (base64) to the model via the "input" hook. this mirrors
// opencode's placeholder UX without needing virtual-text / extmark support in
// pi's plain-text editor. multiple pastes stack as [image #1], [image #2], ...
//
// the editor-swap path in core only wires its default paste handler when ours
// is unset (`if (!customEditor.onPasteImage)`), so if pi's clipboard-image
// module is missing or no longer exports readClipboardImage we simply DON'T set onPasteImage and pi's default
// (insert path) transparently takes back over. it loads on the first paste:
// under our bundle that pulls in a second pi-tui (~36 ms), which startup must not pay.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
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
// ---------------------------------------------------------------------------

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

interface Label {
	key: string;
	text: string;
	position: "top" | "bottom";
	align: "left" | "right";
}

interface SetLabelPayload {
	key: string;
	text: string;
	position?: "top" | "bottom";
	align?: "left" | "right";
}

interface RemoveLabelPayload {
	key: string;
}

const SEPARATOR = " · ";

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
const CORNER_TL = "╭";
const CORNER_TR = "╮";
const CORNER_BL = "╰";
const CORNER_BR = "╯";
const HORIZONTAL = "─";
const VERTICAL = "│";

class LabeledEditor extends CustomEditor {
	private labels: Map<string, Label> = new Map();
	private appTheme: Theme;
	private tuiRef: TUI;
	private borderCache: Record<"top" | "bottom", { key: string; line: string } | null> = {
		top: null,
		bottom: null,
	};

	constructor(tui: TUI, editorTheme: EditorTheme, keybindings: KeybindingsManager, appTheme: Theme) {
		super(tui, editorTheme, keybindings, { embedWorkingStatus: true });
		this.appTheme = appTheme;
		this.tuiRef = tui;
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
	 * `CustomEditor` declares `onEscape` as a bare class field, so `super()`
	 * has already installed an OWN data property by the time we get here — a
	 * prototype accessor would be shadowed by it. Redefining the own property
	 * as an accessor is what actually works.
	 *
	 * The getter reports `undefined` until core has assigned, because core
	 * wires its default with `if (!customEditor.onEscape)`. Returning our gate
	 * too early would make core skip the assignment and leave us with nothing
	 * to delegate to — Escape would then do nothing at all.
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
				this.removeLabel(ESCAPE_LABEL_KEY);
				this.tuiRef.requestRender();
			}, ESCAPE_WINDOW_MS);
		}

		if (this.escapeHits >= ESCAPE_HITS_REQUIRED) {
			this.resetEscapeGate();
			this.coreEscape?.();
			return;
		}

		const left = ESCAPE_HITS_REQUIRED - this.escapeHits;
		this.setLabel(
			ESCAPE_LABEL_KEY,
			this.appTheme.fg("warning", `esc ×${left} more to stop`),
			"bottom",
			"left",
		);
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
			this.removeLabel(ESCAPE_LABEL_KEY);
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

	/** @returns true if the stored label actually changed (callers use this to
	 * skip a pointless repaint — a polling label emitter would otherwise force
	 * a render on every tick). */
	setLabel(key: string, text: string, position: "top" | "bottom" = "top", align: "left" | "right" = "left"): boolean {
		// SINK GUARD: labels are embedded into single border lines. An embedded
		// \n renders as an extra terminal row the TUI doesn't account for —
		// visibleWidth counts it as 0, so no width check catches it — and the
		// differential renderer desyncs (screen smear). Flatten ALL control
		// chars here so no label source (incl. other extensions via the
		// editor-set-label event) can ever inject one.
		const flat = flattenLabelText(text);
		const prev = this.labels.get(key);
		if (prev && prev.text === flat && prev.position === position && prev.align === align) return false;
		this.labels.set(key, { key, text: flat, position, align });
		return true;
	}

	removeLabel(key: string): boolean {
		return this.labels.delete(key);
	}

	/** repaint the border. labels set from outside the editor (via the
	 * editor:set-label event) have no other way to reach the render loop. */
	requestRepaint(): void {
		this.tuiRef.requestRender();
	}

	private getLabelsFor(position: "top" | "bottom", align: "left" | "right"): string {
		const matching = [...this.labels.values()].filter((l) => l.position === position && l.align === align);
		if (matching.length === 0) return "";
		return matching.map((l) => l.text).join(SEPARATOR);
	}

	private extractScrollIndicator(originalLine: string): string {
		if (!originalLine.includes("↑") && !originalLine.includes("↓")) return "";
		const match = originalLine.match(/[↑↓]\s+\d+\s+more/);
		return match ? match[0] : "";
	}

	private workingStatusText(budget: number): string {
		if (!this.embedWorkingStatus || budget < 3) return "";
		const indicator = (
			this as unknown as {
				workingStatusIndicator?: { renderInBorder: (width: number) => string };
			}
		).workingStatusIndicator;
		if (!indicator) return "";
		return flattenLabelText(indicator.renderInBorder(budget));
	}

	/**
	 * build a border line like: ╭─ left label ─────── right label ─╮
	 *
	 * inherits scroll indicator text from the original border line if present.
	 * originalLine is the border super.render() produced — we check it for
	 * scroll indicators (↑/↓) and preserve that text as a right-aligned label.
	 */
	private buildBorderLine(
		outerWidth: number,
		cornerLeft: string,
		cornerRight: string,
		position: "top" | "bottom",
		originalLine: string,
	): string {
		const leftText = this.getLabelsFor(position, "left");
		const rightText = this.getLabelsFor(position, "right");
		const scrollIndicator = this.extractScrollIndicator(originalLine);
		const status = position === "top" ? this.workingStatusText(Math.max(8, Math.floor(outerWidth / 3))) : "";
		const rightParts = [rightText, status, scrollIndicator].filter(Boolean);
		const rightCombined = rightParts.join(SEPARATOR);
		const cacheKey = `${outerWidth}|${position}|${leftText}|${rightCombined}`;
		const cached = this.borderCache[position];
		if (cached?.key === cacheKey) return cached.line;

		// layout: ╭─leftLabel────────rightLabel─╮
		// always ─ after left corner and before right corner
		const hasLeft = leftText.length > 0;
		const hasRight = rightCombined.length > 0;

		const leftLabelWidth = hasLeft ? visibleWidth(leftText) : 0;
		const rightLabelWidth = hasRight ? visibleWidth(rightCombined) : 0;

		// budget: outerWidth - 2 corners - 2 edge dashes (╭─...─╮)
		const innerWidth = outerWidth - 4;
		const fillWidth = innerWidth - leftLabelWidth - rightLabelWidth;

		const line = fillWidth < 0
			? this.dim(cornerLeft + HORIZONTAL.repeat(Math.max(0, outerWidth - 2)) + cornerRight)
			: this.dim(cornerLeft + HORIZONTAL) +
				(hasLeft ? leftText : "") +
				this.dim(HORIZONTAL.repeat(fillWidth)) +
				(hasRight ? rightCombined : "") +
				this.dim(HORIZONTAL + cornerRight);

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

function formatTokens(n: number): string {
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return String(n);
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
				total += estimateTokens(entry.message as AgentMessage);
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

function updateStatsLabels(editor: LabeledEditor | null, pi: ExtensionAPI, ctx: ExtensionContext, cachedLen?: { value: number }): void {
	if (!editor) return;

	// skip recomputation if branch length unchanged (cheap proxy for "nothing new happened")
	const branch = ctx.sessionManager.getBranch();
	if (cachedLen && branch.length === cachedLen.value) return;
	if (cachedLen) cachedLen.value = branch.length;

	// top-left: context usage + cost (parent model + sub-agents)
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

	const topLeftParts: string[] = [];

	// use provider-reported usage if available and meaningful, otherwise estimate from entries
	if (usage?.percent != null && usage.tokens != null && usage.tokens > 0) {
		topLeftParts.push(`${Math.round(usage.percent)}% of ${formatTokens(usage.contextWindow)}`);
	} else if (model?.contextWindow) {
		// fallback: estimate tokens from session entries
		const estimatedTokens = estimateContextFromEntries(branch);
		const percent = (estimatedTokens / model.contextWindow) * 100;
		topLeftParts.push(`~${Math.round(percent)}% of ${formatTokens(model.contextWindow)}`);
	}

	if (cost > 0) {
		topLeftParts.push(`$${cost.toFixed(2)}`);
	}
	if (topLeftParts.length > 0) {
		editor.setLabel("stats", topLeftParts.join(" · "), "top", "left");
	}

	// top-right: model + thinking level
	const topRightParts: string[] = [];
	if (model) {
		const provider = model.provider ? `(${model.provider})` : "";
		topRightParts.push(`${provider} ${model.id}`.trim());
	}
	const thinkingLevel = pi.getThinkingLevel();
	if (thinkingLevel && thinkingLevel !== "off") {
		topRightParts.push(thinkingLevel);
	}
	if (topRightParts.length > 0) {
		editor.setLabel("model", topRightParts.join(" · "), "top", "right");
	}
}


async function getGitDiffStats(cwd: string): Promise<string> {
	try {
		const { stdout } = await execFileAsync("git", ["diff", "--stat"], {
			cwd,
			timeout: 3000,
		});
		const out = stdout.trim();
		if (!out) return "";
		// last line is summary: " N files changed, N insertions(+), N deletions(-)"
		const lines = out.split("\n");
		const summary = lines[lines.length - 1].trim();
		const filesMatch = summary.match(/(\d+)\s+files?\s+changed/);
		const insMatch = summary.match(/(\d+)\s+insertions?\(\+\)/);
		const delMatch = summary.match(/(\d+)\s+deletions?\(-\)/);
		if (!filesMatch) return "";
		const parts = [`${filesMatch[1]} files changed`];
		if (insMatch) parts.push(`+${insMatch[1]}`);
		if (delMatch) parts.push(`-${delMatch[1]}`);
		return parts.join(" ");
	} catch {
		return "";
	}
}

// ---------------------------------------------------------------------------
// animated activity spinner — renders rich status below the editor
// ---------------------------------------------------------------------------

const SPINNER_FRAMES = ["·", "•", "*", "⁑", "⁂", "⁑", "*", "•", "·"];

type ActivityPhase = "idle" | "thinking" | "tool" | "streaming";

interface ActivityState {
	phase: ActivityPhase;
	turnIndex: number;
	/** tool names currently in-flight (supports parallel tool calls) */
	activeTools: Map<string, string>;
	/** epoch ms when agent_start fired */
	startedAt: number;
	/** interval handle for spinner animation */
	intervalId: ReturnType<typeof setInterval> | null;
	/** current braille frame index */
	frame: number;
}

function createActivityState(): ActivityState {
	return {
		phase: "idle",
		turnIndex: 0,
		activeTools: new Map(),
		startedAt: 0,
		intervalId: null,
		frame: 0,
	};
}

function formatElapsed(ms: number): string {
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	const rem = s % 60;
	return `${m}m${rem > 0 ? `${rem}s` : ""}`;
}

/**
 * shorten a tool name for display: "tool_execution" → "tool_execution",
 * but we also extract a meaningful arg when possible (e.g. file path).
 */
function describeToolCall(toolName: string, args: any): string {
	// common pi tools have a `path` or `pattern` arg — show it if short
	const hint = args?.path ?? args?.pattern ?? args?.query ?? args?.filePattern ?? args?.cmd;
	if (typeof hint === "string") {
		// ROOT-CAUSE FIX (2026-07-04 smear bug): bash `cmd` is often a MULTILINE
		// script. The old `hint.split("/").pop()` took everything after the
		// last "/" — unbounded, newlines included — and that string ended up
		// embedded in a border/status line, moving the real cursor rows the
		// TUI didn't know about → whole-screen smear. First line only, then
		// basename only for path-like tokens, then a hard cap. flattenLabelText
		// at the sinks is the safety net; this keeps the label meaningful.
		const firstLine = hint.split("\n", 1)[0].trim();
		const pathLike = firstLine.includes("/") && !firstLine.includes(" ");
		const base = pathLike ? (firstLine.split("/").pop() ?? firstLine) : firstLine;
		const short = base.length > 24 ? base.slice(0, 24) + "…" : base;
		return short ? `${toolName}(${short})` : toolName;
	}
	return toolName;
}

function renderActivity(state: ActivityState): string {
	if (state.phase === "idle") return "";

	const parts: string[] = [];

	// animated spinner
	parts.push(SPINNER_FRAMES[state.frame % SPINNER_FRAMES.length]);

	// turn number (0-indexed from the event, display as 1-indexed)
	if (state.turnIndex > 0) {
		parts.push(`turn ${state.turnIndex + 1}`);
	}

	// phase-specific info
	if (state.activeTools.size > 0) {
		const toolDescs = [...state.activeTools.values()];
		// show up to 2 tool descriptions
		const shown = toolDescs.slice(0, 2).join(", ");
		const overflow = toolDescs.length > 2 ? ` +${toolDescs.length - 2}` : "";
		parts.push(shown + overflow);
	} else if (state.phase === "thinking") {
		parts.push("thinking");
	} else if (state.phase === "streaming") {
		parts.push("writing");
	}

	// elapsed time
	if (state.startedAt > 0) {
		const elapsed = Date.now() - state.startedAt;
		if (elapsed >= 1000) {
			parts.push(formatElapsed(elapsed));
		}
	}

	return parts.join(" · ");
}

export default function (pi: ExtensionAPI) {
	let editor: LabeledEditor | null = null;
	const statsCacheBranchLen = { value: -1 };
	let gitBranch: string | null = null;
	let branchUnsub: (() => void) | null = null;
	let statusRow: WidgetRowRegistry | null = null;
	let cacheLine: CacheLineWidget | null = null;
	let requestStartedAt: number | undefined;
	let lastResponseAt: number | undefined;
	const activity = createActivityState();

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

	const syncCacheLine = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI) return;
		const stats = collectCacheStats(ctx.sessionManager.getEntries(), lastResponseAt);
		const ttlMs = cacheTtlMs(ctx, stats);
		// A declared lifetime is enough on its own; without one, the row waits until
		// the provider has actually reported cache activity. Only Anthropic declares
		// a lifetime, but most providers still report reads — the countdown is the
		// only part that genuinely needs it.
		const reportsActivity = stats.cacheRead > 0 || stats.cacheWrite > 0;
		if (ttlMs === undefined && !reportsActivity) {
			if (!cacheLine) return;
			cacheLine.dispose();
			cacheLine = null;
			ctx.ui.setWidget("cache-line", undefined);
			return;
		}
		if (cacheLine) {
			cacheLine.setStats(stats, ttlMs);
			return;
		}
		ctx.ui.setWidget(
			"cache-line",
			(tui, theme) => {
				const widget = new CacheLineWidget(tui, theme);
				widget.setStats(stats, ttlMs);
				cacheLine = widget;
				return widget;
			},
			{ placement: "belowEditor" },
		);
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

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;

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

		// replace editor with labeled box-drawing version
		ctx.ui.setEditorComponent((tui: TUI, editorTheme: EditorTheme, keybindings: KeybindingsManager) => {
			editor = new LabeledEditor(tui, editorTheme, keybindings, ctx.ui.theme);
			return editor;
		});

		// replace footer with empty component — we show its data in the borders
		ctx.ui.setFooter((tui: TUI, _theme: Theme, footerData) => {
			gitBranch = footerData.getGitBranch();
			branchUnsub = footerData.onBranchChange(() => {
				gitBranch = footerData.getGitBranch();
				updateBottomLabel();
				tui.requestRender();
			});

			updateBottomLabel();

			return {
				dispose: () => { branchUnsub?.(); branchUnsub = null; },
				invalidate() {},
				render(_width: number): string[] { return []; },
			};
		});

		ctx.ui.setWidget("status-line", (tui) => {
			statusRow = new WidgetRowRegistry(tui);
			return new HorizontalLineWidget(() => statusRow!.snapshot(), { gap: "  " }, () => statusRow!.version);
		}, { placement: "belowEditor" });

		// set initial bottom label with cwd
		function updateBottomLabel() {
			if (!editor) return;
			const cwd = shortenPath(ctx.cwd);
			const branchText = gitBranch ? `(${gitBranch})` : "";
			editor.setLabel("cwd", `${cwd} ${branchText}`.trim(), "bottom", "right");
		}

		updateBottomLabel();
		updateStatsLabels(editor!, pi, ctx, statsCacheBranchLen);

		cacheLine?.dispose();
		cacheLine = null;
		syncCacheLine(ctx);
	});

	// --- animated activity spinner + git changes widget ---
	const ACTIVITY_SEGMENT = "activity";
	const GIT_SEGMENT = "git-changes";

	/** push current activity state into the widget row */
	const syncActivitySegment = (): void => {
		if (activity.phase === "idle") {
			statusRow?.remove(ACTIVITY_SEGMENT);
			return;
		}
		const text = renderActivity(activity);
		if (!text) return;
		statusRow?.set(ACTIVITY_SEGMENT, {
			align: "left",
			priority: 10,
			renderInline: () => renderActivity(activity),
		});
	};

	const startSpinner = (): void => {
		if (activity.intervalId) return;
		activity.intervalId = setInterval(() => {
			activity.frame = (activity.frame + 1) % SPINNER_FRAMES.length;
			syncActivitySegment();
		}, 150);
	};

	const stopSpinner = (): void => {
		if (activity.intervalId) {
			clearInterval(activity.intervalId);
			activity.intervalId = null;
		}
	};

	const updateGitSegment = (text?: string): void => {
		if (!text) {
			statusRow?.remove(GIT_SEGMENT);
			return;
		}
		statusRow?.set(GIT_SEGMENT, {
			align: "right",
			priority: 0,
			renderInline: () => text,
		});
	};

	pi.on("agent_start", async (_event, ctx) => {
		// suppress native spinner text — we render our own below the editor
		ctx.ui.setWorkingMessage(" ");

		// Escape now aborts — arm the 3-press gate.
		agentRunning = true;
		editor?.resetEscapeGate();

		activity.phase = "thinking";
		activity.turnIndex = 0;
		activity.activeTools.clear();
		activity.startedAt = Date.now();
		activity.frame = 0;
		startSpinner();
		syncActivitySegment();
	});

	pi.on("turn_start", async (event, _ctx) => {
		activity.turnIndex = event.turnIndex;
		activity.phase = activity.activeTools.size > 0 ? "tool" : "thinking";
		syncActivitySegment();
	});

	pi.on("tool_execution_start", async (event, _ctx) => {
		activity.phase = "tool";
		activity.activeTools.set(event.toolCallId, describeToolCall(event.toolName, event.args));
		syncActivitySegment();
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		activity.activeTools.delete(event.toolCallId);
		activity.phase = activity.activeTools.size > 0 ? "tool" : "thinking";
		syncActivitySegment();
		if (editor) updateStatsLabels(editor, pi, ctx, statsCacheBranchLen);
		syncCacheLine(ctx);
	});

	pi.on("message_end", async (event, ctx) => {
		// fires before pi persists the message, so this lands one turn behind;
		// tool_execution_end and agent_end are the post-append syncs.
		if ((event.message as { role?: string }).role === "assistant") syncCacheLine(ctx);
	});

	pi.on("message_start", async (event, _ctx) => {
		if ((event.message as any).role === "assistant") {
			activity.phase = activity.activeTools.size > 0 ? "tool" : "streaming";
			syncActivitySegment();
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
		stopSpinner();
		// Nothing left to abort — disarm, and clear any half-finished count so
		// a stale "esc ×2 more to stop" hint can't linger over an idle editor.
		agentRunning = false;
		editor?.resetEscapeGate();

		activity.phase = "idle";
		activity.activeTools.clear();
		statusRow?.remove(ACTIVITY_SEGMENT);
		if (editor) updateStatsLabels(editor, pi, ctx, statsCacheBranchLen);
		syncCacheLine(ctx);

		const diffStats = await getGitDiffStats(ctx.cwd);
		updateGitSegment(diffStats);
	});

	// A label set from another extension must also trigger the repaint — the
	// editor only re-renders on its own input/agent events otherwise, so a
	// time-based label (e.g. deepseek-peak) would sit stale until the next
	// keystroke. Repaint ONLY on a real change, so a poller emitting the same
	// text every tick costs nothing.
	pi.events.on("editor:set-label", (data: unknown) => {
		const payload = data as SetLabelPayload;
		if (!payload.key || !payload.text) return;
		if (editor?.setLabel(payload.key, payload.text, payload.position ?? "top", payload.align ?? "left")) {
			editor.requestRepaint();
		}
	});

	pi.events.on("editor:remove-label", (data: unknown) => {
		const payload = data as RemoveLabelPayload;
		if (!payload.key) return;
		if (editor?.removeLabel(payload.key)) editor.requestRepaint();
	});

	pi.on("model_select", async (_event, ctx) => {
		// update model display when user changes model via /model or Ctrl+P
		statsCacheBranchLen.value = -1;
		if (editor) updateStatsLabels(editor, pi, ctx, statsCacheBranchLen);
		syncCacheLine(ctx);
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
		syncCacheLine(ctx);
	});

	pi.on("session_start", async (_event, ctx) => {
		requestStartedAt = undefined;
		lastResponseAt = undefined;
		if (_event.reason === "startup" || _event.reason === "reload") return;
		// editor component persists across session switches, just update stats
		branchUnsub?.();
		branchUnsub = null;
		gitBranch = null;
		stopSpinner();
		activity.phase = "idle";
		activity.activeTools.clear();
		statusRow?.clear();
		statsCacheBranchLen.value = -1;
		if (editor) updateStatsLabels(editor, pi, ctx, statsCacheBranchLen);
	});

	// pi emits this before invalidating. Afterwards every ctx call throws, and an
	// uncaught throw inside a live timer is process.exit(1).
	pi.on("session_shutdown", async () => {
		cacheLine?.dispose();
		cacheLine = null;
	});
}
