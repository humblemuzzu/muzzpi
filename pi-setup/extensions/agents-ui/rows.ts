import type { RunSnapshot } from "../tools/lib/agent-channel";
import { padRight, type Styler } from "../tools/lib/agent-layout";
import { firstAnswerLine, formatTokens, freshTokens, identityColor, shortModel, STATUS_STYLE } from "../tools/lib/agent-style";
import { normalizeForDisplay } from "../tools/lib/box-format";
import { formatDuration, getFinalOutput } from "../tools/lib/sub-agent-render";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { isLive, type Clock } from "./store";

export const SPINNER = ["◐", "◓", "◑", "◒"] as const;
const NAME_COLUMN = 28;
const MIN_LEFT = 40;
const MODEL_COLUMN_MAX = 18;
const NOTICE_MS = 6_000;

interface Columns {
	model: number;
	elapsed: number;
	tokens: number;
}

interface RowOptions {
	selected: boolean;
	dim: boolean;
}

export const elapsedMs = (run: RunSnapshot, now: number) => (run.endedAt ?? now) - (run.startedAt ?? run.queuedAt);

const tokenText = (run: RunSnapshot) => {
	const tokens = freshTokens(run.usage);
	return tokens > 0 ? `${isLive(run) ? "↓" : "↑"}${formatTokens(tokens)}` : "";
};

const elapsedText = (run: RunSnapshot, now: number) => (run.status === "queued" ? "queued" : formatDuration(elapsedMs(run, now)));

export const modelText = (run: RunSnapshot) => normalizeForDisplay(shortModel(run.model));

/**
 * The right-hand columns, all or nothing: a row whose status does not fit
 * drops it from every row, so the columns never go ragged. The model goes first.
 */
export function planColumns(runs: readonly RunSnapshot[], width: number, now: number): Columns {
	const widest = (text: (run: RunSnapshot) => string, cap = Infinity) =>
		Math.min(cap, runs.reduce((max, run) => Math.max(max, visibleWidth(text(run))), 0));
	const model = widest(modelText, MODEL_COLUMN_MAX);
	const elapsed = widest((run) => elapsedText(run, now));
	const tokens = widest(tokenText);
	const fits = (cluster: number) => width - cluster - 2 >= MIN_LEFT;
	const timing = elapsed + (tokens > 0 ? 2 + tokens : 0);
	if (model > 0 && fits(model + 2 + timing)) return { model, elapsed, tokens };
	if (fits(timing)) return { model: 0, elapsed, tokens };
	return { model: 0, elapsed: 0, tokens: 0 };
}

const answerLines = new WeakMap<object, { count: number; text: string }>();

function answerLine(run: RunSnapshot): string {
	const cached = answerLines.get(run.messages);
	if (cached?.count === run.messages.length) return cached.text;
	const text = firstAnswerLine(getFinalOutput(run.messages));
	answerLines.set(run.messages, { count: run.messages.length, text });
	return text;
}

export function controlNotice(run: RunSnapshot, now: number): { text: string; ok: boolean } | undefined {
	const control = run.control;
	return control && now - control.at < NOTICE_MS ? { text: control.text, ok: control.ok } : undefined;
}

/** The soonest moment a run's inline notice stops showing, or undefined when none is showing. */
export function noticeExpiry(runs: readonly RunSnapshot[], now: number): number | undefined {
	const stamps = runs.flatMap((run) => (run.control && now - run.control.at < NOTICE_MS ? [run.control.at + NOTICE_MS] : []));
	return stamps.length > 0 ? Math.min(...stamps) : undefined;
}

function activityText(run: RunSnapshot, theme: Styler, now: number, dim: boolean): string {
	const paint = (color: string, text: string) => theme.fg(dim ? "dim" : color, normalizeForDisplay(text.split("\n")[0] ?? ""));
	const notice = controlNotice(run, now);
	if (run.stopping) return paint("error", "stopping…");
	if (notice) return paint(notice.ok ? "dim" : "warning", notice.ok ? notice.text : `✗ ${notice.text}`);
	if (run.status === "running") return paint("dim", run.activity ?? "starting…");
	if (run.status === "queued") return paint("muted", "waiting for a free slot");
	if (run.status === "done") return paint("dim", answerLine(run));
	if (run.status === "failed") return paint("error", run.errorMessage ?? "failed");
	return paint("muted", STATUS_STYLE[run.status].verb);
}

/** One run as one line: `❯ ◐ chad audit the token flow   · read pi-spawn.ts   model  1m12s  ↓45.2k`. */
export function renderRow(run: RunSnapshot, cols: Columns, width: number, theme: Styler, clock: Clock, options: RowOptions): string {
	const now = clock.now();
	const status = STATUS_STYLE[run.status];
	const glyph = run.status === "running" && !run.stopping ? SPINNER[clock.frame % SPINNER.length]! : run.stopping ? STATUS_STYLE.stopped.icon : status.icon;
	const paint = (color: string, text: string) => theme.fg(options.dim ? "dim" : color, text);
	const pointer = options.selected ? theme.fg("accent", "❯") : " ";
	const name = options.dim ? paint("dim", run.agent) : theme.fg(identityColor(run.agent), theme.bold(run.agent));
	const room = Math.min(NAME_COLUMN, Math.max(8, width - 5));
	const nameLabel = padRight(truncateToWidth(`${name} ${paint("text", normalizeForDisplay(run.label))}`, room), room);

	const cluster = clusterOf(run, cols, now, theme, options.dim);
	const clusterWidth = cols.model + cols.elapsed + cols.tokens > 0 ? visibleWidth(cluster) : 0;
	const head = `${pointer} ${theme.fg(run.stopping ? "error" : status.color, glyph)} ${nameLabel}`;
	const available = width - clusterWidth - (clusterWidth > 0 ? 2 : 0) - visibleWidth(head) - 2;
	const activity = available >= 6 ? `  ${truncateToWidth(activityText(run, theme, now, options.dim), available, "…")}` : "";
	const left = head + activity;
	if (clusterWidth === 0) return truncateToWidth(left, width);
	return padRight(truncateToWidth(left, width - clusterWidth - 2), width - clusterWidth) + cluster;
}

function clusterOf(run: RunSnapshot, cols: Columns, now: number, theme: Styler, dim: boolean): string {
	const tone = dim ? "dim" : "muted";
	const parts: string[] = [];
	if (cols.model > 0) parts.push(theme.fg("dim", padRight(truncateToWidth(modelText(run), cols.model), cols.model)));
	if (cols.elapsed > 0) {
		const elapsed = elapsedText(run, now);
		parts.push(theme.fg(tone, " ".repeat(cols.elapsed - visibleWidth(elapsed)) + elapsed));
	}
	if (cols.tokens > 0) {
		const tokens = tokenText(run);
		parts.push(theme.fg(tone, " ".repeat(cols.tokens - visibleWidth(tokens)) + tokens));
	}
	return parts.join("  ");
}
