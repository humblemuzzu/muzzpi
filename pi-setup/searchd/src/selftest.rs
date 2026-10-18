use std::collections::BTreeSet;
use std::io::Read;
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::Duration;

use crate::engine::{Engine, Options};
use crate::query::GrepRequest;

pub struct Report {
	pub compared: usize,
	/// Comparisons where rg returned something (an empty result proves little).
	pub nonempty: usize,
	pub fallbacks: Vec<String>,
	pub failures: Vec<String>,
}

fn write(root: &Path, rel: &str, body: &[u8]) {
	let p = root.join(rel);
	std::fs::create_dir_all(p.parent().unwrap()).unwrap();
	std::fs::write(p, body).unwrap();
}

/// A tree with every rule rg applies to our flags exercised at least once.
pub fn fixture(root: &Path) {
	let n = b"needle\n";
	std::fs::create_dir_all(root.join("repo/.git/info")).unwrap();
	write(root, "repo/.git/info/exclude", b"excluded_by_info.txt\n");
	write(root, "repo/.git/config", b"needle in git config\n");
	write(
		root,
		"repo/.gitignore",
		b"build/\n*.log\n!keep.log\n/rootonly.txt\ndist\n*.local\nnode_modules/\n*.tmp\n",
	);
	write(root, "repo/.ignore", b"ign_by_ignore.md\n");
	write(root, "repo/.rgignore", b"rg_ignored.txt\n");
	for f in [
		"excluded_by_info.txt",
		"rootonly.txt",
		"src/rootonly.txt",
		"build/out.js",
		"dist/x.js",
		"debug.log",
		"keep.log",
	] {
		write(root, &format!("repo/{f}"), n);
	}
	for f in [
		".env.local",
		"ign_by_ignore.md",
		"rg_ignored.txt",
		"node_modules/pkg/index.js",
		".jj/repo/store",
		".hidden/h.txt",
	] {
		write(root, &format!("repo/{f}"), n);
	}
	for f in [
		"with space.txt",
		"-dash/f.txt",
		"b.tmp",
		"deep/a/b/c/d/e/f.txt",
		".claude/settings.local.json",
		".claude/other.json",
	] {
		write(root, &format!("repo/{f}"), n);
	}
	write(root, "repo/.env", b"TOKEN=needle\n");
	write(
		root,
		"repo/src/main.rs",
		b"fn main() {\n    let needle = 1;\n    haystack();\n}\n",
	);
	write(
		root,
		"repo/src/lib.ts",
		b"import { a } from './a';\nexport const needleValue = 2;\n// NEEDLE upper\n",
	);
	write(root, "repo/src/nested/.gitignore", b"secret.txt\n");
	write(root, "repo/src/nested/secret.txt", n);
	write(root, "repo/src/nested/open.txt", b"a.b(c) needle\nplain line\n");
	write(root, "repo/bin.dat", b"text needle\n\x00more needle\n");
	write(root, "repo/bin_early.dat", b"\x00needle\n");
	let mut late = b"needle before a late NUL\n".to_vec();
	late.extend(std::iter::repeat_n(&b"filler line that pads the file past rg's first 64 KB read......\n"[..], 1200).flatten());
	late.extend_from_slice(b"\x00needle after it\n");
	write(root, "repo/late_nul.txt", &late);
	write(root, "repo/crlf.txt", b"line one\r\nneedle here\r\nend\r\n");
	let mut utf16 = vec![0xFF, 0xFE];
	for u in "needle utf16\n".encode_utf16() {
		utf16.extend_from_slice(&u.to_le_bytes());
	}
	write(root, "repo/utf16.txt", &utf16);
	write(root, "repo/na\u{ef}ve.txt", "needle unicode\n".as_bytes());
	write(root, "repo/\u{65e5}\u{672c}.md", "needle \u{65e5}\u{672c}\n".as_bytes());
	write(root, "repo/kelvin.txt", "\u{212a}elvin needle\n".as_bytes());
	std::fs::create_dir_all(root.join("repo/vendor/inner/.git")).unwrap();
	write(root, "repo/vendor/inner/.gitignore", b"inner_only.txt\n");
	write(root, "repo/vendor/inner/inner_only.txt", n);
	write(root, "repo/vendor/inner/a.tmp", n);
	let _ = std::os::unix::fs::symlink("src/main.rs", root.join("repo/link_to_file"));
	let _ = std::os::unix::fs::symlink("src", root.join("repo/link_to_dir"));
	write(root, "plain/.gitignore", b"*.txt\n");
	write(root, "plain/.ignore", b"skip.md\n");
	for f in ["a.txt", "skip.md", "keep.md", "sub/deeper.md"] {
		write(root, &format!("plain/{f}"), n);
	}
	write(root, "errs/ok.txt", n);
	write(root, "errs/locked/inside.txt", n);
	std::fs::set_permissions(root.join("errs/locked"), std::fs::Permissions::from_mode(0o000)).unwrap();
}

pub fn rg(rg_bin: &str, cwd: &Path, args: &[&str]) -> (Vec<u8>, i32) {
	let out = Command::new(rg_bin)
		.args(args)
		.current_dir(cwd)
		.env_remove("RIPGREP_CONFIG_PATH")
		.output()
		.expect("rg runs");
	(out.stdout, out.status.code().unwrap_or(-1))
}

fn strip(p: &str) -> String {
	p.strip_prefix("./").unwrap_or(p).to_string()
}

/// Files rg reported as binary after printing some of their lines. Which
/// lines it printed depends on its read buffer's size, which earlier files
/// grow, so these are left out of the comparison: searchd shows none.
pub fn binary_files(json: &[u8]) -> BTreeSet<String> {
	json.split(|&b| b == b'\n')
		.filter_map(|l| serde_json::from_slice::<serde_json::Value>(l).ok())
		.filter(|v| v["type"] == "end" && !v["data"]["binary_offset"].is_null())
		.filter_map(|v| v["data"]["path"]["text"].as_str().map(strip))
		.collect()
}

/// (path, line, kind, text) for every match and context line of `rg --json`.
pub fn grep_records(json: &[u8]) -> BTreeSet<(String, u64, String, String)> {
	let mut out = BTreeSet::new();
	for l in json.split(|&b| b == b'\n').filter(|l| !l.is_empty()) {
		let Ok(v) = serde_json::from_slice::<serde_json::Value>(l) else {
			continue;
		};
		let kind = v["type"].as_str().unwrap_or("");
		if kind != "match" && kind != "context" {
			continue;
		}
		let d = &v["data"];
		let path = d["path"]["text"]
			.as_str()
			.map(strip)
			.unwrap_or_else(|| d["path"]["bytes"].to_string());
		let text = d["lines"]["text"]
			.as_str()
			.map(str::to_string)
			.unwrap_or_else(|| d["lines"]["bytes"].to_string());
		out.insert((path, d["line_number"].as_u64().unwrap_or(0), kind.to_string(), text));
	}
	out
}

pub const FIND_GLOBS: &[&str] = &[
	"*",
	"*.log",
	"**/*.txt",
	"src/**",
	"/*.md",
	"!*.txt",
	"*.{md,txt}",
	"**/build/**",
	"build",
	"**/.env*",
	"*.json",
	"**/inner/*",
	"nested/**",
	"*.dat",
	"**/*.tmp",
	"node_modules",
];

pub struct GrepCase {
	pub pattern: &'static str,
	pub literal: bool,
	pub ignore_case: bool,
}

pub const GREP_CASES: &[GrepCase] = &[
	GrepCase {
		pattern: "needle",
		literal: false,
		ignore_case: false,
	},
	GrepCase {
		pattern: "ne.dle|(foo|haystack)\\(",
		literal: false,
		ignore_case: false,
	},
	GrepCase {
		pattern: "[nN]eed(le|ful)Value?",
		literal: false,
		ignore_case: false,
	},
	GrepCase {
		pattern: r"^\s*let\s+needle",
		literal: false,
		ignore_case: false,
	},
	GrepCase {
		pattern: "utf16",
		literal: false,
		ignore_case: false,
	},
	GrepCase {
		pattern: "more needle",
		literal: true,
		ignore_case: false,
	},
	GrepCase {
		pattern: "TOKEN=",
		literal: true,
		ignore_case: true,
	},
	GrepCase {
		pattern: "NEEDLE",
		literal: false,
		ignore_case: true,
	},
	GrepCase {
		pattern: "nee+dle",
		literal: false,
		ignore_case: false,
	},
	GrepCase {
		pattern: "needle|haystack",
		literal: false,
		ignore_case: false,
	},
	GrepCase {
		pattern: "a.b(c)",
		literal: true,
		ignore_case: false,
	},
	GrepCase {
		pattern: "^fn",
		literal: false,
		ignore_case: false,
	},
	GrepCase {
		pattern: r"\bneedle\w*",
		literal: false,
		ignore_case: false,
	},
	GrepCase {
		pattern: "\u{65e5}\u{672c}",
		literal: false,
		ignore_case: false,
	},
	GrepCase {
		pattern: "kelvin",
		literal: false,
		ignore_case: true,
	},
	GrepCase {
		pattern: r"\w+\(",
		literal: false,
		ignore_case: false,
	},
];

pub const GREP_GLOBS: &[Option<&str>] = &[None, Some("*.rs"), Some("!*.txt"), Some("*.log")];

pub const DIRS: &[&str] = &[
	"",
	"repo",
	"repo/src",
	"repo/src/nested",
	"repo/vendor/inner",
	"plain",
	"repo/.hidden",
	"repo/build",
	"repo/.claude",
	"repo/link_to_dir",
	"errs",
];

/// A query the engine would not answer: rg answers it instead, which is the
/// contract, so it is not a difference.
pub enum Check {
	Refused(String),
	Differs(String),
}

fn listed(rg_bin: &str, dir: &Path, glob: Option<&str>) -> (BTreeSet<String>, i32) {
	let mut args = vec!["--files", "--hidden", "--color=never", "--glob", "!.git", "--glob", "!.jj"];
	if let Some(g) = glob {
		args.extend(["--glob", g]);
	}
	args.push(".");
	let (out, code) = rg(rg_bin, dir, &args);
	let set: BTreeSet<String> = String::from_utf8_lossy(&out)
		.lines()
		.filter(|l| !l.is_empty())
		.map(strip)
		.collect();
	(set, code)
}

/// What rg lists from `dir` with no glob: the list a glob only narrows.
pub fn listing(rg_bin: &str, dir: &Path) -> BTreeSet<String> {
	listed(rg_bin, dir, None).0
}

/// `engine.find` against rg, with the tools' contract: the glob narrows the
/// .gitignore-respecting list, and it never brings back what an ignore rule
/// skipped. Ok(did rg list anything).
pub fn find_check(engine: &Arc<Engine>, rg_bin: &str, all: &BTreeSet<String>, dir: &Path, glob: &str) -> Result<bool, Check> {
	let (with_glob, code) = listed(rg_bin, dir, Some(glob));
	let want: BTreeSet<String> = with_glob.intersection(all).cloned().collect();
	let res = engine.find(dir, glob).map_err(Check::Refused)?;
	let got: BTreeSet<String> = res.paths.into_iter().collect();
	if got != want {
		let missing: Vec<_> = want.difference(&got).collect();
		let extra: Vec<_> = got.difference(&want).collect();
		return Err(Check::Differs(format!("rg exit {code}: missing {missing:?} extra {extra:?}")));
	}
	if (res.exit == 2 || res.unreadable) != (code == 2) {
		return Err(Check::Differs(format!("exit {} unreadable {} vs rg {code}", res.exit, res.unreadable)));
	}
	Ok(!want.is_empty())
}

/// A match only a file too large for the index can be missing from: outside a
/// repo a broad grep skips those and counts them in `skippedFiles`.
fn unindexable(dir: &Path, p: &str) -> bool {
	std::fs::metadata(dir.join(p)).is_ok_and(|m| m.len() > crate::content::MAX_INDEXED)
}

/// `engine.grep` against rg, in all four of its shapes: every record, and with
/// the tool's match limit.
pub fn grep_check(
	engine: &Arc<Engine>,
	rg_bin: &str,
	all: &BTreeSet<String>,
	dir: &Path,
	glob: Option<&str>,
	case: &GrepCase,
	context: usize,
) -> Result<bool, Check> {
	let ctx = context.to_string();
	let mut args = vec!["--json", "--line-number", "--color=never", "--hidden", "--glob", "!.git", "--glob", "!.jj"];
	args.extend(["--context", &ctx]);
	if case.ignore_case {
		args.push("--ignore-case");
	}
	if case.literal {
		args.push("--fixed-strings");
	}
	if let Some(g) = glob {
		args.extend(["--glob", g]);
	}
	args.extend(["--", case.pattern, "."]);
	let (out, code) = rg(rg_bin, dir, &args);
	let req = GrepRequest {
		pattern: case.pattern,
		literal: case.literal,
		ignore_case: case.ignore_case,
		context,
		limit: u64::MAX,
	};
	let mut buf = Vec::new();
	let res = engine.grep(dir, glob, &req, &mut buf).map_err(Check::Refused)?;
	// Outside a repo an unreadable folder is skipped and reported, where rg
	// prints what it could read and exits 2.
	if (code == 2) != res.unreadable {
		return Err(Check::Differs(format!("rg exited {code} but the engine reported unreadable={}", res.unreadable)));
	}	let binary = binary_files(&out);
	let want: BTreeSet<_> = grep_records(&out).into_iter().filter(|r| all.contains(&r.0) && !binary.contains(&r.0)).collect();
	let got = grep_records(&buf);
	if want != got {
		let missing: Vec<_> = want.difference(&got).take(4).collect();
		let extra: Vec<_> = got.difference(&want).take(4).collect();
		if extra.is_empty() && res.skipped_files > 0 && missing.iter().all(|r| unindexable(dir, &r.0)) {
			return Ok(!want.is_empty());
		}
		return Err(Check::Differs(format!("missing {missing:?} extra {extra:?}")));
	}
	if res.exit != i32::from(want.is_empty()) {
		return Err(Check::Differs(format!("exit {} for {} records vs rg {code}", res.exit, want.len())));
	}
	// With a match limit (the tool's case) only some matches come back, in
	// another order: each must be one of rg's, and at least `limit` of them
	// unless rg has fewer.
	let limit = 3u64;
	let mut part = Vec::new();
	let capped = GrepRequest { limit, ..req };
	if let Ok(res) = engine.grep(dir, glob, &capped, &mut part) {
		let some = grep_records(&part);
		let matches = |s: &BTreeSet<(String, u64, String, String)>| s.iter().filter(|x| x.2 == "match").count() as u64;
		if !some.is_subset(&want) || matches(&some) < limit.min(matches(&want)) || (res.exit == 0) != !want.is_empty() {
			return Err(Check::Differs(format!(
				"limit={limit}: {} matches, not a subset of rg's {}",
				matches(&some),
				matches(&want)
			)));
		}
	}
	Ok(!want.is_empty())
}

/// Compares the engine with the `rg` binary over the fixture: every
/// (folder, glob) for find and (folder, glob, pattern, flags, context) for grep.
pub fn compare(engine: &Arc<Engine>, root: &Path, rg_bin: &str) -> Report {
	let mut r = Report {
		compared: 0,
		nonempty: 0,
		fallbacks: Vec::new(),
		failures: Vec::new(),
	};
	for d in DIRS {
		let dir = root.join(d);
		let canon = std::fs::canonicalize(&dir).unwrap_or(dir.clone());
		let all = listing(rg_bin, &canon);
		for g in FIND_GLOBS {
			let label = format!("find dir={d:?} glob={g:?}");
			match find_check(engine, rg_bin, &all, &canon, g) {
				Err(Check::Refused(reason)) => r.fallbacks.push(format!("{label}: {reason}")),
				Err(Check::Differs(msg)) => r.failures.push(format!("{label}: {msg}")),
				Ok(nonempty) => {
					r.compared += 1;
					r.nonempty += usize::from(nonempty);
				}
			}
		}
		for case in GREP_CASES {
			for glob in GREP_GLOBS {
				for context in [0usize, 1] {
					let label = format!(
						"grep dir={d:?} pattern={:?} glob={glob:?} ci={} lit={} ctx={context}",
						case.pattern, case.ignore_case, case.literal
					);
					match grep_check(engine, rg_bin, &all, &canon, *glob, case, context) {
						Err(Check::Refused(reason)) => r.fallbacks.push(format!("{label}: {reason}")),
						Err(Check::Differs(msg)) => r.failures.push(format!("{label}: {msg}")),
						Ok(nonempty) => {
							r.compared += 1;
							r.nonempty += usize::from(nonempty);
						}
					}
				}
			}
		}
	}
	r
}

/// A tree no other process can name, removed whenever it goes out of scope —
/// while a test unwinds too.
pub struct TempRoot(PathBuf);

impl std::ops::Deref for TempRoot {
	type Target = PathBuf;

	fn deref(&self) -> &PathBuf {
		&self.0
	}
}

impl Drop for TempRoot {
	fn drop(&mut self) {
		cleanup(&self.0);
	}
}

/// Gives every folder under `dir` back to the owner, so a tree a test locked
/// (the unreadable fixture, a privacy folder) can still be removed.
fn open_folders(dir: &Path) {
	let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
	let Ok(entries) = std::fs::read_dir(dir) else { return };
	for e in entries.flatten() {
		if e.file_type().is_ok_and(|t| t.is_dir()) {
			open_folders(&e.path());
		}
	}
}

fn random_suffix() -> u64 {
	let mut bytes = [0u8; 8];
	match std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut bytes)) {
		Ok(()) => u64::from_ne_bytes(bytes),
		Err(_) => std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos() as u64),
	}
}

/// A private tree for one test: 0700, and `create_dir` fails on a name already
/// taken, so a planted symlink in the temp folder is never followed.
pub fn temp_root(tag: &str) -> TempRoot {
	temp_root_under(&std::env::temp_dir(), tag)
}

/// The same under another base: the data folder needs a short path, because a
/// socket address is 104 bytes.
pub fn temp_root_under(base: &Path, tag: &str) -> TempRoot {
	loop {
		let dir = base.join(format!("searchd-{tag}-{}-{:016x}", std::process::id(), random_suffix()));
		match std::fs::DirBuilder::new().mode(0o700).create(&dir) {
			Ok(()) => return TempRoot(std::fs::canonicalize(&dir).unwrap_or(dir)),
			Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
			Err(e) => panic!("cannot create a temp root under {}: {e}", base.display()),
		}
	}
}

pub fn engine_for(root: &Path) -> Arc<Engine> {
	engine_with(root, crate::engine::EXACT_MAX_DIRS)
}

pub fn content_dir(root: &Path) -> PathBuf {
	PathBuf::from(format!("{}-content", root.display()))
}

/// An engine over `root` with its content index built, as the daemon has
/// it once warm.
pub fn engine_with(root: &Path, exact_max_dirs: usize) -> Arc<Engine> {
	let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
	let e = Engine::new(Options {
		root: root.to_path_buf(),
		home,
		threads: 4,
		own_dir: None,
		exact_max_dirs,
		// small enough that a limited grep reads some files in order and hands
		// the rest to the index, so both paths are compared with rg
		scan_first: 4,
		cookie_dir: root.join(".searchd-live"),
		content_dir: Some(content_dir(root)),
		index_under: root.to_path_buf(),
		budget: crate::content::UNLIMITED,
		quiet_window: std::time::Duration::ZERO,
		rebuild_interval: std::time::Duration::from_secs(600),
	});
	e.build(false);
	for _ in 0..600 {
		if e.content_ready.load(std::sync::atomic::Ordering::SeqCst) {
			break;
		}
		std::thread::sleep(std::time::Duration::from_millis(50));
	}
	e
}

/// Removes a tree a test built, and its content index, giving back the
/// folders inside it that the test locked.
pub fn cleanup(root: &Path) {
	open_folders(root);
	let _ = std::fs::remove_dir_all(root);
	let _ = std::fs::remove_dir_all(content_dir(root));
}

/// The parity check `install.sh` runs: a fixture tree, the engine, and the
/// `rg` on PATH must agree on every query the engine does not refuse.
pub fn run(rg_bin: &str) -> Report {
	let root = temp_root("selftest");
	fixture(&root);
	let engine = engine_for(&root);
	compare(&engine, &root, rg_bin)
}

pub enum Start {
	Serve,
	/// This build has not been checked against the rg now installed.
	Recheck,
	Exit(String),
}

/// What a daemon may do at start: serve for the rg its stamp was made with,
/// check itself against a new one first, or say why it stays silent. A stamp
/// that failed for this very pair is final: the client respawns the daemon
/// every 60 s, and a recheck each time would run forever.
pub fn start_decision(stamp: Option<&serde_json::Value>, rg: Option<&str>, searchd: &str) -> Start {
	let Some(stamp) = stamp else {
		return Start::Exit("no passing selftest recorded; run `searchd selftest --stamp`".into());
	};
	if stamp["searchd"] != searchd {
		return Start::Exit("the selftest was recorded by another searchd build; run `searchd selftest --stamp`".into());
	}
	if rg.is_none() {
		return Start::Exit("rg is missing or did not answer; there is nothing to check the index against".into());
	}
	if stamp["rg"].as_str() != rg {
		return Start::Recheck;
	}
	if stamp["ok"] == serde_json::Value::Bool(false) {
		return Start::Exit("the selftest failed against this rg; find and grep run rg instead".into());
	}
	Start::Serve
}

/// rg's version line, the one the stamp names. A hung rg is killed, not waited on.
pub fn rg_version(rg: &str) -> Option<String> {
	let child = Command::new(rg).arg("--version").stdout(Stdio::piped()).stderr(Stdio::null()).spawn().ok()?;
	let pid = child.id();
	let (tx, rx) = std::sync::mpsc::channel();
	std::thread::spawn(move || {
		let _ = tx.send(child.wait_with_output().ok());
	});
	match rx.recv_timeout(Duration::from_secs(5)) {
		Ok(Some(out)) => String::from_utf8_lossy(&out.stdout).lines().next().map(str::to_string),
		Ok(None) => None,
		Err(_) => {
			unsafe { libc::kill(pid as libc::pid_t, libc::SIGKILL) };
			None
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn stamp(rg: &str, searchd: &str, ok: bool) -> serde_json::Value {
		serde_json::json!({ "rg": rg, "searchd": searchd, "ok": ok })
	}

	#[test]
	fn a_daemon_serves_only_for_the_rg_its_selftest_was_made_with() {
		let mine = stamp("ripgrep 14.1.1", "0.5.0", true);
		assert!(matches!(start_decision(Some(&mine), Some("ripgrep 14.1.1"), "0.5.0"), Start::Serve));
		assert!(matches!(start_decision(Some(&mine), Some("ripgrep 15.0.0"), "0.5.0"), Start::Recheck));
		assert!(matches!(start_decision(Some(&mine), Some("ripgrep 14.1.1"), "0.6.0"), Start::Exit(_)));
		assert!(matches!(start_decision(Some(&mine), None, "0.5.0"), Start::Exit(_)), "a missing rg must not start a check that cannot run");
		assert!(matches!(start_decision(None, Some("ripgrep 14.1.1"), "0.5.0"), Start::Exit(_)));
		// Written before `ok` existed: a passing stamp.
		let old = serde_json::json!({ "rg": "ripgrep 14.1.1", "searchd": "0.5.0" });
		assert!(matches!(start_decision(Some(&old), Some("ripgrep 14.1.1"), "0.5.0"), Start::Serve));
	}

	/// A failed check is final for that pair: the client respawns every 60 s and
	/// must never make the daemon run the whole check again.
	#[test]
	fn a_stamp_that_failed_for_this_pair_stops_the_daemon_for_good() {
		let failed = stamp("ripgrep 14.1.1", "0.5.0", false);
		let Start::Exit(reason) = start_decision(Some(&failed), Some("ripgrep 14.1.1"), "0.5.0") else {
			panic!("a failed stamp must stop the daemon");
		};
		assert!(reason.contains("failed against this rg"), "{reason}");
		assert!(matches!(start_decision(Some(&failed), Some("ripgrep 15.0.0"), "0.5.0"), Start::Recheck));
		let gone = serde_json::json!({ "rg": "ripgrep 14.1.1", "searchd": "0.5.0" });
		assert!(matches!(start_decision(Some(&gone), Some("ripgrep 14.1.1"), "0.5.0"), Start::Serve));
	}

	/// The code needs let-chains and edition 2024, and says so.
	#[test]
	fn the_toolchain_it_needs_is_declared() {
		assert_eq!(env!("CARGO_PKG_RUST_VERSION"), "1.88");
	}

	#[test]
	fn a_hung_rg_does_not_hold_up_the_start() {
		let root = temp_root("hung-rg");
		let rg = root.join("rg");
		std::fs::write(&rg, "#!/bin/sh\nsleep 600\n").unwrap();
		std::fs::set_permissions(&rg, std::fs::Permissions::from_mode(0o755)).unwrap();
		let t = std::time::Instant::now();
		assert_eq!(rg_version(&rg.to_string_lossy()), None);
		assert!(t.elapsed() < Duration::from_secs(20), "waited {:?} on a hung rg", t.elapsed());
	}

	#[test]
	fn temp_roots_never_collide() {
		let threads: Vec<_> = (0..2)
			.map(|_| {
				std::thread::spawn(|| {
					let root = temp_root("collide");
					let mode = std::fs::metadata(&*root).unwrap().permissions().mode() & 0o777;
					assert_eq!(mode, 0o700, "a temp root must be private");
					root.to_path_buf()
				})
			})
			.collect();
		let paths: BTreeSet<PathBuf> = threads.into_iter().map(|t| t.join().unwrap()).collect();
		assert_eq!(paths.len(), 2, "two temp roots were the same name: {paths:?}");
	}

	#[test]
	fn a_panicking_test_leaves_nothing_behind() {
		let (tx, rx) = std::sync::mpsc::channel();
		let result = std::panic::catch_unwind(move || {
			let root = temp_root("panic");
			fixture(&root);
			tx.send(root.to_path_buf()).unwrap();
			panic!("a test body that fails halfway");
		});
		let path = rx.recv().unwrap();
		assert!(result.is_err(), "the test body must have panicked");
		assert!(!path.exists(), "{} was left behind", path.display());
		assert!(!content_dir(&path).exists(), "{} was left behind", content_dir(&path).display());
	}
}
