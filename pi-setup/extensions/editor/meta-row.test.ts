import { afterEach, describe, expect, test } from "bun:test";
import { visibleWidth } from "@mariozechner/pi-tui";
import { theme } from "../tools/lib/test-theme";
import { type CacheView, compactCacheText, fullCacheText } from "./cache-line";
import { formatChanges, parseDiffStat } from "./changes";
import { type MetaSource, MetaRow } from "./meta-row";
import { keepEnd, layoutRow } from "./widget-row";

const strip = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "");
const T0 = 1_700_000_000_000;
const HOUR = 3_600_000;
const MIN = 60_000;

const view = (hit: number, ttlMs: number | undefined = HOUR, lastCacheAt = T0): CacheView => ({
	stats: { cacheRead: 83_000_000, cacheWrite: 660_000, toolCalls: 225, lastHitRate: hit, lastCacheAt },
	ttlMs,
});

describe("the glance cache figure", () => {
	test("idle and healthy: hit rate and time left in plain text, only the separator is grey", () => {
		expect(compactCacheText(view(1), T0 + MIN, false, theme)).toBe(`cache 100%${theme.fg("dim", " · ")}59m left`);
	});

	test("while a run is on there is no countdown: every request renews it", () => {
		expect(strip(compactCacheText(view(1), T0 + 50 * MIN, true, theme))).toBe("cache 100%");
	});

	test("the last five minutes of a 1h cache and the last minute of a 5m cache warn", () => {
		expect(compactCacheText(view(1), T0 + 56 * MIN, false, theme)).toContain(theme.fg("warning", "expires in 4m"));
		expect(strip(compactCacheText(view(1, 5 * MIN), T0 + 2 * MIN, false, theme))).toBe("cache 100% · 3m left");
		expect(compactCacheText(view(1, 5 * MIN), T0 + 4.5 * MIN, false, theme)).toContain(theme.fg("warning", "expires in 30s"));
	});

	test("an expired cache says so and nothing else", () => {
		expect(strip(compactCacheText(view(1), T0 + 2 * HOUR, false, theme))).toBe("cache expired");
	});

	test("a poor hit rate gets colour", () => {
		expect(compactCacheText(view(0.6), T0, true, theme)).toContain(theme.fg("warning", "cache 60%"));
		expect(compactCacheText(view(0.2), T0, true, theme)).toContain(theme.fg("error", "cache 20%"));
	});

	test("no cache activity yet shows nothing", () => {
		expect(compactCacheText({ stats: { cacheRead: 0, cacheWrite: 0, toolCalls: 0 }, ttlMs: HOUR }, T0, false, theme)).toBe("");
	});

	test("a healthy detail meter has no colour", () => {
		const full = fullCacheText(view(1), T0 + MIN, theme);
		expect(full).toStartWith(`${theme.fg("dim", "cache")}  ${"█".repeat(12)}`);
		expect(full).toContain("100% hit  expires in 59m  read 83M  write 660k");
	});

	test("the detail figure keeps the meter, lifetime and totals", () => {
		expect(strip(fullCacheText(view(1), T0 + MIN, theme))).toBe("cache  ████████████  100% hit  expires in 59m  read 83M  write 660k  225 calls");
	});
});

describe("git changes", () => {
	test("the summary line of git diff --stat", () => {
		expect(parseDiffStat(" a | 2 +-\n 29 files changed, 1059 insertions(+), 1128 deletions(-)\n")).toEqual({ files: 29, insertions: 1059, deletions: 1128 });
		expect(parseDiffStat(" 1 file changed, 3 deletions(-)")).toEqual({ files: 1, insertions: 0, deletions: 3 });
		expect(parseDiffStat("")).toBeUndefined();
	});

	test("formatted short and grey", () => {
		expect(formatChanges({ files: 29, insertions: 1059, deletions: 1128 }, theme)).toBe(theme.fg("dim", "29 files +1059 -1128"));
		expect(strip(formatChanges({ files: 1, insertions: 0, deletions: 3 }, theme))).toBe("1 file -3");
		expect(formatChanges(undefined, theme)).toBe("");
	});
});

describe("layoutRow", () => {
	test("left flush left, right flush right, exact width", () => {
		const line = layoutRow({ left: "cache 100%", right: "29 files" }, 30);
		expect(line).toBe("cache 100%            29 files");
	});

	test("the middle gives way first, then the right; the left stays whole", () => {
		const parts = { left: "cache 100% · 59m left", center: "Pursuing goal (12m)", right: "29 files +1059 -1128" };
		expect(layoutRow(parts, 80)).toContain("Pursuing goal");
		const tight = layoutRow(parts, 46);
		expect(tight).not.toContain("Pursuing");
		expect(tight).toEndWith("29 files +1059 -1128");
		const narrow = strip(layoutRow(parts, 30));
		expect(narrow).toStartWith("cache 100% · 59m left  ");
		expect(narrow).toEndWith("…");
	});

	test("a path keeps its end", () => {
		expect(keepEnd("~/Documents/Code stuff/ghosttyyy (main)", 22)).toBe("…tuff/ghosttyyy (main)");
		expect(keepEnd("short", 22)).toBe("short");
		expect(keepEnd("abc", 1)).toBe("");
	});

	test("control characters never reach the line", () => {
		expect(layoutRow({ left: "a\nb\tc\u0007" }, 10)).toBe("a b c     ");
	});

	test("every width is exact", () => {
		const parts = { left: theme.fg("dim", "cache 100% · 59m left"), center: "日本語 status", right: theme.fg("dim", "29 files +1059 -1128") };
		for (let width = 1; width <= 160; width++) expect(visibleWidth(layoutRow(parts, width))).toBe(width);
	});
});

describe("MetaRow", () => {
	const realSetInterval = globalThis.setInterval;
	const realClearInterval = globalThis.clearInterval;
	afterEach(() => {
		globalThis.setInterval = realSetInterval;
		globalThis.clearInterval = realClearInterval;
	});

	function setup(overrides: Partial<MetaSource> = {}) {
		const state = { now: T0 + MIN, renders: 0, running: false, detail: false };
		const source: MetaSource = {
			detail: () => state.detail,
			running: () => state.running,
			cache: () => view(1),
			changes: () => formatChanges({ files: 29, insertions: 1059, deletions: 1128 }, theme),
			statuses: () => "",
			session: () => "context 680k of 1.0M · anthropic · turn 69 · 94m26s",
			place: () => "~/Documents/Code stuff/ghosttyyy (main)",
			...overrides,
		};
		const row = new MetaRow(source, theme, { requestRender: () => state.renders++ }, () => state.now);
		return { row, state };
	}

	test("one line at a glance, two in the detail view", () => {
		const { row, state } = setup();
		const glance = row.render(80).map(strip);
		expect(glance).toHaveLength(1);
		expect(glance[0]).toStartWith("   cache 100% · 59m left");
		expect(glance[0]).toEndWith("29 files +1059 -1128   ");
		state.detail = true;
		const detail = row.render(80).map(strip);
		expect(detail).toHaveLength(2);
		expect(detail[0]).toContain("████████████");
		expect(detail[1]).toContain("turn 69");
		expect(detail[1]).toContain("ghosttyyy (main)");
	});

	test("nothing to say renders no line at all", () => {
		const { row } = setup({ cache: () => undefined, changes: () => "" });
		expect(row.render(80)).toEqual([]);
	});

	test("other extensions' statuses sit in the middle", () => {
		const { row } = setup({ statuses: () => "Pursuing goal (12m)" });
		expect(strip(row.render(100)[0]!)).toContain("Pursuing goal (12m)");
	});

	test("the same inputs give the very same lines", () => {
		const { row } = setup();
		const first = row.render(80);
		expect(row.render(80)).toBe(first);
		expect(row.render(81)).not.toBe(first);
	});

	test("every width keeps every line inside it", () => {
		const { row, state } = setup({ statuses: () => "Goal paused because the provider usage limit was reached. Auto-resume will retry." });
		for (const detail of [false, true]) {
			state.detail = detail;
			for (let width = 1; width <= 200; width++) {
				for (const line of row.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});

	test("the countdown ticks only while idle, and stops on dispose", () => {
		const timers = new Set<unknown>();
		globalThis.setInterval = ((() => {
			const handle = { unref() {} };
			timers.add(handle);
			return handle;
		}) as unknown) as typeof setInterval;
		globalThis.clearInterval = ((handle: unknown) => timers.delete(handle)) as typeof clearInterval;

		const { row, state } = setup();
		state.running = true;
		row.sync();
		expect(timers.size).toBe(0);
		state.running = false;
		row.sync();
		expect(timers.size).toBe(1);
		row.dispose();
		expect(timers.size).toBe(0);
	});
});
