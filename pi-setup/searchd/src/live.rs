use std::collections::{BTreeSet, HashMap};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, Weak};
use std::time::{Duration, Instant};

use parking_lot::Mutex as SyncLock;

use crate::engine::Engine;
use crate::fsevents::{self, Changes, Pending, Queue, Stream};
use crate::tree::{NO_DIR, Tree, Walks};

/// The live change feed for broad scopes, where checking every folder per
/// query would cost more than the search.
pub struct Live {
	stream: Mutex<Option<Stream>>,
	/// Changes the callback has handed over and the live thread has not taken.
	queue: Queue,
	pumping: AtomicBool,
	/// The newest event id the callback has delivered.
	last_id: Arc<AtomicU64>,
	cookie: Mutex<Option<PathBuf>>,
	state: Arc<(Mutex<State>, Condvar)>,
	sync_lock: SyncLock<()>,
}

#[derive(Default)]
struct State {
	/// The newest cookie event id whose batch has been applied.
	cookie: u64,
}

pub fn current_event_id() -> u64 {
	fsevents::current_id()
}

const SYNC_TIMEOUT: Duration = Duration::from_secs(3);

/// Short: `sync`'s flush waits out this latency rather than skipping it
/// (at 1 s every broad query took a second).
const LATENCY: f64 = 0.01;

impl Default for Live {
	fn default() -> Self {
		Self::new()
	}
}

impl Live {
	pub fn new() -> Live {
		Live {
			stream: Mutex::new(None),
			queue: Arc::new((Mutex::new(Pending::default()), Condvar::new())),
			pumping: AtomicBool::new(false),
			last_id: Arc::new(AtomicU64::new(0)),
			cookie: Mutex::new(None),
			state: Arc::new((Mutex::new(State::default()), Condvar::new())),
			sync_lock: SyncLock::new(()),
		}
	}

	pub fn running(&self) -> bool {
		self.stream.lock().unwrap().is_some()
	}

	/// Starts the feed from event id `since` (changes made since then are
	/// replayed; re-reading a folder twice is harmless). `cookie_dir` must lie
	/// under the root, outside `quiet_paths`, and be written by nothing but `sync`.
	pub fn start(&self, engine: &Arc<Engine>, since: u64, cookie_dir: &Path) {
		let old = self.stream.lock().unwrap().take();
		drop(old);
		if make_cookie_dir(cookie_dir).is_err() {
			return;
		}
		*self.cookie.lock().unwrap() = Some(cookie_dir.to_path_buf());
		self.last_id.store(since, Ordering::SeqCst);
		self.start_with(engine, since, cookie_dir, &quiet_paths(engine, cookie_dir));
	}

	/// `start` with these folders left out. A stream whose exclusions keep the
	/// cookie from coming back (excluding `/System` stopped every event, the
	/// data volume lying under it) is started again without them.
	fn start_with(&self, engine: &Arc<Engine>, since: u64, cookie_dir: &Path, quiet: &[Vec<u8>]) {
		let root = [engine.root.as_os_str().as_bytes().to_vec()];
		let cookie = cookie_dir.as_os_str().as_bytes();
		*self.stream.lock().unwrap() = fsevents::watch(&root, quiet, since, LATENCY, self.queue.clone(), cookie, self.last_id.clone());
		self.pump(engine);
		if !quiet.is_empty() && self.sync().is_err() {
			eprintln!("searchd: the live feed heard nothing with its exclusions; watching everything");
			let plain = fsevents::watch(&root, &[], since, LATENCY, self.queue.clone(), cookie, self.last_id.clone());
			let old = std::mem::replace(&mut *self.stream.lock().unwrap(), plain);
			drop(old);
		}
	}

	/// Starts the thread that folds changes in. One per feed, whatever the
	/// number of streams it goes through.
	fn pump(&self, engine: &Arc<Engine>) {
		if self.pumping.swap(true, Ordering::SeqCst) {
			return;
		}
		let weak: Weak<Engine> = Arc::downgrade(engine);
		let queue = self.queue.clone();
		let state = self.state.clone();
		std::thread::Builder::new()
			.name("searchd-live".into())
			.spawn(move || {
				unsafe { libc::pthread_set_qos_class_self_np(libc::qos_class_t::QOS_CLASS_UTILITY, 0) };
				let mut pacer = Pacer::default();
				loop {
					let changes = change_set(&queue, &pacer);
					let Some(engine) = weak.upgrade() else { return };
					engine.counters.feed_batches.fetch_add(changes.batches, Ordering::Relaxed);
					let cookie = apply(&engine, changes, &mut pacer);
					if cookie > 0 {
						let mut s = state.0.lock().unwrap();
						s.cookie = s.cookie.max(cookie);
						drop(s);
						state.1.notify_all();
					}
				}
			})
			.ok();
	}

	/// Returns once every change made before the call has been applied.
	///
	/// A flush alone is not enough: an event can still be on its way from the
	/// kernel to fseventsd. So it also makes a change of its own (a folder
	/// appearing or going in `cookie_dir`) and waits for it to come back: the
	/// batch holding the cookie is applied, with every folder the pacer held
	/// back, before the cookie is counted.
	pub fn sync(&self) -> Result<(), String> {
		let _one_at_a_time = self.sync_lock.try_lock_for(SYNC_TIMEOUT).ok_or_else(|| "the live feed is busy".to_string())?;
		let Some(cookie) = self.cookie.lock().unwrap().clone().filter(|_| self.running()) else {
			return Err("the live feed is not running".into());
		};
		make_cookie_dir(&cookie).map_err(|e| format!("live feed cookie: {e}"))?;
		// Our cookie's event id is above this; a late or repeated event of an
		// earlier cookie is not.
		let before = fsevents::current_id();
		let flag = cookie.join("flag");
		let toggled = match std::fs::symlink_metadata(&flag) {
			Ok(m) if m.is_dir() => std::fs::remove_dir(&flag),
			Ok(_) => std::fs::remove_file(&flag).and_then(|_| std::fs::create_dir(&flag)),
			Err(_) => std::fs::create_dir(&flag),
		};
		toggled.map_err(|e| format!("live feed cookie: {e}"))?;
		{
			let slot = self.stream.lock().unwrap();
			let Some(stream) = slot.as_ref() else {
				return Err("the live feed is not running".into());
			};
			stream.flush();
		}
		let (lock, cv) = &*self.state;
		let guard = lock.lock().unwrap();
		let (seen, timeout) = cv.wait_timeout_while(guard, SYNC_TIMEOUT, |s| s.cookie <= before).unwrap();
		drop(seen);
		if timeout.timed_out() {
			return Err("the live feed is behind".into());
		}
		Ok(())
	}
}

/// The cookie folder, private to the user: deleting it, or putting a file
/// where its flag goes, must not leave every broad query on rg until a restart.
fn make_cookie_dir(dir: &Path) -> std::io::Result<()> {
	match std::fs::symlink_metadata(dir) {
		Ok(m) if m.is_dir() && m.permissions().mode() & 0o777 == 0o700 => Ok(()),
		Ok(m) if m.is_dir() => std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)),
		Ok(_) => {
			std::fs::remove_file(dir)?;
			std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)
		}
		Err(_) => std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir),
	}
}

/// Skipped folders that change all day, in the order they wake the feed most.
/// One stream on one root keeps its events in order, which `sync`'s cookie
/// relies on (a stream over many paths delivered them out of order); these are
/// left out of it instead. FSEvents takes at most eight.
const NOISY: [&str; 7] = ["~/Library", "/private", "/Library", "/opt/homebrew", "~/.cache", "/usr", "/Applications"];

fn quiet_paths(engine: &Engine, cookie: &Path) -> Vec<Vec<u8>> {
	NOISY
		.iter()
		.map(|p| match p.strip_prefix("~/") {
			Some(rel) => engine.home.join(rel),
			None => PathBuf::from(p),
		})
		.filter(|p| p.starts_with(&engine.root) && *p != engine.root && engine.exclusions.covers(p) && !cookie.starts_with(p))
		.map(|p| p.as_os_str().as_bytes().to_vec())
		.collect()
}

/// Waits for the feed to hand changes over, or for a paced folder to come due,
/// and takes the whole set.
fn change_set(queue: &Queue, pacer: &Pacer) -> Changes {
	let (lock, cv) = &**queue;
	let mut q = lock.lock().unwrap();
	if q.empty() {
		q = if pacer.waiting.is_empty() {
			cv.wait(q).unwrap()
		} else {
			cv.wait_timeout(q, PACE).unwrap().0
		};
	}
	q.take()
}

/// A folder re-read again within its window waits (an app rewriting a big
/// cache folder every second would otherwise have it re-read every second).
/// Any `sync` re-reads every waiting folder first.
const PACE: Duration = Duration::from_secs(2);

/// A folder's window is fifty times its last re-read, so a re-read never costs
/// more than a fiftieth of a core.
#[derive(Default)]
struct Pacer {
	last: HashMap<Vec<u8>, (Instant, Duration)>,
	waiting: BTreeSet<Vec<u8>>,
}

impl Pacer {
	fn hot(&self, p: &[u8], now: Instant) -> bool {
		match self.last.get(p) {
			Some(&(t, took)) => now.duration_since(t) < PACE.max(took.saturating_mul(50)),
			None => false,
		}
	}

	fn due(&mut self, now: Instant) -> Vec<Vec<u8>> {
		let due: Vec<Vec<u8>> = self.waiting.iter().filter(|p| !self.hot(p, now)).cloned().collect();
		for p in &due {
			self.waiting.remove(p);
		}
		due
	}

	fn mark(&mut self, done: Vec<(Vec<u8>, Duration)>, now: Instant) {
		if self.last.len() > 10_000 {
			self.last.retain(|_, &mut (t, took)| now.duration_since(t) < PACE.max(took));
		}
		for (p, took) in done {
			self.last.insert(p, (now, took));
		}
	}
}

/// Folds one wake-up's changes into the tree; returns the newest cookie event
/// id it held, or 0.
fn apply(engine: &Arc<Engine>, changes: Changes, pacer: &mut Pacer) -> u64 {
	if changes.dropped {
		eprintln!("searchd: the live feed dropped events; rebuilding");
		engine.rebuild_in_background();
		return changes.cookie;
	}
	let now = Instant::now();
	let mut relist = changes.relist;
	if changes.cookie > 0 {
		relist.extend(std::mem::take(&mut pacer.waiting));
	} else {
		relist.extend(pacer.due(now));
		relist.retain(|p| {
			let hot = pacer.hot(p, now);
			if hot {
				pacer.waiting.insert(p.clone());
			}
			!hot
		});
	}
	reread(engine, &changes.rewalk, &relist, pacer);
	engine.maybe_compact();
	changes.cookie
}

fn reread(engine: &Arc<Engine>, rewalk: &[Vec<u8>], relist: &[Vec<u8>], pacer: &mut Pacer) {
	if relist.is_empty() && rewalk.is_empty() {
		return;
	}
	let mut done = Vec::with_capacity(relist.len());
	engine.with_tree_fold(|tree, ctx| {
		let dir_of = |tree: &Tree, p: &[u8]| {
			tree.lookup(Path::new(std::ffi::OsStr::from_bytes(p)))
				.map(|n| tree.nodes[n as usize].dir)
				.filter(|&d| d != NO_DIR)
		};
		let mut work = Walks::default();
		for p in rewalk {
			if let Some(d) = dir_of(tree, p) {
				tree.rewalk(d, ctx, &mut work);
			}
		}
		let mut dirs: Vec<(&Vec<u8>, u32)> = relist.iter().filter_map(|p| dir_of(tree, p).map(|d| (p, d))).collect();
		dirs.sort_by_key(|&(_, d)| tree.depth(tree.dirs[d as usize].node));
		for (p, d) in dirs {
			engine.counters.folders_reread.fetch_add(1, Ordering::Relaxed);
			if std::env::var_os("SEARCHD_TRACE").is_some() {
				eprintln!("reread {} ({} entries)", tree.path_of(tree.dirs[d as usize].node).display(), tree.dirs[d as usize].children.len());
			}
			let started = Instant::now();
			tree.relist(d, ctx, &mut work);
			done.push((p.clone(), started.elapsed()));
		}
		((), work)
	});
	pacer.mark(done, Instant::now());
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::engine::Options;
	use crate::selftest::{cleanup, temp_root};
	use std::os::unix::fs::PermissionsExt;

	fn engine_with(root: &Path, exact_max_dirs: usize, rebuild_interval: Duration) -> Arc<Engine> {
		let e = Engine::new(Options {
			root: root.to_path_buf(),
			home: PathBuf::from("/nonexistent-home"),
			threads: 2,
			own_dir: None,
			exact_max_dirs,
			scan_first: 4,
			cookie_dir: root.join(".searchd-live"),
			content_dir: None,
			index_under: root.to_path_buf(),
			budget: crate::content::UNLIMITED,
			quiet_window: Duration::ZERO,
			rebuild_interval,
		});
		e.build(false);
		e
	}

	fn wait(engine: &Arc<Engine>, done: impl Fn(&Arc<Engine>) -> bool, what: &str) {
		let until = Instant::now() + Duration::from_secs(60);
		while Instant::now() < until {
			if done(engine) {
				return;
			}
			std::thread::sleep(Duration::from_millis(20));
		}
		panic!("timed out waiting for {what}");
	}

	fn changed(cookie: u64, dropped: bool) -> Changes {
		Changes { relist: Vec::new(), rewalk: Vec::new(), cookie, batches: 1, dropped }
	}

	/// Threads of this process whose name starts with `prefix`. Counting every
	/// thread says nothing here: the other tests run their own engines, and
	/// their indexers, feeds and pools, in this same process.
	fn threads_named(prefix: &str) -> usize {
		// `PROC_PIDLISTTHREADS` from <sys/proc_info.h>: libc has the thread info
		// flavour but not this one.
		const PROC_PIDLISTTHREADS: libc::c_int = 6;
		let me = unsafe { libc::getpid() };
		let mut ids = [0u64; 4096];
		let bytes = unsafe {
			libc::proc_pidinfo(
				me,
				PROC_PIDLISTTHREADS,
				0,
				ids.as_mut_ptr().cast(),
				std::mem::size_of_val(&ids) as i32,
			)
		};
		assert!(bytes > 0, "proc_pidinfo listed no threads");
		ids[..bytes as usize / 8]
			.iter()
			.filter(|&&id| {
				let mut info = unsafe { std::mem::zeroed::<libc::proc_threadinfo>() };
				let size = std::mem::size_of::<libc::proc_threadinfo>() as i32;
				let read = unsafe { libc::proc_pidinfo(me, libc::PROC_PIDTHREADINFO, id, (&raw mut info).cast(), size) };
				let name: Vec<u8> = info.pth_name.iter().take_while(|&&c| c != 0).map(|&c| c as u8).collect();
				read > 0 && name.starts_with(prefix.as_bytes())
			})
			.count()
	}

	#[test]
	fn a_dropped_batch_keeps_broad_scopes_off_the_tree() {
		let root = temp_root("live-drop");
		std::fs::write(root.join("a.txt"), b"needle\n").unwrap();
		std::fs::create_dir_all(root.join("d")).unwrap();
		std::fs::write(root.join("d/b.txt"), b"needle\n").unwrap();
		let e = engine_with(&root, 0, Duration::from_secs(4));
		// The first rebuild runs at once and sets the rate limit.
		e.rebuild_in_background();
		wait(&e, |e| !e.catching_up(), "the rebuild asked for at startup");
		assert_eq!(e.find(&root, "*").expect("answered").paths.len(), 2);

		assert_eq!(apply(&e, changed(0, true), &mut Pacer::default()), 0);
		assert!(e.catching_up(), "a dropped batch sets the epoch before the rebuild");
		let Err(refused) = e.find(&root, "*") else { panic!("a broad scope must refuse") };
		assert!(refused.contains("catching up"), "{refused}");

		wait(&e, |e| !e.catching_up(), "the rebuild the drop asked for");
		let paths = e.find(&root, "*").expect("answered once the rebuild is done").paths;
		assert_eq!(paths.len(), 2, "{paths:?}");
		cleanup(&root);
	}

	#[test]
	fn a_cookie_flush_re_reads_every_waiting_folder() {
		let root = temp_root("live-waiting");
		std::fs::create_dir_all(root.join("busy")).unwrap();
		std::fs::write(root.join("busy/a.txt"), b"needle\n").unwrap();
		let e = engine_with(&root, 0, Duration::from_secs(600));
		let mut pacer = Pacer::default();
		let busy = root.join("busy").as_os_str().as_bytes().to_vec();
		pacer.mark(vec![(busy.clone(), Duration::from_millis(100))], Instant::now());
		pacer.waiting.insert(busy);
		apply(&e, changed(1, false), &mut pacer);
		assert!(pacer.waiting.is_empty(), "a sync must not leave a folder waiting");
		cleanup(&root);
	}

	#[test]
	fn a_rebuild_storm_runs_at_most_one_rebuild_per_interval() {
		let root = temp_root("live-storm");
		std::fs::write(root.join("a.txt"), b"needle\n").unwrap();
		let e = engine_with(&root, 50_000, Duration::from_millis(600));
		let rebuilds = |e: &Arc<Engine>| e.status()["rebuilds"].as_u64().unwrap();
		let threads = threads_named("searchd-rebuild");
		assert_eq!(rebuilds(&e), 0);
		for _ in 0..1_000 {
			e.rebuild_in_background();
		}
		assert!(
			threads_named("searchd-rebuild") <= threads + 1,
			"a thousand requests started more than one rebuild thread"
		);
		std::thread::sleep(Duration::from_millis(2_000));
		let storm = rebuilds(&e);
		assert!((1..=2).contains(&storm), "a thousand requests ran {storm} walks");
		std::thread::sleep(Duration::from_millis(2_000));
		assert_eq!(rebuilds(&e), storm, "a rebuild ran with nothing asking for it");

		for _ in 0..1_000 {
			e.rebuild_in_background();
		}
		std::thread::sleep(Duration::from_millis(2_000));
		let second = rebuilds(&e) - storm;
		assert!((1..=2).contains(&second), "one storm ran {second} walks");
		std::thread::sleep(Duration::from_millis(2_000));
		assert_eq!(rebuilds(&e), storm + second, "a rebuild ran with nothing asking for it");
		assert!(!e.catching_up(), "the epoch outlived the last rebuild");

		cleanup(&root);
	}

	#[test]
	fn a_deleted_cookie_folder_is_made_again() {
		let root = temp_root("live-cookie");
		std::fs::write(root.join("a.txt"), b"needle\n").unwrap();
		let e = engine_with(&root, 0, Duration::from_secs(600));
		let cookie = root.join(".searchd-live");
		let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
		assert_eq!(mode(&cookie), 0o700, "the cookie folder must be private to the user");
		std::fs::set_permissions(&cookie, std::fs::Permissions::from_mode(0o755)).unwrap();
		assert!(e.find(&root, "*").is_ok());
		assert_eq!(mode(&cookie), 0o700, "a cookie folder an older build left open is made private");
		std::fs::remove_dir_all(&cookie).unwrap();
		assert!(e.find(&root, "*").is_ok(), "a deleted cookie folder must not cost a broad query");
		let flag = cookie.join("flag");
		if flag.is_dir() {
			std::fs::remove_dir(&flag).unwrap();
		}
		std::fs::write(&flag, b"in the way\n").unwrap();
		assert!(e.find(&root, "*").is_ok(), "a file where the flag goes must not cost a broad query");
		cleanup(&root);
	}

	#[test]
	fn the_feed_leaves_out_the_noisiest_skipped_folders() {
		let root = temp_root("live-watch");
		let home = root.join("Users/u");
		for d in ["Users/u/Library", "Users/u/.npm", "Users/u/loose/node_modules", "Users/u/proj/src", "Users/u/Documents"] {
			std::fs::create_dir_all(root.join(d)).unwrap();
		}
		std::fs::create_dir_all(root.join("opt/x")).unwrap();
		std::fs::create_dir_all(root.join(".own")).unwrap();
		let e = Engine::new(Options {
			root: root.clone(),
			home: home.clone(),
			threads: 1,
			own_dir: Some(root.join(".own")),
			exact_max_dirs: 50_000,
			scan_first: 4,
			cookie_dir: root.join(".searchd-live"),
			content_dir: None,
			index_under: root.clone(),
			budget: crate::content::UNLIMITED,
			quiet_window: Duration::ZERO,
			rebuild_interval: Duration::from_secs(600),
		});
		let cookie = root.join(".searchd-live");
		let quiet: Vec<PathBuf> =
			quiet_paths(&e, &cookie).into_iter().map(|p| PathBuf::from(std::ffi::OsStr::from_bytes(&p))).collect();
		assert_eq!(quiet, vec![home.join("Library"), home.join(".cache")]);
		let inside = home.join("Library/searchd-live");
		let quiet = quiet_paths(&e, &inside);
		assert!(!quiet.contains(&home.join("Library").as_os_str().as_bytes().to_vec()), "the cookie's folder must stay watched");
		cleanup(&root);
	}

	#[test]
	fn a_new_top_level_folder_shows_up_at_the_next_broad_query() {
		let root = temp_root("live-toplevel");
		std::fs::create_dir_all(root.join("old")).unwrap();
		std::fs::write(root.join("old/a.txt"), b"needle\n").unwrap();
		let e = engine_with(&root, 0, Duration::from_secs(600));
		assert!(e.find(&root, "*").is_ok());
		std::fs::create_dir_all(root.join("new/deep")).unwrap();
		std::fs::write(root.join("new/deep/b.txt"), b"needle b\n").unwrap();
		let paths = e.find(&root, "*").expect("a broad query answers").paths;
		assert!(paths.contains(&"new/deep/b.txt".to_string()), "{paths:?}");
		cleanup(&root);
	}

	#[test]
	fn a_stream_that_hears_nothing_is_started_again_without_exclusions() {
		let root = temp_root("live-deaf");
		std::fs::create_dir_all(root.join("d")).unwrap();
		let e = engine_with(&root, 0, Duration::from_secs(600));
		let cookie = root.join(".searchd-live");
		let everything = [root.as_os_str().as_bytes().to_vec()];
		e.live.start_with(&e, crate::live::current_event_id(), &cookie, &everything);
		std::fs::write(root.join("d/new.txt"), b"x\n").unwrap();
		let paths = e.find(&root, "*").expect("a broad query answers").paths;
		assert!(paths.contains(&"d/new.txt".to_string()), "{paths:?}");
		cleanup(&root);
	}

	#[test]
	fn a_folder_that_takes_a_while_to_re_read_waits_longer() {
		let mut p = Pacer::default();
		let now = Instant::now();
		let mark = |took| vec![(b"/big".to_vec(), took), (b"/cheap".to_vec(), Duration::from_millis(1))];
		p.mark(mark(Duration::from_millis(100)), now);
		assert!(p.hot(b"/cheap", now + Duration::from_millis(1_900)));
		assert!(!p.hot(b"/cheap", now + Duration::from_millis(2_100)));
		assert!(p.hot(b"/big", now + Duration::from_millis(4_900)), "a 100 ms re-read waits 5 s");
		assert!(!p.hot(b"/big", now + Duration::from_millis(5_100)));
	}
}
