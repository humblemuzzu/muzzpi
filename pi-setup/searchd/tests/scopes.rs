use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use searchd::engine::{Engine, FindResult, Options};
use searchd::query::GrepRequest;
use searchd::selftest::temp_root;

fn write(root: &Path, rel: &str, body: &[u8]) {
	let p = root.join(rel);
	std::fs::create_dir_all(p.parent().unwrap()).unwrap();
	std::fs::write(p, body).unwrap();
}

/// An engine with the disk index's own rules (path skips under `home`).
fn engine(root: &Path, home: &Path, exact_max_dirs: usize) -> Arc<Engine> {
	let e = Engine::new(Options {
		root: root.to_path_buf(),
		home: home.to_path_buf(),
		threads: 2,
		own_dir: Some(root.join(".own")),
		exact_max_dirs,
		scan_first: 4,
		cookie_dir: root.join(".searchd-live"),
		content_dir: Some(PathBuf::from(format!("{}-content", root.display()))),
		index_under: root.to_path_buf(),
		budget: searchd::content::UNLIMITED,
		quiet_window: std::time::Duration::ZERO,
		rebuild_interval: std::time::Duration::from_secs(600),
	});
	e.build(false);
	for _ in 0..600 {
		if e.content_ready.load(std::sync::atomic::Ordering::SeqCst) {
			break;
		}
		std::thread::sleep(std::time::Duration::from_millis(20));
	}
	e
}

fn grep(e: &Arc<Engine>, dir: &Path, pattern: &str) -> Result<(String, bool), String> {
	let mut buf = Vec::new();
	let req = GrepRequest { pattern, literal: true, ignore_case: false, context: 0, limit: u64::MAX };
	let r = e.grep(dir, None, &req, &mut buf)?;
	Ok((String::from_utf8_lossy(&buf).into_owned(), r.unreadable))
}

#[test]
fn a_repo_holding_a_skipped_path_goes_to_rg() {
	let root = temp_root("scope-repo");
	std::fs::create_dir_all(root.join(".git")).unwrap();
	write(&root, "home/Library/Caches/x.txt", b"needle\n");
	write(&root, "home/src/a.txt", b"needle\n");
	let e = engine(&root, &root.join("home"), 50_000);
	assert!(e.find(&root, "*").is_err(), "the repo's answer would miss home/Library");
	assert!(grep(&e, &root, "needle").is_err());
	assert!(e.find(&root.join("home/src"), "*").is_ok_and(|r| r.paths == ["a.txt"]));
}

#[test]
fn a_dotfiles_repo_in_home_does_not_make_home_a_repo() {
	let root = temp_root("scope-dotfiles");
	let home = root.join("home");
	std::fs::create_dir_all(home.join(".git")).unwrap();
	write(&home, "loose/node_modules/dep/i.js", b"needle\n");
	write(&home, "loose/a.js", b"needle\n");
	write(&home, ".tool/extensions/ext/e.js", b"needle\n");
	let e = engine(&root, &home, 50_000);
	let r = e.find(&home.join("loose"), "*").expect("a folder of folders answers");
	assert_eq!((r.paths, r.skipped_areas), (vec!["a.js".to_string()], 1));
	let r = e.find(&home, "*").expect("home answers despite its .git");
	assert!(r.skipped_areas >= 2 && !r.paths.iter().any(|p| p.contains("node_modules") || p.contains("extensions")));
	assert!(e.find(&home.join(".tool/extensions/ext"), "*").is_err(), "inside a skipped folder goes to rg");
}

#[test]
fn a_large_repo_is_still_answered_exactly() {
	let root = temp_root("scope-broad");
	std::fs::create_dir_all(root.join(".git")).unwrap();
	let mut big = vec![b'x'; 1_500_000];
	big.extend_from_slice(b"\nneedle_in_big\n");
	write(&root, "big.txt", &big);
	write(&root, "small.txt", b"needle_in_small\n");
	// Not home: a .git in home does not make it a repo.
	let e = engine(&root, Path::new("/nonexistent-home"), 0);
	let out = grep(&e, &root, "needle_in_big").expect("answered");
	assert!(out.0.contains("big.txt"), "a file over the index's size cap is still read in a repo");
}

/// A chmod moves a folder's ctime, not its mtime.
fn folder_going_unreadable(exact_max_dirs: usize, tag: &str) {
	let root = temp_root(tag);
	std::fs::create_dir_all(root.join(".git")).unwrap();
	write(&root, "small.txt", b"needle_in_small\n");
	write(&root, "locked/inner.txt", b"needle_in_small\n");
	let e = engine(&root, Path::new("/nonexistent-home"), exact_max_dirs);
	assert!(e.find(&root, "*").is_ok_and(|r| r.paths.contains(&"locked/inner.txt".to_string())));
	std::fs::set_permissions(root.join("locked"), std::fs::Permissions::from_mode(0o000)).unwrap();
	let g = grep(&e, &root, "needle_in_small");
	let f = e.find(&root, "*").map(|r| (r.exit, r.paths));
	std::fs::set_permissions(root.join("locked"), std::fs::Permissions::from_mode(0o755)).unwrap();
	assert!(g.is_err(), "grep with an unreadable folder in a repo must go to rg: {g:?}");
	assert!(
		f.as_ref().is_ok_and(|(exit, paths)| *exit == 2 && !paths.iter().any(|p| p.starts_with("locked"))),
		"find must report rg's error and list nothing it cannot read: {f:?}"
	);
	assert!(
		e.find(&root, "*").is_ok_and(|r| r.exit == 0 && r.paths.contains(&"locked/inner.txt".to_string())),
		"readable again, it is listed again"
	);
}

#[test]
fn a_folder_going_unreadable_checked_folder_by_folder() {
	folder_going_unreadable(50_000, "unreadable-exact");
}

#[test]
fn a_folder_going_unreadable_through_the_live_feed() {
	folder_going_unreadable(0, "unreadable-live");
}

/// A home folder with the three folders macOS shows a privacy prompt for, and
/// one folder it does not.
fn privacy_layout(root: &Path) -> PathBuf {
	let home = root.join("home");
	for d in ["Documents", "Desktop", "Downloads", "notes"] {
		write(&home, &format!("{d}/a.txt"), b"needle\n");
	}
	std::fs::create_dir_all(root.join(".own")).unwrap();
	home
}

/// Waits for the background walk of a folder a search just unlocked.
fn answered(e: &Arc<Engine>, dir: &Path) -> FindResult {
	let until = Instant::now() + Duration::from_secs(30);
	while Instant::now() < until {
		if let Ok(r) = e.find(dir, "*") {
			return r;
		}
		std::thread::sleep(Duration::from_millis(20));
	}
	panic!("nothing answered inside {} within 30 s", dir.display());
}

/// A walk from home must not read a privacy folder; the search that asks for
/// one goes to rg, and later ones are answered from the index.
#[test]
fn a_privacy_folder_is_gated_until_a_search_asks_for_it() {
	let root = temp_root("gate");
	let home = privacy_layout(&root);
	let e = engine(&root, &home, 50_000);
	let r = e.find(&home, "*").expect("home answers");
	assert_eq!(r.paths, ["notes/a.txt"], "a gated folder must not be walked");
	assert_eq!(r.skipped_areas, 3, "a broad query must report the gated folders");

	let asked = root.join("home/Documents");
	let Err(refused) = e.find(&asked, "*") else { panic!("the asking search must go to rg") };
	assert!(refused.contains("privacy"), "{refused}");
	let served = answered(&e, &asked);
	assert_eq!(served.paths, ["a.txt"], "the folder asked for must be answered from the index");
	assert_eq!(served.skipped_areas, 0);
	assert_eq!(e.find(&home, "*").expect("home answers").skipped_areas, 2, "the others stay gated");
}

/// An unlocked folder stays unlocked: a restart must not gate it again.
#[test]
fn an_unlocked_privacy_folder_survives_a_restart() {
	let root = temp_root("gate-restart");
	let home = privacy_layout(&root);
	let asked = root.join("home/Documents");
	let e = engine(&root, &home, 50_000);
	assert!(e.find(&asked, "*").is_err());
	assert_eq!(answered(&e, &asked).paths, ["a.txt"]);

	let again = engine(&root, &home, 50_000);
	let r = again.find(&home, "*").expect("home answers");
	assert_eq!(r.skipped_areas, 2, "the unlocked folder was gated again");
	assert_eq!(again.find(&asked, "*").expect("an unlocked folder is indexed").paths, ["a.txt"]);
}

/// A privacy folder the user said no to is recorded unreadable, once: no walk
/// repeats and the next search there is answered with what could be read.
#[test]
fn a_privacy_folder_that_cannot_be_read_is_recorded_unreadable_once() {
	let root = temp_root("gate-perm");
	let home = privacy_layout(&root);
	let asked = root.join("home/Documents");
	std::fs::set_permissions(&asked, std::fs::Permissions::from_mode(0o000)).unwrap();
	let e = engine(&root, &home, 50_000);
	assert!(!e.find(&home, "*").expect("home answers").unreadable);
	assert!(e.find(&asked, "*").is_err(), "the asking search must go to rg");

	let until = Instant::now() + Duration::from_secs(30);
	let mut seen = None;
	while Instant::now() < until {
		let r = e.find(&home, "*").expect("home answers");
		if r.unreadable {
			seen = Some(r);
			break;
		}
		std::thread::sleep(Duration::from_millis(20));
	}
	let r = seen.expect("the folder that cannot be read was never recorded");
	assert_eq!(r.skipped_areas, 2, "the unlocked folder must not still be counted as gated");

	let indexed = e.status()["filesIndexed"].as_u64();
	for _ in 0..5 {
		let r = e.find(&asked, "*").expect("a folder recorded unreadable is still answered");
		assert!(r.paths.is_empty() && r.unreadable, "{:?}", r.paths);
	}
	assert_eq!(e.status()["filesIndexed"].as_u64(), indexed, "the unreadable folder was walked again");
	std::fs::set_permissions(&asked, std::fs::Permissions::from_mode(0o755)).unwrap();
}

/// A symlink planted where the unlocked folders are recorded must stop the
/// write instead of writing through it.
#[test]
fn a_symlink_where_the_unlocked_folders_are_recorded_stops_the_write() {
	let root = temp_root("gate-symlink");
	let home = privacy_layout(&root);
	let victim = root.join("victim.txt");
	std::fs::write(&victim, b"untouched\n").unwrap();
	std::os::unix::fs::symlink(&victim, root.join(".own/unlocked.json")).unwrap();
	let e = engine(&root, &home, 50_000);
	assert!(e.find(&root.join("home/Documents"), "*").is_err());
	assert_eq!(answered(&e, &root.join("home/Documents")).paths, ["a.txt"]);
	assert_eq!(std::fs::read(&victim).unwrap(), b"untouched\n", "the unlock wrote through the planted symlink");
}

/// A file the process cannot read — what a dataless placeholder becomes for a
/// read — is skipped and reported in a broad scope, and hands a repo to rg.
fn file_going_unreadable(in_repo: bool, exact_max_dirs: usize, tag: &str) {
	let root = temp_root(tag);
	if in_repo {
		std::fs::create_dir_all(root.join(".git")).unwrap();
	}
	write(&root, "found.txt", b"needle_in_both\n");
	write(&root, "locked.txt", b"needle_in_both\n");
	std::fs::set_permissions(root.join("locked.txt"), std::fs::Permissions::from_mode(0o000)).unwrap();
	let e = engine(&root, Path::new("/nonexistent-home"), exact_max_dirs);
	let g = grep(&e, &root, "needle_in_both");
	let f = e.find(&root, "*").map(|r| (r.exit, r.unreadable, r.paths));
	std::fs::set_permissions(root.join("locked.txt"), std::fs::Permissions::from_mode(0o644)).unwrap();
	if in_repo {
		assert!(g.is_err(), "a repo must hand a file it cannot read to rg: {g:?}");
		assert!(f.as_ref().is_ok_and(|(exit, _, _)| *exit == 0), "find lists a name it can read: {f:?}");
	} else {
		let (out, unreadable) = g.expect("a broad scope is answered");
		assert!(out.contains("found.txt"), "{out:?}");
		assert!(!out.contains("locked.txt"), "{out:?}");
		assert!(unreadable, "the file it could not read must be reported");
	}
}

#[test]
fn an_unreadable_file_hands_a_repo_to_rg() {
	file_going_unreadable(true, 50_000, "unreadable-file-repo");
}

#[test]
fn an_unreadable_file_is_skipped_in_a_broad_scope_checked_folder_by_folder() {
	file_going_unreadable(false, 50_000, "unreadable-file-exact");
}

#[test]
fn an_unreadable_file_is_skipped_in_a_broad_scope_through_the_live_feed() {
	file_going_unreadable(false, 0, "unreadable-file-live");
}
