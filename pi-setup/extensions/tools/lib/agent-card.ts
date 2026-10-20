import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Container, Markdown } from "@mariozechner/pi-tui";
import { firstAnswerLine, formatCost, formatTokens, freshTokens, identityColor, STATUS_STYLE } from "./agent-style";
import { CachedLines, justify, type Styler } from "./agent-layout";
import { overlapLine, type RunReport } from "./agent-notice";
import { normalizeForDisplay } from "./box-format";
import { formatDuration, getFinalOutput } from "./sub-agent-render";

const MIN_LABEL_COLUMNS = 24;

function factsOf(run: RunReport): string {
	const tokens = freshTokens(run.usage);
	return [formatDuration(run.durationMs), tokens > 0 ? `↑${formatTokens(tokens)}` : "", run.usage.cost > 0 ? formatCost(run.usage.cost) : ""]
		.filter(Boolean)
		.join(" · ");
}

function answerOf(run: RunReport): string {
	return (run.status === "done" ? getFinalOutput(run.messages) : run.errorMessage ?? "").trim();
}

/** One finished run: what happened, how long and what it cost, then the first line of its answer. */
export class RunCard extends CachedLines {
	constructor(
		private readonly run: RunReport,
		private readonly expanded: boolean,
		private readonly theme: Styler,
		private readonly pad: number,
	) {
		super();
	}

	protected build(width: number): string[] {
		const { run, theme } = this;
		const indent = " ".repeat(this.pad);
		const style = STATUS_STYLE[run.status] ?? STATUS_STYLE.done;
		const who = theme.fg(identityColor(run.agent), theme.bold(run.agent));
		const head = `${indent}${theme.fg(style.color, style.icon)} ${who} ${theme.fg(style.color, style.verb)}  ${normalizeForDisplay(run.label.split("\n")[0] ?? "")}`;
		const facts = factsOf(run);
		const header = justify(head, facts && theme.fg("dim", facts), width, this.pad + MIN_LABEL_COLUMNS);
		const lines = [header.line];
		const under = `${indent}  `;
		if (header.right) lines.push(under + header.right);
		const answer = answerOf(run);
		if (this.expanded) {
			if (answer) lines.push(...new Markdown(normalizeForDisplay(answer), this.pad + 2, 0, getMarkdownTheme()).render(width));
		} else if (answer) {
			lines.push(under + theme.fg(run.status === "done" ? "dim" : "error", normalizeForDisplay(firstAnswerLine(answer))));
		}
		for (const overlap of run.overlaps ?? []) lines.push(under + theme.fg("warning", normalizeForDisplay(`⚠ ${overlapLine(overlap)}`)));
		return lines;
	}
}

/** The agent-result message: a card per run. */
export function renderRunCards(runs: RunReport[], expanded: boolean, theme: Styler, pad: number): Container {
	const container = new Container();
	for (const run of runs) container.addChild(new RunCard(run, expanded, theme, pad));
	return container;
}
