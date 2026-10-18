//! Keeps the content index in step with the tree, in the background.

use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::os::unix::ffi::OsStrExt;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use rayon::prelude::*;

use crate::content::{Block, Content, DOC_PENDING, DocIn, DocMeta, FileSig, Read, read_for_index};
use crate::engine::{Engine, parallel_background, parallel_idle, release_memory, set_qos};
use crate::tree::{F_DEAD, K_FILE};

/// Files read between checks of the batch's budget: small, so a folder of
/// large files cannot run a batch far past it.
const TAKE: usize = 256;
/// With nothing to do the indexer sleeps until poked, waking at most this often.
const IDLE_WAKE: Duration = Duration::from_secs(600);
const WRITE_BACKOFF: Duration = Duration::from_secs(60);
const WRITE_BACKOFF_MAX: Duration = Duration::from_secs(3600);

enum Pass {
	Idle,
	Worked,
	Failed,
}

/// Runs one pass of the indexer: at background QoS, which macOS keeps on
/// efficiency cores and throttles on battery. (All at background, start-up
/// took over five minutes: its disk reads are throttled.)
fn pass<R: Send>(steady: bool, f: impl FnOnce() -> R + Send) -> R {
	if steady { parallel_idle(f) } else { parallel_background(f) }
}

pub fn run(engine: Arc<Engine>) {
	let mut seen_generation = u64::MAX;
	let mut indexed_since_merge = false;
	let mut backoff = WRITE_BACKOFF;
	// Files changed too recently to index: node -> the end of its quiet window.
	let mut deferred: HashMap<u32, i64> = HashMap::new();
	// Files read per take, halved when one overruns the pair budget: a folder
	// of dense files would otherwise be read again and again.
	let mut take = TAKE;
	let mut was_blocked = None;
	loop {
		let now_blocked = blocked(&engine);
		if now_blocked != was_blocked {
			match now_blocked {
				Some(b) => eprintln!("searchd: indexing stopped: {} budget reached", b.name()),
				None => eprintln!("searchd: indexing resumed"),
			}
			was_blocked = now_blocked;
		}
		let warm = engine.content_ready.load(Ordering::SeqCst);
		set_qos(if warm { libc::qos_class_t::QOS_CLASS_BACKGROUND } else { libc::qos_class_t::QOS_CLASS_UTILITY });
		let generation = match engine.tree_generation() {
			Some(g) => g,
			None => {
				std::thread::sleep(Duration::from_millis(500));
				continue;
			}
		};
		if generation != seen_generation {
			engine.content_ready.store(false, Ordering::SeqCst);
			pass(warm, || relink(&engine));
			seed(&engine);
			seen_generation = generation;
			deferred.clear();
			release_memory();
		}
		if let Some(c) = engine.content.write().as_mut() {
			c.drop_damaged();
		}
		requeue_due(&engine, &mut deferred);
		match pass(warm, || index_some(&engine, &mut take, &mut deferred)) {
			Pass::Worked => {
				indexed_since_merge = true;
				backoff = WRITE_BACKOFF;
				continue;
			}
			// The disk is full or the folder unwritable: the files stay pending
			// (greps read them directly) and each retry waits longer, measuring
			// the disk again before it reads anything.
			Pass::Failed => {
				if let Some(c) = engine.content.read().as_ref() {
					c.recheck();
				}
				std::thread::sleep(backoff);
				backoff = (backoff * 2).min(WRITE_BACKOFF_MAX);
				continue;
			}
			Pass::Idle => {}
		}
		engine.maybe_compact();
		if !engine.content_ready.swap(true, Ordering::SeqCst) {
			release_memory();
		}
		if indexed_since_merge {
			if pass(warm, || merge(&engine)) {
				engine.poke_indexer();
			}
			indexed_since_merge = false;
		}
		engine.wait_for_work(wait_for(&deferred));
	}
}

fn now_ns() -> i64 {
	std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.map_or(0, |d| d.as_nanos() as i64)
}

/// Puts deferred files whose quiet window has passed back in the queue.
fn requeue_due(engine: &Engine, deferred: &mut HashMap<u32, i64>) {
	let now = now_ns();
	let due: Vec<u32> = deferred.iter().filter(|(_, due)| **due <= now).map(|(&n, _)| n).collect();
	if due.is_empty() {
		return;
	}
	for n in &due {
		deferred.remove(n);
	}
	engine.with_tree_mut(|tree, _| tree.pending.extend(due));
}

/// How long the indexer sleeps: until the first deferred file is due, and at
/// most one idle wake.
fn wait_for(deferred: &HashMap<u32, i64>) -> Duration {
	let Some(&due) = deferred.values().min() else { return IDLE_WAKE };
	Duration::from_nanos(due.saturating_sub(now_ns()) as u64).min(IDLE_WAKE)
}

/// Why the index may not grow, if it may not.
fn blocked(engine: &Engine) -> Option<Block> {
	engine.content.read().as_ref().and_then(|c| c.room())
}

/// Links records from earlier runs to the files they describe, newest
/// segment first (a file indexed twice keeps its latest record), and only
/// where the file is still the one recorded. One segment at a time, so a
/// disk's worth of paths is never in memory at once.
/// A file a segment still describes: its tree node, its doc inside the
/// segment, and the identity it was recorded with.
type Candidate = (u32, u32, FileSig, PathBuf);

fn relink(engine: &Engine) {
	let slots: Vec<usize> = {
		let cg = engine.content.read();
		let Some(content) = cg.as_ref() else { return };
		(0..content.segs.len()).rev().collect()
	};
	for slot in slots {
		let (candidates, tainted, generation): (Vec<Candidate>, bool, u64) = {
			let tg = engine.tree_read();
			let Some(tree) = tg.as_ref() else { return };
			let cg = engine.content.read();
			let Some(Some(seg)) = cg.as_ref().map(|c| c.segs.get(slot).and_then(Option::as_ref)) else {
				continue;
			};
			let mut seen = HashSet::new();
			let mut tainted = false;
			let found = (0..seg.n_docs())
				.filter_map(|local| {
					let (sig, path) = seg.doc(local)?;
					let p = std::path::Path::new(OsStr::from_bytes(path));
					tainted |= engine.is_secret(p);
					let n = tree.lookup(p)?;
					let node = &tree.nodes[n as usize];
					let wanted = node.kind == K_FILE && node.doc == DOC_PENDING && engine.classify(p).is_none();
					(wanted && seen.insert(n)).then(|| (n, local, sig, p.to_path_buf()))
				})
				.collect();
			(found, tainted, tree.generation)
		};
		// A segment holding a file the rules now keep out goes entirely: its
		// other files are simply indexed again.
		if tainted {
			if let Some(c) = engine.content.write().as_mut() {
				c.drop_segment(slot as u32);
			}
			engine.counters.segments_purged.fetch_add(1, Ordering::Relaxed);
			continue;
		}
		let ok: Vec<_> = candidates
			.into_par_iter()
			.filter(|(_, _, sig, p)| std::fs::symlink_metadata(p).is_ok_and(|m| FileSig::of(&m) == *sig))
			.collect();
		engine.with_tree_mut(|tree, _| {
			if tree.generation != generation {
				return;
			}
			for (n, local, sig, _) in ok {
				let node = tree.nodes[n as usize];
				if node.flags & F_DEAD == 0 && node.doc == DOC_PENDING {
					tree.nodes[n as usize].doc = tree.docs.len() as u32;
					tree.docs.push(DocMeta {
						seg: slot as u32,
						local,
						sig,
						node: n,
					});
				}
			}
		});
	}
}

/// Queues every file the index should hold and is not linked yet.
fn seed(engine: &Engine) {
	engine.with_tree_mut(|tree, _| {
		tree.pending = (1..tree.nodes.len() as u32)
			.filter(|&n| {
				let node = &tree.nodes[n as usize];
				node.kind == K_FILE && node.flags & F_DEAD == 0 && node.doc == DOC_PENDING
			})
			.collect();
	});
}

/// Indexes up to one segment's worth of pending files.
fn index_some(engine: &Engine, take: &mut usize, deferred: &mut HashMap<u32, i64>) -> Pass {
	let (max_bytes, max_files, max_pairs) = Content::batch_limits();
	let quiet = engine.quiet;
	let mut buf: Vec<(u32, PathBuf, FileSig, Vec<u32>)> = Vec::new();
	let mut bytes = 0u64;
	let mut pairs = 0usize;
	let mut worked = false;
	let mut generation = 0u64;
	loop {
		if blocked(engine).is_some() {
			break;
		}
		let (batch, tree_generation): (Vec<(u32, PathBuf)>, u64) = {
			let taken = engine.with_tree_mut(|tree, _| {
				let at = tree.pending.len().saturating_sub(*take);
				let mut out: Vec<u32> = tree.pending.drain(at..).collect();
				out.retain(|&n| {
					let node = &tree.nodes[n as usize];
					node.kind == K_FILE && node.flags & F_DEAD == 0 && node.doc == DOC_PENDING
				});
				out.sort_unstable();
				out.dedup();
				(out.into_iter().map(|n| (n, tree.path_of(n))).collect::<Vec<_>>(), tree.generation)
			});
			taken.unwrap_or_default()
		};
		if batch.is_empty() {
			break;
		}
		generation = tree_generation;
		worked = true;
		let now = now_ns();
		let read: Vec<(u32, PathBuf, Read)> = batch
			.into_par_iter()
			.map(|(n, p)| {
				let r = engine.classify(&p).map_or_else(|| read_for_index(&p, now - quiet, now), Read::Special);
				(n, p, r)
			})
			.collect();
		let mut special = Vec::new();
		let mut again = Vec::new();
		for (n, p, r) in read {
			match r {
				Read::Special(v) => special.push((n, v)),
				Read::Recent(sig) => {
					deferred.insert(n, sig.ctime + quiet);
				}
				Read::Indexed { sig, tris } => {
					if !buf.is_empty() && pairs + tris.len() > max_pairs {
						again.push(n);
					} else {
						pairs += tris.len();
						bytes += sig.size;
						buf.push((n, p, sig, tris));
					}
				}
			}
		}
		let full = !again.is_empty();
		if full {
			*take = (*take / 2).max(1);
		} else if *take < TAKE && pairs < max_pairs / 2 {
			*take = (*take * 2).min(TAKE);
		}
		engine.with_tree_mut(|tree, _| {
			if tree.generation != generation {
				return;
			}
			for (n, v) in special {
				if v != DOC_PENDING && tree.nodes[n as usize].flags & F_DEAD == 0 && tree.nodes[n as usize].doc == DOC_PENDING {
					tree.nodes[n as usize].doc = v;
				}
			}
			for n in again {
				if tree.nodes[n as usize].doc == DOC_PENDING {
					tree.pending.push(n);
				}
			}
		});
		if full || bytes >= max_bytes || buf.len() >= max_files || pairs >= max_pairs {
			break;
		}
	}
	if !buf.is_empty() && !commit(engine, buf, generation) {
		return Pass::Failed;
	}
	if worked { Pass::Worked } else { Pass::Idle }
}

/// Writes one segment and links each file whose bytes are still the ones
/// read; a file written to meanwhile stays pending. False when the segment
/// could not be written: every file goes back to pending.
fn commit(engine: &Engine, mut buf: Vec<(u32, PathBuf, FileSig, Vec<u32>)>, generation: u64) -> bool {
	let slot = {
		let docs: Vec<DocIn> = buf
			.iter()
			.map(|(_, p, sig, tris)| DocIn {
				path: p,
				sig: *sig,
				tris,
			})
			.collect();
		let mut cg = engine.content.write();
		let Some(content) = cg.as_mut() else { return true };
		match content.write_segment(&docs) {
			Ok(Some(slot)) => slot,
			Ok(None) => return true,
			Err(_) => {
				drop(cg);
				engine.with_tree_mut(|tree, _| {
					if tree.generation == generation {
						tree.pending.extend(buf.iter().map(|e| e.0));
					}
				});
				return false;
			}
		}
	};
	for entry in &mut buf {
		entry.3 = Vec::new();
	}
	let unchanged: Vec<bool> = buf
		.par_iter()
		.map(|(_, p, sig, _)| std::fs::symlink_metadata(p).is_ok_and(|m| FileSig::of(&m) == *sig))
		.collect();
	engine.with_tree_mut(|tree, _| {
		// A re-walk renumbers every node: these ids now name other files.
		if tree.generation != generation {
			return;
		}
		for (local, ((n, _, sig, _), same)) in buf.into_iter().zip(unchanged).enumerate() {
			let node = tree.nodes[n as usize];
			if node.flags & F_DEAD != 0 || node.doc != DOC_PENDING {
				continue;
			}
			if same {
				tree.nodes[n as usize].doc = tree.docs.len() as u32;
				tree.docs.push(DocMeta {
					seg: slot,
					local: local as u32,
					sig,
					node: n,
				});
				engine.counters.files_indexed.fetch_add(1, Ordering::Relaxed);
			} else {
				tree.pending.push(n);
			}
		}
	});
	true
}

/// Rebuilds segments that are mostly stale records or too small to be
/// worth a lookup each: their live files go back to pending, and the
/// segment file is deleted. True when it sent files back to pending.
fn merge(engine: &Engine) -> bool {
	let mut tg = engine.tree_write();
	let Some(tree) = tg.as_mut() else { return false };
	let mut cg = engine.content.write();
	let Some(content) = cg.as_mut() else { return false };
	let mut live = vec![0u32; content.segs.len()];
	let mut linked = 0usize;
	for (i, m) in tree.docs.iter().enumerate() {
		if tree
			.nodes
			.get(m.node as usize)
			.is_some_and(|n| n.doc == i as u32 && n.flags & F_DEAD == 0)
		{
			live[m.seg as usize] += 1;
			linked += 1;
		}
	}
	for (slot, seg) in content.segs.iter_mut().enumerate() {
		if let Some(s) = seg {
			s.live = live[slot];
		}
	}
	let slots = content.to_merge();
	let dropped = !slots.is_empty();
	if dropped {
		let drop: HashSet<u32> = slots.iter().copied().collect();
		for i in 0..tree.docs.len() {
			let m = tree.docs[i];
			if drop.contains(&m.seg) && tree.nodes[m.node as usize].doc == i as u32 {
				tree.invalidate(m.node);
			}
		}
		for s in slots {
			content.drop_segment(s);
		}
		content.recheck();
	}
	if tree.docs.len() > 2 * linked + 100_000 {
		let old = std::mem::take(&mut tree.docs);
		for (i, m) in old.into_iter().enumerate() {
			if tree.nodes[m.node as usize].doc == i as u32 {
				tree.nodes[m.node as usize].doc = tree.docs.len() as u32;
				tree.docs.push(m);
			}
		}
	}
	dropped
}

#[cfg(test)]
mod tests {
	use super::*;
	use std::path::Path;

	use crate::content::UNLIMITED;
	use crate::engine::{EXACT_MAX_DIRS, Engine, Options};
	use crate::selftest::{content_dir, temp_root};
	use crate::tree::{Tree, WalkOptions};

	fn engine_at(root: &Path) -> Arc<Engine> {
		Engine::new(Options {
			root: root.to_path_buf(),
			home: PathBuf::from("/nonexistent-home"),
			threads: 2,
			own_dir: None,
			exact_max_dirs: EXACT_MAX_DIRS,
			scan_first: 4,
			cookie_dir: root.join(".searchd-live"),
			content_dir: Some(content_dir(root)),
			index_under: root.to_path_buf(),
			budget: UNLIMITED,
			quiet_window: Duration::from_secs(3600),
			rebuild_interval: Duration::from_secs(600),
		})
	}

	/// The tree a walk of `root` gives, as generation `generation`.
	fn walked(e: &Arc<Engine>, generation: u64) -> Tree {
		let opt = WalkOptions { threads: 1, background: false, exclusions: &e.exclusions };
		let mut t = Tree::walk(&e.root, &opt).expect("the fixture walks");
		t.generation = generation;
		t
	}

	/// An ignore-rule change re-walks the root and renumbers every node while a
	/// segment is being written: the ids that batch carries then belong to other
	/// files, or to none at all.
	#[test]
	fn a_segment_that_finishes_after_the_tree_was_replaced_links_nothing() {
		let root = temp_root("commit-replaced-tree");
		for i in 0..8 {
			std::fs::write(root.join(format!("f{i}.txt")), b"needle_one\n").unwrap();
		}
		let e = engine_at(&root);
		*e.tree_write() = Some(walked(&e, 0));
		let batch: Vec<(u32, PathBuf, FileSig, Vec<u32>)> = e
			.with_tree_mut(|tree, _| {
				(1..tree.nodes.len() as u32)
					.filter(|&n| tree.nodes[n as usize].kind == K_FILE)
					.map(|n| {
						let p = tree.path_of(n);
						let sig = std::fs::symlink_metadata(&p).map(|m| FileSig::of(&m)).unwrap();
						(n, p, sig, Vec::new())
					})
					.collect()
			})
			.expect("the tree is there");
		assert_eq!(batch.len(), 8, "the batch must name every file");
		for i in 0..8 {
			std::fs::remove_file(root.join(format!("f{i}.txt"))).unwrap();
		}
		*e.tree_write() = Some(walked(&e, 1));
		let nodes = e.with_tree_mut(|tree, _| tree.nodes.len()).unwrap();
		assert!(nodes < 9, "the re-walk must have left a smaller tree, it left {nodes} nodes");
		assert!(commit(&e, batch, 0));
		let docs = e.with_tree_mut(|tree, _| tree.docs.len()).unwrap();
		assert_eq!(docs, 0, "a record was linked into a tree it was not read from");
	}
}
