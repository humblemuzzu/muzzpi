/**
 * The streaming-markdown text patch (pi-core-patches/text-patches.mjs) must change nothing on screen: each frame of a
 * streaming reply renders as stock renders that text, and a finished reply is lexed in full. Runs the installed pi.
 * MD_STREAM_SESSIONS=<n> also streams your <n> longest assistant answers of the last 20 days.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AssistantMessageComponent, getMarkdownTheme, initTheme } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";

const { PATCHES, inspect } = await import("../../pi-core-patches/text-patches.mjs");
const PI_PKG = realpathSync(join(import.meta.dir, "node_modules", "@earendil-works", "pi-coding-agent"));

let seed = 1;
const rand = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)];
const wrap = (open: number, close: number) => (text: string) => `\x1b[${open}m${text}\x1b[${close}m`;
const THEME = {
	heading: wrap(1, 22), link: wrap(4, 24), linkUrl: wrap(2, 22), code: wrap(33, 39), codeBlock: wrap(32, 39),
	codeBlockBorder: wrap(90, 39), quote: wrap(3, 23), quoteBorder: wrap(90, 39), hr: wrap(90, 39), listBullet: wrap(36, 39),
	bold: wrap(1, 22), italic: wrap(3, 23), strikethrough: wrap(9, 29), underline: wrap(4, 24),
};

const BLOCKS = [
	"# Heading one", "## Heading *two* with `code`", "Setext title\n============", "Another setext\n---",
	"A paragraph with **bold**, *italic*, `code`, ~~strike~~ and a [link](https://example.com/x).",
	"A long paragraph line that goes on and on so that it has to wrap at the terminal width because it is longer than that.\nWith a second line.",
	"Step one is done.\n2. Install deps\n- run npm i",
	"1. first\n2. second\n   - nested a\n   - nested b\n3. third",
	"- item\n\n- loose item\n\n  continued paragraph",
	"- [ ] task\n- [x] done task", "* star list\n+ plus list", "1) paren list\n2) second", "2. starts at two\n3. three",
	"```ts\nconst x = 1;\nfunction f() {\n\treturn x;\n}\n```", "~~~\ntilde fence\n~~~", "```python\nunclosed = True\nprint(unclosed)",
	"````md\n```\ninner fence\n```\n````", "    indented code\n    more code",
	"| a | b | c |\n|---|:-:|--:|\n| 1 | 2 | 3 |\n| 日本 | 😀 | ok |", "col | col2\n--- | ---\nx | y",
	"> quote line\n> > nested quote\n> back", "> quote\nlazy continuation", "> - list in quote\n> ```\n> code in quote\n> ```",
	"<div>\nhtml block\n</div>", "<pre>\n\npre with blank\n\n</pre>", "<!-- a comment -->",
	"<details>\n<summary>More</summary>\n\nhidden *text*\n\n</details>",
	"$$\nx^2 + y^2 = z^2\n$$", "$$\n\\frac{a}{b}\n\nmore = 2\n$$", "$$\nsum\n\nof all\n\nparts = 3\n$$", "\\[\na \\le b\n\\]",
	"Inline math $a+b$ and \\(c\\) here.", "---", "***", "___",
	"中文段落，包含**粗体**和`代码`。日本語のテキスト。한국어 문장.", "Emoji 😀🇮🇳👨‍👩‍👧 and हिंदी text with tabs\tand\ttabs.",
	"Line with trailing spaces for hard break  \nnext line", "Hard\\\nbreak with backslash", "Text with <https://auto.link> and [^1]",
	"\tTab-indented paragraph?", "Para\n# heading interrupts", "Para\n```\nfence interrupts\n```", "Para\n> quote interrupts",
	"Para\n| x | y |\n|---|---|\n| 1 | 2 |",
];
const REFERENCE = "See [the ref][r1].\n\n[r1]: https://example.com/ref";

function document(): string {
	let doc = "";
	const blocks = 2 + Math.floor(rand() * 9);
	for (let i = 0; i < blocks; i++) doc += (i ? pick(["\n", "\n\n", "\n\n", "\n\n\n"]) : "") + (rand() < 0.03 ? REFERENCE : pick(BLOCKS));
	return rand() < 0.1 ? doc.replaceAll("\n", "\r\n") : doc;
}

const same = (a: string[], b: string[]) => a.length === b.length && a.every((line, i) => line === b[i]);

/** Streams `doc` in `chunks` into a streaming Markdown and into a stock one; counts frames that differ and pieced lexes. */
function stream(doc: string, width: number, chunks: () => number) {
	let streaming = true;
	const md = new Markdown("", 1, 0, THEME, undefined, { streaming: () => streaming } as never);
	const stock = new Markdown("", 1, 0, THEME);
	let frames = 0, differ = 0, pieced = 0;
	for (let end = 0; end < doc.length; ) {
		end = Math.min(doc.length, end + chunks());
		const text = doc.slice(0, end).trim();
		md.setText(text);
		stock.setText(text);
		frames++;
		if (!same(md.render(width), stock.render(width))) differ++;
		if ((md as any).cachedTokens?.deref()?.pieced) pieced++;
	}
	streaming = false;
	md.setText(doc.trim());
	const settled = same(md.render(width), new Markdown(doc.trim(), 1, 0, THEME).render(width));
	return { frames, differ, pieced, settled };
}

describe("streaming Markdown lexes from its last blocks and renders as stock", () => {
	test("the patch is applied to the pi these tests run", () => {
		for (const patch of PATCHES.filter((p: { id: string }) => p.id === "streaming-markdown")) {
			expect(`${patch.file}: ${inspect(patch, PI_PKG).state}`).toBe(`${patch.file}: applied`);
		}
	});

	test("random documents of every block kind, streamed in random chunks: every frame as stock, settled as a full lex", () => {
		seed = 7;
		let frames = 0, differ = 0, pieced = 0, unsettled = 0;
		for (let i = 0; i < 1500; i++) {
			const doc = document();
			const run = stream(doc, pick([24, 40, 72, 120]), () => 1 + Math.floor(rand() * (rand() < 0.5 ? 4 : 40)));
			frames += run.frames;
			differ += run.differ;
			pieced += run.pieced;
			if (!run.settled) unsettled++;
		}
		expect({ differ, unsettled }).toEqual({ differ: 0, unsettled: 0 });
		expect(pieced).toBeGreaterThan(frames / 4);
	});

	test("what a last-three-blocks lex gets wrong mid-stream is lexed in full once the reply ends", () => {
		const math = `Intro.\n\nTotal:\n\n$$\n${Array.from({ length: 6 }, (_, i) => `term ${i}`).join("\n\n")}\n\nsum = 3\n$$\n\nAfter.`;
		const run = stream(math, 72, () => 1);
		expect(run.differ).toBeGreaterThan(0);
		expect(run.settled).toBe(true);
	});

	test("text that is not streaming, or that changed other than by growing, is never pieced", () => {
		const md = new Markdown("", 1, 0, THEME, undefined, { streaming: () => false } as never);
		for (const text of ["# a\n\nb\n\nc\n\nd", "# a\n\nb\n\nc\n\nd\n\ne", "# a\n\nB\n\nc\n\nd\n\ne\n\nf"]) {
			md.setText(text);
			md.render(60);
			expect((md as any).cachedTokens.deref().pieced).toBe(false);
		}
		let streaming = true;
		const live = new Markdown("", 1, 0, THEME, undefined, { streaming: () => streaming } as never);
		live.setText("# a\n\nb\n\nc\n\nd\n\ne");
		live.render(60);
		live.setText("# a\n\nb\n\nc\n\nd\n\ne\n\nf");
		live.render(60);
		expect((live as any).cachedTokens.deref().pieced).toBe(true);
		live.setText("# x\n\nb\n\nc\n\nd\n\ne\n\nf g");
		live.render(60);
		expect((live as any).cachedTokens.deref().pieced).toBe(false);
		streaming = false;
		live.setText("# x\n\nb\n\nc\n\nd\n\ne\n\nf g h");
		live.render(60);
		expect((live as any).cachedTokens.deref().pieced).toBe(false);
	});

	test("pi's assistant message: text and thinking stream as stock, and the finished message renders as a fresh one", () => {
		initTheme("dark");
		seed = 11;
		for (let i = 0; i < 60; i++) {
			const text = document().replaceAll("\r\n", "\n");
			const thinking = document().replaceAll("\r\n", "\n");
			const live = new AssistantMessageComponent(undefined, false, getMarkdownTheme());
			const message = (t: number, x: number) => ({
				role: "assistant",
				content: [{ type: "thinking", thinking: thinking.slice(0, t) }, { type: "text", text: text.slice(0, x) }],
			}) as never;
			const width = pick([60, 100]);
			for (let t = 0, x = 0; t < thinking.length || x < text.length; ) {
				if (t < thinking.length) t = Math.min(thinking.length, t + 1 + Math.floor(rand() * 30));
				else x = Math.min(text.length, x + 1 + Math.floor(rand() * 30));
				live.updateContent(message(t, x), true);
				const fresh = new AssistantMessageComponent(undefined, false, getMarkdownTheme());
				fresh.updateContent(message(t, x), true);
				expect(live.render(width)).toEqual(fresh.render(width));
			}
			live.updateContent(message(thinking.length, text.length), false);
			expect(live.render(width)).toEqual(new AssistantMessageComponent(message(thinking.length, text.length), false, getMarkdownTheme()).render(width));
		}
	});

	const sessions = Number(process.env.MD_STREAM_SESSIONS ?? 0);
	test.if(sessions > 0)("your longest real answers stream as stock", async () => {
		const answers = new Set<string>();
		const root = join(homedir(), ".pi", "agent", "sessions");
		for (const dir of readdirSync(root)) {
			for (const file of readdirSync(join(root, dir))) {
				const path = join(root, dir, file);
				if (!file.endsWith(".jsonl") || Date.now() - statSync(path).mtimeMs > 20 * 86_400_000) continue;
				for (const line of readFileSync(path, "utf8").split("\n")) {
					if (!line.includes('"role":"assistant"')) continue;
					try {
						for (const block of JSON.parse(line).message.content ?? []) if (block.type === "text" && block.text.length > 1500) answers.add(block.text.trim());
					} catch {}
				}
			}
		}
		let differ = 0, unsettled = 0;
		for (const answer of [...answers].sort((a, b) => b.length - a.length).slice(0, sessions)) {
			const run = stream(answer, 110, () => 24);
			differ += run.differ;
			if (!run.settled) unsettled++;
			await new Promise((resolve) => setImmediate(resolve));
		}
		expect({ differ, unsettled }).toEqual({ differ: 0, unsettled: 0 });
	}, 1_800_000);
});
