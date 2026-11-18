import { describe, expect, test } from "bun:test";
import { formatQuota, formatResetTime, parseQuotaSummary } from "./quota";

/** The response `retrieveUserQuotaSummary` gave on an AI Ultra account. */
const ULTRA_SUMMARY = {
	groups: [
		{
			buckets: [
				{ bucketId: "gemini-weekly", displayName: "Weekly Limit Remaining", window: "weekly", resetTime: "2026-11-25T09:12:55Z", remainingFraction: 1 },
				{ bucketId: "gemini-5h", displayName: "Five Hour Limit Remaining", window: "5h", resetTime: "2026-11-18T14:12:55Z", remainingFraction: 1 },
			],
			displayName: "Gemini Models",
			description: "Models within this group: Gemini 4 Carbon, Gemini 4 Argon, Gemini 4 Hydrogen",
		},
		{
			buckets: [
				{ bucketId: "3p-weekly", displayName: "Weekly Limit Remaining", window: "weekly", resetTime: "2026-11-25T09:12:55Z", remainingFraction: 1 },
				{ bucketId: "3p-5h", displayName: "Five Hour Limit Remaining", window: "5h", resetTime: "2026-11-18T14:12:55Z", remainingFraction: 0.875 },
			],
			displayName: "Claude and GPT models",
			description: "Models within this group: Claude Opus 5.5, Claude Sonnet 5.5, GPT-OSS 120B",
		},
	],
	description: "Within each group, models share a weekly limit and a 5-hour limit.",
};

describe("quota summary", () => {
	test("reads both pools and their buckets", () => {
		const summary = parseQuotaSummary(ULTRA_SUMMARY);
		expect(summary.groups.map((group) => group.displayName)).toEqual(["Gemini Models", "Claude and GPT models"]);
		expect(summary.groups[1]!.buckets.map((bucket) => [bucket.window, bucket.remainingFraction])).toEqual([
			["weekly", 1],
			["5h", 0.875],
		]);
	});

	test("prints one line per pool with the reset time in UTC", () => {
		expect(formatQuota(parseQuotaSummary(ULTRA_SUMMARY))).toBe(
			"Gemini Models: weekly 100% (resets Nov 25 09:12Z) · 5h 100% (resets Nov 18 14:12Z)\n" +
				"Claude and GPT models: weekly 100% (resets Nov 25 09:12Z) · 5h 88% (resets Nov 18 14:12Z)",
		);
	});

	test("a fraction stays inside 0 and 1", () => {
		const summary = parseQuotaSummary({
			groups: [{ displayName: "Gemini Models", buckets: [{ window: "5h", resetTime: "2026-11-18T14:12:55Z", remainingFraction: 1.4 }] }],
		});
		expect(formatQuota(summary)).toBe("Gemini Models: 5h 100% (resets Nov 18 14:12Z)");
		const negative = parseQuotaSummary({
			groups: [{ displayName: "Gemini Models", buckets: [{ window: "5h", resetTime: "2026-11-18T14:12:55Z", remainingFraction: -2 }] }],
		});
		expect(formatQuota(negative)).toBe("Gemini Models: 5h 0% (resets Nov 18 14:12Z)");
	});

	test("junk in the response does not crash the command", () => {
		expect(formatQuota(parseQuotaSummary(undefined))).toBe("Antigravity reported no quota groups.");
		expect(parseQuotaSummary({ groups: [{ displayName: "x" }] }).groups[0]!.buckets).toEqual([]);
		expect(formatQuota(parseQuotaSummary({ groups: [{ displayName: "x" }] }))).toBe("x");
	});

	test("an unreadable reset time says so", () => {
		expect(formatResetTime("not a date")).toBe("unknown");
	});
});
