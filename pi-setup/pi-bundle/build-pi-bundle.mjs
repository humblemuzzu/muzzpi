#!/usr/bin/env node
// Builds pi's bundled runtime from the installed, already-patched dist/ files:
// pi's own scripts/build-coding-agent-bundle.mjs (at UPSTREAM.tag), pointed at
// an npm install instead of the monorepo.
//
//   node pi-setup/pi-bundle/build-pi-bundle.mjs --pkg <pi package dir> [--link <pi bin>]
//   node pi-setup/pi-bundle/build-pi-bundle.mjs --pkg <pi package dir> --check
//
// Exit codes: 0 ok · 1 build, smoke test or check failed · 2 usage · 3 pi's recipe
// changed or could not be confirmed (re-derive this file from the new recipe).

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const UPSTREAM = {
	tag: "v1.3.0",
	recipe: "scripts/build-coding-agent-bundle.mjs",
	recipeSha256: "bb8134c84faa8b0e7d9f7af9e127b33dc09c79243ecee666e526ff43961f2335",
	esbuild: "0.28.2",
};
const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const STAMP = ".muzzpi-build.json";
const SCRIPT = fileURLToPath(import.meta.url);
const HERE = dirname(SCRIPT);

class Refusal extends Error {
	constructor(message, code = 1) {
		super(message);
		this.code = code;
	}
}

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

function processAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error.code === "EPERM";
	}
}

function parseArgs(argv) {
	const opts = { pkg: process.env.PI_PKG_DIR, out: "muzzpi-bundle", link: undefined, check: false, smoke: true };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const value = () => {
			if (i + 1 >= argv.length) throw new Refusal(`${arg} needs a value`, 2);
			return argv[++i];
		};
		if (arg === "--pkg") opts.pkg = value();
		else if (arg === "--out") opts.out = value();
		else if (arg === "--link") opts.link = value();
		else if (arg === "--check") opts.check = true;
		else if (arg === "--no-smoke") opts.smoke = false;
		else throw new Refusal(`unknown argument: ${arg}`, 2);
	}
	if (!opts.pkg) throw new Refusal("--pkg <pi package dir> is required (or set PI_PKG_DIR)", 2);
	if (!/^[a-z][\w-]*$/.test(opts.out) || opts.out === "bundle") throw new Refusal(`--out must be a plain directory name other than "bundle"`, 2);
	try {
		opts.pkg = realpathSync(resolve(opts.pkg));
	} catch {
		throw new Refusal(`${opts.pkg} does not exist`, 2);
	}
	return opts;
}

function readPackage(pkg) {
	const file = join(pkg, "package.json");
	let json;
	try {
		json = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		throw new Refusal(`cannot read ${file}: ${error.message}`, 2);
	}
	if (json.name !== PI_PACKAGE) throw new Refusal(`${pkg} is ${json.name}, not ${PI_PACKAGE}`, 2);
	return json;
}

async function fetchText(url) {
	const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
	if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`);
	return response.text();
}

// This file mirrors the recipe at UPSTREAM.tag; any other pi version must ship the same recipe and esbuild.
async function confirmRecipe(version) {
	const tag = `v${version}`;
	if (tag === UPSTREAM.tag) return `${tag} (the version this builder was derived from)`;
	const base = `https://raw.githubusercontent.com/earendil-works/pi/${tag}/`;
	let recipe;
	let rootPackage;
	try {
		[recipe, rootPackage] = await Promise.all([fetchText(base + UPSTREAM.recipe), fetchText(`${base}package.json`)]);
	} catch (error) {
		throw new Refusal(`cannot confirm pi's bundle recipe for ${tag} is unchanged since ${UPSTREAM.tag}: ${error.message}`, 3);
	}
	const root = JSON.parse(rootPackage);
	const esbuild = root.devDependencies?.esbuild ?? root.dependencies?.esbuild;
	const changed = [];
	if (sha256(recipe) !== UPSTREAM.recipeSha256) changed.push(UPSTREAM.recipe);
	if (esbuild !== UPSTREAM.esbuild) changed.push(`esbuild ${UPSTREAM.esbuild} → ${esbuild}`);
	if (changed.length > 0) {
		throw new Refusal(
			`pi's bundle recipe changed between ${UPSTREAM.tag} and ${tag} (${changed.join(", ")}). ` +
				`Re-derive ${relative(process.cwd(), SCRIPT)} from https://github.com/earendil-works/pi/compare/${UPSTREAM.tag}...${tag}, then update UPSTREAM.`,
			3,
		);
	}
	return `${tag} (recipe and esbuild identical to ${UPSTREAM.tag})`;
}

// By path, never by lookup: resolving "esbuild" walks up to any ~/node_modules copy.
function loadEsbuild() {
	const dir = join(HERE, "node_modules", "esbuild");
	const installedVersion = () => {
		try {
			return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version;
		} catch {
			return undefined;
		}
	};
	if (installedVersion() !== UPSTREAM.esbuild) {
		const npm = spawnSync("npm", ["install", "--no-package-lock", "--no-audit", "--no-fund", "--ignore-scripts", "--silent"], {
			cwd: HERE,
			stdio: "inherit",
		});
		if (npm.status !== 0) throw new Refusal(`npm install in ${HERE} failed (exit ${npm.status})`);
	}
	const found = installedVersion();
	if (found !== UPSTREAM.esbuild) throw new Refusal(`need esbuild ${UPSTREAM.esbuild} in ${HERE}/node_modules, found ${found ?? "none"}`);
	const esbuild = createRequire(join(HERE, "package.json"))(dir);
	if (esbuild.version !== UPSTREAM.esbuild) throw new Refusal(`esbuild binary is ${esbuild.version}, package is ${UPSTREAM.esbuild}`);
	return esbuild;
}

// ── pi's recipe ──────────────────────────────────────────────────────────────
// Kept in upstream's order and with every check upstream makes. Differences:
// paths point at an npm install, OAuth flows are read from pi-ai's compiled
// load.js (the package ships no src/), and output goes to `bundleDir`.

const banner = {
	js: 'import { createRequire as __piCreateRequire } from "node:module"; const require = __piCreateRequire(import.meta.url);',
};
const allowedExternalPackages = new Set(["@silvia-odwyer/photon-node", "jiti", "bufferutil", "utf-8-validate", "kerberos", "supports-color"]);

const lazyJitiPlugin = {
	name: "lazy-jiti-transform",
	setup(build) {
		build.onResolve({ filter: /^jiti\/static$/ }, () => ({ namespace: "lazy-jiti", path: "jiti/static" }));
		build.onLoad({ filter: /.*/, namespace: "lazy-jiti" }, () => ({
			contents: `
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let createJitiImpl;

export function createJiti(...args) {
	createJitiImpl ??= require("jiti").createJiti;
	return createJitiImpl(...args);
}
`,
			loader: "js",
		}));
	},
};

function httpsProxyAgentNamedExportPlugin(repoRoot) {
	return {
		name: "https-proxy-agent-named-export",
		setup(build) {
			build.onResolve({ filter: /^https-proxy-agent$/ }, (args) => {
				if (args.kind !== "dynamic-import") return undefined;
				return { namespace: "https-proxy-agent-named-export", path: args.path };
			});
			build.onLoad({ filter: /^https-proxy-agent$/, namespace: "https-proxy-agent-named-export" }, () => ({
				contents: 'export { HttpsProxyAgent } from "https-proxy-agent";',
				loader: "js",
				resolveDir: repoRoot,
			}));
		},
	};
}

// npm -g nests pi's dependencies; a local npm, bun or pnpm install hoists or links them.
// Walked by hand: pi-ai exports only an `import` entry, which require.resolve refuses.
function dependencyDir(repoRoot, name) {
	for (let dir = repoRoot; dir !== dirname(dir); dir = dirname(dir)) {
		const candidate = join(dir, "node_modules", name);
		if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
	}
	throw new Refusal(`cannot find ${name} in any node_modules above ${repoRoot}`);
}

async function runRecipe(esbuild, repoRoot, bundleDir) {
	const { build } = esbuild;
	const codingAgentDistDir = join(repoRoot, "dist");
	const aiDistDir = join(dependencyDir(repoRoot, "@earendil-works/pi-ai"), "dist");
	const commonBuildOptions = () => ({
		absWorkingDir: repoRoot,
		banner,
		bundle: true,
		define: { PI_BUNDLED_NODE: "true" },
		external: ["@silvia-odwyer/photon-node"],
		format: "esm",
		legalComments: "none",
		logLevel: "warning",
		metafile: true,
		minifySyntax: true,
		minifyWhitespace: true,
		platform: "node",
		plugins: [lazyJitiPlugin, httpsProxyAgentNamedExportPlugin(repoRoot)],
		sourcemap: false,
		target: "node22.19",
		tsconfigRaw: { compilerOptions: {} },
	});
	const findContainingOutput = (metafile, inputPath) => {
		const want = relative(repoRoot, inputPath).replaceAll("\\", "/");
		for (const [outputPath, output] of Object.entries(metafile.outputs)) {
			if (Object.keys(output.inputs).some((p) => p.replaceAll("\\", "/") === want)) return resolve(repoRoot, outputPath);
		}
		throw new Refusal(`could not locate bundled output containing ${want}`);
	};

	for (const entry of [
		join(codingAgentDistDir, "cli.js"),
		join(codingAgentDistDir, "index.js"),
		join(codingAgentDistDir, "rpc-entry.js"),
		join(codingAgentDistDir, "utils", "image-resize-worker.js"),
		join(codingAgentDistDir, "extensions", "codemode", "worker.js"),
		join(aiDistDir, "api", "bedrock-converse-stream.js"),
		join(aiDistDir, "auth", "oauth", "anthropic.js"),
	]) {
		if (!existsSync(entry)) throw new Refusal(`bundle input is missing: ${relative(repoRoot, entry)}`);
	}

	rmSync(bundleDir, { force: true, recursive: true });
	mkdirSync(bundleDir, { recursive: true });

	const mainResult = await build({
		...commonBuildOptions(),
		entryNames: "[name]",
		entryPoints: {
			"cli-runtime": join(codingAgentDistDir, "cli.js"),
			index: join(codingAgentDistDir, "index.js"),
			"rpc-entry": join(codingAgentDistDir, "rpc-entry.js"),
		},
		outdir: bundleDir,
		chunkNames: "chunks/[name]-[hash]",
		splitting: true,
	});

	const bedrockLoaderOutput = findContainingOutput(mainResult.metafile, join(aiDistDir, "api", "bedrock-converse-stream.lazy.js"));
	const oauthLoaderOutput = findContainingOutput(mainResult.metafile, join(aiDistDir, "auth", "oauth", "load.js"));
	const imageResizeOutput = findContainingOutput(mainResult.metafile, join(codingAgentDistDir, "utils", "image-resize.js"));
	const configOutput = findContainingOutput(mainResult.metafile, join(codingAgentDistDir, "config.js"));
	if (dirname(bedrockLoaderOutput) !== dirname(oauthLoaderOutput)) {
		throw new Refusal("Bedrock and OAuth lazy loaders were emitted into different directories");
	}

	const lazyEntryPoints = {
		anthropic: join(aiDistDir, "auth", "oauth", "anthropic.js"),
		"bedrock-converse-stream": join(aiDistDir, "api", "bedrock-converse-stream.js"),
		"github-copilot": join(aiDistDir, "auth", "oauth", "github-copilot.js"),
		"image-resize-worker": join(codingAgentDistDir, "utils", "image-resize-worker.js"),
		"kimi-coding": join(aiDistDir, "auth", "oauth", "kimi-coding.js"),
		meta: join(aiDistDir, "auth", "oauth", "meta.js"),
		"openai-chatgpt": join(aiDistDir, "auth", "oauth", "openai-chatgpt.js"),
		"openai-codex": join(aiDistDir, "auth", "oauth", "openai-codex.js"),
		openrouter: join(aiDistDir, "auth", "oauth", "openrouter.js"),
		radius: join(aiDistDir, "auth", "oauth", "radius.js"),
		xai: join(aiDistDir, "auth", "oauth", "xai.js"),
	};

	const oauthLoadSource = readFileSync(join(aiDistDir, "auth", "oauth", "load.js"), "utf8");
	let oauthFlows = 0;
	for (const match of oauthLoadSource.matchAll(/importOAuthModule\("\.\/([^"]+)\.ts"\)/g)) {
		oauthFlows++;
		if (!(match[1] in lazyEntryPoints)) throw new Refusal(`OAuth flow "${match[1]}" is lazily imported but has no lazy bundle entry`);
	}
	if (oauthFlows === 0) throw new Refusal("found no importOAuthModule() calls in pi-ai's oauth/load.js: pi changed how it loads OAuth flows");

	const lazyResult = await build({
		...commonBuildOptions(),
		entryNames: "[name]",
		entryPoints: lazyEntryPoints,
		outdir: dirname(bedrockLoaderOutput),
		splitting: false,
	});

	const codemodeWorkerResult = await build({
		...commonBuildOptions(),
		banner: undefined,
		entryNames: "[name]",
		entryPoints: { "codemode-worker": join(codingAgentDistDir, "extensions", "codemode", "worker.js") },
		outdir: dirname(bedrockLoaderOutput),
		splitting: false,
	});
	for (const [outputPath, output] of Object.entries(codemodeWorkerResult.metafile.outputs)) {
		const invalid = output.imports.filter((imported) => imported.kind !== "import-statement" || !isBuiltin(imported.path));
		if (invalid.length > 0) {
			throw new Refusal(`codemode worker must only import Node builtins: ${invalid.map((imported) => imported.path).join(", ")}`);
		}
		if (readFileSync(resolve(repoRoot, outputPath), "utf8").includes("import.meta")) throw new Refusal("codemode worker must not use import.meta");
	}

	const imageResizeWorkerOutput = resolve(dirname(bedrockLoaderOutput), "image-resize-worker.js");
	if (dirname(imageResizeOutput) !== dirname(imageResizeWorkerOutput)) {
		throw new Refusal("image resize implementation and worker were emitted into different directories");
	}
	if (dirname(configOutput) !== dirname(bedrockLoaderOutput)) {
		throw new Refusal("config.ts and the codemode worker were emitted into different directories");
	}

	const metafiles = [mainResult.metafile, lazyResult.metafile, codemodeWorkerResult.metafile];
	const unexpected = new Set();
	for (const metafile of metafiles) {
		for (const input of Object.values(metafile.inputs)) {
			for (const imported of input.imports) {
				if (imported.external && !isBuiltin(imported.path) && !allowedExternalPackages.has(imported.path)) unexpected.add(imported.path);
			}
		}
	}
	if (unexpected.size > 0) throw new Refusal(`bundle left unexpected external imports: ${[...unexpected].sort().join(", ")}`);

	const cliLauncher = `#!/usr/bin/env node
import { createRequire, enableCompileCache } from "node:module";

enableCompileCache();
createRequire(import.meta.url)("./cli-runtime.js");
`;
	writeFileSync(join(bundleDir, "cli.js"), cliLauncher);
	chmodSync(join(bundleDir, "cli.js"), 0o755);
	chmodSync(join(bundleDir, "rpc-entry.js"), 0o755);
	return { metafiles, oauthFlows };
}

// ── what the build was made from ─────────────────────────────────────────────

function listFiles(dir, prefix = "") {
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) out.push(...listFiles(join(dir, entry.name), rel));
		else out.push(rel);
	}
	return out;
}

function hashInputs(pkg, paths) {
	const inputs = {};
	for (const path of [...paths].sort()) inputs[path] = sha256(readFileSync(join(pkg, path))).slice(0, 16);
	return inputs;
}

function builderHash() {
	return sha256(readFileSync(SCRIPT)).slice(0, 16);
}

function readStamp(dir) {
	try {
		const stamp = JSON.parse(readFileSync(join(dir, STAMP), "utf8"));
		return stamp && typeof stamp.inputs === "object" && Array.isArray(stamp.files) ? stamp : undefined;
	} catch {
		return undefined;
	}
}

export function staleness(pkg, out) {
	const dir = join(pkg, "dist", out);
	if (!existsSync(join(dir, STAMP))) return { built: false, problems: [`no build at ${dir}`] };
	const stamp = readStamp(dir);
	if (!stamp) return { built: false, problems: [`unreadable build record ${join(dir, STAMP)}`] };
	const problems = [];
	const version = readPackage(pkg).version;
	if (stamp.piVersion !== version) problems.push(`built from pi ${stamp.piVersion}, installed is ${version}`);
	if (stamp.builder !== builderHash()) problems.push("build-pi-bundle.mjs changed since the build");
	const changed = [];
	for (const [path, hash] of Object.entries(stamp.inputs)) {
		const file = join(pkg, path);
		if (!existsSync(file)) changed.push(`${path} (gone)`);
		else if (sha256(readFileSync(file)).slice(0, 16) !== hash) changed.push(path);
	}
	if (changed.length > 0) {
		const shown = changed.slice(0, 8).join(", ");
		problems.push(`${changed.length} input file(s) changed since the build: ${shown}${changed.length > 8 ? ", …" : ""}`);
	}
	const missing = stamp.files.filter((file) => !existsSync(join(dir, file)));
	if (missing.length > 0) problems.push(`${missing.length} built file(s) missing: ${missing.slice(0, 5).join(", ")}`);
	return { built: true, stamp, problems };
}

// ── smoke test, publish, link ────────────────────────────────────────────────

function smoke(dir, version, full) {
	const cli = join(dir, "cli.js");
	const run = (args) =>
		spawnSync(process.execPath, [cli, ...args], { cwd: tmpdir(), input: "", encoding: "utf8", timeout: 60_000 });
	const v = run(["--version"]);
	if (v.status !== 0 || v.stdout.trim() !== version) {
		throw new Refusal(`smoke test: ${cli} --version printed "${v.stdout.trim()}" (exit ${v.status}), expected ${version}\n${v.stderr.slice(-800)}`);
	}
	if (!full) return;
	const start = run(["--no-session", "--mode", "rpc"]);
	if (start.status !== 0) {
		throw new Refusal(`smoke test: ${cli} --no-session --mode rpc exited ${start.status} with your extensions loaded\n${start.stderr.slice(-1200)}`);
	}
}

// Hashed chunk names change with their content. A pi already running from the
// previous build imports its chunks lazily, so that build's files stay until the next one.
function publish(staging, final, files, previousFiles) {
	const rank = (file) => (file === "cli.js" ? 2 : file.startsWith("chunks/") ? 0 : 1);
	mkdirSync(final, { recursive: true });
	for (const file of [...files].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))) {
		mkdirSync(dirname(join(final, file)), { recursive: true });
		renameSync(join(staging, file), join(final, file));
	}
	const keep = new Set([...files, ...previousFiles, STAMP]);
	let pruned = 0;
	for (const file of listFiles(final)) {
		if (!keep.has(file)) {
			unlinkSync(join(final, file));
			pruned++;
		}
	}
	return pruned;
}

function writeStamp(final, stamp) {
	const tmp = join(final, `${STAMP}.${process.pid}`);
	writeFileSync(tmp, `${JSON.stringify(stamp, null, "\t")}\n`);
	renameSync(tmp, join(final, STAMP));
}

function link(bin, target) {
	let stat;
	try {
		stat = lstatSync(bin);
	} catch {
		throw new Refusal(`${bin} does not exist`);
	}
	if (!stat.isSymbolicLink()) throw new Refusal(`${bin} is not a symlink; point it at ${target} by hand`);
	const tmp = `${bin}.muzzpi-${process.pid}`;
	rmSync(tmp, { force: true });
	symlinkSync(target, tmp);
	try {
		renameSync(tmp, bin);
	} catch (error) {
		rmSync(tmp, { force: true });
		throw error;
	}
	if (realpathSync(bin) !== realpathSync(target)) throw new Refusal(`${bin} does not resolve to ${target} after linking`);
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	const pkgJson = readPackage(opts.pkg);
	const final = join(opts.pkg, "dist", opts.out);

	if (opts.check) {
		const { problems } = staleness(opts.pkg, opts.out);
		if (problems.length === 0) {
			console.log(`current: ${final} matches the patched files of pi ${pkgJson.version}`);
			return 0;
		}
		for (const problem of problems) console.log(`stale: ${problem}`);
		return 1;
	}

	if (existsSync(final) && !existsSync(join(final, STAMP)) && readdirSync(final).length > 0) {
		throw new Refusal(`${final} exists and was not built by this script; refusing to replace it`, 2);
	}

	const started = performance.now();
	const recipe = await confirmRecipe(pkgJson.version);
	const esbuild = loadEsbuild();
	const stagingPrefix = `.${opts.out}-staging-`;
	for (const entry of readdirSync(join(opts.pkg, "dist"))) {
		const pid = Number(entry.startsWith(stagingPrefix) && entry.slice(stagingPrefix.length));
		if (pid && !processAlive(pid)) rmSync(join(opts.pkg, "dist", entry), { force: true, recursive: true });
	}
	const staging = join(opts.pkg, "dist", `${stagingPrefix}${process.pid}`);
	const cleanUp = () => rmSync(staging, { force: true, recursive: true });
	const onSignal = async (signal) => {
		await esbuild.stop();
		cleanUp();
		process.exit(signal === "SIGINT" ? 130 : 143);
	};
	process.once("SIGINT", onSignal);
	process.once("SIGTERM", onSignal);
	try {
		const { metafiles, oauthFlows } = await runRecipe(esbuild, opts.pkg, staging);
		const inputPaths = new Set();
		for (const metafile of metafiles) {
			for (const input of Object.keys(metafile.inputs)) if (existsSync(join(opts.pkg, input))) inputPaths.add(input);
		}
		const inputs = hashInputs(opts.pkg, inputPaths);
		smoke(staging, pkgJson.version, opts.smoke);

		const files = listFiles(staging);
		const previous = readStamp(final)?.files ?? [];
		const pruned = publish(staging, final, files, previous);
		writeStamp(final, {
			piVersion: pkgJson.version,
			recipe,
			esbuild: esbuild.version,
			builder: builderHash(),
			builtAt: new Date().toISOString(),
			files,
			inputs,
		});
		smoke(final, pkgJson.version, false);

		const bytes = files.reduce((sum, file) => sum + lstatSync(join(final, file)).size, 0);
		console.log(
			`built ${final}: ${files.length} files, ${(bytes / 1024 / 1024).toFixed(1)} MiB, ${inputPaths.size} inputs, ` +
				`${oauthFlows} OAuth flows, esbuild ${esbuild.version}, pi ${recipe}; ` +
				`${pruned} stale file(s) pruned, ${((performance.now() - started) / 1000).toFixed(1)} s`,
		);
	} finally {
		cleanUp();
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
	}

	if (opts.link) {
		link(opts.link, join(final, "cli.js"));
		console.log(`linked ${opts.link} → ${join(final, "cli.js")}`);
	}
	return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(SCRIPT)) {
	main().then(
		(code) => process.exit(code),
		(error) => {
			console.error(`build-pi-bundle: ${error instanceof Refusal ? error.message : error.stack}`);
			process.exit(error instanceof Refusal ? error.code : 1);
		},
	);
}
