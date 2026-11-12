#!/usr/bin/env node
// Small edits to pi's own files, for speed only: pi is correct without them. Each file is edited only
// when it is byte for byte the stock copy the edit was derived on; any other copy is left alone.
//
//   node pi-setup/pi-core-patches/text-patches.mjs --pkg <pi package dir>            apply
//   node pi-setup/pi-core-patches/text-patches.mjs --pkg <pi package dir> --check    report, change nothing
//   node pi-setup/pi-core-patches/text-patches.mjs --pkg <pi package dir> --revert   put the stock files back
//   node pi-setup/pi-core-patches/text-patches.mjs --drift <unpacked pi package dir> which edits a pi release no longer fits
//
// Exit codes: 0 every patch applied · 1 a patch is missing or does not fit · 2 usage.
// Re-deriving after a pi update: diff the old and new stock file, redo the edits on the new one, set `stock`
// to its sha256, then run the test named by the patch.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MARK = "LOCAL PATCH (muzzpi)";
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

const MARKDOWN_LEX = `// ${MARK}: a streaming text that only grew is lexed from its last three top-level blocks on (a "2." line can
// split the paragraph two blocks above it); a text that is not streaming is always lexed in full, as stock.
function tokensLength(tokens) {
    let length = 0;
    for (const token of tokens)
        length += token.raw.length;
    return length;
}
function lexAppended(previous, text) {
    if (!previous?.resumable || !text.startsWith(previous.source))
        return undefined;
    const old = previous.tokens;
    let keep = old.length;
    for (let seen = 0; keep > 0 && seen < 3;) {
        keep--;
        if (old[keep].type !== "space")
            seen++;
    }
    if (keep === 0)
        return undefined;
    let offset = 0;
    for (let i = 0; i < keep; i++)
        offset += old[i].raw.length;
    const tail = markdownParser.lexer(text.slice(offset));
    if (Object.keys(tail.links).length > 0)
        return undefined;
    const tokens = old.slice(0, keep);
    for (const token of tail)
        tokens.push(token);
    tokens.links = tail.links;
    return tokens;
}
`;

export const PATCHES = [
	{
		id: "streaming-markdown",
		what: "a streaming reply is lexed from its last blocks, not in full every frame",
		test: "cd pi-setup/extensions/tools && bun test markdown-stream.test.ts",
		package: "@earendil-works/pi-tui",
		file: "dist/components/markdown.js",
		stock: "409a6c0f8d7d94c1e724ae81f82226d8d0cf8af8c3445dd4457bc36cdd2c7f36",
		requires: { marked: "18.0.11" },
		edits: [
			["const markdownParser = new Marked();\n", `${MARKDOWN_LEX}const markdownParser = new Marked();\n`],
			[
				`        const cached = this.cachedTokens?.deref();
        let tokens = cached?.source === normalizedText ? cached.tokens : undefined;
        if (!tokens) {
            tokens = markdownParser.lexer(normalizedText);
            trimPartialClosingFences(tokens);
            removeHtmlCommentBlocks(tokens);
            this.cachedTokens = new WeakRef({ source: normalizedText, tokens });
        }`,
				`        const cached = this.cachedTokens?.deref();
        const streaming = this.options.streaming?.() === true;
        let tokens = cached?.source === normalizedText && (streaming || !cached.pieced) ? cached.tokens : undefined;
        if (!tokens) {
            const appended = streaming ? lexAppended(cached, normalizedText) : undefined;
            tokens = appended ?? markdownParser.lexer(normalizedText);
            trimPartialClosingFences(tokens);
            removeHtmlCommentBlocks(tokens);
            const resumable = Object.keys(tokens.links).length === 0 && tokensLength(tokens) === normalizedText.length;
            this.cachedTokens = new WeakRef({ source: normalizedText, tokens, pieced: appended !== undefined, resumable });
        }`,
			],
		],
	},
	{
		id: "streaming-markdown",
		what: "the reply being streamed tells its Markdown so",
		test: "cd pi-setup/extensions/tools && bun test markdown-stream.test.ts",
		package: "@earendil-works/pi-coding-agent",
		file: "dist/modes/interactive/components/assistant-message.js",
		stock: "d4820673a831e7d0470b29e09d3dadedbeaaac4c149893ef58dcae8e5a11d661",
		edits: [
			[
				`                    transform: createMarkdownTransform("assistant", () => this.isStreaming, this.markdownTransformers, this.messageId, this.timestamp),\n`,
				`                    transform: createMarkdownTransform("assistant", () => this.isStreaming, this.markdownTransformers, this.messageId, this.timestamp),\n                    streaming: () => this.isStreaming, // ${MARK}\n`,
			],
			[
				`                        transform: createMarkdownTransform("assistant-thinking", () => this.isStreaming, this.markdownTransformers, this.messageId, this.timestamp),\n`,
				`                        transform: createMarkdownTransform("assistant-thinking", () => this.isStreaming, this.markdownTransformers, this.messageId, this.timestamp),\n                        streaming: () => this.isStreaming, // ${MARK}\n`,
			],
		],
	},
	{
		id: "tool-row-result",
		what: "a finished tool row keeps only what it draws, not the up to 1 MiB of structuredContent",
		test: "cd pi-setup/extensions/tools && bun test core-patches.test.ts",
		package: "@earendil-works/pi-coding-agent",
		file: "dist/modes/interactive/interactive-mode.js",
		stock: "a316502682c68544e1950b80e3b19d584c7a43331cfb7029765b5c04d18e4465",
		edits: [
			[
				"component.updateResult({ ...event.result, isError: event.isError, durationMs: event.durationMs });",
				`component.updateResult({ content: event.result.content, details: event.result.details, isError: event.isError, durationMs: event.durationMs }); // ${MARK}`,
			],
		],
	},
];

const PI_PACKAGE = "@earendil-works/pi-coding-agent";

function packageDir(pkg, name) {
	if (name === PI_PACKAGE) return pkg;
	for (let dir = pkg; dir !== dirname(dir); dir = dirname(dir)) {
		const candidate = join(dir, "node_modules", name);
		if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
	}
	return undefined;
}

const version = (dir) => {
	try {
		return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version;
	} catch {
		return undefined;
	}
};

export function patched(patch, stock) {
	let text = stock;
	for (const [from, to] of patch.edits) {
		const at = text.indexOf(from);
		if (at < 0 || text.indexOf(from, at + 1) >= 0) return undefined;
		text = text.slice(0, at) + to + text.slice(at + from.length);
	}
	return text;
}

/** One patch's state in the pi at `pkg`: applied, stock (applicable), or why it cannot be applied. */
export function inspect(patch, pkg) {
	const dir = packageDir(pkg, patch.package);
	if (!dir) return { state: "missing", detail: `${patch.package} not found above ${pkg}` };
	const file = join(dir, patch.file);
	if (!existsSync(file)) return { state: "missing", detail: `${file} not found` };
	for (const [dep, want] of Object.entries(patch.requires ?? {})) {
		const depDir = packageDir(dir, dep);
		const have = depDir && version(depDir);
		if (have !== want) return { state: "drift", file, detail: `needs ${dep} ${want}, found ${have ?? "none"}` };
	}
	const text = readFileSync(file, "utf8");
	const stockCopy = existsSync(`${file}.stock`) ? readFileSync(`${file}.stock`, "utf8") : undefined;
	const stock = sha256(text) === patch.stock ? text : stockCopy !== undefined && sha256(stockCopy) === patch.stock ? stockCopy : undefined;
	if (!stock) return { state: "drift", file, detail: `not the stock file this patch was derived on (sha256 ${patch.stock.slice(0, 12)}…)` };
	const result = patched(patch, stock);
	if (result === undefined) return { state: "drift", file, detail: "an edit does not match the stock file once" };
	if (text === result) return { state: "applied", file };
	if (text === stock) return { state: "stock", file, stock, result };
	// an earlier version of our own edit, over the stock copy kept beside it
	if (stock === stockCopy && text.includes(MARK)) return { state: "stale", file, stock, result };
	return { state: "drift", file, detail: "neither the stock file nor this patch's result" };
}

function apply(pkg) {
	let failed = 0;
	for (const patch of PATCHES) {
		const found = inspect(patch, pkg);
		if (found.state === "stock" || found.state === "stale") {
			writeFileSync(`${found.file}.stock`, found.stock);
			const tmp = `${found.file}.muzzpi-${process.pid}`;
			writeFileSync(tmp, found.result);
			renameSync(tmp, found.file);
			found.state = "patched";
		}
		if (found.state !== "applied" && found.state !== "patched") failed++;
		console.log(`${found.state.padEnd(8)} ${patch.id}  ${found.file ?? patch.file}${found.detail ? `: ${found.detail}` : ""}`);
	}
	return failed ? 1 : 0;
}

function check(pkg) {
	let failed = 0;
	for (const patch of PATCHES) {
		const found = inspect(patch, pkg);
		if (found.state !== "applied") failed++;
		console.log(`${found.state === "applied" ? "applied" : "MISSING"}  ${patch.id} (${patch.what})  ${found.file ?? patch.file}${found.detail ? `: ${found.detail}` : ""}`);
	}
	return failed ? 1 : 0;
}

function revert(pkg) {
	for (const patch of PATCHES) {
		const found = inspect(patch, pkg);
		if (found.state === "applied" && existsSync(`${found.file}.stock`)) {
			copyFileSync(`${found.file}.stock`, found.file);
			console.log(`reverted ${found.file}`);
		}
	}
	return 0;
}

// For update-pi.sh, before installing: the release's own files, and its pi-tui's, fetched with npm pack.
function drift(newPkg) {
	const deps = JSON.parse(readFileSync(join(newPkg, "package.json"), "utf8")).dependencies ?? {};
	const work = mkdtempSync("/tmp/pi-text-drift.");
	let changed = 0;
	try {
		for (const patch of PATCHES) {
			let dir = newPkg;
			if (patch.package !== PI_PACKAGE) {
				const spec = `${patch.package}@${deps[patch.package]}`;
				const out = join(work, patch.package.replace("/", "+"));
				if (!existsSync(out)) {
					const pack = spawnSync("sh", ["-c", `mkdir -p '${out}' && cd '${out}' && npm pack '${spec}' --silent >/dev/null && tar -xzf ./*.tgz`], { encoding: "utf8" });
					if (pack.status !== 0) {
						console.log(`unknown  ${patch.id}  ${patch.package}/${patch.file}: npm pack ${spec} failed`);
						changed++;
						continue;
					}
				}
				dir = join(out, "package");
			}
			const file = join(dir, patch.file);
			const fits = existsSync(file) && sha256(readFileSync(file)) === patch.stock;
			if (!fits) changed++;
			console.log(`${fits ? "fits   " : "DRIFT  "}  ${patch.id}  ${patch.package}/${patch.file}`);
		}
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
	return changed ? 1 : 0;
}

function main(argv) {
	const value = (flag) => {
		const at = argv.indexOf(flag);
		return at >= 0 ? argv[at + 1] : undefined;
	};
	const pkg = value("--pkg") ?? process.env.PI_PKG_DIR;
	if (value("--drift")) return drift(resolve(value("--drift")));
	if (!pkg) {
		console.error("usage: text-patches.mjs --pkg <pi package dir> [--check | --revert]  |  --drift <unpacked pi package dir>");
		return 2;
	}
	const dir = realpathSync(resolve(pkg));
	if (argv.includes("--check")) return check(dir);
	if (argv.includes("--revert")) return revert(dir);
	return apply(dir);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
	process.exit(main(process.argv.slice(2)));
}
