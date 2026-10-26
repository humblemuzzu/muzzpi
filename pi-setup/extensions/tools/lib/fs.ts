/**
 * fs — path resolution utilities, ported from @bds_pi/fs by bdsqqq.
 */

import * as os from "node:os";
import * as path from "node:path";

export function expandPath(filePath: string): string {
	const stripped = filePath.startsWith("@") ? filePath.slice(1) : filePath;
	if (stripped === "~") return os.homedir();
	if (stripped.startsWith("~/")) return os.homedir() + stripped.slice(1);
	return stripped;
}

export function resolveToAbsolute(filePath: string, cwd: string): string {
	const expanded = expandPath(filePath);
	return path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
}

export function isPathWithin(rootPath: string, targetPath: string): boolean {
	const resolvedRoot = path.resolve(rootPath);
	const resolvedTarget = path.resolve(targetPath);
	const relative = path.relative(resolvedRoot, resolvedTarget);
	return (
		relative === "" ||
		(!relative.startsWith("..") && !path.isAbsolute(relative))
	);
}
