import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { piPackageDir } from "../tools/lib/pi-package-dir";
import type { BuiltinCommand } from "./entries";

const loading = new Map<string, Promise<BuiltinCommand[]>>();

/**
 * pi's own slash commands. The package root does not export the list, so it is
 * imported from pi's file on first use (~14 ms, once); without it /help leaves the
 * section out rather than guess.
 */
export function loadBuiltinCommands(packageDir: string | undefined = piPackageDir()): Promise<BuiltinCommand[]> {
	if (!packageDir) return Promise.resolve([]);
	const cached = loading.get(packageDir);
	if (cached) return cached;
	const load = (async () => {
		const file = join(packageDir, "dist", "core", "slash-commands.js");
		if (!existsSync(file)) return [];
		const mod = (await import(pathToFileURL(file).href)) as { BUILTIN_SLASH_COMMANDS?: unknown };
		const list = Array.isArray(mod.BUILTIN_SLASH_COMMANDS) ? mod.BUILTIN_SLASH_COMMANDS : [];
		return list.filter(
			(c): c is BuiltinCommand => typeof c?.name === "string" && c.name !== "" && typeof c.description === "string",
		);
	})().catch(() => []);
	loading.set(packageDir, load);
	return load;
}
