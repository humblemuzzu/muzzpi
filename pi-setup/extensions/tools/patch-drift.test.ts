import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PI_SETUP = join(import.meta.dir, "..", "..");
const PATCHES = join(PI_SETUP, "pi-core-patches");
/** [dist path, patch file] for every entry of patches.sh, read from it so the two cannot drift */
const FILES = spawnSync("bash", ["-c", `source '${join(PATCHES, "patches.sh")}' && for e in "\${PI_CORE_PATCHES[@]}"; do echo "$(patch_dist_path "$e") $(patch_source "$e")"; done`], { encoding: "utf8" })
	.stdout.trim().split("\n").map((line) => line.split(" ") as [dist: string, patch: string]);

test("patches.sh lists its patches and each patch file exists", () => {
	expect(FILES.length).toBeGreaterThanOrEqual(6);
	for (const [dist, patch] of FILES) {
		expect(dist).toEndWith(".js");
		expect(existsSync(join(PATCHES, patch))).toBe(true);
	}
});
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "patch-drift-")));
	dirs.push(dir);
	return dir;
}

function put(file: string, text: string, mode = 0o644) {
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, text, { mode });
}

/** an `npm` whose `pack` drops a tarball of pi's stock files, or fails when there is none */
function stubNpm(root: string, stock: Record<string, string> | null): string {
	const bin = join(root, "stub-bin");
	const tgz = join(root, "pi.tgz");
	if (stock) {
		for (const [file, text] of Object.entries(stock)) put(join(root, "tarball", "package", "dist", file), text);
		spawnSync("tar", ["-czf", tgz, "-C", join(root, "tarball"), "package"]);
	}
	put(join(bin, "npm"), `#!/bin/sh\n[ "$1" = pack ] && [ -f '${tgz}' ] && cp '${tgz}' ./pi-1.0.0.tgz && exit 0\nexit 1\n`, 0o755);
	return bin;
}

const stockOf = () => Object.fromEntries(FILES.map(([dist]) => [dist, `stock ${dist}\n`]));

function drift(dist: string, bin: string) {
	const run = spawnSync("bash", ["-c", `source '${join(PATCHES, "patches.sh")}' && pi_patch_drift "$1" 1.3.0`, "_", dist], {
		env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
		encoding: "utf8",
	});
	return { status: run.status, files: run.stdout.split("\n").filter(Boolean) };
}

describe("pi_patch_drift", () => {
	function setup(change?: (dist: string) => void, stock: Record<string, string> | null = stockOf()) {
		const root = scratch();
		const dist = join(root, "dist");
		for (const [file, text] of Object.entries(stockOf())) put(join(dist, file), text);
		change?.(dist);
		return drift(dist, stubNpm(root, stock));
	}

	test("stock files that match the base version fit", () => {
		expect(setup()).toEqual({ status: 0, files: [] });
	});

	test("a file that is already our patch fits, with or without its .stock copy", () => {
		const result = setup((dist) => {
			copyFileSync(join(PATCHES, "keybindings.js"), join(dist, "core/keybindings.js"));
			copyFileSync(join(dist, "core/resource-loader.js"), join(dist, "core/resource-loader.js.stock"));
			copyFileSync(join(PATCHES, "resource-loader.js"), join(dist, "core/resource-loader.js"));
		});
		expect(result).toEqual({ status: 0, files: [] });
	});

	test("a stock file pi changed is named", () => {
		expect(setup((dist) => put(join(dist, "core/keybindings.js"), "pi 9 changed this\n")).files).toEqual(["core/keybindings.js"]);
	});

	test("the .stock copy is what is compared, not the patched file", () => {
		const result = setup((dist) => {
			put(join(dist, "extensions/mcp/index.js.stock"), "an older pi's stock\n");
			copyFileSync(join(PATCHES, "mcp-index.js"), join(dist, "extensions/mcp/index.js"));
		});
		expect(result.files).toEqual(["extensions/mcp/index.js"]);
	});

	test("a file the base version's tarball lacks counts as changed", () => {
		const stock = stockOf();
		delete stock["core/keybindings.js"];
		expect(setup(undefined, stock).files).toEqual(["core/keybindings.js"]);
	});

	test("no tarball (offline, unknown version) is exit 2 with nothing listed", () => {
		expect(setup(undefined, null)).toEqual({ status: 2, files: [] });
	});
});

describe("install.sh on a pi other than base-version", () => {
	function installDryRun(changed: boolean) {
		const root = scratch();
		const pkg = join(root, "prefix", "lib", "node_modules", "@earendil-works", "pi-coding-agent");
		put(join(pkg, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "9.9.9" }));
		put(join(pkg, "dist", "cli.js"), "#!/usr/bin/env node\nconsole.log('9.9.9');\n", 0o755);
		for (const [file, text] of Object.entries(stockOf())) put(join(pkg, "dist", file), text);
		if (changed) put(join(pkg, "dist", "core/resource-loader.js"), "pi 9 changed this\n");
		mkdirSync(join(root, "prefix", "bin"));
		symlinkSync(join(pkg, "dist", "cli.js"), join(root, "prefix", "bin", "pi"));
		const home = join(root, "home");
		mkdirSync(home);
		const run = spawnSync("bash", [join(PI_SETUP, "install.sh"), "--dry-run"], {
			env: { ...process.env, HOME: home, PATH: `${stubNpm(root, stockOf())}:${join(root, "prefix", "bin")}:${process.env.PATH}` },
			encoding: "utf8",
		});
		const out = `${run.stdout}${run.stderr}`.replace(/\x1b\[[0-9;]*m/g, "");
		return { status: run.status, out, home, prefix: join(root, "prefix") };
	}
	const base = readFileSync(join(PATCHES, "base-version"), "utf8").trim();

	test("stops before writing anything and prints the one command that fixes it", () => {
		const { status, out, home, prefix } = installDryRun(true);
		expect(status).toBe(1);
		expect(out).toContain("pi 9.9.9 changed files the patches replace: core/resource-loader.js. Nothing was changed.");
		expect(out).toContain(`npm install -g --prefix '${prefix}' @earendil-works/pi-coding-agent@${base}`);
		expect(out).not.toContain("Creating directories");
		expect(existsSync(join(home, ".pi"))).toBe(false);
	}, 60_000);

	test("goes on when that pi left the patched files alone", () => {
		const { out, home } = installDryRun(false);
		expect(out).toContain("the patches fit pi 9.9.9");
		expect(out).toContain("Creating directories");
		expect(existsSync(join(home, ".pi"))).toBe(false);
	}, 120_000);
});
