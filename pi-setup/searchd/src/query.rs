use std::ffi::OsStr;
use std::io::Write;
use std::os::unix::ffi::OsStrExt;
use std::path::Path;

use grep_printer::JSONBuilder;
use grep_regex::RegexMatcherBuilder;
use grep_searcher::{BinaryDetection, MmapChoice, SearcherBuilder};
use ignore::overrides::Override;
use rayon::prelude::*;

use crate::tree::{F_DEAD, F_ERROR, K_DIR, K_FILE, NO_DIR, Tree, mtime_ns};

pub struct FileSet {
	/// The file nodes rg lists, in walk order.
	pub nodes: Vec<u32>,
	/// rg would have reported an error (unreadable folder, broken ignore file).
	pub errors: bool,
}

pub type Fallback = String;

/// The files rg lists from tree node `x` both with and without the caller's
/// glob: `--glob` only narrows, it never brings back what an ignore rule
/// skipped (in rg a matching glob would, which is how `--glob '*'` lists
/// all of node_modules).
pub fn file_set(tree: &Tree, x: u32, ov: Option<&Override>) -> Result<FileSet, Fallback> {
	let d = tree.nodes[x as usize].dir;
	if d == NO_DIR {
		return Err("not a walked folder".into());
	}
	let errors = tree.nodes[x as usize].flags & F_ERROR != 0
		|| tree.ancestors(x).iter().any(|&a| tree.nodes[a as usize].flags & F_ERROR != 0);
	let mut out = FileSet { nodes: Vec::new(), errors };
	let mut prefix = Vec::new();
	visit(tree, d, &mut prefix, ov, &mut out)?;
	Ok(out)
}

/// Collects the file nodes under `d`. `prefix` holds the path of `d` below the
/// search dir: one buffer for the whole subtree, so an entry that no glob and
/// no candidate filter keeps never costs a string of its own.
fn visit(tree: &Tree, d: u32, prefix: &mut Vec<u8>, ov: Option<&Override>, out: &mut FileSet) -> Result<(), Fallback> {
	let base = prefix.len();
	let dir = &tree.dirs[d as usize];
	if tree.nodes[dir.node as usize].flags & F_ERROR != 0 {
		out.errors = true;
	}
	let mut subdirs: Vec<(u32, Vec<u8>)> = Vec::new();
	for &c in &dir.children {
		let node = &tree.nodes[c as usize];
		if node.flags & F_DEAD != 0 {
			continue;
		}
		let name = tree.name(c);
		if name.contains(&b'\n') {
			return Err("a file name holds a line break".into());
		}
		if std::str::from_utf8(name).is_err() {
			return Err("a file name is not UTF-8".into());
		}
		if base > 0 {
			prefix.push(b'/');
		}
		prefix.extend_from_slice(name);
		let is_dir = node.kind == K_DIR;
		if ov.is_some_and(|ov| ov.matched(Path::new(OsStr::from_bytes(prefix)), is_dir).is_ignore()) {
			prefix.truncate(base);
			continue;
		}
		if is_dir {
			if node.flags & F_ERROR != 0 {
				out.errors = true;
			}
			if node.dir != NO_DIR {
				subdirs.push((node.dir, prefix.clone()));
			}
		} else if node.kind == K_FILE {
			out.nodes.push(c);
		}
		prefix.truncate(base);
	}
	if subdirs.len() > 1 {
		let nested: Vec<Result<FileSet, Fallback>> = crate::engine::parallel_query(|| {
			subdirs
				.into_par_iter()
				.map(|(sd, mut p)| {
					let mut set = FileSet { nodes: Vec::new(), errors: false };
					visit(tree, sd, &mut p, ov, &mut set).map(|()| set)
				})
				.collect()
		});
		for n in nested {
			let n = n?;
			out.nodes.extend(n.nodes);
			out.errors |= n.errors;
		}
	} else {
		for (sd, mut p) in subdirs {
			visit(tree, sd, &mut p, ov, out)?;
		}
	}
	Ok(())
}

/// Newest first, ties by path, all below node `base`; a file that cannot be
/// stat'ed goes last. `known` supplies an mtime the caller can vouch for,
/// saving a stat.
pub fn newest_first(tree: &Tree, base: u32, files: Vec<u32>, known: impl Fn(u32) -> Option<i64> + Sync) -> Vec<String> {
	let mut keyed: Vec<(i64, String)> = crate::engine::parallel_query(|| {
		files
			.into_par_iter()
			.map(|n| {
				let t = known(n).unwrap_or_else(|| std::fs::metadata(tree.path_of(n)).map(|m| mtime_ns(&m)).unwrap_or(i64::MIN));
				(t, tree.rel_string(base, n))
			})
			.collect()
	});
	crate::engine::parallel_query(|| keyed.par_sort_unstable_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1))));
	keyed.into_iter().map(|(_, p)| p).collect()
}

#[derive(Clone, Copy)]
pub struct GrepRequest<'a> {
	pub pattern: &'a str,
	pub literal: bool,
	pub ignore_case: bool,
	pub context: usize,
	pub limit: u64,
}

/// One searched file's `rg --json` lines.
struct Hit {
	json: Vec<u8>,
	matches: u64,
}

/// The matcher rg builds for `rg [--ignore-case] [--fixed-strings] PATTERN`
/// (crates/core/flags/hiargs.rs `matcher_rust`).
pub fn matcher(req: &GrepRequest) -> Result<grep_regex::RegexMatcher, Fallback> {
	let mut b = RegexMatcherBuilder::new();
	b.multi_line(true)
		.unicode(true)
		.octal(false)
		.fixed_strings(req.literal)
		.case_insensitive(req.ignore_case)
		.line_terminator(Some(b'\n'))
		.dot_matches_new_line(false)
		.ban_byte(Some(b'\x00'));
	b.build(req.pattern).map_err(|e| format!("pattern: {e}"))
}

/// Searches `files` (relative to `base`, already in output order) as rg
/// searches files it found by walking, writing rg's `--json` lines to `out`
/// until `limit` matches. Returns how many matched, and whether a tolerant
/// search skipped an unreadable file (any other hands that to rg, which
/// reports it).
pub fn grep(
	base: &Path,
	files: &[(String, u32)],
	req: &GrepRequest,
	m: &grep_regex::RegexMatcher,
	out: &mut dyn Write,
	tolerant: bool,
	deadline: std::time::Instant,
) -> Result<(u64, bool), Fallback> {
	let mut total = 0u64;
	let mut unreadable = false;
	let mut chunk = 16usize;
	let mut start = 0usize;
	while start < files.len() && total < req.limit {
		if std::time::Instant::now() > deadline {
			return Err("the search ran past its time budget".into());
		}
		let end = (start + chunk).min(files.len());
		let hits: Vec<Result<Option<Hit>, Fallback>> = crate::engine::parallel_query(|| {
			files[start..end]
				.par_iter()
				.map_init(
					|| {
						SearcherBuilder::new()
							.line_terminator(grep_matcher::LineTerminator::byte(b'\n'))
							.line_number(true)
							.multi_line(false)
							.memory_map(MmapChoice::never())
							.binary_detection(BinaryDetection::quit(b'\x00'))
							.before_context(req.context)
							.after_context(req.context)
							.build()
					},
					|searcher, (rel, _)| search_one(searcher, m, base, rel),
				)
				.collect()
		});
		for h in hits {
			if total >= req.limit {
				break;
			}
			match h {
				Ok(Some(hit)) => {
					out.write_all(&hit.json).map_err(|e| e.to_string())?;
					total += hit.matches;
				}
				Ok(None) => {}
				Err(_) if tolerant => unreadable = true,
				Err(e) => return Err(e),
			}
		}
		// Nothing past the limit is ever written: the file that crossed it is the
		// only overshoot, and the chunk ends here.
		start = end;
		chunk = (chunk * 2).min(512);
	}
	Ok((total, unreadable))
}

fn search_one(
	searcher: &mut grep_searcher::Searcher,
	m: &grep_regex::RegexMatcher,
	base: &Path,
	rel: &str,
) -> Result<Option<Hit>, Fallback> {
	let display = format!("./{rel}");
	let mut printer = JSONBuilder::new().pretty(false).always_begin_end(false).build(Vec::new());
	let (matches, binary) = {
		let mut sink = printer.sink_with_path(m, Path::new(&display));
		searcher
			.search_path(m, base.join(rel), &mut sink)
			.map_err(|e| format!("{rel}: {e}"))?;
		(sink.match_count(), sink.binary_byte_offset().is_some())
	};
	// A NUL anywhere makes the file binary, and rg's rule is that a binary
	// file shows no lines. rg itself keeps matches it read before the NUL
	// when they came in an earlier buffer fill, so its answer depends on the
	// buffer size left by the files searched before; this one does not.
	if binary {
		return Ok(None);
	}
	let json = printer.into_inner();
	Ok(if json.is_empty() { None } else { Some(Hit { json, matches }) })
}

pub fn display_bytes(p: &Path) -> &[u8] {
	p.as_os_str().as_bytes()
}
