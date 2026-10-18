use std::collections::HashMap;
use std::ffi::OsStr;
use std::hash::{BuildHasher, Hasher};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU32, Ordering};

use ignore::{DirEntry, IncrementalIgnore, ParallelVisitor, ParallelVisitorBuilder, WalkState};
use rayon::prelude::*;

use crate::content::{DOC_PENDING, DocMeta, FileSig, FIRST_SPECIAL};
use crate::rules::{Exclusions, walk_builder};

pub const K_FILE: u8 = 0;
pub const K_DIR: u8 = 1;
pub const K_LINK: u8 = 2;
pub const K_OTHER: u8 = 3;

pub const F_DEAD: u8 = 4;
/// rg would report an error here: an unreadable folder or a broken ignore file.
pub const F_ERROR: u8 = 8;
/// A folder the index records but does not enter (`rules::Exclusions`).
pub const F_SKIP: u8 = 16;

pub const NO_DIR: u32 = u32::MAX;
/// `Dir::changed` of a folder whose new subfolders are still being walked: no
/// ctime equals it, so the folder reads as stale until they are grafted.
const NOT_GRAFTED: i64 = i64::MIN;

/// One entry rg's walker yields: the tree holds exactly what `rg --files
/// --hidden --glob '!.git' --glob '!.jj'` lists from the root, plus folders.
#[derive(Clone, Copy)]
pub struct Node {
	pub parent: u32,
	name_off: u32,
	name_len: u16,
	pub kind: u8,
	pub flags: u8,
	pub dir: u32,
	/// A file's record in `Tree::docs`, or one of the `content::DOC_*` markers.
	pub doc: u32,
}

/// A file that decides what a folder's subtree contains, by (mtime ns, size):
/// edited in place it changes the rules without touching the folder's mtime.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Stamp {
	which: u8,
	sig: (i64, u64),
}

const RULE_FILES: [&str; 5] = [".gitignore", ".ignore", ".rgignore", ".git", ".git/info/exclude"];

pub struct Dir {
	pub node: u32,
	pub children: Vec<u32>,
	/// The folder's ctime: it moves when the listing changes, and also when
	/// the folder's permissions do (mtime would miss a folder going unreadable).
	pub changed: i64,
	pub stamps: Vec<Stamp>,
}

pub struct Tree {
	pub root: PathBuf,
	pub nodes: Vec<Node>,
	names: Vec<u8>,
	pub dirs: Vec<Dir>,
	pub dead: usize,
	/// Content-index records, by `Node::doc`.
	pub docs: Vec<DocMeta>,
	/// File nodes whose content must be (re)indexed.
	pub pending: Vec<u32>,
	/// Bumped when the whole tree is replaced and every link is lost.
	pub generation: u64,
	/// Nodes flagged `F_SKIP`, dead ones included until the next prune.
	pub skips: Vec<u32>,
}

pub fn mtime_ns(m: &std::fs::Metadata) -> i64 {
	m.mtime() * 1_000_000_000 + m.mtime_nsec()
}

pub fn ctime_ns(m: &std::fs::Metadata) -> i64 {
	m.ctime() * 1_000_000_000 + m.ctime_nsec()
}

fn kind_of(ft: Option<std::fs::FileType>) -> u8 {
	match ft {
		Some(t) if t.is_symlink() => K_LINK,
		Some(t) if t.is_dir() => K_DIR,
		Some(t) if t.is_file() => K_FILE,
		_ => K_OTHER,
	}
}

fn error_path(e: &ignore::Error) -> Option<PathBuf> {
	match e {
		ignore::Error::WithPath { path, .. } => Some(path.clone()),
		ignore::Error::WithDepth { err, .. } | ignore::Error::WithLineNumber { err, .. } => error_path(err),
		ignore::Error::Partial(errs) => errs.iter().find_map(error_path),
		ignore::Error::Loop { child, .. } => Some(child.clone()),
		_ => None,
	}
}

fn stamps_at(path: &Path) -> Vec<Stamp> {
	let mut out = Vec::new();
	for (which, f) in RULE_FILES.iter().enumerate() {
		if let Ok(m) = std::fs::symlink_metadata(path.join(f)) {
			let sig = if which == 3 {
				(0, u64::from(m.is_dir()))
			} else {
				(mtime_ns(&m), m.len())
			};
			out.push(Stamp { which: which as u8, sig });
		}
	}
	out
}

struct Raw {
	parent: u32,
	name_off: u32,
	name_len: u16,
	kind: u8,
	dir_id: u32,
	changed: i64,
}

/// One walker thread's entries, their names packed in one buffer: a whole
/// disk is millions of entries, and an allocation each is what the
/// allocator keeps long after the walk.
#[derive(Default)]
struct Batch {
	names: Vec<u8>,
	raws: Vec<Raw>,
}

const SHARDS: usize = 64;

/// Folders by a 128-bit hash of their path (two independent keys), not a
/// copy of it: a collision is out of reach at any disk's folder count.
type DirKey = (u64, u64);

struct Shared {
	dirs: Vec<Mutex<HashMap<DirKey, u32>>>,
	next_dir: AtomicU32,
	out: Mutex<Vec<Batch>>,
	errors: Mutex<Vec<PathBuf>>,
	hashers: (
		std::collections::hash_map::RandomState,
		std::collections::hash_map::RandomState,
	),
	background: bool,
}

impl Shared {
	fn key(&self, path: &[u8]) -> DirKey {
		let mut a = self.hashers.0.build_hasher();
		a.write(path);
		let mut b = self.hashers.1.build_hasher();
		b.write(path);
		(a.finish(), b.finish())
	}

	fn shard(&self, key: DirKey) -> &Mutex<HashMap<DirKey, u32>> {
		&self.dirs[(key.0 as usize) % SHARDS]
	}
}

struct Visitor<'s> {
	s: &'s Shared,
	buf: Batch,
	last_parent: Vec<u8>,
	last_id: u32,
	qos_set: bool,
}

impl ParallelVisitor for Visitor<'_> {
	fn visit(&mut self, entry: Result<DirEntry, ignore::Error>) -> WalkState {
		if self.s.background && !self.qos_set {
			self.qos_set = true;
			crate::engine::set_qos(libc::qos_class_t::QOS_CLASS_UTILITY);
		}
		let entry = match entry {
			Ok(e) => e,
			Err(e) => {
				if let Some(p) = error_path(&e) {
					self.s.errors.lock().unwrap().push(p);
				}
				return WalkState::Continue;
			}
		};
		if entry.depth() == 0 {
			return WalkState::Continue;
		}
		let path = entry.path();
		let parent = path.parent().map(|p| p.as_os_str().as_bytes()).unwrap_or(b"");
		// The walker visits a folder before it lists it, so a parent is
		// always registered by the time its children arrive.
		let parent_id = if parent == self.last_parent.as_slice() {
			self.last_id
		} else {
			let key = self.s.key(parent);
			let Some(&id) = self.s.shard(key).lock().unwrap().get(&key) else {
				return WalkState::Continue;
			};
			self.last_parent.clear();
			self.last_parent.extend_from_slice(parent);
			self.last_id = id;
			id
		};
		let kind = kind_of(entry.file_type());
		let (dir_id, changed) = if kind == K_DIR {
			let id = self.s.next_dir.fetch_add(1, Ordering::Relaxed);
			let key = self.s.key(path.as_os_str().as_bytes());
			self.s.shard(key).lock().unwrap().insert(key, id);
			(id, entry.metadata().map(|m| ctime_ns(&m)).unwrap_or(0))
		} else {
			(NO_DIR, 0)
		};
		let name = entry.file_name().as_bytes();
		let name_off = self.buf.names.len() as u32;
		self.buf.names.extend_from_slice(name);
		self.buf.raws.push(Raw {
			parent: parent_id,
			name_off,
			name_len: name.len() as u16,
			kind,
			dir_id,
			changed,
		});
		WalkState::Continue
	}
}

impl Drop for Visitor<'_> {
	fn drop(&mut self) {
		let buf = std::mem::take(&mut self.buf);
		self.s.out.lock().unwrap().push(buf);
	}
}

struct Builder<'s>(&'s Shared);

impl<'s> ParallelVisitorBuilder<'s> for Builder<'s> {
	fn build(&mut self) -> Box<dyn ParallelVisitor + 's> {
		Box::new(Visitor {
			s: self.0,
			buf: Batch::default(),
			last_parent: Vec::new(),
			last_id: 0,
			qos_set: false,
		})
	}
}

pub struct WalkOptions<'a> {
	pub threads: usize,
	pub background: bool,
	pub exclusions: &'a Exclusions,
}

impl Tree {
	/// Walks `root` exactly as `rg --files --hidden --glob '!.git' --glob
	/// '!.jj'` would from there, keeping folders as well as files.
	pub fn walk(root: &Path, opt: &WalkOptions) -> std::io::Result<Tree> {
		let root_meta = std::fs::symlink_metadata(root)?;
		if !root_meta.is_dir() {
			return Err(std::io::Error::other("not a directory"));
		}
		let shared = Shared {
			dirs: (0..SHARDS).map(|_| Mutex::new(HashMap::new())).collect(),
			next_dir: AtomicU32::new(1),
			out: Mutex::new(Vec::new()),
			errors: Mutex::new(Vec::new()),
			hashers: Default::default(),
			background: opt.background,
		};
		let root_key = shared.key(root.as_os_str().as_bytes());
		shared.shard(root_key).lock().unwrap().insert(root_key, 0);

		let mut wb = walk_builder(root);
		wb.threads(opt.threads);
		// The walker asks this only of entries its ignore rules let through.
		let excl = opt.exclusions.clone();
		let skipped: std::sync::Arc<Mutex<Vec<PathBuf>>> = Default::default();
		let record = skipped.clone();
		wb.filter_entry(move |e| {
			let is_dir = e.file_type().is_some_and(|t| t.is_dir());
			if excl.skips(e.path(), is_dir) {
				record.lock().unwrap().push(e.path().to_path_buf());
				return false;
			}
			true
		});
		wb.build_parallel().visit(&mut Builder(&shared));

		let ndirs = shared.next_dir.load(Ordering::Relaxed) as usize;
		for s in &shared.dirs {
			*s.lock().unwrap() = HashMap::new();
		}
		let batches: Vec<Batch> = std::mem::take(&mut *shared.out.lock().unwrap());
		let total: usize = batches.iter().map(|b| b.raws.len()).sum();
		let name_bytes: usize = batches.iter().map(|b| b.names.len()).sum();

		let mut t = Tree {
			root: root.to_path_buf(),
			nodes: Vec::with_capacity(total + 1),
			names: Vec::with_capacity(name_bytes),
			dirs: Vec::with_capacity(ndirs),
			dead: 0,
			docs: Vec::new(),
			pending: Vec::new(),
			generation: 0,
			skips: Vec::new(),
		};
		t.nodes.push(Node {
			parent: u32::MAX,
			name_off: 0,
			name_len: 0,
			kind: K_DIR,
			flags: 0,
			dir: 0,
			doc: DOC_PENDING,
		});
		for _ in 0..ndirs {
			t.dirs.push(Dir {
				node: u32::MAX,
				children: Vec::new(),
				changed: 0,
				stamps: Vec::new(),
			});
		}
		t.dirs[0].node = 0;
		t.dirs[0].changed = ctime_ns(&root_meta);
		let mut parents: Vec<u32> = Vec::with_capacity(total);
		for batch in batches {
			let base = t.names.len() as u32;
			t.names.extend_from_slice(&batch.names);
			for raw in batch.raws {
				let idx = t.nodes.len() as u32;
				t.nodes.push(Node {
					parent: u32::MAX,
					name_off: base + raw.name_off,
					name_len: raw.name_len,
					kind: raw.kind,
					flags: 0,
					dir: raw.dir_id,
					doc: DOC_PENDING,
				});
				if raw.dir_id != NO_DIR {
					let d = &mut t.dirs[raw.dir_id as usize];
					d.node = idx;
					d.changed = raw.changed;
				}
				parents.push(raw.parent);
			}
		}
		for (i, &pdir) in parents.iter().enumerate() {
			let idx = i as u32 + 1;
			let pnode = t.dirs[pdir as usize].node;
			t.nodes[idx as usize].parent = pnode;
			t.dirs[pdir as usize].children.push(idx);
		}
		t.sort_children();
		let skipped = std::mem::take(&mut *skipped.lock().unwrap());
		for p in skipped {
			t.add_skip(&p);
		}

		let errors = std::mem::take(&mut *shared.errors.lock().unwrap());
		for p in errors {
			t.mark_error(&p);
		}
		let stamps: Vec<Vec<Stamp>> = crate::engine::parallel_background(|| {
			(0..t.dirs.len())
				.into_par_iter()
				.map(|d| stamps_at(&t.path_of(t.dirs[d].node)))
				.collect()
		});
		for (d, s) in stamps.into_iter().enumerate() {
			t.dirs[d].stamps = s;
		}
		Ok(t)
	}

	pub fn name(&self, n: u32) -> &[u8] {
		let node = &self.nodes[n as usize];
		&self.names[node.name_off as usize..node.name_off as usize + node.name_len as usize]
	}

	fn parts(&self, mut n: u32) -> Vec<&[u8]> {
		let mut parts = Vec::new();
		while n != 0 && n != u32::MAX {
			parts.push(self.name(n));
			n = self.nodes[n as usize].parent;
		}
		parts.reverse();
		parts
	}

	pub fn path_of(&self, n: u32) -> PathBuf {
		let mut p = self.root.clone();
		for part in self.parts(n) {
			p.push(OsStr::from_bytes(part));
		}
		p
	}

	/// The path below the root, as rg's matchers and `IncrementalIgnore` want it.
	pub fn rel_of(&self, n: u32) -> PathBuf {
		let mut p = PathBuf::new();
		for part in self.parts(n) {
			p.push(OsStr::from_bytes(part));
		}
		p
	}

	/// The path of node `n` below node `x`, as the tools print it.
	pub fn rel_string(&self, x: u32, n: u32) -> String {
		let mut parts = Vec::new();
		let mut cur = n;
		while cur != x && cur != u32::MAX {
			parts.push(self.name(cur));
			cur = self.nodes[cur as usize].parent;
		}
		parts.reverse();
		let mut out = String::with_capacity(parts.iter().map(|p| p.len() + 1).sum());
		for (i, part) in parts.iter().enumerate() {
			if i > 0 {
				out.push('/');
			}
			out.push_str(&String::from_utf8_lossy(part));
		}
		out
	}

	fn child(&self, dir: u32, name: &[u8]) -> Option<u32> {
		let d = &self.dirs[dir as usize];
		d.children
			.binary_search_by(|&c| self.name(c).cmp(name))
			.ok()
			.map(|i| d.children[i])
	}

	pub fn lookup(&self, abs: &Path) -> Option<u32> {
		let rel = abs.strip_prefix(&self.root).ok()?;
		let mut n = 0u32;
		for c in rel.components() {
			let std::path::Component::Normal(name) = c else { return None };
			let node = &self.nodes[n as usize];
			if node.dir == NO_DIR || node.flags & F_DEAD != 0 {
				return None;
			}
			n = self.child(node.dir, name.as_bytes())?;
		}
		Some(n)
	}

	fn mark_error(&mut self, p: &Path) {
		let mut cur = p.to_path_buf();
		loop {
			if let Some(n) = self.lookup(&cur) {
				let n = if self.nodes[n as usize].dir == NO_DIR {
					self.nodes[n as usize].parent
				} else {
					n
				};
				self.nodes[n as usize].flags |= F_ERROR;
				return;
			}
			if !cur.pop() || !cur.starts_with(&self.root) {
				return;
			}
		}
	}

	fn sort_children(&mut self) {
		let names = &self.names;
		let nodes = &self.nodes;
		let dirs = &mut self.dirs;
		let key = |c: &u32| {
			let n = &nodes[*c as usize];
			&names[n.name_off as usize..n.name_off as usize + n.name_len as usize]
		};
		crate::engine::parallel_background(|| {
			dirs.par_iter_mut().for_each(|d| d.children.sort_unstable_by(|a, b| key(a).cmp(key(b))));
		});
	}

	/// Records the skipped folder `abs` as a child of its walked parent.
	fn add_skip(&mut self, abs: &Path) {
		let (Some(parent), Some(name)) = (abs.parent(), abs.file_name()) else { return };
		let Some(p) = self.lookup(parent) else { return };
		let d = self.nodes[p as usize].dir;
		if d == NO_DIR {
			return;
		}
		let idx = self.push_node(p, name.as_bytes(), K_DIR, F_SKIP, NO_DIR);
		self.insert_child(d, idx);
		self.skips.push(idx);
	}

	/// Live skipped folders strictly under node `x`.
	pub fn skips_under(&self, x: u32) -> usize {
		self.skips
			.iter()
			.filter(|&&s| {
				if self.nodes[s as usize].flags & F_DEAD != 0 {
					return false;
				}
				let mut p = self.nodes[s as usize].parent;
				while p != u32::MAX {
					if p == x {
						return true;
					}
					p = self.nodes[p as usize].parent;
				}
				false
			})
			.count()
	}

	/// Whether node `x` lies in a git work tree: it or a folder above it holds
	/// `.git`. One at the tree's root or in `home` (a dotfiles repo) does not
	/// count, as in `Exclusions::in_repo`.
	pub fn in_repo(&self, x: u32, home: Option<u32>) -> bool {
		let disk_root = self.root.parent().is_none();
		std::iter::once(x).chain(self.ancestors(x)).any(|n| {
			let d = self.nodes[n as usize].dir;
			!(n == 0 && disk_root)
				&& Some(n) != home
				&& d != NO_DIR
				&& self.dirs[d as usize].stamps.iter().any(|s| s.which == 3)
		})
	}

	fn prune_skips(&mut self) {
		let nodes = &self.nodes;
		self.skips.retain(|&s| nodes[s as usize].flags & F_DEAD == 0);
	}

	fn push_node(&mut self, parent: u32, name: &[u8], kind: u8, flags: u8, dir: u32) -> u32 {
		let idx = self.nodes.len() as u32;
		let name_off = self.names.len() as u32;
		self.names.extend_from_slice(name);
		self.nodes.push(Node {
			parent,
			name_off,
			name_len: name.len() as u16,
			kind,
			flags,
			dir,
			doc: DOC_PENDING,
		});
		if kind == K_FILE {
			self.pending.push(idx);
		}
		idx
	}

	/// Every live file node at and under node `n`.
	pub fn files_under(&self, n: u32) -> Vec<u32> {
		let mut out = Vec::new();
		let mut stack = vec![n];
		while let Some(x) = stack.pop() {
			let node = &self.nodes[x as usize];
			if node.flags & F_DEAD != 0 {
				continue;
			}
			if node.kind == K_FILE {
				out.push(x);
			} else if node.dir != NO_DIR {
				stack.extend_from_slice(&self.dirs[node.dir as usize].children);
			}
		}
		out
	}

	/// The record a file node is linked to, if it is a real one.
	pub fn doc_of(&self, n: u32) -> Option<&DocMeta> {
		let d = self.nodes[n as usize].doc;
		if d >= FIRST_SPECIAL {
			return None;
		}
		self.docs.get(d as usize).filter(|m| m.node == n)
	}

	/// Unlinks a file whose bytes may differ from what was indexed.
	pub fn invalidate(&mut self, n: u32) {
		let node = &mut self.nodes[n as usize];
		if node.kind == K_FILE && node.doc != DOC_PENDING {
			node.doc = DOC_PENDING;
			self.pending.push(n);
		}
	}

	/// Live folders at and under node `n`, or None past `max` folders or
	/// `max` entries (a grep in a checked scope stats every file).
	pub fn subtree_dirs(&self, n: u32, max: usize) -> Option<Vec<u32>> {
		let mut out = Vec::new();
		let mut entries = 0usize;
		let mut stack = vec![self.nodes[n as usize].dir];
		while let Some(d) = stack.pop() {
			out.push(d);
			entries += self.dirs[d as usize].children.len();
			if out.len() > max || entries > max {
				return None;
			}
			for &c in &self.dirs[d as usize].children {
				let node = &self.nodes[c as usize];
				if node.dir != NO_DIR && node.flags & F_DEAD == 0 {
					stack.push(node.dir);
				}
			}
		}
		Some(out)
	}

	pub fn ancestors(&self, n: u32) -> Vec<u32> {
		let mut out = Vec::new();
		let mut cur = self.nodes[n as usize].parent;
		while cur != u32::MAX {
			out.push(cur);
			cur = self.nodes[cur as usize].parent;
		}
		out
	}

	/// Folders whose listing or permissions (ctime) or rule files changed
	/// since indexed. A new rule file changes its folder's ctime; an edited
	/// one only itself.
	pub fn stale(&self, dirs: &[u32]) -> (Vec<u32>, Vec<u32>) {
		let res: Vec<(u32, bool, bool)> = crate::engine::parallel_query(|| {
			dirs.par_iter()
				.map(|&d| {
					let dir = &self.dirs[d as usize];
					let path = self.path_of(dir.node);
					let listing = match std::fs::symlink_metadata(&path) {
						Ok(m) => !m.is_dir() || ctime_ns(&m) != dir.changed,
						Err(_) => true,
					};
					let rules = !listing && !dir.stamps.is_empty() && stamps_at(&path) != dir.stamps;
					(d, listing, rules)
				})
				.collect()
		});
		let listing = res.iter().filter(|r| r.1).map(|r| r.0).collect();
		let rules = res.iter().filter(|r| r.2).map(|r| r.0).collect();
		(listing, rules)
	}

	pub fn is_live_dir(&self, d: u32) -> bool {
		let n = self.dirs[d as usize].node;
		n != u32::MAX && self.nodes[n as usize].flags & F_DEAD == 0 && self.nodes[n as usize].dir == d
	}

	pub fn depth(&self, n: u32) -> usize {
		self.ancestors(n).len()
	}

	fn kill(&mut self, n: u32) {
		let parent = self.nodes[n as usize].parent;
		if parent != u32::MAX {
			let pd = self.nodes[parent as usize].dir;
			if pd != NO_DIR {
				let kids = &mut self.dirs[pd as usize].children;
				if let Some(i) = kids.iter().position(|&c| c == n) {
					kids.remove(i);
				}
			}
		}
		self.mark_dead(n);
	}

	/// Marks `n` and everything under it dead, leaving the lists that hold them
	/// to be filtered in one pass (a per-child `position` is quadratic).
	fn mark_dead(&mut self, n: u32) {
		let mut stack = vec![n];
		while let Some(x) = stack.pop() {
			let node = &mut self.nodes[x as usize];
			if node.flags & F_DEAD != 0 {
				continue;
			}
			node.flags |= F_DEAD;
			self.dead += 1;
			if node.dir != NO_DIR {
				let d = node.dir as usize;
				stack.append(&mut self.dirs[d].children);
			}
		}
	}

	/// Copies `sub` (a walk rooted at a folder inside this tree) in as a
	/// child of folder `parent_dir`.
	fn graft(&mut self, parent_dir: u32, sub: Tree) {
		let node_base = self.nodes.len() as u32;
		let dir_base = self.dirs.len() as u32;
		let name_base = self.names.len() as u32;
		let parent_node = self.dirs[parent_dir as usize].node;
		let root_name = sub.root.file_name().map(|n| n.as_bytes().to_vec()).unwrap_or_default();
		let root_name_off = name_base + sub.names.len() as u32;
		self.names.extend_from_slice(&sub.names);
		self.names.extend_from_slice(&root_name);
		for (i, n) in sub.nodes.iter().enumerate() {
			let mut n = *n;
			if i == 0 {
				n.parent = parent_node;
				n.name_off = root_name_off;
				n.name_len = root_name.len() as u16;
			} else {
				n.parent += node_base;
				n.name_off += name_base;
			}
			if n.dir != NO_DIR {
				n.dir += dir_base;
			}
			n.doc = DOC_PENDING;
			if n.kind == K_FILE && n.flags & F_DEAD == 0 {
				self.pending.push(node_base + i as u32);
			}
			self.nodes.push(n);
		}
		self.dead += sub.dead;
		self.skips.extend(sub.skips.iter().map(|s| s + node_base));
		for d in sub.dirs {
			self.dirs.push(Dir {
				node: if d.node == u32::MAX { u32::MAX } else { d.node + node_base },
				children: d.children.into_iter().map(|c| c + node_base).collect(),
				changed: d.changed,
				stamps: d.stamps,
			});
		}
		self.insert_child(parent_dir, node_base);
	}

	fn insert_child(&mut self, d: u32, n: u32) {
		let pos = {
			let name = self.name(n);
			let kids = &self.dirs[d as usize].children;
			kids.binary_search_by(|&c| self.name(c).cmp(name)).unwrap_or_else(|i| i)
		};
		self.dirs[d as usize].children.insert(pos, n);
	}

	/// Re-reads one folder with rg's own per-path decision and folds in the
	/// difference. A change to the rules themselves (an ignore file, or a
	/// `.git` appearing or going) is left to `rewalk`.
	///
	/// What the listing adds is only collected into `work`: walking it takes long
	/// enough that the caller must not hold the tree lock for it.
	pub fn relist(&mut self, d: u32, ctx: &mut Relister, work: &mut Walks) {
		if !self.is_live_dir(d) {
			return;
		}
		let node = self.dirs[d as usize].node;
		let path = self.path_of(node);
		let meta = match std::fs::symlink_metadata(&path) {
			Ok(m) if m.is_dir() => m,
			_ => {
				if node == 0 {
					return;
				}
				let parent = self.nodes[node as usize].parent;
				self.kill(node);
				let pd = self.nodes[parent as usize].dir;
				self.relist(pd, ctx, work);
				return;
			}
		};
		if stamps_at(&path) != self.dirs[d as usize].stamps {
			self.rewalk(d, ctx, work);
			return;
		}
		let rd = match std::fs::read_dir(&path) {
			Ok(rd) => rd,
			Err(_) => {
				// rg can list nothing in it now, so neither does the tree.
				for c in std::mem::take(&mut self.dirs[d as usize].children) {
					self.mark_dead(c);
				}
				self.prune_skips();
				self.nodes[node as usize].flags |= F_ERROR;
				self.dirs[d as usize].changed = ctime_ns(&meta);
				return;
			}
		};
		let rel_dir = self.rel_of(node);
		let mut fresh: Vec<(Box<[u8]>, u8)> =
			rd.flatten().map(|e| (e.file_name().as_bytes().into(), kind_of(e.file_type().ok()))).collect();
		// The rules are unchanged (the stamps matched), so an entry already
		// listed with the same kind keeps its decision; only new names are
		// asked. A folder of 50k files re-reads without 50k rule checks.
		fresh.retain(|(name, kind)| {
			if self.child(d, name).is_some_and(|c| self.nodes[c as usize].kind == *kind) {
				return true;
			}
			!ctx.ignored(&rel_dir.join(OsStr::from_bytes(name)), *kind == K_DIR)
		});
		fresh.sort_unstable_by(|a, b| a.0.cmp(&b.0));

		let old: Vec<u32> = self.dirs[d as usize].children.clone();
		let before = work.new.len();
		let mut children: Vec<u32> = Vec::with_capacity(fresh.len());
		let mut removed: Vec<u32> = Vec::new();
		let mut kept_files = Vec::new();
		let mut kept_dirs = Vec::new();
		let mut i = 0;
		for (name, kind) in fresh {
			while i < old.len() && self.name(old[i]) < &*name {
				removed.push(old[i]);
				i += 1;
			}
			if i < old.len() && self.name(old[i]) == &*name {
				let c = old[i];
				i += 1;
				if self.nodes[c as usize].kind == kind {
					if kind == K_FILE {
						kept_files.push(c);
					} else if self.nodes[c as usize].dir != NO_DIR {
						kept_dirs.push(self.nodes[c as usize].dir);
					}
					children.push(c);
					continue;
				}
				removed.push(c);
			}
			if kind == K_DIR {
				let sub_root = path.join(OsStr::from_bytes(&name));
				if ctx.exclusions.skips(&sub_root, true) {
					let idx = self.push_node(node, &name, kind, F_SKIP, NO_DIR);
					self.skips.push(idx);
					children.push(idx);
					continue;
				}
				work.new.push(NewFolder { dir: d, changed: ctime_ns(&meta), name, path: sub_root, walked: None });
			} else {
				children.push(self.push_node(node, &name, kind, 0, NO_DIR));
			}
		}
		removed.extend_from_slice(&old[i..]);
		// A folder event also covers a file in it rewritten in place.
		let changed: Vec<u32> = kept_files
			.into_iter()
			.filter(|&f| match self.doc_of(f) {
				Some(m) => !std::fs::symlink_metadata(path.join(OsStr::from_bytes(self.name(f)))).is_ok_and(|s| FileSig::of(&s) == m.sig),
				None => false,
			})
			.collect();
		for f in changed {
			self.invalidate(f);
		}
		let killed = !removed.is_empty();
		for k in removed {
			self.mark_dead(k);
		}
		if killed {
			self.prune_skips();
		}
		self.dirs[d as usize].children = children;
		self.nodes[node as usize].flags &= !F_ERROR;
		// Until its new folders are grafted the folder is not up to date, and a
		// query checking it in the meantime must find it stale.
		self.dirs[d as usize].changed = if work.new.len() > before { NOT_GRAFTED } else { ctime_ns(&meta) };
		// A subfolder's permission change is reported as an event on this folder.
		for c in kept_dirs {
			let now = std::fs::symlink_metadata(self.path_of(self.dirs[c as usize].node)).map(|m| ctime_ns(&m));
			if now.ok() != Some(self.dirs[c as usize].changed) {
				self.relist(c, ctx, work);
			}
		}
	}

	/// Grafts the folders `relist` collected and `Walks::walk` walked. A folder
	/// that is no longer the folder it was when it was listed is left stale, for
	/// the next check to re-read it whole.
	fn graft_new(&mut self, new: Vec<NewFolder>) {
		for f in new {
			if !self.is_live_dir(f.dir) {
				continue;
			}
			let node = self.dirs[f.dir as usize].node;
			let parent = self.path_of(node);
			let unchanged = std::fs::symlink_metadata(&parent).is_ok_and(|m| m.is_dir() && ctime_ns(&m) == f.changed);
			if !unchanged {
				continue;
			}
			if self.child(f.dir, &f.name).is_none() {
				match f.walked {
					Some(sub) => self.graft(f.dir, sub),
					None => {
						let idx = self.push_node(node, &f.name, K_DIR, F_ERROR, NO_DIR);
						self.insert_child(f.dir, idx);
					}
				}
			}
			self.dirs[f.dir as usize].changed = f.changed;
		}
	}

	/// Replaces the skipped record of folder `abs` with the subtree walked in its
	/// place; a folder that could not be read is recorded unreadable, once.
	pub fn graft_unlocked(&mut self, abs: &Path, walked: Option<Tree>) {
		let Some(n) = self.lookup(abs) else { return };
		if self.nodes[n as usize].flags & F_SKIP == 0 {
			return;
		}
		let parent = self.nodes[n as usize].parent;
		let pd = self.nodes[parent as usize].dir;
		if pd == NO_DIR {
			return;
		}
		self.kill(n);
		self.prune_skips();
		match walked {
			Some(sub) => self.graft(pd, sub),
			None => {
				let name = abs.file_name().map(|x| x.as_bytes().to_vec()).unwrap_or_default();
				let idx = self.push_node(parent, &name, K_DIR, F_ERROR, NO_DIR);
				self.insert_child(pd, idx);
			}
		}
	}

	/// Grafts what `Walks::walk` walked, re-checking under the lock that each
	/// folder is still the one it was read as. A root re-walk replaces the whole
	/// tree, so nothing collected before it can be applied after it.
	pub fn graft_walks(&mut self, work: Walks) {
		let generation = self.generation;
		for r in work.rewalk {
			if self.generation != generation {
				return;
			}
			self.graft_rewalk(r);
		}
		// A re-walk of the root replaces the tree and renumbers every id: the
		// folders the relist set aside now name other folders, or none.
		if self.generation != generation {
			return;
		}
		self.graft_new(work.new);
	}

	fn graft_rewalk(&mut self, r: Rewalk) {
		if !self.is_live_dir(r.dir) || self.dirs[r.dir as usize].node != r.node {
			return;
		}
		let unchanged = std::fs::symlink_metadata(&r.path).is_ok_and(|m| m.is_dir() && ctime_ns(&m) == r.ctime)
			&& stamps_at(&r.path) == r.stamps;
		if !unchanged {
			return;
		}
		let Some(sub) = r.walked else { return };
		if r.node == 0 {
			let mut t = sub;
			t.generation = self.generation + 1;
			*self = t;
			return;
		}
		let parent = self.nodes[r.node as usize].parent;
		let pd = self.nodes[parent as usize].dir;
		if pd == NO_DIR {
			return;
		}
		self.kill(r.node);
		self.graft(pd, sub);
		self.prune_skips();
	}

	/// Decides to walk folder `d` again from scratch, with freshly loaded ignore
	/// rules. The walk itself is `Walks::walk`, with no lock held, and its graft
	/// re-checks that the folder did not change meanwhile. Until then the folder
	/// reads as stale.
	pub fn rewalk(&mut self, d: u32, ctx: &mut Relister, work: &mut Walks) {
		if !self.is_live_dir(d) {
			return;
		}
		ctx.reset();
		let node = self.dirs[d as usize].node;
		let path = self.path_of(node);
		let Ok(meta) = std::fs::symlink_metadata(&path) else {
			if node == 0 {
				return;
			}
			let parent = self.nodes[node as usize].parent;
			self.kill(node);
			let pd = self.nodes[parent as usize].dir;
			self.relist(pd, ctx, work);
			return;
		};
		let ctime = ctime_ns(&meta);
		let stamps = stamps_at(&path);
		self.dirs[d as usize].changed = NOT_GRAFTED;
		work.rewalk.push(Rewalk {
			dir: d,
			node,
			path,
			ctime,
			stamps,
			threads: ctx.threads,
			walked: None,
		});
	}

	pub fn live_nodes(&self) -> usize {
		self.nodes.len() - self.dead
	}

	/// Rebuilds every array without the dead entries and renumbers every id in
	/// them. `generation` moves with it: the indexer keys files by node id, and
	/// that is what tells it the ids it holds are gone.
	pub fn compact(&mut self) {
		if self.dead == 0 {
			return;
		}
		let mut node_map = vec![u32::MAX; self.nodes.len()];
		let mut live = 0u32;
		for (i, n) in self.nodes.iter().enumerate() {
			if n.flags & F_DEAD == 0 {
				node_map[i] = live;
				live += 1;
			}
		}
		let mut dir_map = vec![u32::MAX; self.dirs.len()];
		let mut next = 0u32;
		for (i, d) in self.dirs.iter().enumerate() {
			if d.node != u32::MAX && node_map[d.node as usize] != u32::MAX {
				dir_map[i] = next;
				next += 1;
			}
		}
		let mut nodes = Vec::with_capacity(live as usize);
		let mut names = Vec::with_capacity(self.names.len());
		for n in &self.nodes {
			if n.flags & F_DEAD != 0 {
				continue;
			}
			let name_off = names.len() as u32;
			names.extend_from_slice(&self.names[n.name_off as usize..n.name_off as usize + n.name_len as usize]);
			nodes.push(Node {
				parent: if n.parent == u32::MAX { u32::MAX } else { node_map[n.parent as usize] },
				name_off,
				name_len: n.name_len,
				kind: n.kind,
				flags: n.flags,
				dir: if n.dir == NO_DIR { NO_DIR } else { dir_map[n.dir as usize] },
				doc: n.doc,
			});
		}
		self.nodes = nodes;
		self.names = names;
		let kept = |&&n: &&u32| node_map[n as usize] != u32::MAX;
		self.pending = self.pending.iter().filter(kept).map(|&n| node_map[n as usize]).collect();
		self.skips = self.skips.iter().filter(kept).map(|&n| node_map[n as usize]).collect();
		self.dirs = self
			.dirs
			.drain(..)
			.enumerate()
			.filter(|(i, _)| dir_map[*i] != u32::MAX)
			.map(|(_, d)| Dir {
				node: node_map[d.node as usize],
				children: d.children.iter().filter(kept).map(|&c| node_map[c as usize]).collect(),
				changed: d.changed,
				stamps: d.stamps,
			})
			.collect();
		let old = std::mem::take(&mut self.docs);
		for (i, m) in old.into_iter().enumerate() {
			let n = node_map[m.node as usize];
			if n != u32::MAX && self.nodes[n as usize].doc == i as u32 {
				self.nodes[n as usize].doc = self.docs.len() as u32;
				self.docs.push(DocMeta { node: n, ..m });
			}
		}
		self.dead = 0;
		self.generation += 1;
	}
}

/// rg's per-path decision (`IncrementalIgnore`) for folder re-reads. It
/// snapshots each folder's ignore files on first use, so one matcher lives
/// across re-reads (building it reads every ignore file up to the root) and
/// is dropped whenever a rule changes: a re-walk always resets it.
pub struct Relister<'a> {
	root: PathBuf,
	matcher: &'a Mutex<Option<IncrementalIgnore>>,
	pub exclusions: &'a Exclusions,
	pub threads: usize,
}

impl<'a> Relister<'a> {
	pub fn new(
		root: &Path,
		exclusions: &'a Exclusions,
		threads: usize,
		matcher: &'a Mutex<Option<IncrementalIgnore>>,
	) -> Relister<'a> {
		Relister { root: root.to_path_buf(), matcher, exclusions, threads }
	}

	pub fn reset(&mut self) {
		*self.matcher.lock().unwrap() = None;
	}

	fn ignored(&mut self, rel: &Path, is_dir: bool) -> bool {
		let mut m = self.matcher.lock().unwrap();
		let m = m.get_or_insert_with(|| walk_builder(&self.root).build_matchers().remove(0));
		m.matched(rel, is_dir).is_ignore()
	}
}

/// Applies what `Tree::stale` found: rule changes re-walk, outermost first;
/// listing changes re-read one folder each, parents before children. Both only
/// decide, and set aside what has to be walked (`Walks`).
pub fn refresh(tree: &mut Tree, dirs: &[u32], rules: &[u32], ctx: &mut Relister, work: &mut Walks) {
	let mut rules: Vec<u32> = rules.to_vec();
	rules.sort_by_key(|&d| tree.depth(tree.dirs[d as usize].node));
	for d in rules {
		tree.rewalk(d, ctx, work);
	}
	let mut dirs: Vec<u32> = dirs.iter().copied().filter(|&d| tree.is_live_dir(d)).collect();
	dirs.sort_by_key(|&d| tree.depth(tree.dirs[d as usize].node));
	for d in dirs {
		tree.relist(d, ctx, work);
	}
}

/// A folder a listing added, and its walk once one has done it.
pub struct NewFolder {
	/// The folder it belongs to, and that folder's ctime when it was listed.
	dir: u32,
	changed: i64,
	name: Box<[u8]>,
	path: PathBuf,
	walked: Option<Tree>,
}

/// A folder whose rules changed, and its walk once one has done it.
struct Rewalk {
	dir: u32,
	node: u32,
	path: PathBuf,
	/// The folder's ctime, and its ignore files' stamps, when it was read: a
	/// folder that is not that folder any more is left stale instead.
	ctime: i64,
	stamps: Vec<Stamp>,
	threads: usize,
	walked: Option<Tree>,
}

/// What a re-read decided has to be walked, and was not while the tree lock
/// was held: a new folder, or a folder whose ignore rules changed.
#[derive(Default)]
pub struct Walks {
	pub new: Vec<NewFolder>,
	rewalk: Vec<Rewalk>,
}

impl Walks {
	pub fn is_empty(&self) -> bool {
		self.new.is_empty() && self.rewalk.is_empty()
	}

	/// Walks everything set aside, with no lock held: one walker thread per
	/// folder on the background pool, never a pool per folder.
	pub fn walk(&mut self, exclusions: &Exclusions) {
		crate::engine::parallel_background(|| {
			self.rewalk.par_iter_mut().for_each(|r| {
				let opt = WalkOptions { threads: r.threads, background: false, exclusions };
				r.walked = Tree::walk(&r.path, &opt).ok();
			});
			let opt = WalkOptions { threads: 1, background: false, exclusions };
			self.new.par_iter_mut().for_each(|f| f.walked = Tree::walk(&f.path, &opt).ok());
		});
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::content::FIRST_SPECIAL;
	use crate::selftest::{cleanup, temp_root};

	/// Every id in the tree names the thing it says it names, and every live node
	/// is reachable from the folder that holds it.
	fn well_formed(t: &Tree) {
		assert_eq!(t.nodes[0].parent, u32::MAX, "the root is nobody's child");
		assert_eq!(t.nodes[0].flags & F_DEAD, 0, "the root must never be dead");
		for (i, d) in t.dirs.iter().enumerate() {
			if d.node == u32::MAX || t.nodes[d.node as usize].flags & F_DEAD != 0 {
				continue;
			}
			assert_eq!(t.nodes[d.node as usize].dir, i as u32, "folder {i} is not its node's folder");
			assert!(d.children.windows(2).all(|w| t.name(w[0]) < t.name(w[1])), "folder {i}'s children are not sorted");
			for &c in &d.children {
				assert_eq!(t.nodes[c as usize].parent, d.node, "node {c} is in folder {i}, not under its node");
				assert_eq!(t.nodes[c as usize].flags & F_DEAD, 0, "a dead node is still listed");
			}
		}
		for n in 0..t.nodes.len() as u32 {
			let node = &t.nodes[n as usize];
			if node.flags & F_DEAD != 0 {
				assert!(node.doc >= FIRST_SPECIAL, "a dead node still holds a doc link");
				continue;
			}
			if node.parent != u32::MAX {
				assert_eq!(t.nodes[node.parent as usize].flags & F_DEAD, 0, "node {n} hangs under a dead one");
				let pd = t.nodes[node.parent as usize].dir;
				assert!(t.dirs[pd as usize].children.contains(&n), "node {n} is in no folder's children");
			}
			if node.doc < FIRST_SPECIAL {
				assert_eq!(t.docs[node.doc as usize].node, n, "node {n}'s doc link points elsewhere");
			}
		}
		for &s in &t.skips {
			assert_eq!(t.nodes[s as usize].flags & F_SKIP, F_SKIP, "a skip that is not a skip");
			assert_eq!(t.nodes[s as usize].flags & F_DEAD, 0, "a dead skip is still listed");
		}
	}

	fn walk(root: &Path, excl: &Exclusions, threads: usize) -> (Tree, Mutex<Option<IncrementalIgnore>>) {
		let opt = WalkOptions { threads, background: false, exclusions: excl };
		(Tree::walk(root, &opt).unwrap(), Mutex::new(None))
	}

	#[test]
	fn a_compaction_keeps_every_live_path_and_drops_every_dead_id() {
		let root = temp_root("tree-compact");
		for d in ["a/deep", "b", "gone/inner"] {
			std::fs::create_dir_all(root.join(d)).unwrap();
		}
		for f in ["a/x.txt", "a/deep/y.txt", "b/z.txt", "gone/w.txt", "gone/inner/v.txt", "top.txt"] {
			std::fs::write(root.join(f), b"needle\n").unwrap();
		}
		let excl = Exclusions::names_only();
		let (mut tree, matcher) = walk(&root, &excl, 2);
		well_formed(&tree);
		let dir = tree.nodes[tree.lookup(&root).unwrap() as usize].dir;

		std::fs::remove_dir_all(root.join("gone")).unwrap();
		std::fs::remove_file(root.join("b/z.txt")).unwrap();
		let mut ctx = Relister::new(&root, &excl, 2, &matcher);
		let mut work = Walks::default();
		tree.relist(dir, &mut ctx, &mut work);
		assert!(tree.dead >= 4, "{} dead entries", tree.dead);
		well_formed(&tree);

		let paths: Vec<PathBuf> = (0..tree.nodes.len() as u32)
			.filter(|&n| tree.nodes[n as usize].flags & F_DEAD == 0)
			.map(|n| tree.path_of(n))
			.collect();
		let generation = tree.generation;
		tree.compact();
		assert_eq!(tree.dead, 0);
		assert_eq!(tree.nodes.len(), paths.len(), "live entries were dropped or dead ones kept");
		assert_eq!(tree.generation, generation + 1, "the ids moved, so the generation must too");
		well_formed(&tree);
		for p in &paths {
			assert!(tree.lookup(p).is_some(), "{} lost its node", p.display());
		}
		assert!(tree.lookup(&root.join("gone")).is_none(), "a deleted folder came back");
		assert!(tree.lookup(&root.join("b/z.txt")).is_none(), "a deleted file came back");
		assert_eq!(tree.name(0), b"", "the root keeps its empty name");
		cleanup(&root);
	}

	/// One re-read can hold both a rule change at the root, which replaces the
	/// whole tree, and folders a relist has just listed: the graft of those
	/// folders then carries the ids of the tree that is gone.
	#[test]
	fn a_root_rewalk_abandons_the_new_folders_of_the_same_batch() {
		let root = temp_root("rewalk-batch");
		std::fs::create_dir_all(root.join(".git")).unwrap();
		std::fs::write(root.join(".gitignore"), b"").unwrap();
		std::fs::create_dir_all(root.join("sub/deep")).unwrap();
		std::fs::write(root.join("sub/deep/a.txt"), b"needle\n").unwrap();
		let excl = Exclusions::names_only();
		let opt = WalkOptions { threads: 1, background: false, exclusions: &excl };
		let mut tree = Tree::walk(&root, &opt).unwrap();
		let matcher = Mutex::new(None);
		let mut relister = Relister::new(&root, &excl, 1, &matcher);
		let mut work = Walks::default();
		// a folder appears under `sub`, and in the same re-read the root's
		// rules start skipping it
		std::fs::create_dir_all(root.join("sub/fresh")).unwrap();
		let sub = tree.lookup(&root.join("sub")).unwrap();
		tree.relist(tree.nodes[sub as usize].dir, &mut relister, &mut work);
		assert_eq!(work.new.len(), 1, "the new folder must be set aside for a walk");
		std::fs::write(root.join(".gitignore"), b"sub/\nfresh/\n").unwrap();
		let top = tree.lookup(&root).unwrap();
		tree.rewalk(tree.nodes[top as usize].dir, &mut relister, &mut work);
		work.walk(&excl);
		tree.graft_walks(work);
		well_formed(&tree);
	}

	#[test]
	fn removing_half_of_a_big_folder_never_looks_each_child_up() {
		let root = temp_root("tree-kill-many");
		let big = root.join("big");
		std::fs::create_dir_all(&big).unwrap();
		for i in 0..60_000 {
			std::fs::write(big.join(format!("f{i:05}")), b"x").unwrap();
		}
		let excl = Exclusions::names_only();
		let (mut tree, matcher) = walk(&root, &excl, 4);
		let d = tree.nodes[tree.lookup(&big).unwrap() as usize].dir;
		assert_eq!(tree.dirs[d as usize].children.len(), 60_000);
		for i in (0..60_000).step_by(2) {
			std::fs::remove_file(big.join(format!("f{i:05}"))).unwrap();
		}
		let mut ctx = Relister::new(&root, &excl, 4, &matcher);
		let mut work = Walks::default();
		let started = std::time::Instant::now();
		tree.relist(d, &mut ctx, &mut work);
		let took = started.elapsed();
		assert!(took < std::time::Duration::from_millis(100), "relisting 30k removals took {took:?}");
		let kept: Vec<Vec<u8>> = tree.dirs[d as usize].children.iter().map(|&c| tree.name(c).to_vec()).collect();
		let want: Vec<Vec<u8>> = (0..60_000).filter(|i| i % 2 == 1).map(|i| format!("f{i:05}").into_bytes()).collect();
		assert_eq!(kept, want, "the folder's children are not exactly what is left");
		well_formed(&tree);
		cleanup(&root);
	}

	#[test]
	fn a_rule_change_is_walked_outside_the_lock_and_a_changed_folder_stays_stale() {
		let root = temp_root("tree-rewalk-outside");
		std::fs::create_dir_all(root.join("a")).unwrap();
		std::fs::write(root.join("a/.ignore"), b"").unwrap();
		std::fs::write(root.join("a/keep.txt"), b"needle\n").unwrap();
		std::fs::write(root.join("a/skip.txt"), b"needle\n").unwrap();
		let excl = Exclusions::names_only();
		let (mut tree, matcher) = walk(&root, &excl, 1);
		let d = tree.nodes[tree.lookup(&root.join("a")).unwrap() as usize].dir;

		std::fs::write(root.join("a/.ignore"), b"skip.txt\n").unwrap();
		let mut ctx = Relister::new(&root, &excl, 1, &matcher);
		let mut work = Walks::default();
		tree.relist(d, &mut ctx, &mut work);
		assert_eq!(work.rewalk.len(), 1, "a rule change must be set aside for a walk");
		assert_eq!(tree.dirs[d as usize].changed, NOT_GRAFTED, "until the walk is grafted the folder reads stale");
		assert!(tree.lookup(&root.join("a/skip.txt")).is_some(), "the walk ran under the lock");

		work.walk(&excl);
		tree.graft_walks(work);
		assert!(tree.lookup(&root.join("a/skip.txt")).is_none(), "the new rules were not applied");
		assert!(tree.lookup(&root.join("a/keep.txt")).is_some(), "a file the rules keep was dropped");
		let a = tree.nodes[tree.lookup(&root.join("a")).unwrap() as usize].dir;
		assert_ne!(tree.dirs[a as usize].changed, NOT_GRAFTED, "the grafted folder must read fresh");
		well_formed(&tree);

		std::fs::write(root.join("a/.ignore"), b"skip.txt\nanother.txt\n").unwrap();
		let mut work = Walks::default();
		tree.relist(a, &mut ctx, &mut work);
		assert_eq!(work.rewalk.len(), 1);
		std::fs::write(root.join("a/late.txt"), b"needle\n").unwrap();
		work.walk(&excl);
		tree.graft_walks(work);
		assert_eq!(tree.dirs[a as usize].changed, NOT_GRAFTED, "a folder that changed while walked must stay stale");
		assert!(tree.lookup(&root.join("a/late.txt")).is_none(), "a walk of the older folder was grafted");
		cleanup(&root);
	}

	#[test]
	fn a_relist_collects_a_new_folder_instead_of_walking_it() {
		let root = temp_root("tree-graft");
		std::fs::create_dir_all(root.join("a")).unwrap();
		std::fs::write(root.join("a/f.txt"), b"needle\n").unwrap();
		let excl = Exclusions::names_only();
		let opt = WalkOptions { threads: 1, background: false, exclusions: &excl };
		let mut tree = Tree::walk(&root, &opt).unwrap();
		let d = tree.nodes[tree.lookup(&root.join("a")).unwrap() as usize].dir;

		std::fs::create_dir_all(root.join("a/new/deep")).unwrap();
		std::fs::write(root.join("a/new/deep/g.txt"), b"needle\n").unwrap();
		let matcher = Mutex::new(None);
		let mut ctx = Relister::new(&root, &excl, 1, &matcher);
		let mut work = Walks::default();
		tree.relist(d, &mut ctx, &mut work);
		assert_eq!(work.new.len(), 1, "the new folder is set aside, not walked");
		assert!(tree.lookup(&root.join("a/new")).is_none());

		work.walk(&excl);
		tree.graft_walks(work);
		let g = tree.lookup(&root.join("a/new/deep/g.txt")).expect("grafted");
		assert_eq!(tree.nodes[g as usize].kind, K_FILE);
		cleanup(&root);
	}

	#[test]
	fn a_pass_ends_when_a_re_walk_of_the_root_replaces_every_id() {
		let root = temp_root("tree-rewalk-ids");
		std::fs::create_dir_all(root.join(".git")).unwrap();
		std::fs::write(root.join(".gitignore"), b"").unwrap();
		for i in 0..20 {
			let d = root.join(format!("big/d{i:02}"));
			std::fs::create_dir_all(&d).unwrap();
			std::fs::write(d.join("f.txt"), b"needle\n").unwrap();
		}
		std::fs::create_dir_all(root.join("small")).unwrap();
		let excl = Exclusions::names_only();
		let opt = WalkOptions { threads: 4, background: false, exclusions: &excl };
		let mut tree = Tree::walk(&root, &opt).unwrap();
		let all: Vec<u32> = (0..tree.dirs.len() as u32).collect();
		let generation = tree.generation;

		std::fs::write(root.join(".gitignore"), b"big/\n").unwrap();
		std::fs::write(root.join("big/d19/new.txt"), b"needle new\n").unwrap();
		let (listing, rules) = tree.stale(&all);
		assert_eq!(rules, vec![0], "the root's rules must be the first thing the pass re-walks");
		let matcher = Mutex::new(None);
		let mut ctx = Relister::new(&root, &excl, 4, &matcher);
		let mut work = Walks::default();
		refresh(&mut tree, &listing, &rules, &mut ctx, &mut work);
		assert_eq!(tree.generation, generation, "the re-walk runs outside the lock, so the pass is not cut short");
		work.walk(&excl);
		tree.graft_walks(work);
		assert_eq!(tree.generation, generation + 1, "the root was re-walked");
		assert!(tree.lookup(&root.join("big")).is_none(), "the ignored folder is gone");
		assert!(tree.lookup(&root.join("small")).is_some());
		cleanup(&root);
	}
}
