import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@mariozechner/pi-tui";
import { theme } from "../tools/lib/test-theme";
import { type BorderSegment, layoutBorder } from "./border";

const strip = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "");
const style = { left: "╭", right: "╮", horizontal: "─", chrome: (text: string) => theme.fg("dim", text) };
const seg = (text: string, priority = 50): BorderSegment => ({ text, priority });

describe("layoutBorder", () => {
	test("labels sit inside a space on each side, with dashes between", () => {
		const line = strip(layoutBorder(40, style, [seg("68%"), seg("$72.54")], [seg("opus"), seg("high")]));
		expect(line).toBe("╭─ 68% · $72.54 ───────── opus · high ─╮");
	});

	test("no labels is a plain rule", () => {
		expect(strip(layoutBorder(10, style, [], []))).toBe("╭────────╮");
	});

	test("a narrow line drops the lowest priority first, whole", () => {
		const left = [seg("68%", 100), seg("$72.54", 60)];
		const right = [seg("claude-opus-5-5", 90), seg("high", 70)];
		const wide = strip(layoutBorder(60, style, left, right));
		expect(wide).toContain("$72.54");
		const tighter = strip(layoutBorder(34, style, left, right));
		expect(tighter).toBe("╭─ 68% ─ claude-opus-5-5 · high ─╮");
		const narrow = strip(layoutBorder(30, style, left, right));
		expect(narrow).toContain("68%");
		expect(narrow).toContain("claude-opus-5-5");
		expect(narrow).not.toContain("hig");
	});

	test("the last label left is truncated rather than dropped", () => {
		const line = strip(layoutBorder(14, style, [seg("a very long activity label", 100)], [seg("cwd", 10)]));
		expect(line).toStartWith("╭─ a very");
		expect(line).toContain("…");
		expect(line).not.toContain("cwd");
	});

	test("every width from 4 to 200 is exact, colour and wide glyphs included", () => {
		const left = [seg(theme.fg("accent", "⁂") + " read(index.ts) · 4m", 100), seg("日本語のラベル", 40)];
		const right = [seg(theme.fg("muted", "ghosttyyy (main)"), 35)];
		for (let width = 4; width <= 200; width++) {
			expect(visibleWidth(layoutBorder(width, style, left, right))).toBe(width);
		}
	});
});
