/**
 * Splits a shell command into the part that runs on this machine and the parts
 * that run on a server over ssh, so local-only rules (the delete guard) skip
 * server work while every rule still sees what each host will run.
 *
 * A guardrail, not a sandbox. Anything it cannot place with confidence stays
 * local, where the stricter rules apply.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { splitWords } from "./read-only-bash";

export interface RemoteCommand {
	host: string;
	command: string;
}

interface Span {
	start: number;
	end: number;
}

type Quote = '"' | "'" | "$'" | null;

/**
 * Top-level command positions, quote-aware. `$(`, `<(`, `>(` and backticks
 * open a new position even inside double quotes, and their matching `)` closes
 * it and restores the quote that was open before: the local shell runs them
 * before ssh sees the argument, so their text must never sit inside an ssh span.
 * `$'..'` honours backslashes and a `#` comment ends at the newline, as in bash.
 */
function segmentSpans(cmd: string): Span[] {
	const spans: Span[] = [];
	const stack: { quote: Quote; kind: "sub" | "tick" | "group" }[] = [];
	let start = 0;
	let quote: Quote = null;
	const close = (end: number, next: number) => {
		if (cmd.slice(start, end).trim()) spans.push({ start, end });
		start = next;
	};
	for (let i = 0; i < cmd.length; i++) {
		const ch = cmd[i]!;
		if (quote === "'") {
			if (ch === "'") quote = null;
			continue;
		}
		if (ch === "\\") {
			i++;
			continue;
		}
		if (quote === "$'") {
			if (ch === "'") quote = null;
			continue;
		}
		if (ch === "`") {
			close(i, i + 1);
			if (stack.at(-1)?.kind === "tick") quote = stack.pop()!.quote;
			else {
				stack.push({ quote, kind: "tick" });
				quote = null;
			}
			continue;
		}
		if ((ch === "$" || ch === "<" || ch === ">") && cmd[i + 1] === "(") {
			close(i, i + 2);
			stack.push({ quote, kind: "sub" });
			quote = null;
			i++;
			continue;
		}
		if (quote === '"') {
			if (ch === '"') quote = null;
			continue;
		}
		if (ch === "(") {
			stack.push({ quote: null, kind: "group" });
			continue;
		}
		if (ch === ")") {
			const frame = stack.at(-1)?.kind === "tick" ? undefined : stack.pop();
			if (frame?.kind === "sub") {
				close(i, i + 1);
				quote = frame.quote;
			}
			continue;
		}
		if (ch === "$" && cmd[i + 1] === "'") {
			quote = "$'";
			i++;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}
		if (ch === "#" && (i === 0 || /[\s;&|()]/.test(cmd[i - 1]!))) {
			while (i + 1 < cmd.length && cmd[i + 1] !== "\n") i++;
			continue;
		}
		if (ch === "&" && (cmd[i + 1] === ">" || cmd[i - 1] === ">")) continue;
		if (ch === ";" || ch === "\n" || ch === "|" || ch === "&") close(i, i + 1);
	}
	close(cmd.length, cmd.length);
	return spans;
}

/**
 * The heredoc tags a line opens, read the way bash reads them: only outside
 * quotes and comments, and never `<<<` (a here-string). null when the line
 * leaves a quote open, so the caller cannot know where the body is.
 */
export function heredocTags(line: string): string[] | null {
	const tags: string[] = [];
	let quote: Quote = null;
	// `<<` inside `$(( ))` or `(( ))` is a shift, not a heredoc.
	let arithmetic = 0;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i]!;
		if (quote === "'") {
			if (ch === "'") quote = null;
			continue;
		}
		if (ch === "\\") {
			i++;
			continue;
		}
		if (quote) {
			if (ch === (quote === '"' ? '"' : "'")) quote = null;
			continue;
		}
		if (ch === "$" && line[i + 1] === "'") {
			quote = "$'";
			i++;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}
		if (ch === "#" && (i === 0 || /[\s;&|()]/.test(line[i - 1]!))) break;
		if (ch === "(" && line[i + 1] === "(") {
			arithmetic++;
			i++;
			continue;
		}
		if (ch === ")" && line[i + 1] === ")" && arithmetic > 0) {
			arithmetic--;
			i++;
			continue;
		}
		if (ch !== "<" || line[i + 1] !== "<" || arithmetic > 0) continue;
		if (line[i + 2] === "<") {
			i += 2;
			continue;
		}
		const tag = /^<<-?[ \t]*(?:'([^']+)'|"([^"]+)"|\\?([A-Za-z0-9_][\w.-]*))/.exec(line.slice(i));
		if (tag) {
			tags.push(tag[1] ?? tag[2] ?? tag[3]!);
			i += tag[0].length - 1;
		}
	}
	return quote ? null : tags;
}

/** ssh options that take a value, as the next word or glued on (`-p22`). */
const SSH_VALUE_FLAGS = new Set("BbcDEeFIiJLlmOoPpQRSWw");
/** -o options that make ssh run a command or load code on THIS machine. */
const SSH_LOCAL_EXEC =
	/^\s*(?:ProxyCommand|LocalCommand|PermitLocalCommand|KnownHostsCommand|PKCS11Provider|SecurityKeyProvider|Include|ProxyUseFdpass)\b/i;

/** inet_aton: `127.1`, `0x7f000001` and `2130706433` all mean 127.0.0.1 to ssh. */
function ipv4(host: string): number | undefined {
	const parts = host.split(".");
	if (parts.length > 4) return undefined;
	const values: number[] = [];
	for (const part of parts) {
		const value = /^0x[0-9a-f]+$/i.test(part)
			? Number.parseInt(part, 16)
			: /^0[0-7]*$/.test(part)
				? Number.parseInt(part, 8)
				: /^[1-9]\d*$/.test(part)
					? Number.parseInt(part, 10)
					: Number.NaN;
		if (Number.isNaN(value)) return undefined;
		values.push(value);
	}
	const last = values.pop()!;
	let address = 0;
	values.forEach((value, index) => {
		address += value * 2 ** (24 - 8 * index);
	});
	return address + last;
}

/** `Host alias` → `HostName` from ~/.ssh/config, for exact aliases only. */
function sshConfigHostName(alias: string): string | undefined {
	let text: string;
	try {
		text = fs.readFileSync(path.join(os.homedir(), ".ssh", "config"), "utf8");
	} catch {
		return undefined;
	}
	let matches = false;
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		const [keyword, ...rest] = line.split(/\s+|=/).filter(Boolean);
		if (!keyword) continue;
		const key = keyword.toLowerCase();
		if (key === "host" || key === "match") matches = key === "host" && rest.includes(alias);
		else if (matches && key === "hostname" && rest[0]) return rest[0].replace(/%h/g, alias);
	}
	return undefined;
}

/**
 * Whether ssh would reach this machine. Fails closed: a host the shell or ssh
 * could still rewrite (`$HOSTNAME`, `~`, a glob, a trailing dot) counts as local.
 */
function isLocalHost(raw: string, depth = 0): boolean {
	const host = raw.toLowerCase().replace(/^\[|\]$/g, "");
	if (!host || /[$`~*?{}\\]/.test(host) || host.endsWith(".")) return true;
	const own = os.hostname().toLowerCase();
	if (["localhost", own, own.replace(/\.local$/, "")].includes(host) || /^localhost\.|^ip6-/.test(host)) return true;
	if (host.includes(":")) {
		const v4 = /^::ffff:(.+)$/.exec(host)?.[1];
		if (v4) return isLocalHost(v4, depth + 1);
		return /^[0:]*:?0*1?$/.test(host);
	}
	const address = ipv4(host);
	if (address !== undefined) return address >>> 24 === 127 || address >>> 24 === 0;
	if (depth === 0) {
		const configured = sshConfigHostName(host);
		if (configured && configured.toLowerCase() !== host) return isLocalHost(configured, depth + 1);
	}
	return false;
}

/** `user@host`, `ssh://user@host:22`, `[::1]`: ssh splits the user off at the LAST `@`. */
function hostOf(destination: string): string {
	const withoutScheme = destination.replace(/^ssh:\/\//, "");
	const bare = withoutScheme.slice(withoutScheme.lastIndexOf("@") + 1);
	const bracketed = /^\[([^\]]*)\]/.exec(bare);
	return bracketed ? bracketed[1]! : bare.replace(/[:/].*$/, "");
}

/** drops `VAR=x`, `command`, `exec`, `nohup`, `time`, `env`, `timeout [-opts] N` in front of the real command. */
function stripLauncher(words: string[]): string[] {
	let i = 0;
	while (i < words.length) {
		const word = words[i]!;
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || ["command", "exec", "nohup", "time", "env"].includes(word)) {
			i++;
		} else if (word === "timeout") {
			i++;
			while (i < words.length && words[i]!.startsWith("-")) {
				i += ["-k", "-s", "--kill-after", "--signal"].includes(words[i]!) ? 2 : 1;
			}
			i++;
		} else {
			break;
		}
	}
	return words.slice(i);
}

const basename = (word: string) => word.slice(word.lastIndexOf("/") + 1);

/**
 * `remote`: the host and the words ssh runs there. `local`: ssh runs or loads
 * something here (`-o ProxyCommand=…`), or reads a config that could (`-F`,
 * `-I`), so the whole segment stays local; `exposed` is a command to check too.
 */
type SshCall = { kind: "remote"; host: string; command: string[] } | { kind: "local"; exposed?: string };

function parseSsh(words: string[]): SshCall | null {
	const argv = stripLauncher(words);
	if (argv.length === 0 || basename(argv[0]!) !== "ssh") return null;
	let hostName: string | undefined;
	let i = 1;
	for (; i < argv.length; i++) {
		const word = argv[i]!;
		if (word === "--") {
			i++;
			break;
		}
		if (!word.startsWith("-") || word === "-") break;
		for (let k = 1; k < word.length; k++) {
			const flag = word[k]!;
			if (!SSH_VALUE_FLAGS.has(flag)) continue;
			const value = word.slice(k + 1) || argv[++i] || "";
			if (flag === "F" || flag === "I") return { kind: "local" };
			if (flag === "o" && SSH_LOCAL_EXEC.test(value)) {
				return { kind: "local", exposed: value.trim().replace(/^\w+\s*=?\s*/, "") };
			}
			if (flag === "o" && /^\s*HostName\s*[=\s]/i.test(value)) hostName = value.trim().replace(/^\w+\s*=?\s*/, "");
			break;
		}
	}
	const destination = argv[i];
	if (!destination) return null;
	const host = hostOf(destination);
	if (isLocalHost(host) || (hostName !== undefined && isLocalHost(hostName))) return { kind: "local" };
	return { kind: "remote", host, command: argv.slice(i + 1) };
}

function remoteSsh(words: string[]): { host: string; command: string[] } | null {
	const call = parseSsh(words);
	return call?.kind === "remote" ? call : null;
}

/** rsync options whose value is the next word when not written `--opt=value`. */
const RSYNC_VALUE_OPTIONS = new Set([
	"--exclude", "--include", "--filter", "-f", "--exclude-from", "--include-from", "--files-from", "--log-file",
	"--partial-dir", "--temp-dir", "-T", "--backup-dir", "--compare-dest", "--copy-dest", "--link-dest", "--chmod",
	"--chown", "--block-size", "-B", "--timeout", "--contimeout", "--port", "--password-file", "--bwlimit",
	"--max-size", "--min-size", "--out-format", "--suffix", "--usermap", "--groupmap", "--info", "--debug",
	"--skip-compress", "--max-delete", "--modify-window", "--sockopts", "--outbuf", "--iconv", "--checksum-choice",
	"--compress-choice", "--write-batch", "--only-write-batch", "--read-batch", "--protocol", "--early-input",
]);
const RSYNC_REMOTE = (operand: string) =>
	/^rsync:\/\/(?:[^@/]*@)?([^/:]+)/.exec(operand)?.[1] ?? /^(?:[^@\s/:]*@)?([^\s/:]+):/.exec(operand)?.[1];

/**
 * `rsync --delete src host:dst` deletes on the server. It stays local when it
 * also removes source files here, runs a remote shell other than plain ssh, or
 * any source is remote (then the deletes land here).
 */
function remoteRsyncHost(words: string[]): string | null {
	const argv = stripLauncher(words);
	if (argv.length < 3 || basename(argv[0]!) !== "rsync") return null;
	const operands: string[] = [];
	let deletes = false;
	for (let i = 1; i < argv.length; i++) {
		const word = argv[i]!;
		if (word === "--") {
			operands.push(...argv.slice(i + 1));
			break;
		}
		if (!word.startsWith("-")) {
			operands.push(word);
			continue;
		}
		if (/^--remove-(?:source|sent)-files$/.test(word)) return null;
		if (/^--del(?:ete[\w-]*)?$/.test(word)) deletes = true;
		let shell: string | undefined;
		if (word === "-e" || word === "--rsh") shell = argv[++i] ?? "";
		else if (word.startsWith("--rsh=")) shell = word.slice("--rsh=".length);
		else if (/^-[a-zA-Z]+$/.test(word) && word.includes("e")) shell = word.slice(word.indexOf("e") + 1) || (argv[++i] ?? "");
		if (shell !== undefined) {
			// -e runs its value on THIS machine; only a plain ssh is a remote shell.
			if (!/^\s*ssh(?:\s[^;&|`$()<>#]*)?$/.test(shell)) return null;
			continue;
		}
		if (RSYNC_VALUE_OPTIONS.has(word)) i++;
	}
	if (!deletes || operands.length < 2) return null;
	const destination = operands.at(-1)!;
	if (operands.slice(0, -1).some((source) => RSYNC_REMOTE(source))) return null;
	const host = RSYNC_REMOTE(destination);
	return host && !isLocalHost(host) ? host : null;
}

/** commands that only pass a heredoc body down a pipe into ssh. */
const FEEDERS = new Set(["cat", "echo", "printf"]);

/**
 * Takes out heredoc bodies a remote shell receives (`ssh host <<EOF`,
 * `cat <<EOF | ssh host bash`), keyed by where that ssh segment starts in the
 * returned text. Every other body stays, so it is checked as local.
 */
function extractRemoteHeredocs(cmd: string): { text: string; bodies: Map<number, RemoteCommand> } {
	const lines = cmd.split("\n");
	const kept: string[] = [];
	const bodies = new Map<number, RemoteCommand>();
	let length = 0;
	const keep = (line: string) => {
		length += (kept.length > 0 ? 1 : 0) + line.length;
		kept.push(line);
	};
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]!;
		const lineStart = length + (kept.length > 0 ? 1 : 0);
		keep(line);
		const tags = heredocTags(line);
		if (!tags || tags.length === 0) continue;

		const spans = segmentSpans(line);
		const argvs = spans.map((span) => splitWords(line.slice(span.start, span.end)));
		const sshAt = argvs.findIndex((words) => remoteSsh(words) !== null);
		const onlyFeeders = argvs.every((words, k) => k === sshAt || FEEDERS.has(basename(stripLauncher(words)[0] ?? "")));
		if (sshAt < 0 || !onlyFeeders) continue;
		const host = remoteSsh(argvs[sshAt]!)!.host;

		const body: string[] = [];
		for (const tag of tags) {
			while (index + 1 < lines.length && lines[index + 1]!.trim() !== tag) body.push(lines[++index]!);
			if (index + 1 < lines.length) keep(lines[++index]!);
		}
		bodies.set(lineStart + spans[sshAt]!.start, { host, command: body.join("\n") });
	}
	return { text: kept.join("\n"), bodies };
}

/** `<<EOF`, `<<-'EOF'`, `<< EOF`: the heredoc operator is local shell syntax, not part of the remote command. */
function withoutHeredocTokens(words: string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < words.length; i++) {
		if (/^<<-?$/.test(words[i]!)) i++;
		else if (!/^<<-?\S/.test(words[i]!)) out.push(words[i]!);
	}
	return out;
}

/** the command with every remote part replaced by `ssh <host>`, and the remote parts. */
export function splitRemote(cmd: string): { local: string; remote: RemoteCommand[] } {
	const { text, bodies } = extractRemoteHeredocs(cmd);
	const remote: RemoteCommand[] = [];
	const runsHere: string[] = [];
	let local = "";
	let cursor = 0;
	for (const span of segmentSpans(text)) {
		const segment = text.slice(span.start, span.end);
		const words = splitWords(segment);
		const call = parseSsh(words);
		if (call?.kind === "local" && call.exposed) runsHere.push(call.exposed);
		const ssh = call?.kind === "remote" ? call : null;
		const host = ssh?.host ?? remoteRsyncHost(words);
		if (!host) continue;
		const body = bodies.get(span.start);
		bodies.delete(span.start);
		const command = ssh ? [withoutHeredocTokens(ssh.command).join(" "), body?.command ?? ""].join("\n").trim() : segment.trim();
		if (command) remote.push({ host, command });
		local += `${text.slice(cursor, span.start)}ssh ${host}`;
		cursor = span.end;
	}
	// a body whose ssh segment was not found again is still checked, as remote.
	for (const body of bodies.values()) if (body.command.trim()) remote.push(body);
	const extra = runsHere.map((command) => `\n${command}`).join("");
	if (cursor === 0) return { local: text + extra, remote };
	return { local: local + text.slice(cursor) + extra, remote };
}
