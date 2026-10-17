import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clipboardImageModule, piPackageDir } from "./pi-package-dir";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakePi(): string {
	const pkg = realpathSync(mkdtempSync(join(tmpdir(), "pi-pkg-")));
	dirs.push(pkg);
	for (const file of ["docs/codemode.md", "dist/cli.js", "dist/utils/clipboard-image.js", "dist/bundle/cli.js", "dist/muzzpi-bundle/cli.js"]) {
		mkdirSync(join(pkg, file, ".."), { recursive: true });
		writeFileSync(join(pkg, file), "");
	}
	writeFileSync(join(pkg, "dist/utils/clipboard-image.js"), "export async function readClipboardImage(options) {}\n");
	return pkg;
}

describe("piPackageDir", () => {
	test("finds the package from the modular CLI, pi's bundle and ours", () => {
		const pkg = fakePi();
		for (const entry of ["dist/cli.js", "dist/bundle/cli.js", "dist/muzzpi-bundle/cli.js"]) {
			expect(piPackageDir(join(pkg, entry))).toBe(pkg);
		}
	});

	test("follows the bin symlink", () => {
		const pkg = fakePi();
		const bin = join(pkg, "pi");
		symlinkSync(join(pkg, "dist", "muzzpi-bundle", "cli.js"), bin);
		expect(piPackageDir(bin)).toBe(pkg);
	});

	test("is undefined outside a pi package", () => {
		const dir = mkdtempSync(join(tmpdir(), "not-pi-"));
		dirs.push(dir);
		writeFileSync(join(dir, "cli.js"), "");
		expect(piPackageDir(join(dir, "cli.js"))).toBeUndefined();
		expect(piPackageDir(undefined)).toBeUndefined();
	});
});

describe("clipboardImageModule", () => {
	test("is pi's dist/utils file whichever entrypoint runs", () => {
		const pkg = fakePi();
		expect(clipboardImageModule(piPackageDir(join(pkg, "dist", "muzzpi-bundle", "cli.js")))).toBe(
			join(pkg, "dist", "utils", "clipboard-image.js"),
		);
	});

	test("is undefined when pi no longer ships it, so pi's own paste handler stays", () => {
		const pkg = fakePi();
		rmSync(join(pkg, "dist", "utils"), { recursive: true });
		expect(clipboardImageModule(pkg)).toBeUndefined();
	});

	test("is undefined when the file no longer exports readClipboardImage", () => {
		const pkg = fakePi();
		writeFileSync(join(pkg, "dist/utils/clipboard-image.js"), "export async function readClipboardImageV2() {}\n");
		expect(clipboardImageModule(pkg)).toBeUndefined();
	});

	test("the installed pi has it and it exports readClipboardImage", async () => {
		const pkg = piPackageDir(Bun.which("pi") ?? undefined);
		if (!pkg) return;
		const file = clipboardImageModule(pkg);
		expect(file).toBeDefined();
		expect(typeof (await import(file!)).readClipboardImage).toBe("function");
	});
});
