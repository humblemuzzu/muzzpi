// bash `$ …` call header. guards: it was `cmd.split("\n")[0]` and renderCall
// never read context.expanded, so a multi-line command was unreachable.

import { describe, it, expect } from "bun:test";
import { createBashTool } from "./bash";

const tool: any = createBashTool();
const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };

function render(args: any, expanded = false): string {
	let out = "";
	tool.renderCall(args, theme, { lastComponent: { setText: (t: string) => (out = t) }, expanded });
	return out;
}

describe("bash call header", () => {
	const REPORTED = `cd "/Users/me/Documents/Code stuff"\nrg 'DATABASE_URL' --glob '*.ts'`;

	it("shows the command under the cd, not just the cd", () => {
		expect(render({ cmd: REPORTED, timeout: 120 })).toContain(`rg 'DATABASE_URL' --glob '*.ts'`);
	});

	it("still shows the timeout", () => {
		expect(render({ cmd: "ls", timeout: 120 })).toContain("(timeout 120s)");
	});

	it("stays one row for a one-line command", () => {
		expect(render({ cmd: "ls -la", timeout: 10 })).toBe("$ ls -la (timeout 10s)");
	});

	it("caps a long script and says how much it withheld", () => {
		const out = render({ cmd: "a\nb\nc\nd\ne", timeout: 10 });
		expect(out.split("\n")).toHaveLength(4);
		expect(out).toContain("… +2 more (ctrl+o)");
	});

	it("shows every line when expanded — regression for ctrl+o doing nothing", () => {
		const out = render({ cmd: "a\nb\nc\nd\ne", timeout: 10 }, true);
		expect(out.split("\n")).toEqual(["$ a (timeout 10s)", "  b", "  c", "  d", "  e"]);
	});

	it("indents continuation lines under the $", () => {
		expect(render({ cmd: "one\ntwo", timeout: 10 })).toBe("$ one (timeout 10s)\n  two");
	});

	it("emits no carriage return, which would smear the row", () => {
		expect(render({ cmd: "one\r\ntwo", timeout: 10 }, true)).toBe("$ one (timeout 10s)\n  two");
	});

	it("splits a lone CR too", () => {
		expect(render({ cmd: "one\rtwo", timeout: 10 }, true)).toContain("\n  two");
	});

	it("drops a trailing newline instead of showing a blank row", () => {
		expect(render({ cmd: "ls\n", timeout: 10 })).toBe("$ ls (timeout 10s)");
	});

	it("keeps blank lines inside the script", () => {
		expect(render({ cmd: "one\n\ntwo", timeout: 10 }, true)).toBe("$ one (timeout 10s)\n  \n  two");
	});

	const WRITE_THEN_RUN = "cat > f.ts <<'EOF'\nconst a = 1;\nconst b = 2;\nconsole.log(a + b);\nEOF\nbun f.ts";

	it("folds a heredoc body so the command after it stays in view", () => {
		expect(render({ cmd: WRITE_THEN_RUN, timeout: 10 }).split("\n")).toEqual([
			"$ cat > f.ts <<'EOF' (timeout 10s)",
			"  … 3 lines to EOF",
			"  bun f.ts",
		]);
	});

	it("shows the heredoc body when expanded", () => {
		expect(render({ cmd: WRITE_THEN_RUN, timeout: 10 }, true).split("\n")).toHaveLength(6);
	});

	it("folds an unterminated heredoc to the end, and leaves `<<` inside quotes alone", () => {
		expect(render({ cmd: "python3 - <<PY\nprint(1)\nprint(2)", timeout: 10 })).toBe("$ python3 - <<PY (timeout 10s)\n  … 2 lines to PY");
		expect(render({ cmd: "echo '<<EOF'\nls", timeout: 10 })).toBe("$ echo '<<EOF' (timeout 10s)\n  ls");
	});

	it("counts what is still hidden after folding", () => {
		const out = render({ cmd: `${WRITE_THEN_RUN}\necho one\necho two`, timeout: 10 });
		expect(out.split("\n")).toHaveLength(4);
		expect(out).toContain("… +2 more (ctrl+o)");
	});

	it("accepts `command` as well as `cmd`", () => {
		expect(render({ command: "ls -la", timeout: 10 })).toContain("$ ls -la");
	});

	it("survives a missing command", () => {
		expect(render({ timeout: 10 })).toContain("$ ...");
	});
});
