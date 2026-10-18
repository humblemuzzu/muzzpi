use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use searchd::content::{Budget, UNLIMITED};
use searchd::engine::{Engine, Options};
use searchd::query::GrepRequest;
use searchd::selftest::{content_dir, temp_root};

fn write(root: &Path, rel: &str, body: &[u8]) {
	let p = root.join(rel);
	std::fs::create_dir_all(p.parent().unwrap()).unwrap();
	std::fs::write(p, body).unwrap();
}

fn engine(root: &Path, exact_max_dirs: usize, budget: Budget, quiet: Duration) -> Arc<Engine> {
	let e = Engine::new(Options {
		root: root.to_path_buf(),
		home: PathBuf::from("/nonexistent-home"),
		threads: 4,
		own_dir: None,
		exact_max_dirs,
		scan_first: 4,
		cookie_dir: root.join(".searchd-live"),
		content_dir: Some(content_dir(root)),
		index_under: root.to_path_buf(),
		budget,
		quiet_window: quiet,
		rebuild_interval: std::time::Duration::from_secs(600),
	});
	e.build(false);
	wait_for(&e, |e| e.content_ready.load(Ordering::SeqCst), "the content index");
	e
}

fn wait_for(e: &Arc<Engine>, done: impl Fn(&Arc<Engine>) -> bool, what: &str) {
	let until = Instant::now() + Duration::from_secs(60);
	while Instant::now() < until {
		if done(e) {
			return;
		}
		std::thread::sleep(Duration::from_millis(20));
	}
	panic!("timed out waiting for {what}");
}

fn seg_files(root: &Path) -> usize {
	std::fs::read_dir(content_dir(root))
		.into_iter()
		.flatten()
		.flatten()
		.filter(|e| e.file_name().to_string_lossy().starts_with("seg-"))
		.count()
}

fn grep(e: &Arc<Engine>, dir: &Path, pattern: &str) -> Result<(String, usize), String> {
	let mut buf = Vec::new();
	let req = GrepRequest {
		pattern,
		literal: false,
		ignore_case: false,
		context: 0,
		limit: u64::MAX,
	};
	let r = e.grep(dir, None, &req, &mut buf)?;
	Ok((String::from_utf8_lossy(&buf).into_owned(), r.skipped_files))
}

/// A cap that leaves no room for a segment.
fn capped() -> Budget {
	Budget {
		free_floor: 0,
		free_percent: 0,
		cap: 0,
	}
}

fn num(v: &serde_json::Value, key: &str) -> u64 {
	v[key].as_u64().unwrap_or_else(|| panic!("{key} is not a number in {v}"))
}

/// A cap that leaves no room for a segment blocks the index; the files stay
/// unindexed, a repo reads them live and a broad grep skips and counts them.
#[test]
fn an_index_over_its_cap_writes_nothing_and_says_what_it_skips() {
	let root = temp_root("cap");
	std::fs::create_dir_all(root.join("r/.git")).unwrap();
	write(&root, "r/in.txt", b"needle_in_repo\n");
	write(&root, "loose.txt", b"needle_loose\n");
	let e = engine(&root, 50_000, capped(), Duration::ZERO);
	let st = e.status();
	assert_eq!(st["indexBlocked"], "cap", "{st}");
	assert_eq!(num(&st, "segments"), 0);
	assert_eq!(num(&st, "filesIndexed"), 0);
	assert_eq!(num(&st, "filesPending"), 2);
	let (out, _) = grep(&e, &root.join("r"), "needle_in_repo").expect("a repo is answered");
	assert!(out.contains("in.txt"), "an unindexed file in a repo is read live: {out:?}");

	let broad = engine(&root, 0, capped(), Duration::ZERO);
	let st = broad.status();
	assert_eq!(st["indexBlocked"], "cap", "{st}");
	let (out, skipped) = grep(&broad, &root, "needle").expect("a broad scope is answered");
	assert_eq!(skipped, 2, "both unindexed files must be counted as skipped: {out:?}");
	assert!(out.is_empty(), "a broad grep must not read what it cannot index: {out:?}");
	assert_eq!(seg_files(&root), 0, "a segment was written past the cap");
}

/// A floor above the free space blocks the index too, and nothing is read
/// again on the next indexer wake.
#[test]
fn a_full_disk_blocks_indexing_and_is_not_retried_in_a_loop() {
	let root = temp_root("floor");
	write(&root, "a.txt", b"needle a\n");
	write(&root, "b.txt", b"needle b\n");
	let e = engine(
		&root,
		50_000,
		Budget {
			free_floor: u64::MAX,
			free_percent: 0,
			cap: u64::MAX,
		},
		Duration::ZERO,
	);
	let st = e.status();
	assert_eq!(st["indexBlocked"], "disk", "{st}");
	assert_eq!(num(&st, "filesIndexed"), 0);
	assert_eq!(num(&st, "segments"), 0);
	e.poke_indexer();
	std::thread::sleep(Duration::from_millis(500));
	assert_eq!(num(&e.status(), "filesIndexed"), 0, "the indexer read the files again");
	assert_eq!(seg_files(&root), 0, "a segment was written with no room for it");
}

/// A file still being written is not read for the index until it has been
/// still for the quiet window; until then greps read it live.
#[test]
fn a_file_still_being_written_is_indexed_only_after_it_settles() {
	let root = temp_root("quiet");
	std::fs::create_dir_all(root.join(".git")).unwrap();
	let path = root.join("a.txt");
	std::fs::write(&path, "needle 0\n").unwrap();
	let e = engine(&root, 50_000, UNLIMITED, Duration::from_secs(1));
	let settled = num(&e.status(), "filesIndexed");
	for i in 1..=54u32 {
		std::fs::write(&path, format!("needle {i}\n")).unwrap();
		if i % 9 == 0 {
			let out = grep(&e, &root, &format!("needle {i}")).expect("answered");
			assert!(out.0.contains("a.txt") && out.0.contains(&format!("needle {i}")), "the newest text must be found: {:?}", out.0);
		}
		std::thread::sleep(Duration::from_millis(120));
	}
	assert_eq!(
		num(&e.status(), "filesIndexed"),
		settled,
		"a file that keeps changing was read for the index"
	);
	wait_for(&e, |e| num(&e.status(), "filesIndexed") > settled, "the settled file to be indexed");
}

/// Random printable text: nearly every 3-byte window is a distinct trigram, so
/// a file holds close to one trigram pair per byte.
fn random_text(len: usize, seed: &mut u64) -> Vec<u8> {
	let alphabet: Vec<u8> = (1..=255u8).collect();
	let mut out = Vec::with_capacity(len);
	for _ in 0..len {
		*seed ^= *seed << 13;
		*seed ^= *seed >> 7;
		*seed ^= *seed << 17;
		out.push(alphabet[(*seed >> 32) as usize % alphabet.len()]);
	}
	out
}

/// A batch is cut by its trigram pairs as well as by its bytes: 10 MB of
/// dense text is one segment's worth of bytes but two of pairs.
#[test]
fn a_batch_is_cut_by_its_trigram_pairs() {
	let root = temp_root("pairs");
	std::fs::create_dir_all(root.join(".git")).unwrap();
	let mut seed = 0x9e37_79b9_7f4a_7c15u64;
	for i in 0..10 {
		write(&root, &format!("dense{i}.txt"), &random_text(1 << 20, &mut seed));
	}
	write(&root, "small.txt", b"unique_needle_token\n");
	let e = engine(&root, 50_000, UNLIMITED, Duration::ZERO);
	wait_for(&e, |e| num(&e.status(), "filesIndexed") == 11, "all 11 files to be indexed");
	let segments = num(&e.status(), "segments");
	assert!(segments >= 2, "10 MB of dense text went into {segments} segment(s): no pair limit");
	let out = grep(&e, &root, "unique_needle_token").expect("answered");
	assert!(out.0.contains("small.txt"), "the indexed file must still be found: {:?}", out.0);
}

/// A damaged segment is dropped on open, so a tree whose index was damaged
/// still answers exactly what rg answers.
#[test]
fn a_tree_whose_index_is_damaged_still_answers_like_rg() {
	let root = temp_root("damaged-tree");
	std::fs::create_dir_all(root.join("repo/.git")).unwrap();
	write(&root, "repo/a.txt", b"a needle here\n");
	write(&root, "repo/b.txt", b"nothing here\n");
	let e = engine(&root, 50_000, UNLIMITED, Duration::ZERO);
	wait_for(&e, |e| num(&e.status(), "filesIndexed") == 2, "the two files to be indexed");
	let mut damaged = 0;
	for entry in std::fs::read_dir(content_dir(&root)).unwrap().flatten() {
		let mut bytes = std::fs::read(entry.path()).unwrap();
		if bytes.len() < 60 {
			continue;
		}
		let at = 44 + (bytes.len() - 44) / 2;
		bytes[at] ^= 0xff;
		// Rewritten in place, not truncated: the running daemon has it mapped.
		let mut f = std::fs::OpenOptions::new().write(true).open(entry.path()).unwrap();
		f.write_all(&bytes).unwrap();
		damaged += 1;
	}
	assert!(damaged > 0, "no segment was written to damage");
	let e = engine(&root, 50_000, UNLIMITED, Duration::ZERO);
	let out = grep(&e, &root.join("repo"), "needle").expect("answered");
	assert!(out.0.contains("a.txt"), "the match must be found: {:?}", out.0);
	let rg = std::process::Command::new("rg")
		.args(["--json", "--hidden", "--glob", "!.git", "--glob", "!.jj", "--", "needle", "."])
		.current_dir(root.join("repo"))
		.output()
		.unwrap();
	let matches = |b: &[u8]| {
		b.split(|&x| x == b'\n')
			.filter_map(|l| serde_json::from_slice::<serde_json::Value>(l).ok())
			.filter(|v| v["type"] == "match")
			.count()
	};
	assert_eq!(matches(out.0.as_bytes()), matches(&rg.stdout), "not what rg answers");
}

/// A long literal is one trigram term per window; the index decodes only the
/// rarest few of them, and still finds exactly the files rg finds.
#[test]
fn a_long_literal_finds_every_file_that_holds_it() {
	let root = temp_root("long-literal");
	std::fs::create_dir_all(root.join("r/.git")).unwrap();
	let literal = "the quick brown fox jumps over the lazy dog and keeps on running past the barn at dawn";
	assert!(literal.len() >= 80);
	write(&root, "r/holds.txt", format!("{literal}\n").as_bytes());
	write(&root, "r/nearly.txt", &literal.as_bytes()[1..]);
	write(&root, "r/other.txt", b"nothing here\n");
	let e = engine(&root, 50_000, UNLIMITED, Duration::ZERO);
	wait_for(&e, |e| num(&e.status(), "filesIndexed") == 3, "all three files to be indexed");
	let out = grep(&e, &root.join("r"), literal).expect("answered");
	assert!(out.0.contains("holds.txt"), "the file holding the literal must be found: {:?}", out.0);
	assert!(!out.0.contains("nearly.txt"), "a file missing a trigram is not a match: {:?}", out.0);
	let rg = std::process::Command::new("rg")
		.args(["--json", "--hidden", "--glob", "!.git", "--glob", "!.jj", "--", literal, "."])
		.current_dir(root.join("r"))
		.output()
		.unwrap();
	let matches = |b: &[u8]| {
		b.split(|&x| x == b'\n')
			.filter_map(|l| serde_json::from_slice::<serde_json::Value>(l).ok())
			.filter(|v| v["type"] == "match")
			.count()
	};
	assert_eq!(matches(out.0.as_bytes()), matches(&rg.stdout), "not what rg answers");
}

/// Compaction renumbers every node and folder id, so every holder of one has to
/// move with them: the index's records, what the tree queues for the indexer,
/// and the answer find and grep give.
#[test]
fn a_compacted_tree_still_answers_like_rg_and_keeps_its_record_links() {
	let root = temp_root("compact-tree");
	std::fs::create_dir_all(root.join("repo/.git")).unwrap();
	for i in 0..40 {
		write(&root, &format!("repo/d{i:02}/f.txt"), b"needle in a folder\n");
	}
	write(&root, "repo/keep.txt", b"needle kept\n");
	let e = engine(&root, 50_000, UNLIMITED, Duration::ZERO);
	wait_for(&e, |e| num(&e.status(), "filesIndexed") == 41, "every file to be indexed");
	for i in (0..40).step_by(2) {
		std::fs::remove_dir_all(root.join(format!("repo/d{i:02}"))).unwrap();
	}
	let got: std::collections::BTreeSet<String> =
		e.find(&root.join("repo"), "*").expect("listed").paths.into_iter().collect();
	let folders = num(&e.status(), "folders");
	{
		let mut g = e.tree_write();
		g.as_mut().expect("a tree").compact();
	}
	let after = e.status();
	assert!(num(&after, "folders") < folders, "compaction kept the dead folders: {} then {folders}", num(&after, "folders"));
	assert_eq!(num(&after, "filesPending"), 0, "a live file lost its record: {after}");
	assert_eq!(num(&after, "indexedFiles"), 21, "the dead files' records were kept: {after}");
	assert_eq!(got, {
		let mut b = std::collections::BTreeSet::new();
		for i in (1..40).step_by(2) {
			b.insert(format!("d{i:02}/f.txt"));
		}
		b.insert("keep.txt".to_string());
		b
	});
	let out = grep(&e, &root.join("repo"), "needle").expect("answered");
	let rg = std::process::Command::new("rg")
		.args(["--json", "--hidden", "--glob", "!.git", "--glob", "!.jj", "--", "needle", "."])
		.current_dir(root.join("repo"))
		.output()
		.unwrap();
	let matches = |b: &[u8]| {
		b.split(|&x| x == b'\n')
			.filter_map(|l| serde_json::from_slice::<serde_json::Value>(l).ok())
			.filter(|v| v["type"] == "match")
			.count()
	};
	assert_eq!(matches(out.0.as_bytes()), matches(&rg.stdout), "not what rg answers after a compaction");
}
