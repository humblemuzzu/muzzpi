//! The content index: which 3-byte chunks each text file holds, in
//! immutable memory-mapped segments. It only ever narrows the files a grep
//! reads; every candidate is still searched with rg's own matcher.

use std::io::Write;
use std::os::darwin::fs::MetadataExt as DarwinMetadataExt;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use memmap2::Mmap;
use rayon::prelude::*;

use crate::plan::{Q, Tri, tri};
use crate::tree::{ctime_ns, mtime_ns};

/// Not indexed yet (or changed since): read at query time.
pub const DOC_PENDING: u32 = u32::MAX;
/// Never stored in the index, always read at query time: files in secret
/// folders, and UTF-16 files (rg transcodes them before matching).
pub const DOC_LIVE: u32 = u32::MAX - 1;
/// Not indexed: over the size cap, outside home, or a placeholder whose bytes
/// are not on this disk. A small scope reads it; a home- or disk-wide grep
/// skips it and says so.
pub const DOC_NOINDEX: u32 = u32::MAX - 2;
pub const FIRST_SPECIAL: u32 = DOC_NOINDEX;

pub const MAX_INDEXED: u64 = 1 << 20;
/// `SF_DATALESS`: the file's bytes are not on this disk (an iCloud Drive or
/// Dropbox/OneDrive placeholder). Reading one makes macOS download it.
const SF_DATALESS: u32 = 0x4000_0000;
const BATCH_BYTES: u64 = 24 << 20;
const BATCH_FILES: usize = 40_000;
/// Trigram pairs one batch may hold as well as bytes: generated and minified
/// files have close to a pair per byte, and a pair is 8 bytes before the
/// segment write turns it into postings.
const BATCH_PAIRS: usize = 8 << 20;
const MAGIC: &[u8; 8] = b"SDSEG003";
/// magic, doc count, trigram count, paths length, postings length, rules
/// digest, crc32 of everything after the header
const HEADER: usize = 44;
const DOC_REC: usize = 40;
const TRI_REC: usize = 16;
/// A blocked index measures the disk again at most this often.
const RECHECK: Duration = Duration::from_secs(600);

/// What tells one file from another at the same path: its identity, not only
/// its size and time (`touch -r`, `rsync -a`, `cp -p` keep both of those).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct FileSig {
	pub size: u64,
	pub mtime: i64,
	pub ctime: i64,
	pub ino: u64,
}

impl FileSig {
	pub fn of(m: &std::fs::Metadata) -> FileSig {
		FileSig {
			size: m.len(),
			mtime: mtime_ns(m),
			ctime: ctime_ns(m),
			ino: m.ino(),
		}
	}
}

#[derive(Clone, Copy, Debug)]
pub struct DocMeta {
	pub seg: u32,
	pub local: u32,
	pub sig: FileSig,
	/// The tree node this record was linked to; stale once that node's
	/// `doc` points elsewhere.
	pub node: u32,
}

/// Why the index may not grow right now.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Block {
	Disk,
	Cap,
}

impl Block {
	pub fn name(self) -> &'static str {
		match self {
			Block::Disk => "disk",
			Block::Cap => "cap",
		}
	}
}

/// What the content index may use on disk.
pub struct Budget {
	/// Free space left on the volume: this many bytes, or this percentage of
	/// it, whichever is more.
	pub free_floor: u64,
	pub free_percent: u64,
	/// Segment bytes in total.
	pub cap: u64,
}

/// No floor and no cap, for the tests and the selftest that are not about
/// the budget.
pub const UNLIMITED: Budget = Budget {
	free_floor: 0,
	free_percent: 0,
	cap: u64::MAX,
};

impl Budget {
	fn floor(&self, volume: u64) -> u64 {
		self.free_floor.max(volume / 100 * self.free_percent)
	}
}

#[derive(Default)]
struct Gate {
	blocked: Option<Block>,
	checked: Option<Instant>,
}

pub struct Segment {
	pub id: u64,
	path: PathBuf,
	map: Mmap,
	n_docs: u32,
	n_tris: u32,
	paths_off: usize,
	paths_len: usize,
	tris_off: usize,
	post_off: usize,
	post_len: usize,
	/// Docs still linked from the tree; the rest is garbage awaiting a merge.
	pub live: u32,
	/// Bytes of the files indexed in it.
	bytes: u64,
	/// Decoding found the file disagreeing with itself: every doc is a
	/// candidate from here on, and the next pass over the index drops it.
	damaged: AtomicBool,
}

fn u32_at(b: &[u8], o: usize) -> Option<u32> {
	b.get(o..o.checked_add(4)?)?.try_into().ok().map(u32::from_le_bytes)
}

fn u64_at(b: &[u8], o: usize) -> Option<u64> {
	b.get(o..o.checked_add(8)?)?.try_into().ok().map(u64::from_le_bytes)
}

/// (free, total) bytes on the volume holding `dir`; None when it cannot be
/// asked, which blocks nothing.
fn free_space(dir: &Path) -> Option<(u64, u64)> {
	let path = std::ffi::CString::new(dir.as_os_str().as_bytes()).ok()?;
	let mut s: libc::statvfs = unsafe { std::mem::zeroed() };
	(unsafe { libc::statvfs(path.as_ptr(), &mut s) } == 0)
		.then(|| (s.f_bavail as u64 * s.f_frsize as u64, s.f_blocks as u64 * s.f_frsize as u64))
}

fn varint(out: &mut Vec<u8>, mut v: u32) {
	while v >= 0x80 {
		out.push((v as u8) | 0x80);
		v >>= 7;
	}
	out.push(v as u8);
}

impl Segment {
	/// None for a damaged segment, or one written under other index rules.
	fn open(path: &Path, id: u64, rules: u64) -> Option<Segment> {
		let f = std::fs::File::open(path).ok()?;
		let map = unsafe { Mmap::map(&f) }.ok()?;
		if map.len() < HEADER || &map[..8] != MAGIC || u64_at(&map, 32)? != rules {
			return None;
		}
		let n_docs = u32_at(&map, 8)?;
		let n_tris = u32_at(&map, 12)?;
		let paths_len = usize::try_from(u64_at(&map, 16)?).ok()?;
		let post_len = usize::try_from(u64_at(&map, 24)?).ok()?;
		let paths_off = HEADER.checked_add((n_docs as usize).checked_mul(DOC_REC)?)?;
		let tris_off = paths_off.checked_add(paths_len)?.checked_add(7)? & !7;
		let post_off = tris_off.checked_add((n_tris as usize).checked_mul(TRI_REC)?)?;
		if post_off.checked_add(post_len)? != map.len() || crc32fast::hash(&map[HEADER..]) != u32_at(&map, 40)? {
			return None;
		}
		let bytes = (0..n_docs as usize).filter_map(|i| u64_at(&map, HEADER + i * DOC_REC)).sum();
		let seg = Segment {
			id,
			path: path.to_path_buf(),
			map,
			n_docs,
			n_tris,
			paths_off,
			paths_len,
			tris_off,
			post_off,
			post_len,
			live: 0,
			bytes,
			damaged: AtomicBool::new(false),
		};
		seg.verify().then_some(seg)
	}

	/// Every offset and range in the file, once: the decode paths then only
	/// have to check their own arithmetic.
	fn verify(&self) -> bool {
		for i in 0..self.n_docs {
			let Some(o) = self.rec_off(i) else { return false };
			let (Some(po), Some(pl)) = (u32_at(&self.map, o + 32), u32_at(&self.map, o + 36)) else {
				return false;
			};
			if (po as usize).checked_add(pl as usize).is_none_or(|end| end > self.paths_len) {
				return false;
			}
		}
		let mut last = None;
		for i in 0..self.n_tris as usize {
			let rec = self.tris_off + i * TRI_REC;
			let (Some(t), Some(count), Some(start)) = (u32_at(&self.map, rec), u32_at(&self.map, rec + 4), u64_at(&self.map, rec + 8))
			else {
				return false;
			};
			if last.is_some_and(|l| l >= t) || !self.postings_fit(start, count) {
				return false;
			}
			last = Some(t);
		}
		true
	}

	/// Whether `count` deltas from `start` decode inside the postings, each
	/// naming a doc that exists.
	fn postings_fit(&self, start: u64, count: u32) -> bool {
		let Ok(mut p) = usize::try_from(start) else { return false };
		if p > self.post_len {
			return false;
		}
		let mut doc = 0u64;
		for _ in 0..count {
			let Some(delta) = self.delta(&mut p) else { return false };
			doc += u64::from(delta);
			if doc >= u64::from(self.n_docs) {
				return false;
			}
		}
		true
	}

	/// One varint delta, refusing to run past the postings.
	fn delta(&self, p: &mut usize) -> Option<u32> {
		let (mut v, mut shift) = (0u32, 0u32);
		loop {
			let &b = self.map.get(self.post_off + *p)?;
			*p += 1;
			if shift >= 32 {
				return None;
			}
			v |= u32::from(b & 0x7f) << shift;
			if b < 0x80 {
				return Some(v);
			}
			shift += 7;
		}
	}

	pub fn n_docs(&self) -> u32 {
		self.n_docs
	}

	fn rec_off(&self, i: u32) -> Option<usize> {
		(i < self.n_docs).then(|| HEADER + i as usize * DOC_REC)
	}

	/// `FileSig` and path of local doc `i`; None for a record the file does
	/// not hold.
	pub fn doc(&self, i: u32) -> Option<(FileSig, &[u8])> {
		let found = self.doc_at(i);
		if found.is_none() {
			self.damaged.store(true, Ordering::Relaxed);
		}
		found
	}

	fn doc_at(&self, i: u32) -> Option<(FileSig, &[u8])> {
		let o = self.rec_off(i)?;
		let sig = FileSig {
			size: u64_at(&self.map, o)?,
			mtime: u64_at(&self.map, o + 8)? as i64,
			ctime: u64_at(&self.map, o + 16)? as i64,
			ino: u64_at(&self.map, o + 24)?,
		};
		let start = self.paths_off.checked_add(u32_at(&self.map, o + 32)? as usize)?;
		let end = start.checked_add(u32_at(&self.map, o + 36)? as usize)?;
		Some((sig, self.map.get(start..end)?))
	}

	/// The trigram's record: Ok(None) when the segment holds no such trigram.
	fn tris_rec(&self, t: Tri) -> Result<Option<usize>, ()> {
		let (mut lo, mut hi) = (0usize, self.n_tris as usize);
		while lo < hi {
			let mid = (lo + hi) / 2;
			let key = u32_at(&self.map, self.tris_off + mid * TRI_REC).ok_or(())?;
			if key < t {
				lo = mid + 1;
			} else {
				hi = mid;
			}
		}
		if lo >= self.n_tris as usize {
			return Ok(None);
		}
		let rec = self.tris_off + lo * TRI_REC;
		Ok((u32_at(&self.map, rec).ok_or(())? == t).then_some(rec))
	}

	fn count(&self, t: Tri) -> Result<u32, ()> {
		match self.tris_rec(t)? {
			Some(rec) => u32_at(&self.map, rec + 4).ok_or(()),
			None => Ok(0),
		}
	}

	fn postings(&self, t: Tri, bits: &mut [u64]) -> Result<(), ()> {
		#[cfg(test)]
		counted::LISTS.with(|c| c.set(c.get() + 1));
		let Some(rec) = self.tris_rec(t)? else { return Ok(()) };
		let count = u32_at(&self.map, rec + 4).ok_or(())?;
		let Ok(mut p) = usize::try_from(u64_at(&self.map, rec + 8).ok_or(())?) else {
			return Err(());
		};
		if p > self.post_len {
			return Err(());
		}
		let mut doc = 0u64;
		for _ in 0..count {
			doc += u64::from(self.delta(&mut p).ok_or(())?);
			let Some(w) = bits.get_mut((doc / 64) as usize) else { return Err(()) };
			*w |= 1 << (doc % 64);
		}
		Ok(())
	}

	/// Local docs that may satisfy `q`; None means all of them.
	fn eval(&self, q: &Q) -> Option<Vec<u64>> {
		let bits = self.eval_checked(q);
		if bits.is_err() {
			self.damaged.store(true, Ordering::Relaxed);
		}
		bits.unwrap_or(None)
	}

	fn eval_checked(&self, q: &Q) -> Result<Option<Vec<u64>>, ()> {
		let words = (self.n_docs as usize).div_ceil(64);
		Ok(match q {
			Q::All => None,
			Q::Tri(t) => {
				let mut bits = vec![0u64; words];
				self.postings(*t, &mut bits)?;
				Some(bits)
			}
			Q::And(qs) => {
				let mut acc: Option<Vec<u64>> = None;
				for q in self.fewest(qs)? {
					if let Some(b) = self.eval_checked(q)? {
						acc = Some(match acc {
							None => b,
							Some(mut a) => {
								a.iter_mut().zip(&b).for_each(|(x, y)| *x &= y);
								a
							}
						});
						if acc.as_ref().is_some_and(|a| a.iter().all(|&w| w == 0)) {
							break;
						}
					}
				}
				acc
			}
			Q::Or(qs) => {
				let mut acc = vec![0u64; words];
				for q in qs {
					let Some(b) = self.eval_checked(q)? else { return Ok(None) };
					acc.iter_mut().zip(&b).for_each(|(x, y)| *x |= y);
				}
				Some(acc)
			}
		})
	}

	/// The terms of an `And` worth decoding in this segment: every term that is
	/// not a trigram, and of the trigrams only the rarest few. Leaving one out
	/// only widens the answer, so it stays a superset of the real matches.
	fn fewest<'q>(&self, qs: &'q [Q]) -> Result<Vec<&'q Q>, ()> {
		let mut tris: Vec<(u32, &'q Q)> = Vec::new();
		let mut rest: Vec<&'q Q> = Vec::new();
		for q in qs {
			match q {
				Q::Tri(t) => tris.push((self.count(*t)?, q)),
				q => rest.push(q),
			}
		}
		if tris.len() > MAX_AND_TERMS {
			tris.sort_unstable_by_key(|&(count, _)| count);
			tris.truncate(MAX_AND_TERMS);
		}
		rest.extend(tris.into_iter().map(|(_, q)| q));
		Ok(rest)
	}

	fn damaged(&self) -> bool {
		self.damaged.load(Ordering::Relaxed)
	}
}

/// One file for `Content::write_segment`.
pub struct DocIn<'a> {
	pub path: &'a Path,
	pub sig: FileSig,
	pub tris: &'a [Tri],
}

/// Per-segment candidate bitsets for one query (None: every doc).
pub struct Candidates(Vec<Option<Vec<u64>>>);

impl Candidates {
	pub fn contains(&self, m: &DocMeta) -> bool {
		match self.0.get(m.seg as usize) {
			Some(Some(bits)) => bits
				.get((m.local / 64) as usize)
				.is_some_and(|w| w >> (m.local % 64) & 1 == 1),
			_ => true,
		}
	}
}

pub struct Content {
	dir: PathBuf,
	pub segs: Vec<Option<Segment>>,
	next_id: u64,
	rules: u64,
	budget: Budget,
	gate: Mutex<Gate>,
}

/// What reading a file for the index found.
pub enum Read {
	Indexed { sig: FileSig, tris: Vec<Tri> },
	Special(u32),
	/// Changed after `settled_after`: left unread until it has been still.
	Recent(FileSig),
}

/// Trigram terms an `And` decodes before the rest are dropped: a long literal
/// becomes one term per window, and decoding all of them costs far more than
/// the six that decide almost every file.
const MAX_AND_TERMS: usize = 6;

/// Whether a file's stat flags say its bytes are somewhere else than on this
/// disk.
pub fn is_dataless(flags: u32) -> bool {
	flags & SF_DATALESS != 0
}

/// What the index must do with a file whose stat reported `flags`: a marker
/// for one it may not read, None to read it.
fn not_indexable(meta: &std::fs::Metadata, flags: u32) -> Option<u32> {
	if !meta.is_file() || meta.len() > MAX_INDEXED || is_dataless(flags) {
		return Some(DOC_NOINDEX);
	}
	None
}

/// Reads a file as the index stores it: ASCII-lowercased trigrams, and none
/// at all for a file with a NUL in it (rg shows no line of a binary file).
/// A file whose ctime lies between `settled_after` and `now` is not read.
pub fn read_for_index(path: &Path, settled_after: i64, now: i64) -> Read {
	let Ok(meta) = std::fs::symlink_metadata(path) else {
		return Read::Special(DOC_PENDING);
	};
	if let Some(marker) = not_indexable(&meta, meta.st_flags()) {
		return Read::Special(marker);
	}
	let sig = FileSig::of(&meta);
	if sig.ctime > settled_after && sig.ctime <= now {
		return Read::Recent(sig);
	}
	let Ok(bytes) = std::fs::read(path) else {
		return Read::Special(DOC_LIVE);
	};
	if bytes.starts_with(&[0xFF, 0xFE]) || bytes.starts_with(&[0xFE, 0xFF]) {
		return Read::Special(DOC_LIVE);
	}
	let text: &[u8] = if memchr_nul(&bytes).is_some() { &[] } else { &bytes };
	let mut tris: Vec<Tri> = text.windows(3).map(|w| tri(w[0], w[1], w[2])).collect();
	tris.sort_unstable();
	tris.dedup();
	// The list was sized for every 3-byte window; a batch holds thousands.
	tris.shrink_to_fit();
	Read::Indexed { sig, tris }
}

fn memchr_nul(b: &[u8]) -> Option<usize> {
	b.iter().position(|&x| x == 0)
}

/// Counts the posting lists one segment's evaluation decodes, on the thread
/// that decodes them: the test that a long `And` stays cheap.
#[cfg(test)]
mod counted {
	use std::cell::Cell;

	thread_local!(pub static LISTS: Cell<usize> = const { Cell::new(0) });

	pub fn take() -> usize {
		LISTS.with(|c| c.replace(0))
	}
}

/// (trigram, doc) pairs for one segment, sized once: a full batch's pairs run
/// to tens of megabytes, and growing the buffer would keep a second copy.
fn pairs(docs: &[DocIn]) -> Vec<u64> {
	let mut pairs = Vec::with_capacity(docs.iter().map(|d| d.tris.len()).sum());
	for (i, d) in docs.iter().enumerate() {
		pairs.extend(d.tris.iter().map(|&t| (t as u64) << 32 | i as u64));
	}
	pairs
}

impl Content {
	/// Opens the segments in `dir`, deleting any that are damaged, written
	/// under rules other than `rules` (see `engine::index_rules`), or left
	/// half-written by a crash.
	pub fn open(dir: &Path, rules: u64, budget: Budget) -> Content {
		let _ = std::fs::create_dir_all(dir);
		let _ = std::fs::set_permissions(dir, std::os::unix::fs::PermissionsExt::from_mode(0o700));
		let mut found: Vec<(u64, PathBuf)> = Vec::new();
		for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
			let name = e.file_name();
			let Some(s) = name.to_str() else { continue };
			let Some(stem) = s.strip_prefix("seg-") else { continue };
			if stem.ends_with(".tmp") {
				let _ = std::fs::remove_file(e.path());
			} else if let Some(id) = stem.strip_suffix(".bin").and_then(|i| i.parse().ok()) {
				found.push((id, e.path()));
			}
		}
		found.sort();
		let next_id = found.last().map_or(1, |f| f.0 + 1);
		let segs = found
			.into_iter()
			.map(|(id, p)| {
				let s = Segment::open(&p, id, rules);
				if s.is_none() {
					let _ = std::fs::remove_file(&p);
				}
				s
			})
			.collect();
		Content {
			dir: dir.to_path_buf(),
			segs,
			next_id,
			rules,
			budget,
			gate: Mutex::new(Gate::default()),
		}
	}

	/// An upper bound on the share of indexed files `q` admits, from the
	/// stored posting counts alone (nothing is decoded).
	pub fn estimate(&self, q: &Q) -> f64 {
		let total: f64 = self.segs.iter().flatten().map(|s| s.n_docs as f64).sum();
		if total == 0.0 {
			return 1.0;
		}
		fn est(segs: &[Option<Segment>], q: &Q, total: f64) -> Option<f64> {
			Some(match q {
				Q::All => 1.0,
				Q::Tri(t) => segs
					.iter()
					.flatten()
					.try_fold(0.0, |sum, s| s.count(*t).ok().map(|c| sum + c as f64))?
					/ total,
				Q::And(qs) => qs.iter().try_fold(1.0f64, |low, q| est(segs, q, total).map(|e| low.min(e)))?,
				Q::Or(qs) => qs.iter().try_fold(0.0f64, |sum, q| est(segs, q, total).map(|e| sum + e))?.min(1.0),
			})
		}
		est(&self.segs, q, total).unwrap_or(1.0)
	}

	pub fn candidates(&self, q: &Q) -> Candidates {
		Candidates(crate::engine::parallel_query(|| self.segs.par_iter().map(|s| s.as_ref().and_then(|s| s.eval(q))).collect()))
	}

	/// Bytes the segment files take.
	pub fn bytes(&self) -> u64 {
		self.segs.iter().flatten().map(|s| s.map.len() as u64).sum()
	}

	/// None when the index may take another batch. The segment total is
	/// always checked; the volume is measured at most every `RECHECK`, and the
	/// answer stands until then.
	pub fn room(&self) -> Option<Block> {
		if self.bytes().saturating_add(BATCH_BYTES) > self.budget.cap {
			return Some(Block::Cap);
		}
		let mut gate = self.gate.lock().unwrap();
		if gate.blocked.is_some() && gate.checked.is_some_and(|t| t.elapsed() < RECHECK) {
			return gate.blocked;
		}
		gate.checked = Some(Instant::now());
		gate.blocked = free_space(&self.dir).and_then(|(free, volume)| {
			(free < self.budget.floor(volume).saturating_add(BATCH_BYTES)).then_some(Block::Disk)
		});
		gate.blocked
	}

	/// Forgets the last measurement, so the next `room` measures again.
	pub fn recheck(&self) {
		self.gate.lock().unwrap().checked = None;
	}

	/// Writes one segment for files already read; returns its slot, or None
	/// when nothing in the batch was indexable.
	pub fn write_segment(&mut self, docs: &[DocIn]) -> std::io::Result<Option<u32>> {
		if docs.is_empty() {
			return Ok(None);
		}
		let mut paths = Vec::new();
		let mut recs = Vec::with_capacity(docs.len() * DOC_REC);
		for DocIn { path: p, sig, .. } in docs {
			let b = p.as_os_str().as_bytes();
			recs.extend_from_slice(&sig.size.to_le_bytes());
			recs.extend_from_slice(&(sig.mtime as u64).to_le_bytes());
			recs.extend_from_slice(&(sig.ctime as u64).to_le_bytes());
			recs.extend_from_slice(&sig.ino.to_le_bytes());
			recs.extend_from_slice(&(paths.len() as u32).to_le_bytes());
			recs.extend_from_slice(&(b.len() as u32).to_le_bytes());
			paths.extend_from_slice(b);
		}
		let mut pairs = pairs(docs);
		crate::engine::parallel_background(|| pairs.par_sort_unstable());
		let mut tris = Vec::new();
		let mut post = Vec::new();
		let mut i = 0;
		while i < pairs.len() {
			let t = (pairs[i] >> 32) as u32;
			let start = post.len() as u64;
			let mut prev = 0u32;
			let mut count = 0u32;
			while i < pairs.len() && (pairs[i] >> 32) as u32 == t {
				let d = pairs[i] as u32;
				varint(&mut post, d - prev);
				prev = d;
				count += 1;
				i += 1;
			}
			tris.extend_from_slice(&t.to_le_bytes());
			tris.extend_from_slice(&count.to_le_bytes());
			tris.extend_from_slice(&start.to_le_bytes());
		}
		drop(pairs);
		let n_tris = (tris.len() / TRI_REC) as u32;
		let pad = ((HEADER + recs.len() + paths.len() + 7) & !7) - (HEADER + recs.len() + paths.len());
		let zeros = vec![0u8; pad];
		let body = [&recs[..], &paths, &zeros, &tris, &post];
		let mut header = Vec::with_capacity(HEADER);
		header.extend_from_slice(MAGIC);
		header.extend_from_slice(&(docs.len() as u32).to_le_bytes());
		header.extend_from_slice(&n_tris.to_le_bytes());
		header.extend_from_slice(&(paths.len() as u64).to_le_bytes());
		header.extend_from_slice(&(post.len() as u64).to_le_bytes());
		header.extend_from_slice(&self.rules.to_le_bytes());
		let mut crc = crc32fast::Hasher::new();
		body.iter().for_each(|part| crc.update(part));
		header.extend_from_slice(&crc.finalize().to_le_bytes());

		let id = self.next_id;
		self.next_id += 1;
		let path = self.dir.join(format!("seg-{id}.bin"));
		let tmp = self.dir.join(format!("seg-{id}.tmp"));
		let written = (|| {
			let mut f = std::fs::OpenOptions::new()
				.create(true)
				.truncate(true)
				.write(true)
				.mode(0o600)
				.custom_flags(libc::O_NOFOLLOW)
				.open(&tmp)?;
			f.write_all(&header)?;
			body.iter().try_for_each(|part| f.write_all(part))?;
			f.sync_all()?;
			drop(f);
			std::fs::rename(&tmp, &path)?;
			std::fs::File::open(&self.dir)?.sync_all()
		})();
		if let Err(e) = written {
			let _ = std::fs::remove_file(&tmp);
			return Err(e);
		}
		let seg = Segment::open(&path, id, self.rules).ok_or_else(|| std::io::Error::other("segment unreadable after write"))?;
		self.segs.push(Some(seg));
		Ok(Some((self.segs.len() - 1) as u32))
	}

	pub fn drop_segment(&mut self, slot: u32) {
		if let Some(s) = self.segs.get_mut(slot as usize).and_then(Option::take) {
			let _ = std::fs::remove_file(&s.path);
		}
	}

	/// Drops the segments whose decoding found them inconsistent.
	pub fn drop_damaged(&mut self) {
		let damaged: Vec<u32> = self
			.segs
			.iter()
			.enumerate()
			.filter(|(_, s)| s.as_ref().is_some_and(Segment::damaged))
			.map(|(slot, _)| slot as u32)
			.collect();
		for slot in damaged {
			self.drop_segment(slot);
		}
	}

	/// Segments worth rebuilding: mostly garbage, or too many small ones.
	/// Small means well short of both batch limits, so a merge's own output
	/// (full batches, and at most one remainder) is never small again.
	pub fn to_merge(&self) -> Vec<u32> {
		let mut out: Vec<u32> = Vec::new();
		let mut small = Vec::new();
		for (slot, s) in self.segs.iter().enumerate() {
			let Some(s) = s else { continue };
			if s.n_docs > 0 && (s.live as u64) * 2 < s.n_docs as u64 {
				out.push(slot as u32);
			} else if s.bytes < BATCH_BYTES / 4 && (s.n_docs as usize) < BATCH_FILES / 2 {
				small.push(slot as u32);
			}
		}
		if small.len() >= 16 {
			out.extend(small);
		}
		out
	}

	pub fn batch_limits() -> (u64, usize, usize) {
		(BATCH_BYTES, BATCH_FILES, BATCH_PAIRS)
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn sig(size: u64) -> FileSig {
		FileSig {
			size,
			mtime: 0,
			ctime: 0,
			ino: 0,
		}
	}

	fn segment(c: &mut Content, path: &Path, docs: usize, size: u64) {
		let docs: Vec<DocIn> = (0..docs).map(|_| DocIn { path, sig: sig(size), tris: &[1] }).collect();
		c.write_segment(&docs).unwrap();
	}

	#[test]
	fn a_merge_never_feeds_itself() {
		let dir = std::env::temp_dir().join(format!("searchd-merge-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&dir);
		let mut c = Content::open(&dir, 9, UNLIMITED);
		let p = dir.join("f");
		// What a batch of large files writes: few docs, a full byte budget.
		for _ in 0..20 {
			segment(&mut c, &p, 256, BATCH_BYTES / 256 + 1);
		}
		for s in c.segs.iter_mut().flatten() {
			s.live = s.n_docs;
		}
		assert!(c.to_merge().is_empty(), "full segments were picked for a merge");
		for _ in 0..16 {
			segment(&mut c, &p, 3, 10);
		}
		for s in c.segs.iter_mut().flatten() {
			s.live = s.n_docs;
		}
		assert_eq!(c.to_merge().len(), 16, "small segments were not merged");
		let _ = std::fs::remove_dir_all(&dir);
	}

	#[test]
	fn the_pair_buffer_is_reserved_exactly() {
		let tris: Vec<Tri> = (0..7).collect();
		let docs: Vec<DocIn> = (0..3).map(|_| DocIn { path: Path::new("f"), sig: sig(1), tris: &tris }).collect();
		let pairs = pairs(&docs);
		assert_eq!(pairs.len(), 21);
		assert_eq!(pairs.capacity(), 21, "the pair vector grew while being filled");
	}

	/// A segment file is trusted only as far as its checksum and its own
	/// offsets: whatever a damaged one holds, it is dropped and never decoded.
	#[test]
	fn a_corrupted_segment_is_dropped() {
		let root = std::env::temp_dir().join(format!("searchd-damaged-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&root);
		let src = root.join("src");
		let mut c = Content::open(&src, 7, UNLIMITED);
		let tris: Vec<Vec<Tri>> = (0..8u32).map(|i| vec![0x616263, 0x616264 + i, 0x616265]).collect();
		let docs: Vec<DocIn> = (0..8u32)
			.map(|i| DocIn {
				path: Path::new("a/long/path/with/a/name.txt"),
				sig: sig(1000 + u64::from(i)),
				tris: &tris[i as usize],
			})
			.collect();
		c.write_segment(&docs).unwrap();
		assert_eq!(c.candidates(&Q::Tri(0x616263)).0, [Some(vec![0xff])], "the trigram is in every doc");
		let bytes = std::fs::read(src.join("seg-1.bin")).unwrap();
		assert!(bytes.len() > HEADER + 8 * DOC_REC);
		let mut seed = 0x2545_f491_4f6c_dd1du64;
		let mut rand = move || {
			seed ^= seed << 13;
			seed ^= seed >> 7;
			seed ^= seed << 17;
			seed
		};
		for i in 0..500 {
			let mut b = bytes.clone();
			match rand() % 4 {
				0 => {
					let at = (rand() as usize) % b.len();
					b[at] ^= 1 << (rand() % 8);
				}
				1 => {
					let at = HEADER + (rand() as usize) % (b.len() - HEADER);
					b[at] = (rand() % 256) as u8;
				}
				2 => b.truncate(HEADER + (rand() as usize) % (b.len() - HEADER)),
				_ => {
					let at = 8 * (rand() as usize % 5);
					b[at..at + 4].fill(0xff);
				}
			}
			let dir = root.join(format!("iter{i}"));
			std::fs::create_dir_all(&dir).unwrap();
			std::fs::write(dir.join("seg-1.bin"), &b).unwrap();
			let c = Content::open(&dir, 7, UNLIMITED);
			assert_eq!(c.segs.iter().flatten().count(), 0, "iteration {i} kept a damaged segment");
			let _ = std::fs::remove_dir_all(&dir);
		}
		let _ = std::fs::remove_dir_all(&root);
	}

	/// A long literal becomes one trigram term per window. A segment decodes only
	/// the rarest few of them, and a file that holds it is still a candidate.
	#[test]
	fn a_long_literal_decodes_only_the_rarest_posting_lists() {
		const SIX: usize = 6;
		let dir = std::env::temp_dir().join(format!("searchd-rarest-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&dir);
		let mut c = Content::open(&dir, 4, UNLIMITED);
		let literal = "the quick brown fox jumps over the lazy dog and keeps on running past the barn at dawn";
		assert!(literal.len() > 80);
		let full: Vec<Tri> = {
			let mut t: Vec<Tri> = literal.as_bytes().windows(3).map(|w| tri(w[0], w[1], w[2])).collect();
			t.sort_unstable();
			t.dedup();
			t
		};
		assert!(full.len() > SIX * 4, "{} trigrams", full.len());
		// The first file holds the literal; the others hold most of it.
		let sets = [full.clone(), full[..full.len() - 1].to_vec(), full[full.len() / 2..].to_vec()];
		let docs: Vec<DocIn> = sets
			.iter()
			.enumerate()
			.map(|(i, tris)| DocIn { path: Path::new("f"), sig: sig(10 + i as u64), tris })
			.collect();
		c.write_segment(&docs).unwrap();

		let q = crate::plan::plan(literal, true, false);
		assert!(matches!(q, Q::And(_)), "a long literal is an And of trigrams");
		let seg = c.segs[0].as_ref().unwrap();
		counted::take();
		let bits = seg.eval(&q);
		let decoded = counted::take();
		assert!(decoded <= SIX, "{decoded} posting lists decoded for one long literal");
		let bits = bits.expect("a narrowed answer, not every doc");
		assert_eq!(bits[0] & 1, 1, "the file that holds the literal is not a candidate");
		let _ = std::fs::remove_dir_all(&dir);
	}

	/// A file whose stat flags say it is not on this disk is left to the index's
	/// "not indexed" marker without a read: reading it makes macOS download it.
	#[test]
	fn a_placeholder_is_never_read_for_the_index() {
		assert!(is_dataless(SF_DATALESS));
		assert!(is_dataless(SF_DATALESS | 0x20), "other flags beside it change nothing");
		assert!(!is_dataless(0));
		assert!(!is_dataless(0x20 | 0x8000), "readable files carry flags too");

		let dir = std::env::temp_dir().join(format!("searchd-dataless-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&dir);
		std::fs::create_dir_all(&dir).unwrap();
		let path = dir.join("f.txt");
		std::fs::write(&path, b"needle\n").unwrap();
		let meta = std::fs::symlink_metadata(&path).unwrap();
		assert_eq!(not_indexable(&meta, meta.st_flags()), None, "a plain file must be read");
		assert_eq!(not_indexable(&meta, meta.st_flags() | SF_DATALESS), Some(DOC_NOINDEX));
		assert!(matches!(read_for_index(&path, i64::MAX, i64::MAX), Read::Indexed { .. }));
		let _ = std::fs::remove_dir_all(&dir);
	}

	/// A symlink where a segment is written must fail the write, not write
	/// through it: the daemon's own files are no one else's.
	#[test]
	fn a_symlink_where_a_segment_is_written_stops_the_write() {
		let root = std::env::temp_dir().join(format!("searchd-tmp-symlink-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&root);
		let dir = root.join("content");
		let victim = root.join("victim.txt");
		std::fs::create_dir_all(victim.parent().unwrap()).unwrap();
		std::fs::write(&victim, b"untouched\n").unwrap();
		let mut c = Content::open(&dir, 3, UNLIMITED);
		let path = root.join("a.txt");
		std::fs::write(&path, b"needle\n").unwrap();
		std::os::unix::fs::symlink(&victim, dir.join("seg-1.tmp")).unwrap();
		let docs = [DocIn { path: &path, sig: sig(7), tris: &[1] }];
		assert!(c.write_segment(&docs).is_err(), "a write through a planted symlink must fail");
		assert_eq!(std::fs::read(&victim).unwrap(), b"untouched\n", "the write went through the symlink");
		assert_eq!(c.segs.iter().flatten().count(), 0);
		assert!(!dir.join("seg-1.bin").exists(), "a segment was written anyway");
		let _ = std::fs::remove_dir_all(&root);
	}

	/// A file rewritten under a live map: decoding answers "every doc is a
	/// candidate" and marks the segment, instead of panicking a query thread.
	#[test]
	fn a_segment_rewritten_under_its_map_answers_all_docs_and_is_dropped() {
		use std::io::{Seek, SeekFrom};

		let dir = std::env::temp_dir().join(format!("searchd-remap-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&dir);
		let mut c = Content::open(&dir, 7, UNLIMITED);
		let docs: Vec<DocIn> = (0..8u32)
			.map(|i| DocIn {
				path: Path::new("a/name.txt"),
				sig: sig(10 + u64::from(i)),
				tris: &[0x616263, 0x616264],
			})
			.collect();
		c.write_segment(&docs).unwrap();
		let path = dir.join("seg-1.bin");
		let (tris_off, rec) = {
			let seg = c.segs[0].as_ref().unwrap();
			(seg.tris_off, HEADER + 3 * DOC_REC)
		};
		let mut f = std::fs::OpenOptions::new().write(true).open(&path).unwrap();

		f.seek(SeekFrom::Start((rec + 36) as u64)).unwrap();
		f.write_all(&u32::MAX.to_le_bytes()).unwrap();
		assert!(c.segs[0].as_ref().unwrap().doc(3).is_none(), "a path outside the file is not a doc");

		f.seek(SeekFrom::Start((tris_off + 4) as u64)).unwrap();
		f.write_all(&u32::MAX.to_le_bytes()).unwrap();
		f.write_all(&u64::MAX.to_le_bytes()).unwrap();
		drop(f);
		assert_eq!(c.candidates(&Q::Tri(0x616263)).0, [None], "every doc must be a candidate");
		assert!(c.estimate(&Q::Tri(0x616263)) >= 1.0, "the estimate must stay an upper bound");
		c.drop_damaged();
		assert_eq!(c.segs.iter().flatten().count(), 0, "the segment was not dropped");
		assert!(!path.exists(), "the segment file is still there");
		let _ = std::fs::remove_dir_all(&dir);
	}
}
