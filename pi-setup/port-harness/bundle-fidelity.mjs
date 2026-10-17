#!/usr/bin/env node
// Is build-pi-bundle.mjs still pi's recipe? Installs stock pi <version> in a temp
// prefix, runs our builder on it, and compares the result with the bundle pi shipped.
//
//   node pi-setup/port-harness/bundle-fidelity.mjs [version]   (default: the installed pi)
//
// Chunk names hash file paths, which differ between pi's monorepo and an npm install,
// so names are normalised first. A file that still differs usually carries a newer
// dependency npm resolved; the report shows how much of it is renamed identifiers.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const builder = join(dirname(fileURLToPath(import.meta.url)), "..", "pi-bundle", "build-pi-bundle.mjs");

function installedVersion() {
	const which = spawnSync("sh", ["-c", "command -v pi"], { encoding: "utf8" }).stdout.trim();
	let dir = dirname(realpathSync(which));
	while (dir !== dirname(dir)) {
		try {
			const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
			if (pkg.name === PI_PACKAGE) return pkg.version;
		} catch {}
		dir = dirname(dir);
	}
	throw new Error("cannot find the installed pi's version; pass one");
}

function files(dir, prefix = "") {
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) out.push(...files(join(dir, entry.name), rel));
		else if (!entry.name.startsWith(".")) out.push(rel);
	}
	return out;
}

const unhash = (text) => text.replace(/-[A-Z0-9]{8}\.js/g, "-H.js");
const renamesOnly = (text) => unhash(text).replace(/([A-Za-z_$])\d+\b/g, "$1");
const md5 = (text) => createHash("md5").update(text).digest("hex");

function load(dir) {
	return files(dir).map((rel) => {
		const text = readFileSync(join(dir, rel), "utf8");
		return { rel, stem: unhash(rel), text: unhash(text), bytes: Buffer.byteLength(text) };
	});
}

const version = process.argv[2] ?? installedVersion();
const prefix = mkdtempSync(join(tmpdir(), "pi-fidelity-"));
try {
	console.log(`installing stock pi ${version} into ${prefix} ...`);
	const npm = spawnSync("npm", ["install", "-g", "--prefix", prefix, "--ignore-scripts", "--silent", `${PI_PACKAGE}@${version}`], {
		cwd: prefix,
		stdio: ["ignore", "inherit", "inherit"],
	});
	if (npm.status !== 0) throw new Error(`npm install failed (exit ${npm.status})`);
	const pkg = join(prefix, "lib", "node_modules", PI_PACKAGE);

	const build = spawnSync(process.execPath, [builder, "--pkg", pkg, "--out", "fidelity", "--no-smoke"], { stdio: "inherit" });
	if (build.status !== 0) throw new Error(`build-pi-bundle.mjs failed (exit ${build.status})`);

	const official = load(join(pkg, "dist", "bundle"));
	const ours = load(join(pkg, "dist", "fidelity"));
	const stems = (list) => list.map((f) => f.stem).sort().join("\n");
	if (stems(official) !== stems(ours)) {
		const a = new Set(official.map((f) => f.stem));
		const b = new Set(ours.map((f) => f.stem));
		console.log(`DIFFERENT FILE SETS\n  only pi's: ${[...a].filter((s) => !b.has(s)).join(", ") || "-"}\n  only ours: ${[...b].filter((s) => !a.has(s)).join(", ") || "-"}`);
		process.exitCode = 1;
	}

	const pool = new Map();
	for (const f of ours) pool.set(md5(f.text), f);
	const unmatchedOfficial = official.filter((f) => !pool.delete(md5(f.text)));
	const unmatchedOurs = [...pool.values()];
	console.log(`\n${official.length - unmatchedOfficial.length} of ${official.length} files byte-identical to pi's own bundle (hash names normalised)`);

	const byStem = (list, stem) => list.filter((f) => f.stem === stem).sort((x, y) => x.bytes - y.bytes);
	for (const stem of [...new Set(unmatchedOfficial.map((f) => f.stem))]) {
		const a = byStem(unmatchedOfficial, stem);
		const b = byStem(unmatchedOurs, stem);
		a.forEach((x, i) => {
			const y = b[i];
			if (!y) return console.log(`  ${stem}: no counterpart in ours`);
			const lines = (t) => renamesOnly(t).split(/[;,]/);
			const ys = new Set(lines(y.text));
			const real = lines(x.text).filter((l) => !ys.has(l)).length;
			console.log(`  ${stem}: ${x.bytes} → ${y.bytes} bytes; ${real === 0 ? "renamed identifiers only" : `${real} statement(s) differ beyond renames`}`);
		});
	}
	if (unmatchedOfficial.length > 0) {
		console.log("\nDependencies npm resolved differently from pi's lockfile (each differing file should trace to one):");
		const response = await fetch(`https://raw.githubusercontent.com/earendil-works/pi/v${version}/package-lock.json`);
		const locked = response.ok ? Object.entries(JSON.parse(await response.text()).packages ?? {}) : [];
		const nested = join(pkg, "node_modules");
		let differing = 0;
		for (const name of files(nested).filter((f) => f.endsWith("/package.json") && f.split("/").length === (f.startsWith("@") ? 3 : 2))) {
			const dep = name.slice(0, -"/package.json".length);
			const ours = JSON.parse(readFileSync(join(nested, name), "utf8")).version;
			const theirs = [...new Set(locked.filter(([k]) => k.endsWith(`node_modules/${dep}`)).map(([, v]) => v.version).filter(Boolean))];
			if (theirs.length > 0 && !theirs.includes(ours)) {
				differing++;
				console.log(`  ${dep}: pi's lockfile ${theirs.join(" ")}, npm installed ${ours}`);
			}
		}
		if (!response.ok) console.log(`  (could not fetch pi's lockfile: ${response.status})`);
		else if (differing === 0) console.log("  none: the differences are not dependency drift, so read them");
	}
} finally {
	rmSync(prefix, { recursive: true, force: true });
}
