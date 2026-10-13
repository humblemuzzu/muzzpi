import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { splitRemote } from "./remote-command";

/**
 * Real bash decides: `ssh` is stubbed to print its arguments and stdin (where a
 * heredoc body goes), and `probe` says when it runs on this machine. Both write
 * to stderr, so `out=$(ssh …)` cannot swallow the evidence. The stub fails
 * when its arguments say FAIL, so `ssh h FAIL || probe` reaches the probe.
 */
function whereBashRunsProbe(cmd: string): "local" | "remote" {
	const stub = `ssh() { { printf 'REMOTE[%s ' "$*"; cat; printf ']\\n'; } >&2; [[ "$*" != *FAIL* ]]; }`;
	const script = `${stub}\nprobe() { echo LOCAL-PROBE >&2; }\n${cmd}\nwait`;
	const run = spawnSync("/bin/bash", ["-c", script], { encoding: "utf8", input: "", timeout: 5000 });
	if (run.stderr.includes("LOCAL-PROBE")) return "local";
	if (/REMOTE\[[^\]]*probe/.test(run.stderr)) return "remote";
	throw new Error(`probe never ran for ${JSON.stringify(cmd)}: ${run.stdout} ${run.stderr}`);
}

describe("splitRemote agrees with real bash about where a command runs", () => {
	const cases = [
		"ssh h 'probe'",
		"ssh h probe",
		'ssh h "a; probe"',
		"ssh h 'a' '; probe'",
		"ssh h 'ls'; probe",
		"ssh h 'a' && probe",
		"ssh h 'a' | probe",
		"probe | ssh h 'a'",
		'ssh h "echo $(probe)"',
		"ssh h 'echo $(probe)'",
		'ssh h "echo `probe`"',
		"ssh h ls <(probe)",
		"ssh h ls >(probe)",
		"ssh h $'it\\'s'; probe",
		"ssh h ls # it's\nprobe",
		"ssh h ls \\\nprobe",
		"ssh h 'echo a#b'; probe",
		"ssh h bash -s <<'EOF'\nprobe\nEOF",
		"cat <<EOF | ssh h bash\nprobe\nEOF",
		"FOO=1 ssh h 'probe'",
		// found in review: each one used to hide the local probe inside the ssh part.
		'out="$(ssh h cat f)"; probe',
		'echo "$(ssh h ls)"\nprobe',
		"ssh h 'cat <<EOF'\nprobe",
		"ssh h true # <<EOF\nprobe",
		"ssh h <<<EOF\nprobe\nEOF",
		"ssh h echo $((1<<2))\nprobe",
		'ssh h "$(echo a) b"; probe',
		'ssh h "echo \\"$(date)\\"" && probe',
		"out=$(ssh h 'probe')",
		'echo "$(ssh h "probe")"',
	];
	// every way of writing the ssh part, joined to a local probe by every separator.
	const sshForms = ["ssh h 'X'", 'ssh h "X"', "ssh h X", "out=\"$(ssh h 'X')\"", 'echo "$(ssh h "X")"', "echo `ssh h X`"];
	for (const form of sshForms) {
		cases.push(form.replace("X", "probe"));
		for (const separator of ["; ", " && ", " || ", " | ", "\n", " & "]) {
			// `echo … || probe` never reaches the probe: the status is echo's.
			if (separator === " || " && form.startsWith("echo")) continue;
			cases.push(form.replace("X", separator === " || " ? "FAIL" : "ls") + separator + "probe");
		}
	}
	for (const cmd of cases) {
		it(JSON.stringify(cmd), () => {
			const split = splitRemote(cmd);
			const ours = split.remote.some((part) => part.command.includes("probe")) && !split.local.includes("probe") ? "remote" : "local";
			expect(ours).toBe(whereBashRunsProbe(cmd));
		});
	}
});

describe("splitRemote: what runs on a server", () => {
	it("leaves a command with no ssh untouched", () => {
		const cmd = "ls -la && git status | head";
		expect(splitRemote(cmd)).toEqual({ local: cmd, remote: [] });
	});

	it("takes the quoted remote command out of the local view", () => {
		expect(splitRemote("ssh crawlapi 'rm -rf /root/old && df -h'")).toEqual({
			local: "ssh crawlapi",
			remote: [{ host: "crawlapi", command: "rm -rf /root/old && df -h" }],
		});
	});

	it("joins unquoted remote words the way ssh does", () => {
		expect(splitRemote("ssh box rm -rf /srv/x").remote).toEqual([{ host: "box", command: "rm -rf /srv/x" }]);
	});

	it("skips ssh options, with values given apart or glued on", () => {
		const split = splitRemote("ssh -tt -i ~/.ssh/key -p 2222 -oStrictHostKeyChecking=no root@10.0.0.5 'docker ps'");
		expect(split.remote).toEqual([{ host: "10.0.0.5", command: "docker ps" }]);
		expect(splitRemote("ssh -p22 -J jump admin@db1 uptime").remote).toEqual([{ host: "db1", command: "uptime" }]);
		expect(splitRemote("ssh -- web 'ls'").remote).toEqual([{ host: "web", command: "ls" }]);
	});

	it("sees ssh behind env assignments, timeout and exec", () => {
		expect(splitRemote("FOO=1 ssh a 'x'").remote).toEqual([{ host: "a", command: "x" }]);
		expect(splitRemote("timeout -k 5 30 ssh a 'x'").remote).toEqual([{ host: "a", command: "x" }]);
		expect(splitRemote("/usr/bin/ssh a 'x'").remote).toEqual([{ host: "a", command: "x" }]);
	});

	it("keeps every host apart", () => {
		expect(splitRemote("ssh a 'rm x' && ssh b 'rm y'").remote).toEqual([
			{ host: "a", command: "rm x" },
			{ host: "b", command: "rm y" },
		]);
	});

	it("an interactive ssh with no command runs nothing remotely", () => {
		expect(splitRemote("ssh crawlapi")).toEqual({ local: "ssh crawlapi", remote: [] });
	});
});

describe("splitRemote: what still runs on this machine", () => {
	it("a command after the ssh one is local", () => {
		const split = splitRemote("ssh host 'ls'; rm -rf ~");
		expect(split.local).toBe("ssh host; rm -rf ~");
		expect(split.remote).toEqual([{ host: "host", command: "ls" }]);
	});

	it("$( ) inside double quotes runs locally before ssh starts", () => {
		expect(splitRemote('ssh host "echo $(rm -rf ~)"').local).toContain("rm -rf ~");
		expect(splitRemote('ssh host "echo `rm -rf ~`"').local).toContain("rm -rf ~");
	});

	it("quoting the shell reads differently cannot hide a local command inside the ssh part", () => {
		for (const cmd of [
			"ssh h $'it\\'s'; rm -rf ~",
			"ssh h ls # it's\nrm -rf ~",
			"ssh h ls >(rm -rf ~)",
			"ssh h ls <(rm -rf ~)",
		]) {
			expect({ cmd, local: splitRemote(cmd).local }).toEqual({ cmd, local: expect.stringContaining("rm -rf ~") });
		}
	});

	it("a # inside a word is not a comment", () => {
		expect(splitRemote("ssh h 'echo a#b'").remote).toEqual([{ host: "h", command: "echo a#b" }]);
	});

	it("$( ) inside single quotes runs on the server", () => {
		const split = splitRemote("ssh host 'echo $(rm -rf /x)'");
		expect(split.local).toBe("ssh host");
		expect(split.remote[0]!.command).toBe("echo $(rm -rf /x)");
	});

	it("every spelling of this machine is local", () => {
		const own = os.hostname();
		for (const cmd of [
			"ssh localhost rm f", "ssh 127.0.0.1 'rm f'", "ssh me@127.0.1.1 rm f", `ssh ${own} rm f`, "ssh [::1] rm f",
			"ssh localhost. rm f", "ssh localhost.localdomain rm f", "ssh ip6-localhost rm f", "ssh 0 rm f",
			"ssh 127.1 rm f", "ssh 2130706433 rm f", "ssh 0x7f000001 rm f", "ssh ::ffff:127.0.0.1 rm f",
			"ssh a@b@localhost rm f", "ssh $HOSTNAME rm f", "ssh ~ rm f", "ssh -o HostName=127.0.0.1 web rm f",
			"ssh -F ./cfg web rm f", "ssh -I /tmp/lib.so web rm f",
		]) {
			expect({ cmd, ...splitRemote(cmd) }).toEqual({ cmd, local: cmd, remote: [] });
		}
	});

	it("an ~/.ssh/config alias for this machine is local", () => {
		// a child process: the home directory is read once at startup.
		const fake = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-home-"));
		fs.mkdirSync(path.join(fake, ".ssh"));
		fs.writeFileSync(path.join(fake, ".ssh", "config"), "Host selfalias\n  HostName 127.0.0.1\nHost web\n  HostName 203.0.113.7\n");
		const script = `import { splitRemote } from ${JSON.stringify(path.join(import.meta.dir, "remote-command.ts"))};
			console.log(JSON.stringify([splitRemote("ssh selfalias rm f").remote, splitRemote("ssh web rm f").remote]));`;
		const run = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", env: { ...process.env, HOME: fake } });
		fs.rmSync(fake, { recursive: true, force: true });
		expect(JSON.parse(run.stdout)).toEqual([[], [{ host: "web", command: "rm f" }]]);
	});

	it("real servers stay remote", () => {
		for (const [cmd, host] of [
			["ssh web1 rm f", "web1"], ["ssh 10.0.0.5 rm f", "10.0.0.5"], ["ssh deploy@203.0.113.7 rm f", "203.0.113.7"],
			["ssh [2001:db8::1] rm f", "2001:db8::1"], ["ssh ssh://root@box.example.net:2222 rm f", "box.example.net"],
		]) {
			expect(splitRemote(cmd!).remote).toEqual([{ host, command: "rm f" }]);
		}
	});

	it("an ssh option that runs a command here keeps it all local and exposes that command", () => {
		const cmd = "ssh -o ProxyCommand='rm -rf ~' host true";
		expect(splitRemote(cmd)).toEqual({ local: `${cmd}\nrm -rf ~`, remote: [] });
		const spaced = "ssh -o ' ProxyCommand=rm -rf x' foo true";
		expect(splitRemote(spaced)).toEqual({ local: `${spaced}\nrm -rf x`, remote: [] });
		expect(splitRemote("ssh -o 'ProxyCommand nc %h %p' host ls").local).toEndWith("\nnc %h %p");
		expect(splitRemote("ssh -oLocalCommand=touch\\ x -oPermitLocalCommand=yes host ls").remote).toEqual([]);
	});
});

describe("splitRemote: heredocs", () => {
	it("a body fed to ssh runs on the server", () => {
		const split = splitRemote("ssh crawlapi bash -s <<'EOF'\nrm -rf /srv/old\ndocker ps\nEOF");
		expect(split.local).toBe("ssh crawlapi\nEOF");
		expect(split.remote).toEqual([{ host: "crawlapi", command: "bash -s\nrm -rf /srv/old\ndocker ps" }]);
	});

	it("a body piped into ssh by cat runs on the server", () => {
		const split = splitRemote("cat <<EOF | ssh box bash\nrm -rf /tmp/x\nEOF");
		expect(split.local).not.toContain("rm -rf");
		expect(split.remote).toEqual([{ host: "box", command: "bash\nrm -rf /tmp/x" }]);
	});

	it("a body read by a local program on the same line stays local", () => {
		const split = splitRemote("ssh box 'cat log' | python3 - <<'EOF'\nimport os; os.remove('f')\nEOF");
		expect(split.local).toContain("os.remove('f')");
	});

	it("a heredoc on a line with no ssh is left alone", () => {
		const cmd = "bash <<'EOF'\nrm f\nEOF";
		expect(splitRemote(cmd)).toEqual({ local: cmd, remote: [] });
	});
});

describe("splitRemote: rsync", () => {
	it("--delete into a server deletes on the server", () => {
		expect(splitRemote("rsync -az --delete ./dist/ deploy@web:/srv/app/").remote).toEqual([
			{ host: "web", command: "rsync -az --delete ./dist/ deploy@web:/srv/app/" },
		]);
	});

	it("a plain ssh remote shell is still remote", () => {
		for (const cmd of ['rsync -avz -e "ssh -p 2222" --delete ./ h:/x/', "rsync -avze ssh --delete ./ h:/x/", "rsync --rsh=ssh --delete ./ h:/x/"]) {
			expect(splitRemote(cmd).remote).toEqual([{ host: "h", command: cmd }]);
		}
	});

	it("--delete into this machine, or --remove-source-files, deletes here", () => {
		for (const cmd of [
			"rsync -a --delete web:/srv/app/ ./backup/",
			"rsync -a --remove-source-files --delete ./a/ web:/b/",
			"rsync -a --delete ./a/ localhost:/b/",
			"rsync -a --delete h:src/ dst/ --exclude=a:b",
			"rsync -a --delete h:src/ dst/ --exclude a:b",
			"rsync --delete --remove-sent-files src/ h:dst/",
			"rsync --delete -e 'rm -rf x #' src/ h:dst/",
			"rsync --delete --rsh='sh -c \"rm -rf ~\"' src/ h:dst/",
		]) {
			expect(splitRemote(cmd)).toEqual({ local: cmd, remote: [] });
		}
	});
});
