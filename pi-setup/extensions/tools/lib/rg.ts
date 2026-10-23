import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createInterface } from "node:readline";

export const GITIGNORE_NOTE = "files matched by .gitignore are skipped; an ignored directory passed as `path` is searched";

/**
 * rg matches a glob containing `/` against the path relative to its target, so
 * rg must run FROM the search dir on a relative target: an absolute target
 * makes `src/**\/*.ts` match nothing.
 */
export function rgLocation(searchPath: string): { cwd: string; target: string } | { error: string } {
	let stat: fs.Stats;
	try {
		stat = fs.statSync(searchPath);
	} catch {
		return { error: `path not found: ${searchPath}` };
	}
	return stat.isDirectory()
		? { cwd: searchPath, target: "." }
		: { cwd: path.dirname(searchPath), target: path.basename(searchPath) };
}

export interface RgFiles {
	/** Relative to `cwd`, `/`-separated. */
	paths: string[];
	code: number | null;
	stderr: string;
	aborted: boolean;
	error?: string;
}

/** `rg --no-config --files --hidden --glob '!.git' --glob '!.jj' [--glob G] .` run in `cwd`. */
export function rgFiles(cwd: string, glob: string | undefined, signal?: AbortSignal): Promise<RgFiles> {
	return new Promise((resolve) => {
		const args = ["--no-config", "--files", "--hidden", "--color=never", "--glob", "!.git", "--glob", "!.jj"];
		if (glob !== undefined) args.push("--glob", glob);
		args.push(".");
		const child = spawn("rg", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		const rl = createInterface({ input: child.stdout! });
		const out: RgFiles = { paths: [], code: null, stderr: "", aborted: false };
		const onAbort = () => {
			out.aborted = true;
			if (!child.killed) child.kill();
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		child.stderr?.on("data", (chunk: Buffer) => {
			out.stderr += chunk.toString();
		});
		rl.on("line", (line) => {
			const trimmed = line.trim();
			if (!trimmed) return;
			const rel = path.relative(cwd, path.resolve(cwd, trimmed)).replace(/\\/g, "/");
			if (rel && !rel.startsWith("..")) out.paths.push(rel);
		});
		child.on("error", (err) => {
			rl.close();
			signal?.removeEventListener("abort", onAbort);
			resolve({ ...out, error: err.message });
		});
		child.on("close", (code) => {
			rl.close();
			signal?.removeEventListener("abort", onAbort);
			resolve({ ...out, code });
		});
	});
}

/**
 * The files `glob` selects from the .gitignore-respecting list. A matching
 * `--glob` makes rg list ignored files too (`--glob '*'` lists all of
 * node_modules), so the glob's list is cut down to the plain one.
 */
export async function rgFilesNarrowed(cwd: string, glob: string, signal?: AbortSignal): Promise<RgFiles> {
	const [withGlob, plain] = await Promise.all([rgFiles(cwd, glob, signal), rgFiles(cwd, undefined, signal)]);
	if (withGlob.error || withGlob.aborted) return withGlob;
	const allowed = new Set(plain.paths);
	return { ...withGlob, paths: withGlob.paths.filter((p) => allowed.has(p)) };
}
