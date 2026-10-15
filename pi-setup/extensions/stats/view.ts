import { decodeKittyPrintable, Key, matchesKey, truncateToWidth, type TuiMouseEvent, type TuiMouseEventResult, visibleWidth } from "@mariozechner/pi-tui";
import { addDays, burn, type Burn, type Dataset, type Filter, monthWindow, previousWindow, RANGES, type RangeId, rangeWindow, type Streaks, streaks, type Summary, summarize, summarizeWindow } from "./aggregate";
import { bg, bold, clampLines, fg, HARNESS_COLOR, type Ink, int, pad, plain, RAMPS, type RGB, spread, WARN } from "./draw";
import { HARNESS_LABEL, HARNESSES, type Harness } from "./record";
import { TABS } from "./tabs";
import { type BustOrder, type Ctx, filterChips, GROUPS, type Group, METRICS, type Metric, modelLabel, seriesColors } from "./widgets";

const MAX_WIDTH = 150;
const MEMO_LIMIT = 24;
const PILL_BG: RGB = [64, 60, 58];
const PILL_FG: RGB = [250, 245, 235];
const SHORT_TITLES = ["Over", "You", "Models", "Cache", "Tools", "Agents", "Proj", "Rhythm", "Wrap"];

export interface ViewOptions {
	planUsd: number;
	/** `provider/model` → context window, from pi's model registry. */
	windows: Map<string, number>;
	budget?: number;
	range?: RangeId;
	/** Harness sources that could not be read this time, with why. */
	problems?: string[];
}

export function terminalRows(): number {
	const rows = process.stdout.rows;
	return typeof rows === "number" && rows > 0 ? rows : 40;
}

/** The item after `current` in `list`, wrapping to undefined after the last. */
function cycle<T>(list: readonly T[], current: T | undefined): T | undefined {
	return list[current === undefined ? 0 : list.indexOf(current) + 1];
}

/** The content column: at most MAX_WIDTH wide, centred, at least one column of margin. */
function frame(width: number): { w: number; left: number } {
	const w = Math.min(width - 2, Math.max(20, Math.min(MAX_WIDTH, width - 4)));
	return { w, left: Math.max(1, Math.floor((width - w) / 2)) };
}

interface Pill {
	text: string;
	on: boolean;
	color?: RGB;
	act: () => void;
}

type Hit = [row: number, from: number, to: number, act: () => void];

export class StatsView {
	private tab = 0;
	private range: number;
	private metric: Metric = "cost";
	private ramp = 0;
	private skyline = false;
	private group: Group = "harness";
	private bustOrder: BustOrder = "cost";
	private filter: Filter = {};
	private cursor: string;
	private scroll = new Map<number, number>();
	private summaries = new Map<string, Summary>();
	private month?: Burn;
	private headerRows = 3;
	private body?: { key: string; lines: string[] };
	private cache?: { key: string; lines: string[] };
	private hits: Hit[] = [];

	constructor(
		private readonly ds: Dataset,
		private readonly ink: Ink,
		private readonly opts: ViewOptions,
		private readonly done: () => void,
	) {
		this.cursor = ds.today;
		this.range = Math.max(0, RANGES.findIndex((r) => r.id === (opts.range ?? "30d")));
	}

	private filterKey(): string {
		return `${this.filter.harness ?? ""}\t${this.filter.project ?? ""}\t${this.filter.provider ?? ""}`;
	}

	/** Summaries per filter and window; the oldest go once there are more than a few filters' worth. */
	private memo(key: string, make: () => Summary): Summary {
		const full = `${key}\t${this.filterKey()}`;
		let s = this.summaries.get(full);
		if (!s) {
			this.summaries.set(full, (s = make()));
			if (this.summaries.size > MEMO_LIMIT) this.summaries.delete(this.summaries.keys().next().value!);
		}
		return s;
	}

	private summary(id: RangeId): Summary {
		return this.memo(id, () => summarize(this.ds, id, this.filter));
	}

	private previous(id: RangeId): Summary | undefined {
		if (id === "all") return undefined;
		return this.memo(`prev:${id}`, () => summarizeWindow(this.ds, previousWindow(rangeWindow(this.ds, id)), this.filter));
	}

	private streak(): Streaks {
		if (this.filterKey() === "\t\t") return this.ds.lifetime;
		const all = this.summary("all");
		return streaks(new Set(all.days.filter((d) => all.daily.get(d)!.tokens > 0)), this.ds.today);
	}

	private monthToDate(): Burn {
		this.month ??= burn(summarizeWindow(this.ds, monthWindow(this.ds.today)).cost, this.ds.today, this.opts.budget);
		return this.month;
	}

	invalidate(): void {
		this.cache = undefined;
		this.body = undefined;
	}

	private change(fn: () => void): void {
		fn();
		this.invalidate();
	}

	/** Scrolling only moves the window over the cached body. */
	private scrollBy(n: number): void {
		this.scroll.set(this.tab, Math.max(0, (this.scroll.get(this.tab) ?? 0) + n));
		this.cache = undefined;
	}

	private moveCursor(days: number): void {
		const next = addDays(this.cursor, days);
		if (next > this.ds.today || next < addDays(this.ds.today, -364)) return;
		this.change(() => (this.cursor = next));
	}

	private setRange(i: number): void {
		this.change(() => (this.range = (i + RANGES.length) % RANGES.length));
	}

	private setTab(i: number): void {
		this.change(() => (this.tab = (i + TABS.length) % TABS.length));
	}

	private setFilter(next: Filter): void {
		this.change(() => {
			this.filter = next;
			this.scroll.clear();
		});
	}

	/** Harnesses with any usage, in the fixed order the switch shows them. */
	private present(): Harness[] {
		return HARNESSES.filter((h) => this.ds.lifetime.harnessRank.includes(h));
	}

	handleInput(raw: string): void {
		const data = decodeKittyPrintable(raw) ?? raw;
		const page = Math.max(1, terminalRows() - this.headerRows - 3);
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data === "q") return this.done();
		if (matchesKey(data, Key.tab)) return this.setTab(this.tab + 1);
		if (matchesKey(data, Key.shift("tab"))) return this.setTab(this.tab - 1);
		if (/^[1-9]$/.test(data) && Number(data) <= TABS.length) return this.setTab(Number(data) - 1);
		if (data === "]" || data === "r") return this.setRange(this.range + 1);
		if (data === "[" || data === "R") return this.setRange(this.range - 1);
		if (data === "m") return this.change(() => (this.metric = cycle(METRICS, this.metric) ?? METRICS[0]));
		if (data === "g") return this.change(() => (this.group = cycle(GROUPS, this.group) ?? GROUPS[0]));
		if (data === "c") return this.change(() => (this.ramp = (this.ramp + 1) % RAMPS.length));
		if (data === "v") return this.change(() => (this.skyline = !this.skyline));
		if (data === "t") return this.change(() => (this.cursor = this.ds.today));
		if (data === "b") return this.change(() => (this.bustOrder = this.bustOrder === "cost" ? "recent" : "cost"));
		if (data === "h") return this.setFilter({ ...this.filter, harness: cycle(this.present(), this.filter.harness) });
		if (data === "H") return this.setFilter({ ...this.filter, harness: undefined });
		if (data === "p") return this.setFilter({ ...this.filter, project: cycle(this.ds.lifetime.projectRank, this.filter.project) });
		if (data === "P") return this.setFilter({ ...this.filter, project: undefined });
		if (data === "o") return this.setFilter({ ...this.filter, provider: cycle(this.ds.lifetime.providerRank, this.filter.provider) });
		if (data === "O") return this.setFilter({ ...this.filter, provider: undefined });

		const onOverview = this.tab === 0;
		if (onOverview && matchesKey(data, Key.left)) return this.moveCursor(-7);
		if (onOverview && matchesKey(data, Key.right)) return this.moveCursor(7);
		if (onOverview && matchesKey(data, Key.up)) return this.moveCursor(-1);
		if (onOverview && matchesKey(data, Key.down)) return this.moveCursor(1);
		if (matchesKey(data, Key.left)) return this.setRange(this.range - 1);
		if (matchesKey(data, Key.right)) return this.setRange(this.range + 1);
		if (matchesKey(data, Key.up) || data === "k") return this.scrollBy(-1);
		if (matchesKey(data, Key.down) || data === "j") return this.scrollBy(1);
		if (matchesKey(data, Key.pageUp) || data === "u") return this.scrollBy(-page);
		if (matchesKey(data, Key.pageDown) || data === "d" || data === " ") return this.scrollBy(page);
		if (matchesKey(data, Key.home)) return this.scrollBy(-1e9);
		if (matchesKey(data, Key.end)) return this.scrollBy(1e9);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "wheel" && event.wheelDelta) {
			this.scrollBy(event.wheelDelta * 3);
			return { handled: true };
		}
		if (event.type === "press" && event.button === "left") {
			const hit = this.hits.find(([row, a, b]) => event.y === row && event.x >= a && event.x < b);
			if (hit) {
				hit[3]();
				return { handled: true };
			}
		}
		return undefined;
	}

	private pillText(p: Pill): string {
		if (p.on) return bg(PILL_BG, bold(fg(PILL_FG, ` ${p.text} `)));
		return p.color ? ` ${fg(p.color, p.text)} ` : this.ink.muted(` ${p.text} `);
	}

	/** Pills from column `x0` of row `row`; a pill past `limit` is neither drawn nor clickable. */
	private pills(row: number, x0: number, limit: number, items: Pill[]): string {
		let x = x0;
		let out = "";
		for (const it of items) {
			const cell = this.pillText(it);
			const w = visibleWidth(cell);
			if (x + w > limit) break;
			this.hits.push([row, x, x + w, it.act]);
			out += cell;
			x += w;
		}
		return out;
	}

	private harnessItems(): Pill[] {
		const ordered = this.present();
		if (ordered.length < 2) return [];
		return [
			{ text: "All", on: this.filter.harness === undefined, act: () => this.setFilter({ ...this.filter, harness: undefined }) },
			...ordered.map((h) => ({ text: `● ${HARNESS_LABEL[h]}`, on: this.filter.harness === h, color: this.filter.harness === h ? undefined : HARNESS_COLOR[h], act: () => this.setFilter({ ...this.filter, harness: h }) })),
		];
	}

	private header(w: number, left: number, s: Summary): string[] {
		const ink = this.ink;
		this.hits = [];
		const end = left + w;
		const used = s.harnesses.size;
		const brand = `${bold(ink.accent("◆ stats"))}  ${ink.dim(`${s.label} · ${int(s.sessions.length)} sessions${used > 1 ? ` · ${used} harnesses` : ""}`)}`;
		const rangeItems: Pill[] = RANGES.map((r, i) => ({ text: r.id === "all" ? "All" : r.id, on: i === this.range, act: () => this.setRange(i) }));
		const rangesW = rangeItems.reduce((a, r) => a + visibleWidth(r.text) + 2, 0);
		const ranges = rangesW + 1 < w ? this.pills(0, end - rangesW, end, rangeItems) : "";

		const full = TABS.reduce((a, t) => a + visibleWidth(t.title) + 3, -1) <= w;
		let x = left;
		const cells: string[] = [];
		let underline: [number, number] = [0, 0];
		TABS.forEach((t, i) => {
			const title = full ? t.title : SHORT_TITLES[i];
			const label = i === this.tab ? bold(ink.text(` ${title} `)) : ink.muted(` ${title} `);
			const cw = visibleWidth(label);
			if (x + cw > end) return;
			this.hits.push([1, x, x + cw, () => this.setTab(i)]);
			if (i === this.tab) underline = [x - left, cw];
			cells.push(label);
			x += cw + 1;
		});
		const tabs = cells.join(" ");
		const harness = this.harnessItems();
		const harnessW = harness.reduce((a, h) => a + visibleWidth(h.text) + 2, 0);
		const inline = harness.length > 0 && visibleWidth(tabs) + harnessW + 4 <= w;

		const rows = [spread(brand, ranges, w)];
		rows.push(inline ? spread(tabs, this.pills(1, end - harnessW, end, harness), w) : tabs);
		if (harness.length && !inline) rows.push(this.pills(2, left, end, harness));

		const ruleRow = rows.length;
		let chips = "";
		let cx = end;
		for (const [label, key] of [...filterChips(this.ds, this.filter)].reverse()) {
			const cell = ` ${label} ✕ `;
			const cw = visibleWidth(cell);
			if (cx - cw - 1 < left + 8) break;
			cx -= cw + 1;
			this.hits.push([ruleRow, cx, cx + cw, () => this.setFilter({ ...this.filter, [key]: undefined })]);
			chips = `${bg(PILL_BG, fg(PILL_FG, cell))} ${chips}`;
		}
		const [ux, uw] = underline;
		const ruleW = w - (end - cx);
		const lead = Math.min(ux, ruleW);
		const mark = Math.max(0, Math.min(uw, ruleW - lead));
		rows.push(ink.border("─".repeat(lead)) + ink.accent("━".repeat(mark)) + ink.border("─".repeat(Math.max(0, ruleW - lead - mark))) + chips);
		return rows;
	}

	private context(width: number): Ctx {
		const view = this;
		const id = RANGES[this.range].id;
		const s = this.summary(id);
		return {
			ds: this.ds,
			s,
			prev: this.previous(id),
			get year() {
				return view.summary("1y");
			},
			get all() {
				return view.summary("all");
			},
			get streak() {
				return view.streak();
			},
			get burn() {
				return view.monthToDate();
			},
			windows: this.opts.windows,
			width,
			ink: this.ink,
			metric: this.metric,
			ramp: RAMPS[this.ramp],
			skyline: this.skyline,
			group: this.group,
			cursor: this.cursor,
			bustOrder: this.bustOrder,
			planUsd: this.opts.planUsd,
			color: seriesColors(s),
			label: (k) => this.ds.projectName.get(k) ?? modelLabel(k),
		};
	}

	/** One tab's body at content width `width`, without header, footer or margin. */
	tabLines(tab: number, width: number): string[] {
		return TABS[tab].render(this.context(Math.max(40, width)));
	}

	render(width: number): string[] {
		const rows = terminalRows();
		const key = `${width}x${rows}`;
		if (this.cache?.key === key) return this.cache.lines;

		const { w, left } = frame(width);
		const s = this.summary(RANGES[this.range].id);
		const header = this.header(w, left, s);
		this.headerRows = header.length;
		const bodyKey = `${this.tab}\t${w}`;
		if (this.body?.key !== bodyKey) {
			const problems = (this.opts.problems ?? []).map((p) => fg(WARN, `! ${p}`));
			this.body = { key: bodyKey, lines: ["", ...problems, ...(problems.length ? [""] : []), ...this.tabLines(this.tab, w), ""] };
		}
		const body = this.body.lines;
		const viewport = Math.max(1, rows - header.length - 1);
		const maxScroll = Math.max(0, body.length - viewport);
		const scroll = Math.min(this.scroll.get(this.tab) ?? 0, maxScroll);
		this.scroll.set(this.tab, scroll);
		const visible = body.slice(scroll, scroll + viewport);
		while (visible.length < viewport) visible.push("");

		const filtered = Object.values(this.filter).some((v) => v !== undefined);
		const keys = `tab next   [ ] range   h harness   p project   o provider${filtered ? "   H P O clear" : ""}   q close`;
		const position = maxScroll ? `${String(Math.round((scroll / maxScroll) * 100)).padStart(3)}%  ` : "      ";
		const hint = `${position}${TABS[this.tab].hint}`;
		const footer = visibleWidth(hint) + visibleWidth(keys) + 4 <= w ? spread(this.ink.dim(hint), this.ink.dim(keys), w) : this.ink.dim(truncateToWidth(keys, w));

		const margin = " ".repeat(left);
		const lines = clampLines([...header, ...visible, footer].map((l) => plain(margin + l)), width);
		this.cache = { key, lines: lines.map((l) => (visibleWidth(l) < width ? pad(l, width) : l)) };
		return this.cache.lines;
	}
}
