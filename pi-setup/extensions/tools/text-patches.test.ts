/**
 * pi-core-patches/text-patches.mjs edits a pi file only when it is the stock copy the edit was made on, and the
 * installed pi carries every edit. The tool-row patch drops what a finished tool row never draws: pinned here by
 * reading what pi's ToolExecutionComponent takes from its result.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "..", "pi-core-patches", "text-patches.mjs");
const { PATCHES, inspect, patched } = await import(SCRIPT);
const PI_PKG = realpathSync(join(import.meta.dir, "node_modules", "@earendil-works", "pi-coding-agent"));
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** a pi package holding one stock file for `patch` */
function fakePi(text: string) {
	const pkg = realpathSync(mkdtempSync(join(tmpdir(), "text-patches-")));
	dirs.push(pkg);
	writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "1.0.0" }));
	mkdirSync(join(pkg, "dist"), { recursive: true });
	writeFileSync(join(pkg, "dist", "x.js"), text);
	return pkg;
}

const STOCK = "const a = 1;\nconst b = 2;\n";
const PATCH = {
	id: "t",
	package: "@earendil-works/pi-coding-agent",
	file: "dist/x.js",
	stock: sha256(STOCK),
	edits: [["const b = 2;", "const b = 3; // LOCAL PATCH (muzzpi)"]],
};

describe("text patches", () => {
	test("every patch is applied to the installed pi, and each edit matches its stock file exactly once", () => {
		for (const patch of PATCHES) {
			const found = inspect(patch, PI_PKG);
			expect(`${patch.id} ${patch.file}: ${found.state}`).toBe(`${patch.id} ${patch.file}: applied`);
			const stock = readFileSync(`${found.file}.stock`, "utf8");
			expect(sha256(stock)).toBe(patch.stock);
			expect(patched(patch, stock)).toBe(readFileSync(found.file, "utf8"));
		}
	});

	test("a stock file is patched once, a patched one is left alone, a changed one is refused", () => {
		const pkg = fakePi(STOCK);
		expect(inspect(PATCH, pkg).state).toBe("stock");
		expect(patched(PATCH, STOCK)).toBe("const a = 1;\nconst b = 3; // LOCAL PATCH (muzzpi)\n");
		writeFileSync(join(pkg, "dist", "x.js"), patched(PATCH, STOCK));
		writeFileSync(join(pkg, "dist", "x.js.stock"), STOCK);
		expect(inspect(PATCH, pkg).state).toBe("applied");
		writeFileSync(join(pkg, "dist", "x.js"), "const a = 1;\nconst b = 2;\nconst c = 3;\n");
		expect(inspect(PATCH, pkg)).toMatchObject({ state: "drift", detail: "neither the stock file nor this patch's result" });
		const updated = fakePi("const a = 1;\nconst b = 2;\nconst c = 3;\n");
		expect(inspect(PATCH, updated).state).toBe("drift");
		expect(inspect(PATCH, updated).detail).toContain("not the stock file");
	});

	test("an edit whose text appears twice is refused rather than guessed", () => {
		const twice = "const b = 2;\nconst b = 2;\n";
		expect(patched({ ...PATCH, stock: sha256(twice) }, twice)).toBeUndefined();
		expect(inspect({ ...PATCH, stock: sha256(twice) }, fakePi(twice)).state).toBe("drift");
	});

	test("a dependency at another version than the patch was made on is refused", () => {
		const pkg = fakePi(STOCK);
		mkdirSync(join(pkg, "node_modules", "marked"), { recursive: true });
		writeFileSync(join(pkg, "node_modules", "marked", "package.json"), JSON.stringify({ version: "99.0.0" }));
		const found = inspect({ ...PATCH, requires: { marked: "18.0.11" } }, pkg);
		expect(found.state).toBe("drift");
		expect(found.detail).toContain("marked 18.0.11");
	});

	test("the CLI applies, checks and reverts the real patches on a copy of pi's stock files", () => {
		const pkg = realpathSync(mkdtempSync(join(tmpdir(), "text-patches-cli-")));
		dirs.push(pkg);
		writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "1.5.0" }));
		for (const patch of PATCHES) {
			const found = inspect(patch, PI_PKG);
			const rel = patch.package === "@earendil-works/pi-coding-agent" ? patch.file : join("node_modules", patch.package, patch.file);
			mkdirSync(join(pkg, rel, ".."), { recursive: true });
			writeFileSync(join(pkg, rel), readFileSync(`${found.file}.stock`));
			if (patch.package !== "@earendil-works/pi-coding-agent") {
				writeFileSync(join(pkg, "node_modules", patch.package, "package.json"), "{}");
			}
			for (const [dep, version] of Object.entries(patch.requires ?? {})) {
				mkdirSync(join(pkg, "node_modules", dep), { recursive: true });
				writeFileSync(join(pkg, "node_modules", dep, "package.json"), JSON.stringify({ version }));
			}
		}
		const run = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, "--pkg", pkg, ...args], { encoding: "utf8" });
		expect(run("--check").status).toBe(1);
		expect(run().status).toBe(0);
		expect(run("--check").status).toBe(0);
		expect(run().stdout).not.toContain("patched ");
		expect(run("--revert").status).toBe(0);
		for (const patch of PATCHES) {
			const rel = patch.package === "@earendil-works/pi-coding-agent" ? patch.file : join("node_modules", patch.package, patch.file);
			expect(sha256(readFileSync(join(pkg, rel), "utf8"))).toBe(patch.stock);
			expect(existsSync(join(pkg, `${rel}.stock`))).toBe(true);
		}
	});
});

describe("tool-row-result: a finished tool row draws only content, details, isError and durationMs", () => {
	const source = readFileSync(join(PI_PKG, "dist", "modes", "interactive", "components", "tool-execution.js"), "utf8");

	test("renderers are handed content and details only", () => {
		expect(source).toContain("resultRenderer({ content: this.result.content, details: this.result.details }");
	});

	test("the component reads no other field of its result", () => {
		const fields = new Set([...source.matchAll(/this\.result\??\.(\w+)/g)].map((m) => m[1]));
		expect([...fields].sort()).toEqual(["content", "details", "durationMs", "isError"]);
		expect(source).toMatch(/getRenderedTextOutput\(this\.result, this\.showImages\)/);
		const renderUtils = readFileSync(join(PI_PKG, "dist", "core", "tools", "render-utils.js"), "utf8");
		const getTextOutput = renderUtils.slice(renderUtils.indexOf("export function getTextOutput"), renderUtils.indexOf("\n}\n", renderUtils.indexOf("export function getTextOutput")));
		expect([...new Set([...getTextOutput.matchAll(/result\.(\w+)/g)].map((m) => m[1]))]).toEqual(["content"]);
	});
});
