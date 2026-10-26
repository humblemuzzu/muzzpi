import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createReadTool, NORMAL_LIMITS } from "./read";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "read-"));
afterAll(() => fs.rmSync(DIR, { recursive: true, force: true }));

const read = createReadTool(NORMAL_LIMITS) as any;
const ctx = { cwd: DIR, sessionManager: { getSessionId: () => "read-test" } };
const file = (name: string, data: string | Buffer) => {
	const f = path.join(DIR, name);
	fs.writeFileSync(f, data);
	return f;
};
/** the model's own call */
const run = (args: object) => read.execute("toolu_1", args, undefined, undefined, ctx);
/** a call a codemode script makes: pi names it `<script call id>/<n>` */
const script = (args: object) => read.execute("toolu_1/0", args, undefined, undefined, ctx);

function stallsDuring(work: () => Promise<unknown>): Promise<{ took: number; worst: number }> {
	let last = performance.now();
	let worst = 0;
	const timer = setInterval(() => {
		const now = performance.now();
		worst = Math.max(worst, now - last);
		last = now;
	}, 5);
	const started = performance.now();
	return work().then(() => {
		clearInterval(timer);
		return { took: performance.now() - started, worst };
	});
}

describe("read", () => {
	test("a long line is cut once, at a character boundary; a script still gets it whole", async () => {
		const line = `${"x".repeat(4094)}😀😀 end`;
		const f = file("emoji.txt", `${line}\nnext\n`);
		const [first, second] = (await run({ path: f })).content[0].text.split("\n");
		expect(first).toBe(`1: ${"x".repeat(4094)}... (line truncated)`);
		expect(second).toBe("2: next");
		expect((await script({ path: f })).structuredContent).toBe(`${line}\nnext\n`);
	});

	test("the model's own call carries no script copy", async () => {
		const r = await run({ path: file("plain.txt", "a\nb\n") });
		expect(r.content[0].text).toBe("1: a\n2: b");
		expect("structuredContent" in r).toBe(false);
	});

	test("a 20 MB line: the model sees its start at once; a script is refused, saying why", async () => {
		const f = file("huge.json", JSON.stringify({ x: "a".repeat(20_000_000) }));
		let shown = "";
		const { took, worst } = await stallsDuring(async () => {
			shown = (await run({ path: f })).content[0].text;
		});
		expect(shown).toStartWith('1: {"x":"aaa');
		expect(shown).toEndWith("... (line truncated)");
		expect(took).toBeLessThan(3000);
		expect(worst).toBeLessThan(400);
		const refused = await script({ path: f });
		expect(refused.isError).toBe(true);
		expect(refused.content[0].text).toContain("line 1 alone is 19.1 MB");
	});

	test("a script range over the limit is refused with what to do instead; one line of it is not", async () => {
		const f = file("three.txt", ["a", "b", "c"].map((c) => c.repeat(2 << 20)).join("\n"));
		const refused = await script({ path: f });
		expect(refused.isError).toBe(true);
		expect(refused.content[0].text).toContain("lines 1-3 hold 6.0 MB (the longest, line 1, is 2.0 MB)");
		expect((await script({ path: f, read_range: [2, 2] })).structuredContent).toBe("b".repeat(2 << 20));
		expect((await run({ path: f })).isError).toBeUndefined();
	});

	test("exactly the limit is returned; one byte more is refused", async () => {
		const limit = 4 << 20;
		expect((await script({ path: file("at.txt", `${"z".repeat(limit - 1)}\n`) })).structuredContent).toHaveLength(limit);
		expect((await script({ path: file("over.txt", `${"z".repeat(limit)}\n`) })).isError).toBe(true);
	});

	test("the model sees whole lines up to 64 KB, contiguous, with where to continue", async () => {
		const f = file("wide.txt", Array.from({ length: 2000 }, (_, i) => `${i + 1} ${"w".repeat(300)}`).join("\n") + "\n");
		const lines: string[] = (await run({ path: f, read_range: [1, 2000] })).content[0].text.split("\n");
		const shown = lines.slice(0, -2);
		shown.forEach((line, i) => expect(line).toStartWith(`${i + 1}: ${i + 1} `));
		expect(Buffer.byteLength(shown.join("\n"))).toBeLessThanOrEqual(NORMAL_LIMITS.maxFileBytes);
		expect(lines.at(-1)).toBe(`(showing lines 1-${shown.length} of 2000. use read_range to see more.)`);
		expect((await script({ path: f, read_range: [1, 2000] })).structuredContent.split("\n")).toHaveLength(2001);
	});

	test("a binary file is refused; UTF-16 is decoded, an odd trailing byte dropped; UTF-32 is not mistaken for it", async () => {
		const bin = await run({ path: file("x.bin", Buffer.from([0x89, 0x50, 0, 0, 1, 0x0a])) });
		expect(bin.isError).toBe(true);
		expect(bin.content[0].text).toContain("binary file");
		const le = await run({ path: file("le.strings", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('"k" = "ü";\n', "utf16le")])) });
		expect(le.content[0].text).toBe('1: "k" = "ü";');
		const be = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(Buffer.from("hi\n", "utf16le")).swap16(), Buffer.from([0x00])]);
		expect((await run({ path: file("be.strings", be) })).content[0].text).toBe("1: hi");
		const utf32 = await run({ path: file("u32.txt", Buffer.from([0xff, 0xfe, 0, 0, 0x41, 0, 0, 0])) });
		expect(utf32.content[0].text).toContain("binary file");
	});

	test("line endings, a missing final newline, an empty file and a bad range come back exactly", async () => {
		expect((await script({ path: file("crlf.txt", "a\r\nb\r\n") })).structuredContent).toBe("a\r\nb\r\n");
		const open = await script({ path: file("open.txt", "a\nb"), read_range: [2, 2] });
		expect([open.content[0].text, open.structuredContent]).toEqual(["2: b", "b"]);
		expect((await run({ path: file("empty.txt", "") })).content[0].text).toBe("(empty file)");
		const past = await run({ path: file("short.txt", "one\n"), read_range: [5, 9] });
		expect(past.isError).toBe(true);
		expect(past.content[0].text).toContain("the file has only 1 line");
		expect((await run({ path: file("short.txt", "one\n"), read_range: [5, 2] })).content[0].text).toContain("is backwards");
	});
});
