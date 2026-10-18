use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::{Duration, Instant};

use searchd::engine::{Engine, Options};
use searchd::query::GrepRequest;
use searchd::selftest::{engine_with, fixture, temp_root};

const DIRS: [&str; 3] = ["repo", "repo/src", "plain"];

fn rg_lines(dir: &Path, args: &[&str]) -> BTreeSet<String> {
	let out = Command::new("rg").args(args).current_dir(dir).output().unwrap();
	String::from_utf8_lossy(&out.stdout)
		.lines()
		.map(|l| l.strip_prefix("./").unwrap_or(l).to_string())
		.collect()
}

/// Match lines, leaving out files rg reported as binary (see
/// `selftest::binary_files`: rg's lines for those depend on its buffer).
fn grep_matches(json: &[u8]) -> BTreeSet<String> {
	let events: Vec<serde_json::Value> = json.split(|&b| b == b'\n').filter_map(|l| serde_json::from_slice(l).ok()).collect();
	let binary: BTreeSet<String> = events
		.iter()
		.filter(|v| v["type"] == "end" && !v["data"]["binary_offset"].is_null())
		.filter_map(|v| v["data"]["path"]["text"].as_str().map(str::to_string))
		.collect();
	events
		.into_iter()
		.filter(|v| v["type"] == "match" && !v["data"]["path"]["text"].as_str().is_some_and(|p| binary.contains(p)))
		.map(|v| {
			let p = v["data"]["path"]["text"]
				.as_str()
				.unwrap_or("")
				.trim_start_matches("./")
				.to_string();
			format!(
				"{p}:{}:{}",
				v["data"]["line_number"],
				v["data"]["lines"]["text"].as_str().unwrap_or("")
			)
		})
		.collect()
}

/// find and grep agree with rg, right now, for every scope in DIRS.
fn agree(e: &Arc<Engine>, root: &Path, step: &str) -> Vec<String> {
	let mut bad = Vec::new();
	for d in DIRS {
		let dir = root.join(d);
		let want = rg_lines(&dir, &["--files", "--hidden", "--glob", "!.git", "--glob", "!.jj", "."]);
		match e.find(&dir, "*") {
			Ok(r) => {
				let got: BTreeSet<String> = r.paths.into_iter().collect();
				if got != want {
					bad.push(format!(
						"{step}: find {d}: missing {:?} extra {:?}",
						want.difference(&got).collect::<Vec<_>>(),
						got.difference(&want).collect::<Vec<_>>()
					));
				}
			}
			Err(reason) => bad.push(format!("{step}: find {d} fell back: {reason}")),
		}
		let out = Command::new("rg")
			.args(["--json", "--hidden", "--glob", "!.git", "--glob", "!.jj", "--", "needle", "."])
			.current_dir(&dir)
			.output()
			.unwrap();
		let want = grep_matches(&out.stdout);
		let mut buf = Vec::new();
		let req = GrepRequest {
			pattern: "needle",
			literal: false,
			ignore_case: false,
			context: 0,
			limit: u64::MAX,
		};
		match e.grep(&dir, None, &req, &mut buf) {
			Ok(_) => {
				let got = grep_matches(&buf);
				if got != want {
					bad.push(format!(
						"{step}: grep {d}: missing {:?} extra {:?}",
						want.difference(&got).collect::<Vec<_>>(),
						got.difference(&want).collect::<Vec<_>>()
					));
				}
			}
			Err(reason) => bad.push(format!("{step}: grep {d} fell back: {reason}")),
		}
	}
	bad
}

fn mutations(e: &Arc<Engine>, root: &Path) -> Vec<String> {
	let p = |r: &str| root.join(r);
	let mut bad = agree(e, root, "start");
	type Step<'a> = (&'static str, Box<dyn Fn() + 'a>);
	let steps: Vec<Step> = vec![
		(
			"create a file",
			Box::new(move || std::fs::write(p("repo/src/new.txt"), "needle new\n").unwrap()),
		),
		(
			"edit a file in place",
			Box::new(move || {
				use std::io::Write;
				let mut f = std::fs::OpenOptions::new().append(true).open(p("repo/src/main.rs")).unwrap();
				f.write_all(b"// needle appended\n").unwrap();
			}),
		),
		(
			"rename a file",
			Box::new(move || std::fs::rename(p("repo/src/new.txt"), p("repo/src/renamed.txt")).unwrap()),
		),
		(
			"delete a file",
			Box::new(move || std::fs::remove_file(p("repo/src/renamed.txt")).unwrap()),
		),
		(
			"create a folder tree",
			Box::new(move || {
				std::fs::create_dir_all(p("repo/fresh/dir")).unwrap();
				std::fs::write(p("repo/fresh/dir/f.txt"), "needle fresh\n").unwrap();
			}),
		),
		(
			"ignore it by editing .gitignore in place",
			Box::new(move || {
				use std::io::Write;
				let mut f = std::fs::OpenOptions::new().append(true).open(p("repo/.gitignore")).unwrap();
				f.write_all(b"fresh/\n").unwrap();
			}),
		),
		(
			"add a .gitignore to a subfolder",
			Box::new(move || std::fs::write(p("repo/src/.gitignore"), "*.rs\n").unwrap()),
		),
		(
			"turn a plain folder into a repo",
			Box::new(move || std::fs::create_dir_all(p("plain/.git")).unwrap()),
		),
		(
			"delete a folder tree",
			Box::new(move || std::fs::remove_dir_all(p("repo/deep")).unwrap()),
		),
		(
			"replace a file with a folder",
			Box::new(move || {
				std::fs::remove_file(p("repo/src/lib.ts")).unwrap();
				std::fs::create_dir_all(p("repo/src/lib.ts")).unwrap();
				std::fs::write(p("repo/src/lib.ts/inner.txt"), "needle inner\n").unwrap();
			}),
		),
		(
			"remove the subfolder .gitignore",
			Box::new(move || std::fs::remove_file(p("repo/src/.gitignore")).unwrap()),
		),
	];
	for (name, f) in steps {
		f();
		bad.extend(agree(e, root, name));
	}
	bad
}

#[test]
fn small_scopes_see_every_change_immediately() {
	let root = temp_root("fresh-exact");
	fixture(&root);
	let e = engine_with(&root, 50_000);
	let bad = mutations(&e, &root);
	assert!(bad.is_empty(), "{}", bad.join("\n"));
}

fn agree_on(e: &Arc<Engine>, dir: &Path, pattern: &str) {
	let out = Command::new("rg")
		.args(["--json", "--hidden", "--glob", "!.git", "--glob", "!.jj", "--", pattern, "."])
		.current_dir(dir)
		.output()
		.unwrap();
	let want = grep_matches(&out.stdout);
	assert!(!want.is_empty(), "rg finds no {pattern} either");
	let mut buf = Vec::new();
	let req = GrepRequest {
		pattern,
		literal: false,
		ignore_case: false,
		context: 0,
		limit: u64::MAX,
	};
	if let Err(reason) = e.grep(dir, None, &req, &mut buf) {
		panic!("grep {pattern} fell back: {reason}");
	}
	assert_eq!(grep_matches(&buf), want, "grep {pattern} in {}", dir.display());
}

/// `touch -r`, `rsync -a`, `cp -p` and build caches all put new text in a file
/// of the same size with the same mtime.
fn same_size_replacement(exact_max_dirs: usize, tag: &str) {
	let root = temp_root(tag);
	fixture(&root);
	let path = root.join("repo/src/replaced.txt");
	std::fs::write(&path, "needle alpha\n").unwrap();
	let e = engine_with(&root, exact_max_dirs);
	let until = std::time::Instant::now() + std::time::Duration::from_secs(30);
	while e.status()["filesPending"].as_u64() != Some(0) {
		assert!(std::time::Instant::now() < until, "the index never caught up");
		std::thread::sleep(std::time::Duration::from_millis(20));
	}
	let mtime = std::fs::metadata(&path).unwrap().modified().unwrap();
	let tmp = root.join("repo/src/replaced.new");
	std::fs::write(&tmp, "needle gamma\n").unwrap();
	std::fs::File::options().write(true).open(&tmp).unwrap().set_modified(mtime).unwrap();
	std::fs::rename(&tmp, &path).unwrap();
	assert_eq!(std::fs::metadata(&path).unwrap().modified().unwrap(), mtime);
	agree_on(&e, &root.join("repo/src"), "gamma");
}

#[test]
fn a_same_size_replacement_with_the_mtime_kept_is_seen_in_a_checked_scope() {
	same_size_replacement(50_000, "samemtime-exact");
}

#[test]
fn a_same_size_replacement_with_the_mtime_kept_is_seen_through_the_live_feed() {
	same_size_replacement(0, "samemtime-live");
}

#[test]
fn broad_scopes_see_every_change_through_the_live_feed() {
	let root = temp_root("fresh-live");
	fixture(&root);
	let e = engine_with(&root, 0);
	let mut bad = mutations(&e, &root);
	let mut misses = 0;
	for i in 0..300 {
		let name = format!("loop_{i}.txt");
		std::fs::write(root.join("repo/src").join(&name), "x\n").unwrap();
		match e.find(&root.join("repo/src"), "loop_*") {
			Ok(r) if r.paths.contains(&name) => {}
			Ok(_) => misses += 1,
			Err(reason) => bad.push(format!("loop {i} fell back: {reason}")),
		}
	}
	assert!(misses == 0, "{misses} of 300 writes were not visible to the next query");
	assert!(bad.is_empty(), "{}", bad.join("\n"));
}

/// A re-walk of the root replaces every folder id; the refresh must not go on
/// applying the old tree's ids afterwards.
#[test]
fn a_root_re_walk_does_not_apply_the_old_tree_s_ids() {
	let root = temp_root("rewalk-root");
	std::fs::create_dir_all(root.join(".git")).unwrap();
	std::fs::write(root.join(".gitignore"), b"").unwrap();
	for i in 0..40 {
		let d = root.join(format!("big/d{i:02}"));
		std::fs::create_dir_all(&d).unwrap();
		std::fs::write(d.join("f.txt"), b"needle\n").unwrap();
	}
	std::fs::create_dir_all(root.join("small")).unwrap();
	std::fs::write(root.join("small/s.txt"), b"needle small\n").unwrap();
	let e = engine_with(&root, 50_000);
	// One step changes the root's rules and another folder's listing. The
	// folder that changed sits in the subtree the re-walk drops, so its id is
	// past the end of the tree the re-walk leaves behind.
	std::fs::write(root.join(".gitignore"), b"big/\n").unwrap();
	std::fs::write(root.join("big/d39/new.txt"), b"needle new\n").unwrap();
	agree_on(&e, &root, "needle");
}

/// A burst of changes can make the kernel drop events, and the daemon then
/// rebuilds and hands queries to rg until it is done: that is not an answer, so
/// wait it out. A wrong answer fails at once.
fn when_ready<T>(e: &Arc<Engine>, f: impl Fn() -> Result<T, String>) -> T {
	let until = std::time::Instant::now() + std::time::Duration::from_secs(120);
	while std::time::Instant::now() < until {
		if e.catching_up() {
			std::thread::sleep(std::time::Duration::from_millis(50));
			continue;
		}
		match f() {
			Ok(v) => return v,
			Err(reason) if reason.contains("indexing") || reason.contains("catching up") => {
				std::thread::sleep(std::time::Duration::from_millis(50))
			}
			Err(reason) => panic!("fell back: {reason}"),
		}
	}
	panic!("the daemon never answered");
}

/// A folder tree that appears at once, as a clone or an unzip makes one: every
/// new folder is walked and listed.
#[test]
fn five_hundred_new_folders_are_walked_and_listed() {
	let root = temp_root("graft-many");
	std::fs::create_dir_all(root.join("big")).unwrap();
	let e = engine_with(&root, 50_000);
	for i in 0..500 {
		let d = root.join(format!("big/d{i}"));
		std::fs::create_dir_all(&d).unwrap();
		std::fs::write(d.join("f.txt"), b"needle\n").unwrap();
	}
	let big = root.join("big");
	let got: BTreeSet<String> = when_ready(&e, || e.find(&big, "*").map(|r| r.paths)).into_iter().collect();
	assert_eq!(got.len(), 500, "a new folder was not walked");
	let want = rg_lines(&big, &["--files", "--hidden", "--glob", "!.git", "--glob", "!.jj", "."]);
	assert_eq!(got, want);
}

/// An engine with no content index: every query reads its files itself.
fn engine_plain(root: &Path, exact_max_dirs: usize) -> Arc<Engine> {
	let e = Engine::new(Options {
		root: root.to_path_buf(),
		home: PathBuf::from("/nonexistent-home"),
		threads: 2,
		own_dir: None,
		exact_max_dirs,
		scan_first: 4,
		cookie_dir: root.join(".searchd-live"),
		content_dir: None,
		index_under: root.to_path_buf(),
		budget: searchd::content::UNLIMITED,
		quiet_window: Duration::ZERO,
		rebuild_interval: Duration::from_secs(600),
	});
	e.build(false);
	e
}

fn match_count(json: &[u8]) -> usize {
	json.split(|&b| b == b'\n')
		.filter_map(|l| serde_json::from_slice::<serde_json::Value>(l).ok())
		.filter(|v| v["type"] == "match")
		.count()
}

/// A query waits a second for the tree, then hands the search to rg: a client
/// must never sit behind a fold that is re-reading a big folder.
#[test]
fn a_query_gives_up_waiting_for_the_tree_lock_after_a_second() {
	let root = temp_root("lock-wait");
	std::fs::write(root.join("a.txt"), b"needle\n").unwrap();
	let e = engine_plain(&root, 50_000);
	assert!(e.find(&root, "*").is_ok(), "the fixture must answer before the lock is taken");
	let held = e.tree_write();
	let started = Instant::now();
	let Err(refused) = e.find(&root, "*") else { panic!("a held lock must hand the search to rg") };
	let waited = started.elapsed();
	assert!(refused.contains("busy"), "{refused}");
	assert!(waited >= Duration::from_millis(900), "gave up after {waited:?}, before the limit");
	assert!(waited < Duration::from_secs(3), "waited {waited:?}, past the limit");
	drop(held);
	assert!(e.find(&root, "*").is_ok(), "the tree answers once the lock is back");
}

/// The daemon treats any bug as fatal (its panic hook exits), so a lock must
/// never come back poisoned and leave every later query panicking too.
#[test]
fn a_panic_while_holding_the_tree_lock_does_not_poison_the_index() {
	let root = temp_root("lock-poison");
	std::fs::write(root.join("a.txt"), b"needle\n").unwrap();
	let e = engine_plain(&root, 50_000);
	assert!(e.find(&root, "*").is_ok());
	let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
		let _held = e.tree_write();
		panic!("a write that fails halfway");
	}));
	assert!(panicked.is_err(), "the test must have panicked inside the lock");
	let g = e.tree_read();
	assert!(g.as_ref().is_some(), "the tree must still be there after a panicking writer");
	drop(g);
	assert!(e.find(&root, "*").is_ok(), "a query after a panicking writer");
}

/// rg prints a name with a line break as one JSON path; the tools render each
/// line as a list entry, and one of them would not be a path.
#[test]
fn a_file_name_with_a_line_break_goes_to_rg() {
	let root = temp_root("newline-name");
	std::fs::write(root.join("plain.txt"), b"needle\n").unwrap();
	std::fs::write(root.join("a\nb.txt"), b"needle\n").unwrap();
	let e = engine_plain(&root, 50_000);
	let Err(refused) = e.find(&root, "*") else { panic!("a name with a line break must go to rg") };
	assert!(refused.contains("line break"), "{refused}");
	let mut buf = Vec::new();
	let req = GrepRequest { pattern: "needle", literal: true, ignore_case: false, context: 0, limit: u64::MAX };
	let Err(refused) = e.grep(&root, None, &req, &mut buf) else { panic!("a grep must refuse the same tree") };
	assert!(refused.contains("line break"), "{refused}");
	assert!(e.status()["globalIgnoreAnchored"].is_boolean(), "status must say whether a global rule is anchored: {}", e.status());
}

/// With `limit` the tool shows a few matches and throws the rest away; writing
/// thousands of them costs a search of every file in the scope.
#[test]
fn a_grep_writes_nothing_past_the_match_limit() {
	let root = temp_root("limit");
	std::fs::create_dir_all(root.join("src")).unwrap();
	for i in 0..100 {
		std::fs::write(root.join(format!("src/f{i:03}.txt")), b"needle one\nneedle two\nneedle three\nneedle four\nneedle five\n")
			.unwrap();
	}
	let e = engine_plain(&root, 50_000);
	let mut buf = Vec::new();
	let req = GrepRequest { pattern: "needle", literal: true, ignore_case: false, context: 0, limit: 7 };
	let out = e.grep(&root.join("src"), None, &req, &mut buf).expect("answered");
	assert_eq!(out.exit, 0);
	let written = match_count(&buf);
	assert!(written >= 7, "only {written} matches written for a limit of 7");
	assert!(written <= 7 + 4, "{written} matches written for a limit of 7");
	let want = grep_matches(
		&Command::new("rg")
			.args(["--json", "--hidden", "--glob", "!.git", "--glob", "!.jj", "--", "needle", "."])
			.current_dir(root.join("src"))
			.output()
			.unwrap()
			.stdout,
	);
	assert!(grep_matches(&buf).is_subset(&want), "{:?}", &grep_matches(&buf) - &want);
}

/// Every file in a folder deleted at once must leave exactly what rg lists.
#[test]
fn removing_half_a_folder_at_once_leaves_exactly_what_rg_lists() {
	let root = temp_root("kill-half");
	let big = root.join("big");
	std::fs::create_dir_all(&big).unwrap();
	for i in 0..2_000 {
		std::fs::write(big.join(format!("f{i:04}.txt")), b"needle\n").unwrap();
	}
	let e = engine_plain(&root, 50_000);
	assert_eq!(when_ready(&e, || e.find(&big, "*").map(|r| r.paths)).len(), 2_000);
	for i in (0..2_000).step_by(2) {
		std::fs::remove_file(big.join(format!("f{i:04}.txt"))).unwrap();
	}
	let got: BTreeSet<String> = when_ready(&e, || e.find(&big, "*").map(|r| r.paths)).into_iter().collect();
	let want = rg_lines(&big, &["--files", "--hidden", "--glob", "!.git", "--glob", "!.jj", "."]);
	assert_eq!(got, want);
	let out = Command::new("rg")
		.args(["--json", "--hidden", "--glob", "!.git", "--glob", "!.jj", "--", "needle", "."])
		.current_dir(&big)
		.output()
		.unwrap();
	let req = GrepRequest { pattern: "needle", literal: true, ignore_case: false, context: 0, limit: u64::MAX };
	let buf = when_ready(&e, || {
		let mut buf = Vec::new();
		e.grep(&big, None, &req, &mut buf).map(|_| buf)
	});
	assert_eq!(grep_matches(&buf), grep_matches(&out.stdout));
}
