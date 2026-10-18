use std::io::{Read, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

use parking_lot::{RwLock, RwLockReadGuard, RwLockWriteGuard};
use rayon::prelude::*;

use crate::content::{Block, Budget, Content, DOC_LIVE, DOC_NOINDEX, DOC_PENDING, FileSig, MAX_INDEXED};
use crate::plan::{Q, plan};
use crate::query::{self, Fallback, GrepRequest};
use crate::rules::{Exclusions, GlobalExcludes, overrides};
use crate::tree::{NO_DIR, Relister, Tree, WalkOptions, Walks, mtime_ns, refresh};

/// Scopes up to this many folders and entries are checked against the disk
/// on every query (about 1 µs a stat); larger ones trust the live change feed.
pub const EXACT_MAX_DIRS: usize = 50_000;

pub struct Options {
	pub root: PathBuf,
	pub home: PathBuf,
	pub threads: usize,
	/// Leave out other volumes, privacy-guarded folders and this data folder
	/// (the daemon's own); None indexes everything under the root.
	pub own_dir: Option<PathBuf>,
	pub exact_max_dirs: usize,
	/// Files a common-looking pattern reads in order before the index takes over.
	pub scan_first: usize,
	/// Where the live feed's sync cookie lives: under the root, written by
	/// nothing else.
	pub cookie_dir: PathBuf,
	/// Where the content index is stored; None runs without one.
	pub content_dir: Option<PathBuf>,
	/// Only files under here have their content indexed.
	pub index_under: PathBuf,
	/// What the content index may use on disk.
	pub budget: Budget,
	/// A file changed more recently than this is left pending, and read live.
	pub quiet_window: Duration,
	/// Two whole-root rebuilds start no closer together than this.
	pub rebuild_interval: Duration,
}

/// Refused to a scope large enough to trust the live feed, while a rebuild the
/// feed asked for is still to come: the tree may be missing changes.
const CATCHING_UP: &str = "the index is catching up after missed changes";

/// A query waits this long for the index while a change is being folded
/// in, then hands the search to rg rather than keep the tool waiting.
const LOCK_WAIT: Duration = Duration::from_secs(1);

/// Dead entries this many, and outnumbering the live ones, are worth the copy
/// that folds them out of the tree.
const COMPACT_DEAD: usize = 100_000;

/// Credential locations under home: nothing in them enters the content
/// index. Their files are read at query time instead, so results are
/// unchanged.
pub const SECRETS: [&str; 21] = [
	".ssh",
	".aws",
	".gnupg",
	".azure",
	".kube",
	".docker",
	".config/gh",
	".config/gcloud",
	".config/op",
	".password-store",
	".pi/agent/auth.json",
	".pi/agent/mcp-auth.json",
	".pi/agent/psst",
	".cargo/credentials",
	".cargo/credentials.toml",
	".wrangler",
	".config/.wrangler",
	".supabase",
	".terraform.d",
	".config/rclone",
	".config/stripe",
];

/// Files that hold credentials by convention, wherever they are (names
/// compared lowercased: APFS ignores case).
/// Shell startup files and histories hold `export KEY=...` lines and keys
/// typed inline.
pub const SECRET_NAMES: [&str; 21] = [
	".env",
	".envrc",
	".dev.vars",
	".npmrc",
	".yarnrc.yml",
	".pypirc",
	".netrc",
	".git-credentials",
	".pgpass",
	".my.cnf",
	".htpasswd",
	"credentials",
	"terraform.tfvars",
	"token",
	"tokens",
	"apikey",
	"api_key",
	"api-key",
	"access_token",
	"access-token",
	"config.fish",
];
/// Folders whose every file is a credential, wherever they are.
pub const SECRET_DIRS: [&str; 5] = ["credentials", "secrets", ".ssh", ".gnupg", ".password-store"];

/// `id_ed25519_github`, `.zshrc.bak`, `.zshrc.swp`: a credential's name
/// often carries a suffix.
pub const SECRET_PREFIXES: [&str; 17] = [
	".zshrc",
	".zshenv",
	".zprofile",
	".zlogin",
	".bashrc",
	".bash_profile",
	".profile",
	"client_secret",
	".env.",
	".envrc.",
	".dev.vars.",
	"secrets.",
	"service-account",
	"id_rsa",
	"id_dsa",
	"id_ecdsa",
	"id_ed25519",
];
/// `auth.json` is where agent CLIs (codex, grok, factory, opencode) keep
/// their login tokens.
pub const SECRET_SUFFIXES: [&str; 20] = [
	".pem",
	".key",
	".p12",
	".pfx",
	".jks",
	".keystore",
	".tfvars",
	".tfstate",
	".ovpn",
	".kdbx",
	".gpg",
	".asc",
	".secret",
	"auth.json",
	"creds.json",
	"credentials.json",
	"token.json",
	"tokens.json",
	"credentials.toml",
	"_history",
];

pub fn is_secret_name(name: &[u8]) -> bool {
	let n = name.to_ascii_lowercase();
	SECRET_NAMES.iter().any(|s| n == s.as_bytes())
		|| SECRET_PREFIXES.iter().any(|s| n.starts_with(s.as_bytes()))
		|| SECRET_SUFFIXES.iter().any(|s| n.ends_with(s.as_bytes()))
}

/// A digest of every rule that decides what the content index may hold.
/// Each segment records the digest it was written under, and one written
/// under other rules is deleted on open: a rule added later also purges
/// what the earlier rules let in.
pub fn index_rules(index_under: &Path) -> u64 {
	let mut h: u64 = 0xcbf2_9ce4_8422_2325;
	let mut eat = |b: &[u8]| {
		for &x in b.iter().chain([0xffu8].iter()) {
			h ^= u64::from(x);
			h = h.wrapping_mul(0x0100_0000_01b3);
		}
	};
	eat(index_under.as_os_str().as_encoded_bytes());
	eat(b"Library");
	eat(&MAX_INDEXED.to_le_bytes());
	for s in SECRETS.iter().chain(&SECRET_NAMES).chain(&SECRET_PREFIXES).chain(&SECRET_SUFFIXES).chain(&SECRET_DIRS) {
		eat(s.as_bytes());
	}
	h
}

pub struct Engine {
	pub root: PathBuf,
	pub home: PathBuf,
	pub exclusions: Exclusions,
	global: GlobalExcludes,
	global_sig: Mutex<Vec<(i64, u64)>>,
	tree: RwLock<Option<Tree>>,
	threads: usize,
	exact_max_dirs: usize,
	scan_first: usize,
	cookie_dir: PathBuf,
	building: Mutex<bool>,
	pub live: crate::live::Live,
	pub content: RwLock<Option<Content>>,
	pub content_ready: AtomicBool,
	indexer_started: AtomicBool,
	index_under: PathBuf,
	/// `Options::quiet_window`, in nanoseconds.
	pub quiet: i64,
	secrets: Vec<PathBuf>,
	/// App data: caches, logs and databases that change all day and that no
	/// one greps. Kept out of the content index so the indexer is not kept
	/// busy re-reading them; a search inside reads the files directly.
	app_data: PathBuf,
	work: (Mutex<bool>, Condvar),
	rebuild: (Mutex<Rebuild>, Condvar),
	rebuild_interval: Duration,
	catching_up: AtomicBool,
	/// The daemon's own data folder, where the folders a search has unlocked are
	/// recorded.
	own: Option<PathBuf>,
	pub counters: Counters,
	matcher: Mutex<Option<ignore::IncrementalIgnore>>,
}

#[derive(Default)]
struct Rebuild {
	wanted: bool,
	last: Option<Instant>,
	thread: bool,
}

/// What the daemon did since it started, for `status`.
#[derive(Default)]
pub struct Counters {
	pub feed_batches: AtomicU64,
	pub folders_reread: AtomicU64,
	pub files_indexed: AtomicU64,
	pub queries: AtomicU64,
	/// Segments deleted at start-up for holding a file the rules now keep out.
	pub segments_purged: AtomicU64,
	/// Whole-root rebuilds started by the scheduler.
	pub rebuilds: AtomicU64,
}

pub struct FindResult {
	pub paths: Vec<String>,
	pub exit: i32,
	pub skipped_areas: usize,
	/// A broad scope held folders rg could not read; they were skipped.
	pub unreadable: bool,
}

/// Above this estimated share of files, a small scope reads files in order
/// and stops at the match limit: a common word is found sooner that way
/// than by decoding its posting lists.
const SCAN_ABOVE: f64 = 0.25;
pub const SCAN_FIRST: usize = 500;

pub struct GrepResult {
	pub exit: i32,
	pub skipped_areas: usize,
	/// Files a broad grep did not read: over the index's size cap, or
	/// outside the indexed home folder.
	pub skipped_files: usize,
	pub searched: usize,
	pub unreadable: bool,
}

struct Fresh<'a> {
	tree: RwLockReadGuard<'a, Option<Tree>>,
	node: u32,
	skipped_areas: usize,
	/// Too many folders to check per query: trusts the live feed instead.
	broad: bool,
	/// Not inside a repo: unreadable folders and files are skipped and
	/// reported rather than handed to rg, which would fail the whole call.
	tolerant: bool,
}

/// A search that has not finished by then hands over to rg, before the
/// client's own silence limit (10 s) gives up on it.
const SEARCH_BUDGET: Duration = Duration::from_secs(8);

unsafe extern "C" {
	fn malloc_zone_pressure_relief(zone: *mut std::ffi::c_void, goal: usize) -> usize;
}

/// Hands freed memory back to the system: macOS's allocator otherwise keeps
/// a walk's or a large query's buffers dirty long after they are freed.
pub fn release_memory() {
	unsafe { malloc_zone_pressure_relief(std::ptr::null_mut(), 0) };
}

/// Sets the class macOS charges the calling thread at.
pub fn set_qos(class: libc::qos_class_t) {
	unsafe { libc::pthread_set_qos_class_self_np(class, 0) };
}

/// The machine's power source, from IOKit, loaded on first use. A daemon that
/// cannot ask (no IOKit, no symbols) is on mains power, which costs only a
/// slower build on a laptop.
mod power {
	use std::ffi::{CStr, c_void};
	use std::sync::{Mutex, OnceLock};
	use std::time::{Duration, Instant};

	const RECHECK: Duration = Duration::from_secs(60);
	const BATTERY: &[u8] = b"Battery Power";
	const UTF8: u32 = 0x0800_0100;

	struct Api {
		sources: unsafe extern "C" fn() -> *const c_void,
		kind: unsafe extern "C" fn(*const c_void) -> *const c_void,
		copy_string: unsafe extern "C" fn(*const c_void, *mut i8, isize, u32) -> u8,
		release: unsafe extern "C" fn(*const c_void),
	}

	unsafe fn symbol<T>(handle: *mut c_void, name: &CStr) -> Option<T> {
		let p = unsafe { libc::dlsym(handle, name.as_ptr()) };
		(!p.is_null()).then(|| unsafe { std::mem::transmute_copy(&p) })
	}

	fn api() -> Option<&'static Api> {
		static API: OnceLock<Option<Api>> = OnceLock::new();
		API.get_or_init(|| unsafe {
			let iokit = libc::dlopen(c"/System/Library/Frameworks/IOKit.framework/IOKit".as_ptr(), libc::RTLD_LAZY);
			let cf = libc::dlopen(c"/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation".as_ptr(), libc::RTLD_LAZY);
			if iokit.is_null() || cf.is_null() {
				return None;
			}
			Some(Api {
				sources: symbol(iokit, c"IOPSCopyPowerSourcesInfo")?,
				kind: symbol(iokit, c"IOPSGetProvidingPowerSourceType")?,
				copy_string: symbol(cf, c"CFStringGetCString")?,
				release: symbol(cf, c"CFRelease")?,
			})
		})
		.as_ref()
	}

	/// None when IOKit will not say which source is providing power.
	pub(super) fn probe() -> Option<bool> {
		let a = api()?;
		unsafe {
			let info = (a.sources)();
			if info.is_null() {
				return None;
			}
			let kind = (a.kind)(info);
			let mut buf = [0i8; 64];
			let read = !kind.is_null() && (a.copy_string)(kind, buf.as_mut_ptr(), buf.len() as isize, UTF8) == 1;
			(a.release)(info);
			read.then(|| CStr::from_ptr(buf.as_ptr()).to_bytes() == BATTERY)
		}
	}

	/// Whether the machine is on its battery. A minute is soon enough to notice
	/// a cable, and often enough not to leave the power daemon alone.
	pub fn battery() -> bool {
		static STATE: Mutex<Option<(Instant, bool)>> = Mutex::new(None);
		let mut state = STATE.lock().unwrap();
		if let Some((at, on)) = *state
			&& at.elapsed() < RECHECK
		{
			return on;
		}
		let on = probe().unwrap_or(false);
		*state = Some((Instant::now(), on));
		on
	}
}

/// True when the machine runs on its battery.
pub fn on_battery() -> bool {
	power::battery()
}

fn background_class() -> libc::qos_class_t {
	if on_battery() {
		libc::qos_class_t::QOS_CLASS_BACKGROUND
	} else {
		libc::qos_class_t::QOS_CLASS_UTILITY
	}
}

/// The two pools every parallel job runs on. rayon's own global pool has no QoS
/// class, so macOS charges a whole-disk walk there at full clock on every core.
struct Pools {
	query: rayon::ThreadPool,
	background: rayon::ThreadPool,
}

fn pools() -> &'static Pools {
	static POOLS: OnceLock<Pools> = OnceLock::new();
	POOLS.get_or_init(|| {
		// Never one: a folder re-walk holds the tree lock and needs a worker to
		// sort its children, while the indexer's graft can be waiting in this
		// same pool for that lock.
		let threads = std::thread::available_parallelism().map_or(4, |n| n.get()).max(2);
		let pool = move |name: &'static str, class| {
			rayon::ThreadPoolBuilder::new()
				.num_threads(threads)
				.thread_name(move |i| format!("{name}-{i}"))
				.start_handler(move |_| set_qos(class))
				.build()
				.expect("thread pool")
		};
		Pools {
			query: pool("searchd-query", libc::qos_class_t::QOS_CLASS_USER_INITIATED),
			background: pool("searchd-bg", background_class()),
		}
	})
}

fn run<R: Send>(pool: &rayon::ThreadPool, class: libc::qos_class_t, f: impl FnOnce() -> R + Send) -> R {
	pool.install(|| {
		set_qos(class);
		f()
	})
}

/// Runs a query's parallel work on the query pool.
pub fn parallel_query<R: Send>(f: impl FnOnce() -> R + Send) -> R {
	run(&pools().query, libc::qos_class_t::QOS_CLASS_USER_INITIATED, f)
}

/// Runs background work — a walk, a re-read, a merge — where macOS will not let
/// it starve anything else.
pub fn parallel_background<R: Send>(f: impl FnOnce() -> R + Send) -> R {
	run(&pools().background, background_class(), f)
}

/// Runs background work that always yields, whatever the power source.
pub fn parallel_idle<R: Send>(f: impl FnOnce() -> R + Send) -> R {
	run(&pools().background, libc::qos_class_t::QOS_CLASS_BACKGROUND, f)
}

/// Reads a file the daemon owns, never through a symlink planted at its path.
fn read_private(path: &Path) -> std::io::Result<String> {
	let mut f = std::fs::OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW).open(path)?;
	let mut text = String::new();
	f.read_to_string(&mut text)?;
	Ok(text)
}

/// Writes a file the daemon owns: 0600, and never through a symlink planted at
/// its path.
fn write_private(path: &Path, body: &[u8]) -> std::io::Result<()> {
	let mut f = std::fs::OpenOptions::new()
		.create(true)
		.truncate(true)
		.write(true)
		.mode(0o600)
		.custom_flags(libc::O_NOFOLLOW)
		.open(path)?;
	f.write_all(body)
}

/// The private folders a search has already asked for.
fn unlocked_folders(own: &Path) -> Vec<PathBuf> {
	let Ok(text) = read_private(&own.join("unlocked.json")) else { return Vec::new() };
	let Ok(list) = serde_json::from_str::<Vec<String>>(&text) else { return Vec::new() };
	list.into_iter().map(PathBuf::from).collect()
}

fn sig(p: &Path) -> (i64, u64) {
	std::fs::metadata(p).map(|m| (mtime_ns(&m), m.len())).unwrap_or((-1, 0))
}

impl Engine {
	pub fn new(mut opt: Options) -> Arc<Engine> {
		let root = std::fs::canonicalize(&opt.root).unwrap_or(opt.root.clone());
		opt.home = std::fs::canonicalize(&opt.home).unwrap_or(opt.home);
		let unlocked = opt.own_dir.as_deref().map(unlocked_folders).unwrap_or_default();
		let exclusions = match &opt.own_dir {
			Some(own) => Exclusions::for_root(&root, &opt.home, own, &unlocked),
			None => Exclusions::names_only(),
		};
		let global = GlobalExcludes::load(&opt.home);
		if let Some((rule, file)) = global.anchored() {
			eprintln!(
				"searchd: {} holds the global ignore rule {rule:?}, which is anchored to the folder it is used from; searches below other folders run rg",
				file.display()
			);
		}
		let global_sig = global.files.iter().map(|p| sig(p)).collect();
		let index_under = std::fs::canonicalize(&opt.index_under).unwrap_or(opt.index_under.clone());
		let secrets = SECRETS.iter().map(|d| index_under.join(d)).collect();
		let rules = index_rules(&index_under);
		let content = opt.content_dir.as_deref().map(|d| Content::open(d, rules, opt.budget));
		pools();
		Arc::new(Engine {
			root,
			home: opt.home,
			exclusions,
			global,
			global_sig: Mutex::new(global_sig),
			tree: RwLock::new(None),
			threads: opt.threads,
			exact_max_dirs: opt.exact_max_dirs,
			scan_first: opt.scan_first,
			cookie_dir: opt.cookie_dir,
			building: Mutex::new(false),
			live: crate::live::Live::new(),
			content: RwLock::new(content),
			content_ready: AtomicBool::new(false),
			indexer_started: AtomicBool::new(false),
			app_data: index_under.join("Library"),
			index_under,
			quiet: opt.quiet_window.as_nanos() as i64,
			secrets,
			work: (Mutex::new(false), Condvar::new()),
			rebuild: (Mutex::new(Rebuild::default()), Condvar::new()),
			rebuild_interval: opt.rebuild_interval,
			catching_up: AtomicBool::new(false),
			own: opt.own_dir,
			counters: Counters::default(),
			matcher: Mutex::new(None),
		})
	}

	/// Asks macOS, through the search that asked for it, to read a private
	/// folder: that search goes to rg, and the folder is walked and grafted in
	/// the background so the next one is answered from the index. A folder it
	/// cannot read is recorded unreadable by the graft, and asked for once.
	fn unlock(self: &Arc<Engine>, folder: &Path) {
		if !self.exclusions.gate().unlock(folder) {
			return;
		}
		self.save_unlocked();
		let me = self.clone();
		let folder = folder.to_path_buf();
		let _ = std::thread::Builder::new().name("searchd-unlock".into()).spawn(move || {
			let walked = {
				let opt = WalkOptions { threads: 1, background: true, exclusions: &me.exclusions };
				parallel_background(|| Tree::walk(&folder, &opt)).ok()
			};
			me.with_tree_mut(|tree, _| tree.graft_unlocked(&folder, walked));
			me.recheck_under(&folder);
		});
	}

	/// Re-reads the folders under `folder` that changed while it was being
	/// walked: the feed's events for them arrived while it was still skipped.
	fn recheck_under(&self, folder: &Path) {
		let stale = {
			let g = self.tree_read();
			g.as_ref().and_then(|t| {
				let x = t.lookup(folder)?;
				let dirs = t.subtree_dirs(x, usize::MAX)?;
				let (listing, rules) = t.stale(&dirs);
				(!listing.is_empty() || !rules.is_empty()).then_some((t.generation, listing, rules))
			})
		};
		if let Some((generation, listing, rules)) = stale {
			self.with_tree_fold(|tree, ctx| {
				let mut work = Walks::default();
				if tree.generation == generation {
					refresh(tree, &listing, &rules, ctx, &mut work);
				}
				((), work)
			});
		}
	}

	fn save_unlocked(&self) {
		let Some(own) = self.own.as_ref() else { return };
		let folders: Vec<String> = self.exclusions.gate().unlocked().iter().map(|p| p.to_string_lossy().into_owned()).collect();
		let Ok(text) = serde_json::to_string(&folders) else { return };
		let _ = write_private(&own.join("unlocked.json"), text.as_bytes());
	}

	/// Wakes the indexer: there are files to (re)index.
	pub fn poke_indexer(&self) {
		*self.work.0.lock().unwrap() = true;
		self.work.1.notify_one();
	}

	/// Sleeps until `poke_indexer` or `timeout`; the indexer never polls.
	pub fn wait_for_work(&self, timeout: Duration) {
		let guard = self.work.0.lock().unwrap();
		let (mut flag, _) = self.work.1.wait_timeout_while(guard, timeout, |w| !*w).unwrap();
		*flag = false;
	}

	pub fn tree_generation(&self) -> Option<u64> {
		self.tree.read().as_ref().map(|t| t.generation)
	}

	pub fn tree_read(&self) -> RwLockReadGuard<'_, Option<Tree>> {
		self.tree.read()
	}

	pub fn tree_write(&self) -> RwLockWriteGuard<'_, Option<Tree>> {
		self.tree.write()
	}

	/// A content-index marker decided by path alone, or None to read the file.
	pub fn classify(&self, p: &Path) -> Option<u32> {
		if !p.starts_with(&self.index_under) || p.starts_with(&self.app_data) {
			return Some(DOC_NOINDEX);
		}
		self.is_secret(p).then_some(DOC_LIVE)
	}

	pub fn is_secret(&self, p: &Path) -> bool {
		p.file_name().is_some_and(|n| is_secret_name(n.as_encoded_bytes()))
			|| self.secrets.iter().any(|s| p.starts_with(s))
			|| p.parent().is_some_and(|d| {
				d.strip_prefix(&self.index_under).unwrap_or(d).iter().any(|c| {
					let c = c.as_encoded_bytes().to_ascii_lowercase();
					SECRET_DIRS.iter().any(|s| c == s.as_bytes())
				})
			})
	}

	/// The tree for a query: waits out a short update, never a long one.
	fn read_tree(&self) -> Result<RwLockReadGuard<'_, Option<Tree>>, Fallback> {
		self.tree.try_read_for(LOCK_WAIT).ok_or_else(|| "the index is busy folding in a large change".into())
	}

	pub fn ready(&self) -> bool {
		self.tree.read().is_some()
	}

	/// Walks the whole root. The live feed starts from the event id taken
	/// before the walk, so a change made during the walk is replayed after it.
	pub fn build(self: &Arc<Engine>, background: bool) {
		{
			let mut b = self.building.lock().unwrap();
			if *b {
				return;
			}
			*b = true;
		}
		let since = crate::live::current_event_id();
		let opt = WalkOptions {
			threads: self.threads,
			background,
			exclusions: &self.exclusions,
		};
		// A rebuild lets go of the old tree first, so two whole-disk trees are
		// never held at once; queries go to rg until the walk is done.
		let generation = self.tree.write().take().map_or(0, |old| old.generation + 1);
		release_memory();
		if let Ok(mut t) = Tree::walk(&self.root, &opt) {
			*self.matcher.lock().unwrap() = None;
			t.generation = generation;
			*self.tree.write() = Some(t);
			*self.global_sig.lock().unwrap() = self.global.files.iter().map(|p| sig(p)).collect();
			self.live.start(self, since, &self.cookie_dir);
		}
		release_memory();
		self.poke_indexer();
		if self.content.read().is_some() && !self.indexer_started.swap(true, Ordering::SeqCst) {
			let me = self.clone();
			let _ = std::thread::Builder::new()
				.name("searchd-index".into())
				.spawn(move || crate::indexer::run(me));
		}
		*self.building.lock().unwrap() = false;
	}

	/// Asks for a whole-root rebuild. One thread does them, and never two closer
	/// together than `rebuild_interval`: a storm of dropped-event batches cannot
	/// chain full walks. Until it has finished, a scope large enough to trust
	/// the live feed is refused (`fresh`).
	pub fn rebuild_in_background(self: &Arc<Engine>) {
		self.catching_up.store(true, Ordering::SeqCst);
		let (lock, cv) = &self.rebuild;
		let mut r = lock.lock().unwrap();
		if !r.wanted {
			r.wanted = true;
			cv.notify_one();
		}
		if r.thread {
			return;
		}
		r.thread = true;
		let me = self.clone();
		drop(r);
		let _ = std::thread::Builder::new().name("searchd-rebuild".into()).spawn(move || me.rebuild_loop());
	}

	/// True from a rebuild request until the rebuild has finished.
	pub fn catching_up(&self) -> bool {
		self.catching_up.load(Ordering::SeqCst)
	}

	fn rebuild_loop(self: Arc<Engine>) {
		let (lock, cv) = &self.rebuild;
		loop {
			let mut r = lock.lock().unwrap();
			while !r.wanted {
				r = cv.wait(r).unwrap();
			}
			if let Some(due) = r.last.map(|last| last + self.rebuild_interval)
				&& let Some(left) = due.checked_duration_since(Instant::now())
			{
				r = cv.wait_timeout(r, left).unwrap().0;
				continue;
			}
			r.wanted = false;
			r.last = Some(Instant::now());
			drop(r);
			eprintln!("searchd: rebuilding the whole index");
			self.counters.rebuilds.fetch_add(1, Ordering::Relaxed);
			self.build(true);
			// The walk just finished read the disk, so anything asked for while
			// it ran is covered: no second walk, and the epoch is over.
			self.rebuild.0.lock().unwrap().wanted = false;
			self.catching_up.store(false, Ordering::SeqCst);
		}
	}

	fn rules_unchanged(self: &Arc<Engine>) -> bool {
		let now: Vec<(i64, u64)> = self.global.files.iter().map(|p| sig(p)).collect();
		if *self.global_sig.lock().unwrap() == now {
			return true;
		}
		eprintln!("searchd: rebuild: the global ignore files changed");
		self.rebuild_in_background();
		false
	}

	pub fn relister(&self) -> Relister<'_> {
		Relister::new(&self.root, &self.exclusions, self.threads, &self.matcher)
	}

	/// Folds the dead entries out of the tree once they outnumber the live ones.
	/// Almost every node and folder id moves: `generation` moves with the ids, so
	/// the indexer drops the node ids it holds and links the new ones on its next
	/// pass. Called from background work, never from a query, and never waits for
	/// the lock: a batched change is worth no delay to the feed.
	pub fn maybe_compact(&self) {
		let Some(mut g) = self.tree.try_write() else { return };
		let Some(tree) = g.as_mut() else { return };
		if tree.dead <= COMPACT_DEAD || tree.dead <= tree.live_nodes() {
			return;
		}
		tree.compact();
	}

	pub fn with_tree_mut<R>(&self, f: impl FnOnce(&mut Tree, &mut Relister) -> R) -> Option<R> {
		self.mutate(self.tree.write(), f)
	}

	/// A write lock for a query, which hands over to rg rather than wait behind
	/// a long update.
	fn lock_tree(&self) -> Result<RwLockWriteGuard<'_, Option<Tree>>, Fallback> {
		self.tree.try_write_for(LOCK_WAIT).ok_or_else(|| "the index is busy folding in a large change".into())
	}

	/// Re-reads folders, holding the write lock only to decide what changed and
	/// to graft: a new folder's walk, and a re-walk after an ignore-file change,
	/// happen with the lock released, so a search is never queued behind them.
	pub fn with_tree_fold<R>(&self, f: impl FnOnce(&mut Tree, &mut Relister) -> (R, Walks)) -> Option<R> {
		self.fold(self.tree.write(), f)
	}

	fn try_tree_fold<R>(&self, f: impl FnOnce(&mut Tree, &mut Relister) -> (R, Walks)) -> Result<Option<R>, Fallback> {
		Ok(self.fold(self.lock_tree()?, f))
	}

	fn fold<R>(&self, mut g: RwLockWriteGuard<'_, Option<Tree>>, f: impl FnOnce(&mut Tree, &mut Relister) -> (R, Walks)) -> Option<R> {
		let (out, mut work) = {
			let tree = g.as_mut()?;
			let mut ctx = self.relister();
			f(tree, &mut ctx)
		};
		let queued = g.as_ref().is_some_and(|t| !t.pending.is_empty());
		drop(g);
		if queued {
			self.poke_indexer();
		}
		if !work.is_empty() {
			work.walk(&self.exclusions);
			self.with_tree_mut(|t, _| t.graft_walks(work));
		}
		Some(out)
	}

	fn mutate<R>(&self, mut g: RwLockWriteGuard<'_, Option<Tree>>, f: impl FnOnce(&mut Tree, &mut Relister) -> R) -> Option<R> {
		let tree = g.as_mut()?;
		let mut ctx = self.relister();
		let out = f(tree, &mut ctx);
		let queued = !tree.pending.is_empty();
		drop(g);
		if queued {
			self.poke_indexer();
		}
		Some(out)
	}

	/// The tree, up to date for queries under `dir`. A small scope is checked
	/// against the disk folder by folder; a large one waits for the live feed
	/// to deliver everything that happened before now.
	fn fresh(self: &Arc<Engine>, dir: &Path) -> Result<Fresh<'_>, Fallback> {
		if !dir.starts_with(&self.root) {
			return Err("outside the indexed root".into());
		}
		if let Some(folder) = self.exclusions.gate().locked(dir) {
			self.unlock(folder);
			return Err("a folder macOS shows a privacy prompt for; a search inside it is answered by rg".into());
		}
		if self.exclusions.covers(dir) {
			return Err("inside a folder the index skips (system, app, cache or dependency folder)".into());
		}
		if !self.global.agrees_below(&self.root, dir) {
			return Err("a global gitignore rule could decide differently here".into());
		}
		if !self.rules_unchanged() {
			return Err("the global ignore rules changed; re-indexing".into());
		}
		// A repo is answered exactly or not at all. A folder of folders (home,
		// the disk, a projects folder) is answered without what it skips, and
		// the answer says how many folders that was.
		let scope = |tree: &Tree| -> Result<(u32, usize, bool), Fallback> {
			let x = tree.lookup(dir).ok_or("not an indexed folder")?;
			if tree.nodes[x as usize].dir == NO_DIR {
				return Err("not an indexed folder".into());
			}
			let skipped = tree.skips_under(x);
			let in_repo = tree.in_repo(x, tree.lookup(&self.home));
			if skipped > 0 && in_repo {
				return Err("the repo holds a folder the index skips".into());
			}
			Ok((x, skipped, in_repo))
		};
		for _ in 0..3 {
			let g = self.read_tree()?;
			let tree = g.as_ref().ok_or("still indexing")?;
			let (x, skipped_areas, in_repo) = scope(tree)?;
			let Some(mut dirs) = tree.subtree_dirs(x, self.exact_max_dirs) else {
				drop(g);
				if self.catching_up() {
					return Err(CATCHING_UP.into());
				}
				self.live.sync()?;
				if self.catching_up() {
					return Err(CATCHING_UP.into());
				}
				let g = self.read_tree()?;
				let tree = g.as_ref().ok_or("still indexing")?;
				let (x, skipped_areas, in_repo) = scope(tree)?;
				return Ok(Fresh {
					tree: g,
					node: x,
					skipped_areas,
					broad: true,
					tolerant: !in_repo,
				});
			};
			dirs.extend(tree.ancestors(x).iter().map(|&a| tree.nodes[a as usize].dir));
			let (listing, rules) = tree.stale(&dirs);
			if listing.is_empty() && rules.is_empty() {
				return Ok(Fresh {
					tree: g,
					node: x,
					skipped_areas,
					broad: false,
					tolerant: !in_repo,
				});
			}
			let generation = tree.generation;
			drop(g);
			self.try_tree_fold(|t, ctx| {
				let mut work = Walks::default();
				if t.generation == generation {
					refresh(t, &listing, &rules, ctx, &mut work);
				}
				((), work)
			})?;
		}
		Err("the folder keeps changing".into())
	}

	pub fn find(self: &Arc<Engine>, dir: &Path, glob: &str) -> Result<FindResult, Fallback> {
		self.counters.queries.fetch_add(1, Ordering::Relaxed);
		let ov = overrides(dir, Some(glob)).map_err(|e| format!("glob: {e}"))?;
		let f = self.fresh(dir)?;
		let tree = f.tree.as_ref().unwrap();
		let set = query::file_set(tree, f.node, Some(&ov))?;
		if set.errors && set.nodes.is_empty() && !f.tolerant {
			return Err("rg would report an error here".into());
		}
		// A broad scope trusts the live feed, which unlinks a changed file's
		// record, so a linked record's mtime is current.
		let paths = if f.broad {
			query::newest_first(tree, f.node, set.nodes, |n| tree.doc_of(n).map(|m| m.sig.mtime))
		} else {
			query::newest_first(tree, f.node, set.nodes, |_| None)
		};
		let unreadable = f.tolerant && set.errors;
		let exit = if set.errors && !f.tolerant { 2 } else { 0 };
		Ok(FindResult {
			paths,
			exit,
			skipped_areas: f.skipped_areas,
			unreadable,
		})
	}

	pub fn grep(
		self: &Arc<Engine>,
		dir: &Path,
		glob: Option<&str>,
		req: &GrepRequest,
		out: &mut dyn Write,
	) -> Result<GrepResult, Fallback> {
		self.counters.queries.fetch_add(1, Ordering::Relaxed);
		let m = query::matcher(req)?;
		// Without a caller's glob, the tool's own `!.git` `!.jj` are what the
		// walk already applied, so there is nothing left to match per entry.
		let ov = match glob {
			Some(g) => Some(overrides(dir, Some(g)).map_err(|e| format!("glob: {e}"))?),
			None => None,
		};
		let q = plan(req.pattern, req.literal, req.ignore_case);
		let t0 = std::time::Instant::now();
		let trace = std::env::var_os("SEARCHD_TRACE").is_some();
		let f = self.fresh(dir)?;
		let t_fresh = t0.elapsed();
		let tree = f.tree.as_ref().unwrap();
		let set = query::file_set(tree, f.node, ov.as_ref())?;
		let t_set = t0.elapsed();
		if set.errors && !f.tolerant {
			return Err("rg would report an error here".into());
		}
		let ready = self.content_ready.load(Ordering::SeqCst);
		if f.broad && (q == Q::All || !ready) {
			return Err(if q == Q::All {
				"no literal text to look up; a scope this large means reading every file".into()
			} else {
				"the content index is still being built".into()
			});
		}
		let looks_common = !f.broad
			&& q != Q::All
			&& req.limit != u64::MAX
			&& self.content.read().as_ref().is_some_and(|c| c.estimate(&q) > SCAN_ABOVE);
		let mut rest = set.nodes;
		// A pattern whose rarest trigram is common usually fills the match
		// limit within the first few hundred files read in order. The estimate
		// is an upper bound, so when it does not, the index takes the rest.
		let mut found = 0u64;
		let mut unreadable_files = false;
		let mut searched = 0usize;
		if looks_common {
			let first: Vec<(String, u32)> =
				rest.drain(..self.scan_first.min(rest.len())).map(|n| (tree.rel_string(f.node, n), n)).collect();
			searched += first.len();
			(found, unreadable_files) = query::grep(dir, &first, req, &m, out, f.tolerant, t0 + SEARCH_BUDGET)?;
		}
		if found >= req.limit {
			rest.clear();
		}
		let cands = if q == Q::All || rest.is_empty() {
			None
		} else {
			self.content.read().as_ref().map(|c| c.candidates(&q))
		};
		let skipped_files = AtomicUsize::new(0);
		// A blocked index leaves files pending: a broad grep would read every
		// one of them, so it skips them and says how many, as it does for files
		// too large to index.
		let skip_pending = f.broad && f.tolerant && self.content.read().as_ref().is_some_and(|c| c.room().is_some());
		let (broad, tolerant) = (f.broad, f.tolerant);
		// A small scope re-checks each indexed file against the disk; a broad
		// one relies on the live feed having unlinked every changed file. A file
		// the index or the freshness check rules out costs no path string.
		let files: Vec<(String, u32)> = parallel_query(|| {
			rest.into_par_iter()
				.filter(|&n| match tree.nodes[n as usize].doc {
					DOC_PENDING if skip_pending => {
						skipped_files.fetch_add(1, Ordering::Relaxed);
						false
					}
					DOC_PENDING | DOC_LIVE => true,
					DOC_NOINDEX if broad && tolerant => {
						skipped_files.fetch_add(1, Ordering::Relaxed);
						false
					}
					DOC_NOINDEX => true,
					_ => {
						let Some(meta) = tree.doc_of(n) else { return true };
						let Some(c) = cands.as_ref() else { return true };
						if !broad {
							let same = std::fs::symlink_metadata(tree.path_of(n)).is_ok_and(|m| FileSig::of(&m) == meta.sig);
							if !same {
								return true;
							}
						}
						c.contains(meta)
					}
				})
				.map(|n| (tree.rel_string(f.node, n), n))
				.collect()
		});
		let skipped_areas = f.skipped_areas;
		let unreadable = tolerant && set.errors;
		drop(f);
		let t_filter = t0.elapsed();
		searched += files.len();
		if !files.is_empty() {
			let left = GrepRequest {
				limit: req.limit - found,
				..*req
			};
			let (more, unr) = query::grep(dir, &files, &left, &m, out, tolerant, t0 + SEARCH_BUDGET)?;
			found += more;
			unreadable_files |= unr;
		}
		let any = found > 0;
		let unreadable = unreadable || unreadable_files;
		if trace {
			eprintln!(
				"grep {:?} in {}: fresh {:?} set {:?} filter {:?} search {:?} ({} files searched, index {})",
				req.pattern,
				dir.display(),
				t_fresh,
				t_set - t_fresh,
				t_filter - t_set,
				t0.elapsed() - t_filter,
				searched,
				if cands.is_some() { "used" } else { "skipped" },
			);
		}
		Ok(GrepResult {
			exit: if any { 0 } else { 1 },
			skipped_areas,
			skipped_files: skipped_files.into_inner(),
			searched,
			unreadable,
		})
	}

	pub fn status(&self) -> serde_json::Value {
		let g = self.tree.read();
		match g.as_ref() {
			None => serde_json::json!({ "ready": false }),
			Some(t) => {
				let (mut live, mut noindex, mut pending) = (0usize, 0usize, 0usize);
				for n in &t.nodes {
					if n.kind == crate::tree::K_FILE && n.flags & crate::tree::F_DEAD == 0 {
						match n.doc {
							DOC_LIVE => live += 1,
							DOC_NOINDEX => noindex += 1,
							DOC_PENDING => pending += 1,
							_ => {}
						}
					}
				}
				let (segments, blocked) = {
					let c = self.content.read();
					match c.as_ref() {
						Some(c) => (c.segs.iter().flatten().count(), c.room()),
						None => (0, None),
					}
				};
				serde_json::json!({
				"ready": true,
				"filesReadLive": live,
				"filesNotIndexed": noindex,
				"filesPending": pending,
				"root": t.root,
				"entries": t.live_nodes(),
				"folders": t.dirs.len(),
				"skippedFolders": t.skips_under(0),
				"live": self.live.running(),
				"contentReady": self.content_ready.load(Ordering::SeqCst),
				"indexedFiles": t.docs.len(),
				"pending": t.pending.len(),
				"segments": segments,
				"indexBlocked": blocked.map(Block::name),
				"globalIgnoreAnchored": self.global.anchored().is_some(),
				"globalIgnoreRule": self.global.anchored().map(|(rule, _)| rule),
				"globalIgnoreFile": self.global.anchored().map(|(_, file)| file.display().to_string()),
				"feedBatches": self.counters.feed_batches.load(Ordering::Relaxed),
				"foldersReread": self.counters.folders_reread.load(Ordering::Relaxed),
				"filesIndexed": self.counters.files_indexed.load(Ordering::Relaxed),
				"queries": self.counters.queries.load(Ordering::Relaxed),
				"segmentsPurged": self.counters.segments_purged.load(Ordering::Relaxed),
				"rebuilds": self.counters.rebuilds.load(Ordering::Relaxed),
				})
			}
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn class_of_this_thread() -> u32 {
		let mut class = libc::qos_class_t::QOS_CLASS_UNSPECIFIED;
		let mut relative = 0i32;
		let r = unsafe { libc::pthread_get_qos_class_np(libc::pthread_self(), &raw mut class, &mut relative) };
		assert_eq!(r, 0, "pthread_get_qos_class_np failed");
		class as u32
	}

	/// Work on rayon's own global pool is charged at full clock on every core;
	/// ours is charged at the class the job is worth.
	#[test]
	fn pool_threads_carry_the_class_macos_charges_them_at() {
		let (in_pool, background) = parallel_background(|| (rayon::current_thread_index().is_some(), class_of_this_thread()));
		assert!(in_pool, "background work did not run on a pool thread");
		let wanted = if on_battery() {
			libc::qos_class_t::QOS_CLASS_BACKGROUND as u32
		} else {
			libc::qos_class_t::QOS_CLASS_UTILITY as u32
		};
		assert_eq!(background, wanted);
		assert_eq!(parallel_query(class_of_this_thread), libc::qos_class_t::QOS_CLASS_USER_INITIATED as u32);
		assert_eq!(parallel_idle(class_of_this_thread), libc::qos_class_t::QOS_CLASS_BACKGROUND as u32);
	}

	/// IOKit may be missing or unwilling to say; the daemon then treats the
	/// machine as on mains power, and must not crash asking.
	#[test]
	fn the_power_probe_answers_without_crashing() {
		let _ = power::probe();
		let first = on_battery();
		assert_eq!(on_battery(), first, "a second read within the minute must be the cached answer");
	}
}
