/**
 * read-only bash policy tests.
 *
 * the bypass cases are the point. permissions.json records five different ways
 * a naive `rm *` glob was beaten (`echo hi;rm f`, `for f in *; do rm $f; done`,
 * `find . -exec rm {} +`, `xargs rm < list`, …) — every one of those is a test
 * here, because a guard that only stops the obvious spelling stops nothing.
 *
 * the quoted cases matter just as much in the other direction: a guard that
 * refuses `grep "a > b"` gets switched off, and then it guards nothing.
 */

import { describe, expect, test } from "bun:test";
import {
	READ_ONLY_BASH_ENV,
	evaluateReadOnlyCommand,
	isReadOnlyBash,
	readOnlyRefusal,
	scanCommand,
	splitWords,
} from "./read-only-bash";

const allows = (cmd: string) => evaluateReadOnlyCommand(cmd).allowed;
const refuses = (cmd: string) => !evaluateReadOnlyCommand(cmd).allowed;

describe("research commands are allowed", () => {
	const allowed = [
		"ls -la src",
		"cat package.json",
		"rg --files-with-matches 'piSpawn' .",
		"grep -rn 'export function' lib/",
		"find . -name '*.ts' -not -path './node_modules/*'",
		"head -50 README.md",
		"tail -n 20 log.txt",
		"wc -l src/*.ts",
		"jq '.dependencies' package.json",
		"sort file.txt | uniq -c | sort -rn | head -20",
		"uniq -c file.txt",
		"xxd -l 64 file.png",
		"cut -d, -f2 data.csv | sort -u",
		"diff a.ts b.ts",
		"stat -f '%z' big.png",
		"du -sh node_modules",
		"tree -L 2 src",
		"echo $HOME",
		"date +%s",
		"which rg",
		"file assets/icon.png",
		"shasum -a 256 dist/bundle.js",
		"strings binary | head",
		"xxd -l 64 file.png",
		"basename /a/b/c.ts",
		"cat a.ts | wc -l",
		"ls src 2>/dev/null",
		"rg pattern . >/dev/null 2>&1",
		"ps aux | grep node",
		"sw_vers -productVersion",
		"paste -sd, list.txt",
		"paste - - < pairs.txt",
		"fold -w 80 long.txt",
		"dig +short example.com",
		"dig -x 8.8.8.8 +noall +answer",
	];
	for (const cmd of allowed) {
		test(cmd, () => expect(allows(cmd)).toBe(true));
	}
});

describe("direct mutation is refused", () => {
	const refused = [
		"rm file.txt",
		"rm -rf build",
		"mv a.ts b.ts",
		"cp a.ts b.ts",
		"mkdir newdir",
		"touch newfile",
		"chmod +x script.sh",
		"chown me file",
		"ln -s a b",
		"dd if=/dev/zero of=f",
		"truncate -s 0 file",
		"tee output.txt",
		"trash file.txt",
		"install -m 644 a b",
		"rsync -a src/ dst/",
		"paste a b > merged.txt",
		"fold -w 80 long.txt > folded.txt",
		"dig example.com > answer.txt",
	];
	for (const cmd of refused) {
		test(cmd, () => expect(refuses(cmd)).toBe(true));
	}
});

describe("separator bypasses — every form permissions.json was beaten by", () => {
	const refused = [
		"echo hi; rm f",
		"echo hi;rm f",
		"echo hi && rm f",
		"echo hi||rm f",
		"cat a | rm f",
		"for f in *; do rm $f; done",
		"find . -exec rm {} +",
		"xargs rm < list",
		"ls\nrm f",
		"echo $(rm f)",
		"echo `rm f`",
		"( rm f )",
		"{ rm f; }",
		"true && { rm f; }",
	];
	for (const cmd of refused) {
		test(JSON.stringify(cmd), () => expect(refuses(cmd)).toBe(true));
	}
});

describe("redirection", () => {
	test("writing to a file is refused", () => {
		expect(refuses("echo x > out.txt")).toBe(true);
		expect(refuses("echo x >> out.txt")).toBe(true);
		expect(refuses("ls &> out.txt")).toBe(true);
		expect(refuses("ls >| out.txt")).toBe(true);
		expect(refuses("cat <<EOF > out.txt")).toBe(true);
		expect(refuses("rg pattern . > results.md")).toBe(true);
	});

	test("/dev/null is allowed — every real command line uses it", () => {
		expect(allows("ls >/dev/null")).toBe(true);
		expect(allows("ls > /dev/null")).toBe(true);
		expect(allows("ls 2>/dev/null")).toBe(true);
		expect(allows('ls > "/dev/null"')).toBe(true);
	});

	test("fd duplication touches no file", () => {
		expect(allows("ls 2>&1")).toBe(true);
		expect(allows("ls >/dev/null 2>&1")).toBe(true);
		expect(allows("echo x >&2")).toBe(true);
	});

	test("`>&file` is a write, not a duplication", () => {
		expect(refuses("ls >&out.txt")).toBe(true);
	});

	test("the refusal names the target", () => {
		const verdict = evaluateReadOnlyCommand("echo x > secrets.txt");
		expect(verdict.reason).toContain("secrets.txt");
	});
});

describe("quotes are respected in both directions", () => {
	test("a quoted angle bracket is not a redirect", () => {
		expect(allows('grep "a > b" file.txt')).toBe(true);
		expect(allows("rg 'x->y' src/")).toBe(true);
		expect(allows(`sed -n '/a > b/p' data.txt`)).toBe(true);
		expect(allows(`jq '.items[] | select(.n > 5)' data.json`)).toBe(true);
	});

	test("a quoted separator does not open a new command", () => {
		expect(allows(`grep "a; rm b" file.txt`)).toBe(true);
		expect(allows(`rg 'foo && bar' .`)).toBe(true);
	});

	test("an UNQUOTED arrow really is a redirect, so refusing it is correct", () => {
		// bash parses `rg x->y .` as `rg x-` redirecting into `y`. this is not a
		// false positive; the shell would have created the file.
		expect(refuses("rg x->y .")).toBe(true);
	});
});

describe("interpreters and shells are not read-only commands", () => {
	const refused = [
		`node -e "require('fs').writeFileSync('f','x')"`,
		`python3 -c "open('f','w').write('x')"`,
		`perl -pi -e 's/a/b/' file`,
		"ruby -e 'File.write(\"f\",\"x\")'",
		"bash -c 'rm f'",
		"sh script.sh",
		"zsh -c 'echo x > f'",
		"eval 'rm f'",
		"exec rm f",
		"osascript -e 'do shell script \"rm f\"'",
	];
	for (const cmd of refused) {
		test(JSON.stringify(cmd.slice(0, 40)), () => expect(refuses(cmd)).toBe(true));
	}
});

describe("sed edits in place only with -i", () => {
	test("a filter is allowed", () => {
		expect(allows("sed -n '1,20p' file.ts")).toBe(true);
		expect(allows("sed 's/a/b/' file.ts")).toBe(true);
	});

	test("every -i spelling is refused", () => {
		expect(refuses("sed -i 's/a/b/' file.ts")).toBe(true);
		expect(refuses("sed -i.bak 's/a/b/' file.ts")).toBe(true);
		expect(refuses("sed -ni 's/a/b/p' file.ts")).toBe(true);
		expect(refuses("sed --in-place 's/a/b/' file.ts")).toBe(true);
	});

	test("the `w` script command writes a file with no flag involved", () => {
		// verified: `sed -n '1w out.txt' a.txt` creates out.txt.
		expect(refuses("sed -n '1w out.txt' file.ts")).toBe(true);
		expect(refuses("sed 's/a/b/w out.txt' file.ts")).toBe(true);
		expect(refuses("sed 's/a/b/gw out.txt' file.ts")).toBe(true);
		expect(refuses("sed -n '$W out.txt' file.ts")).toBe(true);
	});

	test("a `w` inside the pattern text is not a write", () => {
		expect(allows("sed 's/a w b/x/' file.ts")).toBe(true);
		expect(allows("sed -n '/warning/p' file.ts")).toBe(true);
	});
});

describe("find reports, it does not act", () => {
	test("plain traversal is allowed", () => {
		expect(allows("find src -name '*.test.ts'")).toBe(true);
		expect(allows("find . -type f -newer package.json")).toBe(true);
	});

	test("acting primaries are refused", () => {
		expect(refuses("find . -name '*.log' -delete")).toBe(true);
		expect(refuses("find . -exec cat {} \\;")).toBe(true);
		expect(refuses("find . -execdir rm {} +")).toBe(true);
		expect(refuses("find . -ok rm {} \\;")).toBe(true);
		expect(refuses("find . -fprint out.txt")).toBe(true);
	});
});

describe("awk is an interpreter, so it is excluded like perl and python", () => {
	// an earlier version allowlisted awk and guarded only its `>` redirects.
	// that guard was theatre: `awk 'BEGIN{system("touch f")}'` creates f, verified
	// by running it. a language with system() belongs with node -e, not with cut.
	const refused = [
		`awk 'BEGIN{system("rm f")}'`,
		`awk '{ print > "out.txt" }' data.txt`,
		`awk '{ print $2 }' data.txt`,
		"gawk '{ print }' f",
		"mawk '{ print }' f",
	];
	for (const cmd of refused) {
		test(JSON.stringify(cmd.slice(0, 40)), () => expect(refuses(cmd)).toBe(true));
	}
});

describe("write flags on commands that otherwise only read", () => {
	// EVERY case here was verified by running the command on this machine and
	// confirming the file appeared. a command name is not a capability.
	test("sort -o writes a file", () => {
		expect(refuses("sort -o out.txt in.txt")).toBe(true);
		expect(refuses("sort --output=out.txt in.txt")).toBe(true);
		expect(allows("sort -rn in.txt")).toBe(true);
	});

	test("base64 -o writes a file (macOS spelling)", () => {
		expect(refuses("base64 -o out.txt -i in.png")).toBe(true);
		expect(allows("base64 -i in.png")).toBe(true);
	});

	test("tree -o writes its listing to a file", () => {
		expect(refuses("tree -o out.txt src")).toBe(true);
		expect(allows("tree -L 2 src")).toBe(true);
	});

	test("yq -i edits in place, exactly like sed -i", () => {
		expect(refuses("yq -i '.a = 1' f.yaml")).toBe(true);
		expect(refuses("yq --inplace '.a = 1' f.yaml")).toBe(true);
		expect(allows("yq '.a' f.yaml")).toBe(true);
	});

	test("fd -x executes an arbitrary command per match", () => {
		expect(refuses("fd -e txt -x rm")).toBe(true);
		expect(refuses("fd -e txt -X rm")).toBe(true);
		expect(refuses("fd --exec rm")).toBe(true);
		expect(allows("fd -e ts src")).toBe(true);
	});

	test("rg --pre runs a preprocessor command on every file", () => {
		expect(refuses("rg --pre /bin/rm pattern .")).toBe(true);
		expect(allows("rg --pretty pattern .")).toBe(true);
	});

	test("curl -K reads a config that can name an output file", () => {
		expect(refuses("curl -K cfg https://example.com")).toBe(true);
		expect(refuses("curl --config cfg https://example.com")).toBe(true);
	});

	test("git grep -O opens matches in a pager, i.e. runs a command", () => {
		expect(refuses("git grep -O pattern")).toBe(true);
	});
});

describe("a second operand that is really an output file", () => {
	test("uniq IN OUT writes OUT", () => {
		expect(refuses("uniq in.txt out.txt")).toBe(true);
		expect(allows("uniq in.txt")).toBe(true);
		expect(allows("uniq -c in.txt")).toBe(true);
		expect(allows("uniq -f 2 in.txt")).toBe(true);
	});

	test("xxd IN OUT writes OUT", () => {
		expect(refuses("xxd in.bin out.txt")).toBe(true);
		expect(allows("xxd in.bin")).toBe(true);
	});

	test("a flag's VALUE is not counted as an operand", () => {
		// `xxd -l 64 f` is one file and a length; counting 64 as a file would
		// refuse an ordinary read and make the guard something to switch off.
		expect(allows("xxd -l 64 file.png")).toBe(true);
		expect(allows("xxd -s 100 -l 32 file.png")).toBe(true);
		expect(allows("uniq -w 10 file.txt")).toBe(true);
	});
});

describe("command substitution inside DOUBLE quotes", () => {
	/*
	 * the worst hole in the first version, and the least visible: it needed no
	 * special flag, so every allowlisted command taking a quoted argument was a
	 * way through. verified live \u2014 bash created the file in both double-quoted
	 * forms and did NOT in the single-quoted one.
	 */
	test("$( ) inside double quotes is refused", () => {
		expect(refuses('echo "$(rm f)"')).toBe(true);
		expect(refuses('grep "$(rm f)" file.txt')).toBe(true);
		expect(refuses('rg "prefix $(rm f) suffix" .')).toBe(true);
	});

	test("backticks inside double quotes are refused", () => {
		expect(refuses('echo "`rm f`"')).toBe(true);
		expect(refuses('printf "%s" "`rm f`"')).toBe(true);
	});

	test("SINGLE quotes really are inert, so they stay allowed", () => {
		// verified: bash does not substitute inside single quotes, so refusing
		// these would be a false positive on a legitimate literal search.
		expect(allows(`echo '$(rm f)'`)).toBe(true);
		expect(allows(`rg '$(foo)' src/`)).toBe(true);
		expect(allows("grep '`backtick`' file.txt")).toBe(true);
	});

	test("an escaped substitution in double quotes is literal and stays allowed", () => {
		expect(allows('echo "\\$(rm f)"')).toBe(true);
	});

	test("a read inside double-quoted substitution still works", () => {
		expect(allows('echo "$(git rev-parse HEAD)"')).toBe(true);
	});
});

describe("man's pager is an exec vector and is not tty-gated", () => {
	// verified: `man -P "sh -c 'touch f; cat'" ls` created f even with stdout
	// piped, unlike git's pager which really is tty-gated.
	test("-P and --pager are refused", () => {
		expect(refuses(`man -P "sh -c 'rm f'" ls`)).toBe(true);
		expect(refuses("man --pager=rm ls")).toBe(true);
	});

	test("a plain man page is still allowed", () => {
		expect(allows("man sed")).toBe(true);
	});
});

describe("git read subcommands that mutate given the right operands", () => {
	test("symbolic-ref queries with one operand and WRITES with two", () => {
		expect(allows("git symbolic-ref HEAD")).toBe(true);
		expect(refuses("git symbolic-ref HEAD refs/heads/pwned")).toBe(true);
		expect(refuses("git symbolic-ref -d HEAD")).toBe(true);
	});

	test("reflog lists, but delete and expire prune history", () => {
		expect(allows("git reflog")).toBe(true);
		expect(allows("git reflog show HEAD")).toBe(true);
		expect(refuses("git reflog delete HEAD@{0}")).toBe(true);
		expect(refuses("git reflog expire --expire=now --all")).toBe(true);
	});
});

describe("sed's e command executes (GNU only \u2014 portability guard)", () => {
	test("the e command and s///e flag are refused", () => {
		expect(refuses("sed '1e touch f' file.txt")).toBe(true);
		expect(refuses("sed 's/a/b/e' file.txt")).toBe(true);
	});

	test("an 'e' inside pattern text is not the e command", () => {
		expect(allows("sed -n '/error/p' file.txt")).toBe(true);
		expect(allows("sed 's/foo/bare/' file.txt")).toBe(true);
	});
});

describe("process substitution runs a command the outer name hides", () => {
	// verified: `diff <(touch f) x` creates f. before `<(` was treated as a
	// command boundary the scanner saw only `diff`, which is allowlisted.
	test("a write inside <( ) is refused even under an allowed command", () => {
		expect(refuses("diff <(rm f) other.txt")).toBe(true);
		expect(refuses("cat <(sed -i '' s/a/b/ f)")).toBe(true);
		expect(refuses("comm <(sort a) <(rm b)")).toBe(true);
	});

	test("a read inside <( ) still works", () => {
		expect(allows("diff <(git log --oneline -5) <(git log --oneline -5)")).toBe(true);
		expect(allows("comm <(sort a.txt) <(sort b.txt)")).toBe(true);
	});

	test("a write inside >( ) is refused", () => {
		expect(refuses("cat f >(rm x)")).toBe(true);
	});
});

describe("git: read subcommands only", () => {
	const allowed = [
		"git log --oneline -20",
		"git log -1 --format=%H",
		"git show HEAD:src/index.ts",
		"git diff main...HEAD",
		"git diff --stat",
		"git status --short",
		"git blame -L 10,40 src/index.ts",
		"git ls-files 'src/**/*.ts'",
		"git rev-parse HEAD",
		"git grep -n 'piSpawn'",
		"git shortlog -sn",
		"git cat-file -p HEAD",
		"git reflog",
		"git merge-base main HEAD",
		"git remote",
		"git remote -v",
		"git branch",
		"git branch --list",
		"git branch -a",
		"git tag --list",
		"git stash list",
		"git worktree list",
		"git config --get user.email",
		"git submodule status",
	];
	for (const cmd of allowed) {
		test(`allows ${cmd}`, () => expect(allows(cmd)).toBe(true));
	}

	const refused = [
		"git commit -m 'x'",
		"git add .",
		"git push origin main",
		"git checkout main",
		"git switch -c feature",
		"git reset --hard",
		"git clean -fd",
		"git rebase main",
		"git merge feature",
		"git cherry-pick abc123",
		"git restore src/",
		"git branch -d feature",
		"git branch -D feature",
		"git tag v1.0.0",
		"git remote add upstream url",
		"git remote set-url origin url",
		"git config user.email me@example.com",
		"git stash",
		"git stash pop",
		"git worktree add /tmp/wt",
		"git submodule update --init",
		"git notes add -m x",
		"git apply patch.diff",
		"git am patch.eml",
		"git gc",
		"git",
	];
	for (const cmd of refused) {
		test(`refuses ${cmd}`, () => expect(refuses(cmd)).toBe(true));
	}

	test("`git diff --output=<file>` really writes a file", () => {
		expect(refuses("git diff --output=out.patch")).toBe(true);
		expect(refuses("git diff --output out.patch")).toBe(true);
		expect(refuses("git log -o out.txt")).toBe(true);
	});

	test("bare `git stash` PUSHES — it is not the read case bare `git remote` is", () => {
		expect(refuses("git stash")).toBe(true);
		expect(allows("git remote")).toBe(true);
	});
});

describe("git global options are parsed, not mistaken for the subcommand", () => {
	const allowed = [
		"git -C . log -1",
		"git -C /some/repo status --short",
		"git -C .. stash list",
		"git --git-dir=.git log --oneline",
		"git --git-dir .git --work-tree . diff --stat",
		"git --no-pager log -5",
		"git -P show HEAD",
		"git -C . --no-pager blame -L 1,5 f.ts",
	];
	for (const cmd of allowed) {
		test(`allows ${cmd}`, () => expect(allows(cmd)).toBe(true));
	}

	const refused = [
		// config names commands git runs: fsmonitor, pager, aliases
		"git -c core.fsmonitor=evil status",
		"git -c core.pager=evil log",
		"git -c alias.x=!evil x",
		"git --config-env=core.pager=EVIL log",
		"git --exec-path=/tmp/evil status",
		"git --unknown-global log",
		"git -C . commit -m x",
		"git -C . stash",
		"git -C",
	];
	for (const cmd of refused) {
		test(`refuses ${cmd}`, () => expect(refuses(cmd)).toBe(true));
	}

	test("the refusal names the real subcommand or option, never the -C path", () => {
		expect(evaluateReadOnlyCommand("git -C . commit -m x").reason).toBe("`git commit` can modify the repository");
		expect(evaluateReadOnlyCommand("git -c core.pager=x log").reason).toContain("git global option `-c`");
	});

	test("a mutating word inside the -C path is not mistaken for a mutation", () => {
		expect(allows("git -C ./delete log -1")).toBe(true);
	});
});

describe("write flags are matched in every spelling getopt accepts", () => {
	const refused = [
		"sort -oout.txt in.txt",
		"sort -o out.txt in.txt",
		"sort -ro out.txt in.txt",
		"sort --output=out.txt in.txt",
		"sort --out=out.txt in.txt",
		"sort --o=out.txt in.txt",
		"curl -sSo page.html https://example.com",
		"curl -oX https://example.com",
		"curl -sd 'a=1' https://example.com",
		"base64 -oout.b64 -i in",
		"tree -ofile.txt",
		"fd -xrm",
		"rg --pre=evil x",
		"yq -i '.a=1' f.yaml",
	];
	for (const cmd of refused) {
		test(`refuses ${cmd}`, () => expect(refuses(cmd)).toBe(true));
	}

	const allowed = [
		"sort -rn f",
		"sort -k2,2n f",
		"sort -u -t, -k1 f",
		"curl -sSL https://example.com",
		"curl -fsSL https://example.com",
		"rg --pretty x",
		"rg --pcre2 x",
		"rg --hidden x",
		"fd -H -e ts",
	];
	for (const cmd of allowed) {
		test(`allows ${cmd}`, () => expect(allows(cmd)).toBe(true));
	}
});

describe("sed scripts are found wherever they are written", () => {
	const refused = [
		"sed --expression='1w out' f",
		"sed --expression '1w out' f",
		"sed -e '1w out' f",
		"sed -e'1w out' f",
		"sed -ne '1w out' f",
		"sed -n -e p -e '1w out' f",
		"sed -f script.sed f",
		"sed -nf script.sed f",
		"sed --file=script.sed f",
	];
	for (const cmd of refused) {
		test(`refuses ${cmd}`, () => expect(refuses(cmd)).toBe(true));
	}

	const allowed = ["sed -n '1,5p' f", "sed -e 's/a/b/' f", "sed -E 's/(a)/\\1/' f", "sed --expression='s/a/b/' f"];
	for (const cmd of allowed) {
		test(`allows ${cmd}`, () => expect(allows(cmd)).toBe(true));
	}
});

describe("sed scripts are parsed command by command", () => {
	const refused = [
		"sed -n 'wout' in",
		"sed '1wout' in",
		"sed 's/a/b/wout' in",
		"sed 's|a|b|w out' in",
		"sed -n '/re/w out' in",
		"sed -n '/a/,/b/wout' in",
		"sed -n '1!wout' in",
		"sed -n 'p;wout' in",
		"sed '{wout}' in",
		"sed 's/a/b/gw out' in",
		"sed 'y/ab/xy/;wout' in",
		"sed 's/a/b/e' in",
		"sed '1e date' in",
	];
	for (const cmd of refused) {
		test(`refuses ${cmd}`, () => expect(refuses(cmd)).toBe(true));
	}

	const allowed = [
		"sed 's/a w b/x/' in",
		"sed 's/x/wout/' in",
		"sed -n '/write/p' in",
		"sed 's/\\/w/x/' in",
		"sed -n p words.txt",
		"sed -e p write.log",
		"sed 'y/w/x/' in",
	];
	for (const cmd of allowed) {
		test(`allows ${cmd}`, () => expect(allows(cmd)).toBe(true));
	}
});

describe("long-option abbreviations count only where the command accepts them", () => {
	test("sort and base64 parse with getopt_long, so a prefix is the option", () => {
		expect(refuses("sort --out=x in")).toBe(true);
		expect(refuses("base64 --out=x -i in")).toBe(true);
	});

	test("curl takes no abbreviations: --cookie is not --cookie-jar", () => {
		expect(allows("curl --cookie a=b https://example.com")).toBe(true);
	});

	test("curl's other file-writing and body-sending options are refused", () => {
		for (const flag of ["--remote-name-all", "--json '{}'", "--libcurl x.c", "--stderr e.txt", "--etag-save e"]) {
			expect(refuses(`curl ${flag} https://example.com`)).toBe(true);
		}
	});
});

describe("git info flags need no subcommand", () => {
	for (const cmd of ["git --version", "git -v", "git --help"]) {
		test(`allows ${cmd}`, () => expect(allows(cmd)).toBe(true));
	}
});

describe("positional output counts operands the way each command parses flags", () => {
	test("uniq's getopt bundle ending in a value flag consumes the value", () => {
		expect(allows("uniq -cf 2 in.txt")).toBe(true);
		expect(refuses("uniq -cf 2 in.txt out.txt")).toBe(true);
	});

	test("xxd's -ps is one option, so it cannot hide an output operand", () => {
		expect(allows("xxd -ps in.bin")).toBe(true);
		expect(refuses("xxd -ps in.bin out.txt")).toBe(true);
	});
});

describe("curl fetches but does not write or mutate", () => {
	test("a plain fetch is allowed", () => {
		expect(allows("curl -s https://example.com")).toBe(true);
		expect(allows("curl -sSL http://127.0.0.1:3000/health")).toBe(true);
	});

	test("writing and sending are refused", () => {
		expect(refuses("curl -o page.html https://example.com")).toBe(true);
		expect(refuses("curl -O https://example.com/f.zip")).toBe(true);
		expect(refuses("curl --output page.html https://example.com")).toBe(true);
		expect(refuses("curl -X POST https://example.com")).toBe(true);
		expect(refuses("curl -d 'a=1' https://example.com")).toBe(true);
		expect(refuses("curl --data-binary @f https://example.com")).toBe(true);
		expect(refuses("curl -T upload.txt https://example.com")).toBe(true);
	});
});

describe("assorted escape hatches", () => {
	test("a path-qualified binary is the same binary", () => {
		expect(refuses("/bin/rm file")).toBe(true);
		expect(refuses("/usr/bin/tee out.txt")).toBe(true);
		expect(allows("/bin/ls -la")).toBe(true);
	});

	test("sudo is not a read-only command", () => {
		expect(refuses("sudo ls")).toBe(true);
		expect(refuses("sudo rm -rf /")).toBe(true);
	});

	test("leading assignments do not hide the command", () => {
		expect(allows("FOO=1 ls")).toBe(true);
		expect(refuses("FOO=1 rm f")).toBe(true);
	});

	test("env may print but not run", () => {
		expect(allows("env")).toBe(true);
		expect(allows("env FOO=1")).toBe(true);
		expect(refuses("env FOO=1 rm f")).toBe(true);
	});

	test("cd is allowed — bash.ts splits `cd x && cmd` before this runs", () => {
		expect(allows("cd src")).toBe(true);
	});

	test("an unknown binary fails closed", () => {
		expect(refuses("some-tool-nobody-listed --go")).toBe(true);
		const verdict = evaluateReadOnlyCommand("some-tool-nobody-listed --go");
		expect(verdict.reason).toContain("some-tool-nobody-listed");
	});
});

describe("scanner internals", () => {
	test("command substitution opens a new command position", () => {
		expect(scanCommand("echo $(git log)").segments).toContain("git log)");
	});

	test("words are split with quotes stripped", () => {
		expect(splitWords(`rg "two words" -n src`)).toEqual(["rg", "two words", "-n", "src"]);
		expect(splitWords(`awk '{ print $1 }' f`)).toEqual(["awk", "{ print $1 }", "f"]);
	});

	test("an empty command is allowed rather than crashing", () => {
		expect(allows("")).toBe(true);
		expect(allows("   ")).toBe(true);
	});
});

describe("the switch and the refusal text", () => {
	test("off unless the env var is exactly 1", () => {
		expect(isReadOnlyBash({} as NodeJS.ProcessEnv)).toBe(false);
		expect(isReadOnlyBash({ [READ_ONLY_BASH_ENV]: "0" } as any)).toBe(false);
		expect(isReadOnlyBash({ [READ_ONLY_BASH_ENV]: "true" } as any)).toBe(false);
		expect(isReadOnlyBash({ [READ_ONLY_BASH_ENV]: "1" } as any)).toBe(true);
	});

	test("the refusal names the cause, the command, and the way forward", () => {
		const text = readOnlyRefusal("`rm` is not a read-only command", "rm -rf build");
		expect(text).toContain("rm -rf build");
		expect(text).toContain("not a read-only command");
		expect(text).toMatch(/main agent/);
		// it must not read as a bug the agent should work around
		expect(text).toMatch(/Do not route around/);
	});
});
