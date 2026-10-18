//! An index damaged every way a segment file can be damaged, over and over: a
//! fresh engine over the same tree must never panic, and must answer exactly
//! what rg answers.
//!
//!   SEARCHD_DAMAGE_ITERS=500 SEARCHD_DAMAGE_SEED=0x1234 cargo test --release --test damaged

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use searchd::content::UNLIMITED;
use searchd::engine::{EXACT_MAX_DIRS, Engine, Options};
use searchd::selftest::{Check, GrepCase, cleanup, grep_check, listing, temp_root};

const RG: &str = "rg";

const GREPS: [GrepCase; 20] = [
	GrepCase { pattern: "needle", literal: false, ignore_case: false },
	GrepCase { pattern: "needle_one", literal: true, ignore_case: false },
	GrepCase { pattern: "needle_two", literal: true, ignore_case: false },
	GrepCase { pattern: "needle_three", literal: false, ignore_case: false },
	GrepCase { pattern: "needle_four", literal: false, ignore_case: false },
	GrepCase { pattern: "needle_five", literal: true, ignore_case: false },
	GrepCase { pattern: "needle_six", literal: false, ignore_case: false },
	GrepCase { pattern: "needle_(one|two)", literal: false, ignore_case: false },
	GrepCase { pattern: "needle_(three|four)", literal: false, ignore_case: false },
	GrepCase { pattern: "NEEDLE", literal: false, ignore_case: true },
	GrepCase { pattern: "NEEDLE_ONE", literal: false, ignore_case: true },
	GrepCase { pattern: "NEEDLE_TWO", literal: true, ignore_case: true },
	GrepCase { pattern: "^needle", literal: false, ignore_case: false },
	GrepCase { pattern: "needle$", literal: false, ignore_case: false },
	GrepCase { pattern: "ne+dle", literal: false, ignore_case: false },
	GrepCase { pattern: "needle.{0,10}line", literal: false, ignore_case: false },
	GrepCase { pattern: "a.b(c)", literal: true, ignore_case: false },
	GrepCase { pattern: "haystack\\(\\)", literal: false, ignore_case: false },
	GrepCase { pattern: "\\bneedle\\w*", literal: false, ignore_case: false },
	GrepCase { pattern: "utf16", literal: false, ignore_case: false },
];

fn fixture(root: &Path) {
	let write = |rel: &str, body: &[u8]| {
		let p = root.join(rel);
		std::fs::create_dir_all(p.parent().unwrap()).unwrap();
		std::fs::write(p, body).unwrap();
	};
	std::fs::create_dir_all(root.join(".git")).unwrap();
	write(".gitignore", b"*.log\n");
	write("one.txt", b"needle_one here\nhaystack()\na.b(c)\n");
	write("two.md", b"needle_two there\nNEEDLE_TWO shouted\n");
	write("src/three.rs", b"fn main() { let needle_three = 1; }\n");
	write("src/four.log", b"needle_four in a skipped log\n");
	write("src/nested/five.txt", b"needle_five deep\nNEEDLE_ONE deep\n");
	write("src/nested/six.md", b"needle_six needle line\n");
	let mut utf16 = vec![0xFF, 0xFE];
	for u in "needle utf16\n".encode_utf16() {
		utf16.extend_from_slice(&u.to_le_bytes());
	}
	write("src/utf16.txt", &utf16);
}

fn engine_at(root: &Path, content: &Path, quiet: Duration) -> Arc<Engine> {
	let e = Engine::new(Options {
		root: root.to_path_buf(),
		home: PathBuf::from("/nonexistent-home"),
		threads: 2,
		own_dir: None,
		exact_max_dirs: EXACT_MAX_DIRS,
		scan_first: 4,
		cookie_dir: root.join(".searchd-live"),
		content_dir: Some(content.to_path_buf()),
		index_under: root.to_path_buf(),
		budget: UNLIMITED,
		quiet_window: quiet,
		rebuild_interval: Duration::from_secs(600),
	});
	e.build(false);
	e
}

/// Waits for the indexer's first pass: the records the damaged segments still
/// hold are linked to the files they were written for.
fn ready(e: &Arc<Engine>) {
	let until = Instant::now() + Duration::from_secs(120);
	while !e.content_ready.load(Ordering::SeqCst) {
		assert!(Instant::now() < until, "the indexer never finished a pass: {}", e.status());
		std::thread::sleep(Duration::from_millis(2));
	}
}

fn segments(dir: &Path) -> Vec<(String, Vec<u8>)> {
	let mut out: Vec<(String, Vec<u8>)> = std::fs::read_dir(dir)
		.into_iter()
		.flatten()
		.flatten()
		.filter(|e| e.file_name().to_string_lossy().starts_with("seg-") && e.file_name().to_string_lossy().ends_with(".bin"))
		.map(|e| (e.file_name().to_string_lossy().into_owned(), std::fs::read(e.path()).unwrap()))
		.collect();
	out.sort_by(|a, b| a.0.cmp(&b.0));
	out
}

struct Rng(u64);

impl Rng {
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
}

/// A segment file as a crash, a bad disk or a stray write can leave it.
fn corrupt(seg: &[u8], rng: &mut Rng) -> Vec<u8> {
	let mut out = seg.to_vec();
	match rng.below(3) {
		0 => {
			for _ in 0..1 + rng.below(32) {
				let at = rng.below(out.len());
				out[at] ^= (rng.next() % 255 + 1) as u8;
			}
		}
		1 => out.truncate(rng.below(out.len())),
		_ => {
			// The header fields: doc count, trigram count, path and postings
			// lengths, the rules digest, the checksum.
			let field = 8 + 4 * rng.below(9);
			for b in out.iter_mut().skip(field).take(4) {
				*b = 0;
			}
		}
	}
	out
}

fn count(name: &str, default: u64) -> u64 {
	std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

fn seed() -> u64 {
	match std::env::var("SEARCHD_DAMAGE_SEED") {
		Ok(v) => match v.trim().strip_prefix("0x").and_then(|h| u64::from_str_radix(h, 16).ok()) {
			Some(n) => n,
			None => v.trim().parse().expect("SEARCHD_DAMAGE_SEED is a number or 0x-hex"),
		},
		Err(_) => std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0x5d_5e_ed, |d| d.as_nanos() as u64),
	}
}

#[test]
fn every_damaged_index_answers_exactly_what_rg_answers() {
	let root = temp_root("damaged");
	fixture(&root);
	let content = PathBuf::from(format!("{}-index", root.display()));
	let built = engine_at(&root, &content, Duration::ZERO);
	ready(&built);
	let pristine = segments(&content);
	assert!(!pristine.is_empty(), "the fixture was never indexed: nothing to damage");
	drop(built);

	let damage = PathBuf::from(format!("{}-damaged", root.display()));
	let iterations = count("SEARCHD_DAMAGE_ITERS", 500);
	let mut rng = Rng(seed() | 1);
	let all = listing(RG, &root);
	let mut compared = 0;
	let mut refused = 0;
	for i in 0..iterations {
		let dir = damage.join(format!("c{i}"));
		let _ = std::fs::remove_dir_all(&dir);
		std::fs::create_dir_all(&dir).unwrap();
		for (name, bytes) in &pristine {
			let mut f = std::fs::File::create(dir.join(name)).unwrap();
			f.write_all(&corrupt(bytes, &mut rng)).unwrap();
		}
		let e = engine_at(&root, &dir, Duration::from_secs(3600));
		ready(&e);
		// The greps are compared at once: one rg per case, and rg's own start
		// is most of the cost of a comparison this small.
		let results: Vec<(&str, Result<bool, Check>)> = std::thread::scope(|s| {
			let spawned: Vec<_> = GREPS
				.iter()
				.map(|case| s.spawn(|| (case.pattern, grep_check(&e, RG, &all, &root, None, case, 0))))
				.collect();
			spawned.into_iter().map(|h| h.join().unwrap()).collect()
		});
		for (pattern, result) in results {
			match result {
				Ok(_) => compared += 1,
				Err(Check::Refused(_)) => refused += 1,
				Err(Check::Differs(msg)) => panic!("iteration {i}: grep {pattern:?} in a damaged index: {msg}"),
			}
		}
	}
	println!("damaged: {iterations} damaged indexes, {compared} greps matched rg, {refused} handed to rg");
	assert!(refused * 20 <= compared + refused, "{refused} of {} greps were handed to rg", compared + refused);
	cleanup(&damage);
}
