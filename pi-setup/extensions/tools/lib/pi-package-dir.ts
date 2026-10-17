import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

/** pi's package directory, walking up from the running entrypoint: dist/cli.js, or a bundle under dist/. */
export function piPackageDir(entry: string | undefined = process.argv[1]): string | undefined {
	try {
		let dir = dirname(realpathSync(entry ?? ""));
		for (let i = 0; i < 4; i++) {
			if (existsSync(join(dir, "docs", "codemode.md"))) return dir;
			dir = dirname(dir);
		}
	} catch {}
	return undefined;
}

/**
 * pi's readClipboardImage module; the package root does not export it, and bundles inline it.
 * Checked by its source, not loaded: loading costs ~36 ms under a bundle.
 */
export function clipboardImageModule(packageDir: string | undefined = piPackageDir()): string | undefined {
	const file = packageDir && join(packageDir, "dist", "utils", "clipboard-image.js");
	try {
		return file && /export async function readClipboardImage\b/.test(readFileSync(file, "utf8")) ? file : undefined;
	} catch {
		return undefined;
	}
}
