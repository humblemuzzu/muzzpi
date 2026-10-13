#!/usr/bin/env bun
// Bundles every extension in extensions/ into <out>: a directory becomes
// <name>/index.js, a single file <name>.js. pi loads one prebuilt file per
// extension instead of resolving each TypeScript import through jiti.
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const SRC = join(import.meta.dir, "extensions");
const OUT = process.argv[2];
if (!OUT) {
	console.error("usage: bun build-extensions.ts <out-dir>");
	process.exit(2);
}

const SKIP = new Set(["node_modules", "package-lock.json", "tsconfig.json"]);
// pi supplies these at load time. A plugin resolves them before tsconfig paths
// (stats/tsconfig.json maps them to files), which would inline a second pi.
const piPackages: import("bun").BunPlugin = {
	name: "pi-packages",
	setup(build) {
		build.onResolve({ filter: /^(@mariozechner|@earendil-works)\/|^typebox(\/|$)|^@sinclair\/typebox/ }, (args) => ({
			path: args.path,
			external: true,
		}));
	},
};

async function bundle(entry: string, outFile: string): Promise<void> {
	const result = await Bun.build({ entrypoints: [entry], target: "node", format: "esm", packages: "external", plugins: [piPackages] });
	if (!result.success) throw new AggregateError(result.logs, `bundle failed: ${entry}`);
	mkdirSync(dirname(outFile), { recursive: true });
	writeFileSync(outFile, await result.outputs[0]!.text());
}

const built: string[] = [];
for (const name of readdirSync(SRC).sort()) {
	const path = join(SRC, name);
	if (statSync(path).isDirectory()) {
		if (!existsSync(join(path, "index.ts"))) continue;
		await bundle(join(path, "index.ts"), join(OUT, name, "index.js"));
		for (const file of readdirSync(path)) {
			if (SKIP.has(file) || file.endsWith(".ts") || statSync(join(path, file)).isDirectory()) continue;
			copyFileSync(join(path, file), join(OUT, name, file));
		}
		built.push(name);
	} else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
		await bundle(path, join(OUT, name.replace(/\.ts$/, ".js")));
		built.push(name.replace(/\.ts$/, ".js"));
	}
}
console.log(built.join("\n"));
