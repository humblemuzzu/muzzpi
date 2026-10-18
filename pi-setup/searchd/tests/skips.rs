use std::collections::BTreeSet;
use std::path::Path;
use std::process::Command;
use std::sync::Arc;

use searchd::engine::Engine;
use searchd::query::GrepRequest;
use searchd::selftest::{engine_with, temp_root};

fn write(root: &Path, rel: &str, body: &str) {
	let p = root.join(rel);
	std::fs::create_dir_all(p.parent().unwrap()).unwrap();
	std::fs::write(p, body).unwrap();
}

/// A folder of folders holding dependency and bundle folders rg would
/// enter, a repo that commits its node_modules (the repo's own, indexed),
/// and one that ignores it.
fn layout(root: &Path) {
	write(root, "loose/src/a.js", "needle a\n");
	write(root, "loose/node_modules/dep/index.js", "needle dep\n");
	write(root, "loose/Tool.app/Contents/Info.plist", "needle app\n");
	write(root, "loose/py/__pycache__/m.txt", "needle pyc\n");
	std::fs::create_dir_all(root.join("committed/.git")).unwrap();
	write(root, "committed/src/b.js", "needle b\n");
	write(root, "committed/node_modules/x/i.js", "needle x\n");
	std::fs::create_dir_all(root.join("ignored/.git")).unwrap();
	write(root, "ignored/.gitignore", "node_modules/\n");
	write(root, "ignored/src/c.js", "needle c\n");
	write(root, "ignored/node_modules/y/i.js", "needle y\n");
}

fn rg_files(dir: &Path) -> BTreeSet<String> {
	let out = Command::new("rg")
		.args(["--files", "--hidden", "--glob", "!.git", "--glob", "!.jj", "."])
		.current_dir(dir)
		.output()
		.unwrap();
	String::from_utf8_lossy(&out.stdout)
		.lines()
		.map(|l| l.trim_start_matches("./").to_string())
		.collect()
}

fn rg_matches(dir: &Path) -> BTreeSet<String> {
	let out = Command::new("rg")
		.args(["-n", "--hidden", "--glob", "!.git", "--glob", "!.jj", "--no-heading", "needle", "."])
		.current_dir(dir)
		.output()
		.unwrap();
	String::from_utf8_lossy(&out.stdout)
		.lines()
		.map(|l| l.trim_start_matches("./").to_string())
		.collect()
}

fn engine_matches(e: &Arc<Engine>, dir: &Path) -> Result<(BTreeSet<String>, usize), String> {
	let mut buf = Vec::new();
	let req = GrepRequest {
		pattern: "needle",
		literal: false,
		ignore_case: false,
		context: 0,
		limit: u64::MAX,
	};
	let r = e.grep(dir, None, &req, &mut buf)?;
	let set = buf
		.split(|&b| b == b'\n')
		.filter_map(|l| serde_json::from_slice::<serde_json::Value>(l).ok())
		.filter(|v| v["type"] == "match")
		.map(|v| {
			let d = &v["data"];
			format!(
				"{}:{}:{}",
				d["path"]["text"].as_str().unwrap().trim_start_matches("./"),
				d["line_number"],
				d["lines"]["text"].as_str().unwrap().trim_end()
			)
		})
		.collect();
	Ok((set, r.skipped_areas))
}

/// rg's answer without anything under the skipped folders.
fn without(set: BTreeSet<String>, skipped: &[&str]) -> BTreeSet<String> {
	set.into_iter()
		.filter(|p| !skipped.iter().any(|s| p.starts_with(&format!("{s}/"))))
		.collect()
}

fn check(e: &Arc<Engine>, root: &Path, step: &str, loose_skips: &[&str]) -> Vec<String> {
	let mut bad = Vec::new();
	let loose = root.join("loose");
	match e.find(&loose, "*") {
		Ok(r) => {
			let got: BTreeSet<String> = r.paths.into_iter().collect();
			let want = without(rg_files(&loose), loose_skips);
			if got != want {
				bad.push(format!("{step}: find loose: got {got:?} want {want:?}"));
			}
			if r.skipped_areas != loose_skips.len() {
				bad.push(format!("{step}: find loose skipped {} not {}", r.skipped_areas, loose_skips.len()));
			}
		}
		Err(reason) => bad.push(format!("{step}: find loose fell back: {reason}")),
	}
	match engine_matches(e, &loose) {
		Ok((got, skipped)) => {
			let want = without(rg_matches(&loose), loose_skips);
			if got != want || skipped != loose_skips.len() {
				bad.push(format!("{step}: grep loose: got {got:?} ({skipped} skipped) want {want:?}"));
			}
		}
		Err(reason) => bad.push(format!("{step}: grep loose fell back: {reason}")),
	}
	for inside in ["loose/node_modules", "loose/node_modules/dep", "loose/Tool.app/Contents"] {
		if e.find(&root.join(inside), "*").is_ok() || engine_matches(e, &root.join(inside)).is_ok() {
			bad.push(format!("{step}: {inside} answered instead of going to rg"));
		}
	}
	for exact in ["committed", "committed/node_modules", "committed/src", "ignored"] {
		let dir = root.join(exact);
		match e.find(&dir, "*") {
			Ok(r) if r.skipped_areas == 0 && r.paths.iter().cloned().collect::<BTreeSet<_>>() == rg_files(&dir) => {}
			Ok(r) => bad.push(format!("{step}: find {exact}: {:?} ({} skipped)", r.paths, r.skipped_areas)),
			Err(reason) => bad.push(format!("{step}: find {exact} fell back: {reason}")),
		}
	}
	bad
}

fn run(exact_max_dirs: usize, tag: &str) {
	let root = temp_root(tag);
	layout(&root);
	let e = engine_with(&root, exact_max_dirs);
	let mut bad = check(&e, &root, "start", &["node_modules", "Tool.app", "py/__pycache__"]);

	write(&root, "loose/sub/node_modules/z/z.js", "needle z\n");
	write(&root, "loose/sub/k.js", "needle k\n");
	bad.extend(check(&e, &root, "a node_modules appears", &["node_modules", "Tool.app", "py/__pycache__", "sub/node_modules"]));

	std::fs::remove_dir_all(root.join("loose/node_modules")).unwrap();
	bad.extend(check(&e, &root, "a node_modules goes", &["Tool.app", "py/__pycache__", "sub/node_modules"]));

	assert!(bad.is_empty(), "{}", bad.join("\n"));
}

#[test]
fn skipped_folders_checked_folder_by_folder() {
	run(50_000, "skips-exact");
}

#[test]
fn skipped_folders_through_the_live_feed() {
	run(0, "skips-live");
}
