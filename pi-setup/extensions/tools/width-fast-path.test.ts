/**
 * The width patch's single-cell fast path must change nothing but speed: pi-tui's width, truncation, wrapping and
 * slicing give the same results with it as without it, for every BMP character and for random terminal lines.
 */
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const { FAST_EDITS, FAST_MARKER, withFastPath } = await import("../../pi-core-patches/apply-pi-tui-width-patch.mjs");

const TUI = fs.realpathSync(path.join(import.meta.dir, "node_modules", "@earendil-works", "pi-tui"));
const installed = fs.readFileSync(path.join(TUI, "dist", "utils.js"), "utf8");
let base = installed;
if (installed.includes(FAST_MARKER)) for (const [from, to] of [...FAST_EDITS].reverse()) base = base.replace(to, from);
const fast = withFastPath(base);

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "width-fast-path-"));
afterAll(() => fs.rmSync(DIR, { recursive: true, force: true }));
const eaw = pathToFileURL(Bun.resolveSync("get-east-asian-width", path.join(TUI, "dist"))).href;
async function load(name: string, source: string) {
	const file = path.join(DIR, `${name}.mjs`);
	fs.writeFileSync(file, source.replace('from "get-east-asian-width"', `from "${eaw}"`));
	return import(file);
}
const before = await load("before", base);
const after = await load("after", fast);

function random(seed: number) {
	return () => {
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const PIECES = [
	"a", "Z", "0", " ", "~", "\t", "│", "─", "╭", "╰", "├", "█", "▌", "■", "◐", "◓", "▶", "◀", "▪", "◻", "©", "®", "é", "ß",
	"ǅ", "ʰ", "˜", "—", "–", "“", "”", "…", "•", "‧", "←", "→", "↔", "↩", "⇒", "∑", "≠", "⋯", "·", "⁂", "✓", "✕", "❯",
	"\u0301", "\u0300", "\uFE0F", "\uFE0E", "\u200D", "\u00AD", "\u200B", "\u2028", "😀", "👍🏽", "🇵🇰", "中", "한",
	"\uFF21", "हिंदी", "क्ष", "\u0E33", "\uD800", "\x07", "\x00", "\x7f", "\x1b[31m", "\x1b[0m", "\x1b[38;5;244m",
	"\x1b[1;4m", "\x1b]8;;https://x.y\x07", "\x1b]8;;\x07", "\x1b]133;A\x07", "\x1b", "\x1b[",
];

function line(next: () => number) {
	let s = "";
	const length = Math.floor(next() * 40);
	for (let i = 0; i < length; i++) s += PIECES[Math.floor(next() * PIECES.length)];
	return s;
}

describe("width fast path", () => {
	test("the fast path applies to the installed pi-tui", () => {
		expect(fast).toBeString();
		expect(fast).toContain(FAST_MARKER);
	});

	test("every BMP character measures the same, alone and between styled ASCII", () => {
		const differ: string[] = [];
		for (let code = 0; code <= 0xffff; code++) {
			const c = String.fromCharCode(code);
			for (const s of [c, `a${c}b`, `\x1b[31m${c}\x1b[0m│`]) {
				if (before.visibleWidth(s) !== after.visibleWidth(s)) differ.push(`U+${code.toString(16)} in ${JSON.stringify(s)}`);
			}
		}
		expect(differ).toEqual([]);
	});

	test("20,000 random terminal lines: width, truncation, wrapping and slicing are identical", () => {
		const next = random(7);
		for (let n = 0; n < 20_000; n++) {
			const s = line(next);
			const width = 1 + Math.floor(next() * 50);
			const ellipsis = ["...", "…", "", "→"][n % 4];
			const pad = n % 3 === 0;
			const label = JSON.stringify({ s, width, ellipsis, pad });
			expect([label, after.visibleWidth(s)]).toEqual([label, before.visibleWidth(s)]);
			expect([label, after.truncateToWidth(s, width, ellipsis, pad)]).toEqual([label, before.truncateToWidth(s, width, ellipsis, pad)]);
			expect([label, after.wrapTextWithAnsi(s, width)]).toEqual([label, before.wrapTextWithAnsi(s, width)]);
			const start = Math.floor(next() * 20);
			expect([label, after.sliceWithWidth(s, start, width, n % 2 === 0)]).toEqual([label, before.sliceWithWidth(s, start, width, n % 2 === 0)]);
		}
	});
});
