//! Random mutations of a small tree, each followed by the comparison with `rg`
//! that `searchd selftest` makes, in both freshness modes. A mismatch is
//! reported with the seed and the operations that led to it, so it replays.
//!
//!   SEARCHD_FUZZ_OPS=20000 SEARCHD_FUZZ_SEED=0x1234 cargo test --release --test fuzz

use std::collections::{BTreeMap, BTreeSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use searchd::engine::{Engine, EXACT_MAX_DIRS};
use searchd::selftest::{Check, GrepCase, engine_with, find_check, grep_check, listing, temp_root};

const RG: &str = "rg";

const LITERAL: GrepCase = GrepCase { pattern: "needle_one", literal: true, ignore_case: false };
const ALTERNATION: GrepCase = GrepCase { pattern: "needle_(one|two)", literal: false, ignore_case: false };
const CASELESS: GrepCase = GrepCase { pattern: "NEEDLE", literal: false, ignore_case: true };

const NAMES: [&str; 8] = ["one.txt", "two.md", "three.rs", "four.log", "five.json", "six.tmp", "seven.dat", "na\u{ef}ve-\u{65e5}\u{672c}.txt"];
const RULES: [&str; 8] = ["*.log\n", "!keep.log\n", "*.md\n", "**/five.*\n", "build/\n", "*.tmp\n", "one.txt\n", "# nothing\n"];
const BODIES: [&[u8]; 3] = [b"needle_one\n", b"needle_two\n", b"NEEDLE_upper\n"];

fn fixture(root: &Path) {
	let write = |rel: &str, body: &[u8]| {
		let p = root.join(rel);
		std::fs::create_dir_all(p.parent().unwrap()).unwrap();
		std::fs::write(p, body).unwrap();
	};
	std::fs::create_dir_all(root.join("repo/.git")).unwrap();
	write("repo/.gitignore", b"*.log\n");
	write("repo/src/one.txt", b"needle_one here\nhaystack()\nNEEDLE_upper\n");
	write("repo/src/two.md", b"needle_two there\n");
	write("repo/src/three.rs", b"fn main() { let needle_one = 1; }\n");
	write("repo/src/four.log", b"needle_one in a skipped log\n");
	write("repo/keep.md", b"needle_two kept\n");
	write("a/x.txt", b"needle_one in a\n");
	write("a/y.md", b"needle_two in a\n");
	write("b/nested/z.md", b"NEEDLE_upper deep\n");
	write("b/plain.txt", b"nothing to see\n");
}

struct Rng(u64);

impl Rng {
	fn new(seed: u64) -> Rng {
		Rng(seed | 1)
	}

	fn next(&mut self) -> u64 {
		let mut x = self.0;
		x ^= x >> 12;
		x ^= x << 25;
		x ^= x >> 27;
		self.0 = x;
		x.wrapping_mul(0x2545_f491_4f6c_dd1d)
	}

	fn below(&mut self, n: usize) -> usize {
		(self.next() % n as u64) as usize
	}

	fn pick<T: Clone>(&mut self, xs: &[T]) -> T {
		xs[self.below(xs.len())].clone()
	}
}

struct Fuzz {
	root: PathBuf,
	rng: Rng,
	/// Folders the fuzzer made, and may lock, empty out or remove.
	made_dirs: Vec<PathBuf>,
	made_files: Vec<PathBuf>,
	/// A folder this step locked, given back once it has been compared.
	locked: Option<PathBuf>,
	steps: Vec<String>,
	serial: usize,
}

impl Fuzz {
	fn new(root: &Path, seed: u64) -> Fuzz {
		Fuzz {
			root: root.to_path_buf(),
			rng: Rng::new(seed),
			made_dirs: Vec::new(),
			made_files: Vec::new(),
			locked: None,
			steps: Vec::new(),
			serial: 0,
		}
	}

	fn dirs(&self) -> Vec<PathBuf> {
		let mut out = vec![self.root.clone(), self.root.join("repo"), self.root.join("repo/src"), self.root.join("a")];
		out.extend(self.made_dirs.iter().cloned());
		out
	}

	fn a_dir(&mut self) -> PathBuf {
		let dirs = self.dirs();
		self.rng.pick(&dirs)
	}

	fn unicode_name(&mut self) -> String {
		let n = self.rng.below(3);
		format!("\u{65e5}\u{672c}-\u{ef}ve-{n}-{}.txt", self.serial)
	}

	fn create(&mut self) -> String {
		let dir = self.a_dir();
		let name = if self.rng.below(6) == 0 { self.unicode_name() } else { self.rng.pick(&NAMES).to_string() };
		let body = self.rng.pick(&BODIES);
		let path = dir.join(&name);
		let _ = std::fs::write(&path, body);
		self.made_files.push(path.clone());
		format!("create {}", path.display())
	}

	fn edit_in_place(&mut self) -> String {
		let Some(path) = self.made_files.last().cloned() else { return "edit: nothing to edit".into() };
		let body = self.rng.pick(&BODIES);
		match std::fs::OpenOptions::new().append(true).open(&path) {
			Ok(mut f) => {
				let _ = f.write_all(body);
				format!("append {}", path.display())
			}
			Err(e) => format!("append {}: {e}", path.display()),
		}
	}

	fn same_size_rewrite(&mut self) -> String {
		let dir = self.a_dir();
		let path = dir.join("same.txt");
		let tmp = dir.join("same.new");
		let t = SystemTime::UNIX_EPOCH + Duration::from_secs(1_600_000_000);
		let (old, new): (&[u8], &[u8]) = if self.rng.below(2) == 0 {
			(b"needle_one\n", b"needle_two\n")
		} else {
			(b"needle_two\n", b"needle_one\n")
		};
		let set = |p: &Path, body: &[u8]| -> bool {
			std::fs::write(p, body).is_ok() && std::fs::File::options().write(true).open(p).is_ok_and(|f| f.set_modified(t).is_ok())
		};
		if !set(&path, old) || !set(&tmp, new) {
			return format!("same-size rewrite in {} skipped", dir.display());
		}
		let _ = std::fs::rename(&tmp, &path);
		format!("same-size rewrite {} (mtime kept)", path.display())
	}

	fn rename(&mut self, across: bool) -> String {
		let Some(from) = self.made_files.last().cloned() else { return "rename: nothing to rename".into() };
		let to = if across {
			self.a_dir().join(format!("moved-{}", self.serial))
		} else {
			from.with_file_name(format!("renamed-{}", self.serial))
		};
		match std::fs::rename(&from, &to) {
			Ok(()) => {
				*self.made_files.last_mut().unwrap() = to.clone();
				format!("rename {} -> {}", from.display(), to.display())
			}
			Err(e) => format!("rename {}: {e}", from.display()),
		}
	}

	fn delete(&mut self) -> String {
		let Some(path) = self.made_files.pop() else { return "delete: nothing to delete".into() };
		let r = std::fs::remove_file(&path);
		format!("delete {} {r:?}", path.display())
	}

	fn mkdir(&mut self) -> String {
		let dir = self.root.join(format!("mk-{}/inner/deep", self.serial));
		let _ = std::fs::create_dir_all(&dir);
		self.made_dirs.push(self.root.join(format!("mk-{}", self.serial)));
		self.made_dirs.push(dir.clone());
		let _ = std::fs::write(dir.join("leaf.txt"), self.rng.pick(&BODIES));
		format!("mkdir -p {}", dir.display())
	}

	fn rm_r(&mut self) -> String {
		if self.made_dirs.is_empty() {
			return "rm -r: nothing to remove".into();
		}
		let i = self.rng.below(self.made_dirs.len());
		let dir = self.made_dirs.swap_remove(i);
		let r = std::fs::remove_dir_all(&dir);
		self.made_dirs.retain(|d| !d.starts_with(&dir));
		self.made_files.retain(|f| !f.starts_with(&dir));
		format!("rm -r {} {r:?}", dir.display())
	}

	fn chmod(&mut self) -> String {
		if self.made_dirs.is_empty() {
			return "chmod: no folder of its own to lock".into();
		}
		let dir = self.rng.pick(&self.made_dirs);
		use std::os::unix::fs::PermissionsExt;
		let mode = if self.rng.below(2) == 0 { 0o000 } else { 0o755 };
		let r = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(mode));
		if mode == 0o000 {
			self.locked = Some(dir.clone());
		}
		format!("chmod {mode:o} {} {r:?}", dir.display())
	}

	/// Gives a folder the chmod step locked back its permissions: the comparisons
	/// just after it saw the unreadable folder, and the next operation does not.
	fn unlock(&mut self) {
		use std::os::unix::fs::PermissionsExt;
		if let Some(dir) = self.locked.take() {
			let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o755));
		}
	}

	fn ignore_file(&mut self, which: &str) -> String {
		let dir = self.a_dir();
		let path = dir.join(which);
		let op = self.rng.below(3);
		match op {
			0 => {
				let rule = self.rng.pick(&RULES);
				let _ = std::fs::create_dir_all(&dir);
				let _ = std::fs::write(&path, rule);
				format!("create {} with {rule:?}", path.display())
			}
			1 => {
				let rule = self.rng.pick(&RULES);
				let r = std::fs::OpenOptions::new().append(true).open(&path).map(|mut f| f.write_all(rule.as_bytes()));
				format!("edit {} {r:?}", path.display())
			}
			_ => {
				let r = std::fs::remove_file(&path);
				format!("delete {} {r:?}", path.display())
			}
		}
	}

	fn nested_git(&mut self) -> String {
		let dir = self.a_dir().join(".git");
		let r = std::fs::create_dir_all(&dir);
		format!("mkdir {} {r:?}", dir.display())
	}

	fn symlink(&mut self) -> String {
		let dir = self.a_dir();
		let link = dir.join(format!("link-{}", self.serial));
		let (target, what) = if self.rng.below(2) == 0 { ("one.txt", "file") } else { ("src", "folder") };
		let _ = std::fs::remove_file(&link);
		let r = std::os::unix::fs::symlink(target, &link);
		format!("symlink to {what} {} {r:?}", link.display())
	}

	fn swap_file_and_folder(&mut self) -> String {
		let dir = self.a_dir();
		let path = dir.join(format!("swap-{}", self.serial));
		if path.is_dir() {
			let _ = std::fs::remove_dir_all(&path);
			let _ = std::fs::write(&path, self.rng.pick(&BODIES));
			format!("folder -> file {}", path.display())
		} else {
			let _ = std::fs::remove_file(&path);
			let _ = std::fs::create_dir_all(&path);
			let _ = std::fs::write(path.join("inner.txt"), self.rng.pick(&BODIES));
			self.made_dirs.push(path.clone());
			format!("file -> folder {}", path.display())
		}
	}

	fn big_file(&mut self) -> String {
		let path = self.root.join("big.txt");
		let mut body = Vec::with_capacity(1_200_000);
		body.extend_from_slice(b"needle_one at the top of a file too large to index\n");
		while body.len() < 1_100_000 {
			body.extend_from_slice(b"filler line, nothing in particular\n");
		}
		let r = std::fs::write(&path, &body);
		format!("over 1 MB {} {r:?}", path.display())
	}

	fn binary_file(&mut self) -> String {
		let path = self.root.join("binary.dat");
		let r = std::fs::write(&path, b"needle_one\n\x00needle_two\n");
		format!("binary {} {r:?}", path.display())
	}

	/// One random operation; the description goes in the failure report.
	fn step(&mut self) -> String {
		self.serial += 1;
		let out = match self.rng.below(19) {
			0..=3 => self.create(),
			4 => self.edit_in_place(),
			5 => self.same_size_rewrite(),
			6 => self.rename(false),
			7 => self.rename(true),
			8 => self.delete(),
			9 => self.mkdir(),
			10 => self.rm_r(),
			11 => self.chmod(),
			12 => self.ignore_file(".gitignore"),
			13 => self.ignore_file(".ignore"),
			14 => self.nested_git(),
			15 => self.symlink(),
			16 => self.swap_file_and_folder(),
			17 => self.big_file(),
			_ => self.binary_file(),
		};
		self.steps.push(out.clone());
		out
	}
}

/// One scope's comparisons with rg, together where that is allowed: several
/// clients at once is what the daemon is for, and it keeps the run short. A
/// scope that waits for the change feed is compared one at a time, because the
/// feed's cookie is a file inside the tree being walked: rg met its own
/// toggling flag and exited 2 on it.
fn checks(engine: &Arc<Engine>, dir: &Path, all: &BTreeSet<String>, concurrent: bool) -> Vec<(&'static str, Result<bool, Check>)> {
	let run = || {
		vec![
			("find *", find_check(engine, RG, all, dir, "*")),
			("find *.txt", find_check(engine, RG, all, dir, "*.txt")),
			("find **/*.{md,rs}", find_check(engine, RG, all, dir, "**/*.{md,rs}")),
			("grep literal", grep_check(engine, RG, all, dir, None, &LITERAL, 0)),
			("grep alternation, glob *.txt", grep_check(engine, RG, all, dir, Some("*.txt"), &ALTERNATION, 0)),
			("grep case-insensitive, context 1", grep_check(engine, RG, all, dir, None, &CASELESS, 1)),
		]
	};
	if !concurrent {
		return run();
	}
	std::thread::scope(|s| {
		let find_star = s.spawn(|| find_check(engine, RG, all, dir, "*"));
		let find_txt = s.spawn(|| find_check(engine, RG, all, dir, "*.txt"));
		let find_mixed = s.spawn(|| find_check(engine, RG, all, dir, "**/*.{md,rs}"));
		let literal = s.spawn(|| grep_check(engine, RG, all, dir, None, &LITERAL, 0));
		let alternation = s.spawn(|| grep_check(engine, RG, all, dir, Some("*.txt"), &ALTERNATION, 0));
		let caseless = s.spawn(|| grep_check(engine, RG, all, dir, None, &CASELESS, 1));
		vec![
			("find *", find_star.join().unwrap()),
			("find *.txt", find_txt.join().unwrap()),
			("find **/*.{md,rs}", find_mixed.join().unwrap()),
			("grep literal", literal.join().unwrap()),
			("grep alternation, glob *.txt", alternation.join().unwrap()),
			("grep case-insensitive, context 1", caseless.join().unwrap()),
		]
	})
}

struct Tally {
	compared: usize,
	refused: BTreeMap<String, usize>,
}

impl Tally {
	fn total_refused(&self) -> usize {
		self.refused.values().sum()
	}
}

/// What rg says to stderr about the scope: on a mismatch this names the folder
/// it could not read, or the ignore file it could not parse.
fn rg_complaint(dir: &Path) -> String {
	let out = std::process::Command::new(RG)
		.args(["--files", "--hidden", "--glob", "!.git", "--glob", "!.jj", "."])
		.current_dir(dir)
		.output();
	match out {
		Ok(o) => String::from_utf8_lossy(&o.stderr).trim().replace('\n', "; "),
		Err(e) => e.to_string(),
	}
}

fn run_mode(exact_max_dirs: usize, seed: u64, steps: usize) -> Tally {
	let root = temp_root(&format!("fuzz-{exact_max_dirs}"));
	fixture(&root);
	let engine = engine_with(&root, exact_max_dirs);
	let mut f = Fuzz::new(&root, seed);
	let scopes = [root.clone(), root.join("repo"), root.join("a")];
	let mut tally = Tally { compared: 0, refused: BTreeMap::new() };
	for _ in 0..steps {
		let step = f.step();
		let dir = scopes[f.rng.below(scopes.len())].clone();
		let all = listing(RG, &dir);
		for (label, result) in checks(&engine, &dir, &all, exact_max_dirs > 0) {
			match result {
				Ok(_) => tally.compared += 1,
				Err(Check::Refused(reason)) => *tally.refused.entry(reason).or_default() += 1,
				Err(Check::Differs(msg)) => {
					let recent: Vec<&str> = f.steps.iter().rev().take(20).rev().map(String::as_str).collect();
					panic!(
						"seed {seed:#x} (exact_max_dirs {exact_max_dirs}), {label} in {}: {msg}\nrg said: {}\nlast operations:\n{}\nthis one: {step}",
						dir.display(),
						rg_complaint(&dir),
						recent.join("\n")
					);
				}
			}
		}
		f.unlock();
	}
	tally
}

fn count(name: &str, default: usize) -> usize {
	std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

fn seed() -> u64 {
	match std::env::var("SEARCHD_FUZZ_SEED") {
		Ok(v) => {
			let v = v.trim();
			match v.strip_prefix("0x").and_then(|h| u64::from_str_radix(h, 16).ok()) {
				Some(n) => n,
				None => v.parse().expect("SEARCHD_FUZZ_SEED is a number or 0x-hex"),
			}
		}
		Err(_) => std::time::SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map_or(0x9e37_79b9, |d| d.as_nanos() as u64),
	}
}

/// A comparison against a broad scope waits out the change feed's latency, so
/// it costs about eight times one against a scope checked folder by folder;
/// the operations are split by cost so both modes end together.
const LIVE_SHARE: usize = 12;
/// Four independent trees per mode, run together: they share nothing, and the
/// run is a test's.
const TREES_PER_MODE: usize = 4;

#[test]
fn every_answer_is_the_one_rg_gives_while_the_tree_changes() {
	let total = count("SEARCHD_FUZZ_OPS", 2_000);
	let seed = seed();
	let live = (total * LIVE_SHARE / 100).max(TREES_PER_MODE);
	let exact = total.saturating_sub(live).max(TREES_PER_MODE);
	let mut tallies = Vec::new();
	std::thread::scope(|s| {
		let mut handles = Vec::new();
		for (i, (mode, ops)) in [(EXACT_MAX_DIRS, exact), (0, live)].into_iter().enumerate() {
			let each = ops / TREES_PER_MODE;
			let last = ops - each * (TREES_PER_MODE - 1);
			for tree in 0..TREES_PER_MODE {
				let ops = if tree + 1 == TREES_PER_MODE { last } else { each };
				let seed = seed ^ (((i * TREES_PER_MODE + tree) as u64 + 1) * 0x9e37_79b9_7f4a_7c15);
				handles.push(s.spawn(move || run_mode(mode, seed, ops)));
			}
		}
		for h in handles {
			tallies.push(h.join().expect("a tree's run panicked; its seed is in the message"));
		}
	});
	let compared: usize = tallies.iter().map(|t| t.compared).sum();
	let refused: usize = tallies.iter().map(Tally::total_refused).sum();
	let attempts = compared + refused;
	let mut reasons: BTreeMap<&str, usize> = BTreeMap::new();
	for (reason, n) in tallies.iter().flat_map(|t| t.refused.iter()) {
		*reasons.entry(reason.as_str()).or_default() += n;
	}
	println!(
		"fuzz: seed {seed:#x}, {exact} operations checked folder by folder, {live} through the change feed; \
		 {compared} comparisons matched rg, {refused} handed to rg: {reasons:?}"
	);
	assert!(refused * 5 <= attempts, "{refused} of {attempts} comparisons were handed to rg (seed {seed:#x})");
}
