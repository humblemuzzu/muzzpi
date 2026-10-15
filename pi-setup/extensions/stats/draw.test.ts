import { expect, test } from "bun:test";
import { compact, fg, plain } from "./draw";
import { cleanText } from "./record";

test("compact never rounds into a four-digit unit", () => {
	expect([9999, 12_345, 99_949, 99_950, 999_499, 999_500, 1.5e9, 2.5e12].map(compact)).toEqual(["9,999", "12.3K", "99.9K", "100K", "999K", "1.0M", "1.5B", "2.5T"]);
});

test("plain keeps colour codes and drops every other escape or control character", () => {
	expect(plain(`${fg([1, 2, 3], "ok")}\n\x1b[2J\x1b]0;t\x07a\tb\x7f`)).toBe(`${fg([1, 2, 3], "ok")}a b`);
});

test("names from other tools become one printable line", () => {
	expect(cleanText("  Fix\n\tthe \x1b[31mlogin\x1b[0m bug\x07 ")).toBe("Fix the login bug");
	expect(cleanText("\n\x1b[2J")).toBeUndefined();
});
