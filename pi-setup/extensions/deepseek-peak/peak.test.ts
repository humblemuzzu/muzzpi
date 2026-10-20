import { describe, expect, test } from "bun:test";
import {
	EFFECTIVE_FROM_MS,
	PEAK_WINDOWS_UTC,
	computeState,
	formatClock,
	formatDuration,
	isPeakAt,
	labelColor,
	localPeakWindows,
	renderLabel,
	utcHourToLocal,
} from "./peak";

/** a Date at a given UTC wall time, safely after the effective date. */
const at = (h: number, m = 0, s = 0, day = 20) => new Date(Date.UTC(2026, 7, day, h, m, s));

const MIN = 60_000;
const HOUR = 60 * MIN;

describe("effective date", () => {
	test("is 16:00 UTC on 2026-08-16", () => {
		expect(new Date(EFFECTIVE_FROM_MS).toISOString()).toBe("2026-08-16T16:00:00.000Z");
	});

	test("before it, the scheme is not active", () => {
		const s = computeState(new Date(EFFECTIVE_FROM_MS - 1));
		expect(s.phase).toBe("pre-launch");
		expect(s.multiplier).toBe(1);
		// 16:00 UTC is outside both windows, so it opens off-peak
		expect(s.next).toBe("off-peak");
	});

	test("at the exact instant it flips on", () => {
		const s = computeState(new Date(EFFECTIVE_FROM_MS));
		expect(s.phase).toBe("off-peak");
	});

	test("pre-launch countdown is the real gap", () => {
		const s = computeState(new Date(EFFECTIVE_FROM_MS - 3 * HOUR));
		expect(s.msUntilChange).toBe(3 * HOUR);
	});

	test("a pre-launch instant that falls INSIDE a peak window still reads pre-launch", () => {
		// 2026-08-15 02:00 UTC is inside 01:00-04:00, but the scheme is not live
		expect(computeState(new Date(Date.UTC(2026, 7, 15, 2, 0, 0))).phase).toBe("pre-launch");
	});
});

describe("window boundaries are half-open [start, end)", () => {
	test("peak starts exactly at the top of the hour", () => {
		expect(isPeakAt(at(0, 59, 59))).toBe(false);
		expect(isPeakAt(at(1, 0, 0))).toBe(true);
	});

	test("peak ends exactly at the top of the hour", () => {
		expect(isPeakAt(at(3, 59, 59))).toBe(true);
		expect(isPeakAt(at(4, 0, 0))).toBe(false);
	});

	test("the off-peak gap between the two windows is real", () => {
		expect(isPeakAt(at(4, 0))).toBe(false);
		expect(isPeakAt(at(5, 30))).toBe(false);
		expect(isPeakAt(at(5, 59, 59))).toBe(false);
		expect(isPeakAt(at(6, 0))).toBe(true);
	});

	test("second window closes at 10:00", () => {
		expect(isPeakAt(at(9, 59, 59))).toBe(true);
		expect(isPeakAt(at(10, 0))).toBe(false);
	});

	test("every hour of the day agrees with the published table", () => {
		// 01,02,03 and 06,07,08,09 are peak; all others off-peak
		const peakHours = new Set([1, 2, 3, 6, 7, 8, 9]);
		for (let h = 0; h < 24; h++) {
			expect(isPeakAt(at(h, 30))).toBe(peakHours.has(h));
		}
	});

	test("7 peak hours per weekday, 17 off-peak", () => {
		const total = PEAK_WINDOWS_UTC.reduce((sum, [s, e]) => sum + (e - s), 0);
		expect(total).toBe(7);
	});
});

describe("weekend rule — off-peak all day, Beijing time, from 2026-08-23", () => {
	// 2026-08-20 is a Thursday (day=20 default in `at`); Beijing Sat 08-29 and
	// Sun 08-23 both fall after the effective date.
	test("a Saturday at a former peak hour is now off-peak", () => {
		// Beijing Sat 08-29 10:00 = UTC 02:00, inside the old 01:00-04:00 window
		expect(isPeakAt(new Date(Date.UTC(2026, 7, 29, 2)))).toBe(false);
	});

	test("a Sunday at a former peak hour is now off-peak", () => {
		// Beijing Sun 08-23 10:00 = UTC 02:00
		expect(isPeakAt(new Date(Date.UTC(2026, 7, 23, 2)))).toBe(false);
	});

	test("weekdays keep their windows after the weekend rule", () => {
		// Beijing Mon 08-24 10:00 = UTC 02:00
		expect(isPeakAt(new Date(Date.UTC(2026, 7, 24, 2)))).toBe(true);
	});

	test("Beijing Saturday before the effective date still peaks (old rule)", () => {
		// Beijing Sat 08-22 10:00 = UTC 02:00 — before 08-23 00:00 Beijing
		expect(isPeakAt(new Date(Date.UTC(2026, 7, 22, 2)))).toBe(true);
	});

	test("the whole Beijing weekend is off-peak, both windows", () => {
		for (const h of [2, 7, 8, 13, 20]) {
			// UTC Sat 08-29 hours map into Beijing Sat (16:00+8h offset)
			expect(isPeakAt(new Date(Date.UTC(2026, 7, 29, h)))).toBe(false);
		}
	});

	test("the longest gap is now Friday 10:00 UTC -> Monday 01:00 UTC (63h)", () => {
		// Beijing Fri 08-28 18:00 = UTC 10:00; next peak is Beijing Mon 08-31 09:00 = UTC 01:00
		const s = computeState(new Date(Date.UTC(2026, 7, 28, 10)));
		expect(s.phase).toBe("off-peak");
		expect(s.next).toBe("peak");
		expect(s.msUntilChange).toBe(63 * HOUR);
	});
});

describe("countdown to the next transition", () => {
	test("mid-peak counts down to the window's end", () => {
		const s = computeState(at(2, 15));
		expect(s.phase).toBe("peak");
		expect(s.next).toBe("off-peak");
		expect(s.msUntilChange).toBe(1 * HOUR + 45 * MIN); // -> 04:00
	});

	test("in the gap, counts down to the second window", () => {
		const s = computeState(at(5, 0));
		expect(s.phase).toBe("off-peak");
		expect(s.next).toBe("peak");
		expect(s.msUntilChange).toBe(1 * HOUR); // -> 06:00
	});

	test("the long overnight stretch wraps to tomorrow 01:00", () => {
		const s = computeState(at(10, 0));
		expect(s.phase).toBe("off-peak");
		expect(s.msUntilChange).toBe(15 * HOUR); // 10:00 -> 01:00 next day
	});

	test("just before midnight wraps correctly", () => {
		const s = computeState(at(23, 30));
		expect(s.msUntilChange).toBe(90 * MIN); // -> 01:00
		expect(s.next).toBe("peak");
	});

	test("seconds and ms are honoured, not floored to the minute", () => {
		const d = new Date(Date.UTC(2026, 7, 20, 3, 59, 30, 250));
		expect(computeState(d).msUntilChange).toBe(29_750);
	});

	test("the countdown never exceeds the longest gap (63h over the weekend)", () => {
		// Thursday is a weekday, so per-day gaps stay <= 15h; the weekend rule
		// only extends the Friday-evening -> Monday-morning stretch.
		for (let h = 0; h < 24; h++) {
			for (const m of [0, 17, 33, 59]) {
				const s = computeState(at(h, m));
				expect(s.msUntilChange).toBeGreaterThan(0);
				expect(s.msUntilChange).toBeLessThanOrEqual(15 * HOUR);
			}
		}
		// Friday 10:00 UTC is the new max — next peak is Monday 01:00 UTC
		const fri = computeState(new Date(Date.UTC(2026, 7, 28, 10)));
		expect(fri.msUntilChange).toBe(63 * HOUR);
	});

	test("walking a full day, every flip lands on a published boundary", () => {
		let t = at(0, 0).getTime();
		const end = t + 24 * HOUR;
		const edges: number[] = [];
		while (t < end) {
			const s = computeState(new Date(t));
			t += s.msUntilChange;
			if (t < end) edges.push(new Date(t).getUTCHours());
		}
		expect(edges).toEqual([1, 4, 6, 10]);
	});
});

describe("multiplier", () => {
	test("peak is 2x, off-peak is 1x", () => {
		expect(computeState(at(2)).multiplier).toBe(2);
		expect(computeState(at(20)).multiplier).toBe(1);
	});
});

describe("formatDuration", () => {
	test.each([
		[0, "now"],
		[-5, "now"],
		[30_000, "<1m"],
		[59_999, "<1m"],
		[60_000, "1m"],
		[47 * MIN, "47m"],
		[HOUR, "1h"],
		[HOUR + 48 * MIN, "1h 48m"],
		[11 * HOUR + 48 * MIN, "11h 48m"],
		[23 * HOUR + 59 * MIN, "23h 59m"],
		[24 * HOUR, "1d"],
		[2 * 24 * HOUR + 3 * HOUR, "2d 3h"],
	])("%i ms -> %s", (ms, expected) => {
		expect(formatDuration(ms as number)).toBe(expected as string);
	});
});

describe("label", () => {
	test("peak label names the multiplier", () => {
		const text = renderLabel(computeState(at(2, 15)));
		expect(text).toContain("PEAK");
		expect(text).toContain("2×");
		expect(text).toContain("1h 45m");
	});

	test("off-peak label does not say peak", () => {
		const text = renderLabel(computeState(at(20, 0)));
		expect(text).toContain("off-peak");
		expect(text).not.toContain("PEAK");
	});

	test("pre-launch label does not claim a discount exists", () => {
		const text = renderLabel(computeState(new Date(EFFECTIVE_FROM_MS - HOUR)));
		expect(text).toContain("flat");
		expect(text).not.toContain("off-peak");
		expect(text).not.toContain("PEAK");
	});

	test("pre-launch label is just the phase and the countdown", () => {
		// the "new rates in" wording was dropped — the countdown says it
		const text = renderLabel(computeState(new Date(EFFECTIVE_FROM_MS - (3 * 24 + 2) * HOUR)));
		expect(text).toBe("ds flat · 3d 2h");
	});

	test("labels stay short enough for a border", () => {
		for (const d of [at(2), at(20), new Date(EFFECTIVE_FROM_MS - HOUR)]) {
			expect(renderLabel(computeState(d)).length).toBeLessThanOrEqual(32);
		}
	});

	test("a label never contains a control character (TUI sink guard)", () => {
		for (let h = 0; h < 24; h++) {
			expect(renderLabel(computeState(at(h, 7)))).not.toMatch(/[\x00-\x1f\x7f]/);
		}
	});
});

describe("color", () => {
	test("off-peak is plain text whatever the model", () => {
		expect(labelColor(computeState(at(20)), true)).toBeUndefined();
		expect(labelColor(computeState(at(20)), false)).toBeUndefined();
	});

	test("peak escalates to error only while actually on deepseek", () => {
		expect(labelColor(computeState(at(2)), false)).toBe("warning");
		expect(labelColor(computeState(at(2)), true)).toBe("error");
	});

	test("pre-launch is plain text", () => {
		expect(labelColor(computeState(new Date(EFFECTIVE_FROM_MS - HOUR)), true)).toBeUndefined();
	});
});

describe("formatClock", () => {
	test("12-hour, no leading zero, no meridiem", () => {
		// 13:32 UTC = 19:02 IST
		expect(formatClock(new Date(Date.UTC(2026, 7, 13, 13, 32)), "Asia/Kolkata")).toBe("7:02");
	});

	test("morning and evening render identically — the meridiem is gone by design", () => {
		const morning = formatClock(new Date(Date.UTC(2026, 7, 13, 1, 32)), "Asia/Kolkata"); // 07:02 IST
		const evening = formatClock(new Date(Date.UTC(2026, 7, 13, 13, 32)), "Asia/Kolkata"); // 19:02 IST
		expect(morning).toBe("7:02");
		expect(evening).toBe("7:02");
	});

	test("noon and midnight use 12, not 0", () => {
		expect(formatClock(new Date(Date.UTC(2026, 7, 13, 12, 0)), "UTC")).toBe("12:00");
		expect(formatClock(new Date(Date.UTC(2026, 7, 13, 0, 5)), "UTC")).toBe("12:05");
	});

	test("minutes keep their leading zero, hours do not", () => {
		expect(formatClock(new Date(Date.UTC(2026, 7, 13, 9, 7)), "UTC")).toBe("9:07");
	});

	test("no AM/PM survives, in any spelling or separator", () => {
		for (let h = 0; h < 24; h++) {
			const out = formatClock(new Date(Date.UTC(2026, 7, 13, h, 30)), "UTC");
			// U+202F (narrow no-break space) is what modern ICU emits before AM/PM
			expect(out).toMatch(/^\d{1,2}:\d{2}$/);
			expect(out).not.toMatch(/[AaPp]\.?[Mm]/);
			expect(out).not.toContain("\u202f");
		}
	});

	test("never contains a control char (TUI sink guard)", () => {
		expect(formatClock(new Date(), "Asia/Kolkata")).not.toMatch(/[\x00-\x1f\x7f]/);
	});
});

describe("local time rendering", () => {
	test("IST peak windows are 06:30-09:30 and 11:30-15:30", () => {
		expect(localPeakWindows(at(12), "Asia/Kolkata")).toEqual(["06:30–09:30", "11:30–15:30"]);
	});

	test("Beijing windows are office hours — the independent corroboration", () => {
		expect(localPeakWindows(at(12), "Asia/Shanghai")).toEqual(["09:00–12:00", "14:00–18:00"]);
	});

	test("UTC renders as the published table", () => {
		expect(localPeakWindows(at(12), "UTC")).toEqual(["01:00–04:00", "06:00–10:00"]);
	});

	test("a window crossing local midnight still formats", () => {
		// August is PDT (UTC-7), so 01:00 UTC = 18:00 the previous day
		expect(utcHourToLocal(1, at(12), "America/Los_Angeles")).toBe("18:00");
	});

	test("24-hour clock regardless of system locale (en-IN default here)", () => {
		expect(utcHourToLocal(15, at(12), "UTC")).toBe("15:00");
	});
});
