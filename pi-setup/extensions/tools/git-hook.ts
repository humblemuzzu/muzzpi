/**
 * git runs this for every commit and push made from pi's bash and the commit
 * tool, bundled as git-hook.mjs: `git-hook.mjs commit <prepare-commit-msg args>` and
 * `git-hook.mjs push <pre-push args>`. lib/git.ts registers it through the environment. Exit 1
 * stops git; any failure of its own lets git go on and says so.
 */

import { blockMessage, git, knownSecrets, scanStaged, scanUnpushed, SECRET_SCAN_OFF_ENV, warningMessage, ZERO_SHA, type ScanResult, type Stopped } from "./lib/secret-scan";


function report(result: ScanResult, stopped: Stopped): number {
	if (result.blocked.length > 0) {
		process.stderr.write(`${blockMessage(result.blocked, stopped)}\n`);
		return 1;
	}
	if (result.warned.length > 0) process.stderr.write(`${warningMessage(result.warned)}\n`);
	return 0;
}

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("utf8");
}

/** a squash holds commits of a branch git no longer names, which were checked when they were made */
async function onCommit(source: string | undefined): Promise<number> {
	if (source === "squash") return 0;
	return report(await scanStaged(process.cwd()), "commit");
}

async function onPush(remote: string | undefined): Promise<number> {
	const cwd = process.cwd();
	const known = await knownSecrets();
	const named = remote && /^[\w.-]+$/.test(remote) ? remote : undefined;
	const total: ScanResult = { blocked: [], warned: [] };
	for (const line of (await readStdin()).split("\n")) {
		const [, localSha, , remoteSha] = line.trim().split(/\s+/);
		if (!localSha || ZERO_SHA.test(localSha)) continue;
		const remoteHere = remoteSha && !ZERO_SHA.test(remoteSha) && (await git(cwd, ["cat-file", "-e", `${remoteSha}^{commit}`])) !== undefined;
		const result = await scanUnpushed(cwd, localSha, remoteHere ? remoteSha : undefined, named, known);
		total.blocked.push(...result.blocked);
		total.warned.push(...result.warned);
	}
	return report(total, "push");
}

async function main([event, ...args]: string[]): Promise<number> {
	if (process.env[SECRET_SCAN_OFF_ENV] === "1") return 0;
	if (event === "commit") return onCommit(args[1]);
	if (event === "push") return onPush(args[0]);
	return 0;
}

main(process.argv.slice(2)).then(
	(code) => process.exit(code),
	(error: unknown) => {
		process.stderr.write(`pi secret scan: could not run (${error instanceof Error ? error.message : String(error)}); this was not checked.\n`);
		process.exit(0);
	},
);
